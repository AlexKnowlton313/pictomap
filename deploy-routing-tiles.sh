#!/usr/bin/env bash
# Build & upload the regional ROUTING PMTiles archives.
#
# Unlike deploy-tiles.sh (which range-extracts a subset of Protomaps' prebuilt
# display planet), this pipeline generates tiles ourselves from raw OSM so we
# control the schema: a single `roads` layer of *runnable* highways (vehicle
# roads + pedestrian paths), no simplification, high-resolution extent. That
# fixes the disconnected-edge / dropped-sidewalk fidelity loss in the display
# basemap, and — by publishing one detail-preserving zoom (z13) instead of
# z12-z14 — cuts the client's per-build tile request count ~4x.
#
# Per region (see tiles/regions.json for ids/bboxes, tiles/osm-sources.json for
# the Geofabrik source extract(s) per id):
#   1. Download the region's OSM source extract(s).
#   2. osmium-merge them when there's more than one (cross-continent regions).
#   3. tilemaker --bbox <region bbox>, using tiles/routing/{config.json,
#      process.lua}, -> a date-versioned PMTiles archive.
#   4. Hard-fail if it exceeds CloudFront's 30GB per-object cap.
#   5. Upload with immutable Cache-Control; write a manifest fragment.
# A full run then assembles routing-manifest.json (assemble-manifest.sh).
#
# COST NOTE: these are heavy. The continent extracts are large (europe ~28GB,
# asia ~13GB) and tilemaker reads every node in the input. Budget tens of
# minutes and tens of GB of scratch per region; the CI workflow shards one
# region per runner and frees disk first.
#
# Runs whole or sharded, mirroring deploy-tiles.sh:
#   ONLY_REGION     build just this region id (default: all in REGIONS_FILE)
#   EMIT_MANIFEST   0 to skip the manifest (matrix shards); default 1
#   FRAGMENT_DIR    where per-region manifest fragments are written
#   BUILD_DATE      version stamp YYYYMMDD (default: today UTC)
#   ZOOM            single publish zoom (default 13; see config.json extent note)
#   SKIP_UPLOAD     1 to build PMTiles into OUT_DIR without touching S3 (local
#                   iteration; implies no manifest, and aws creds not required)
#   OUT_DIR         where SKIP_UPLOAD writes archives (default ./routing-tiles-out)

set -euo pipefail
cd "$(dirname "$0")"

# tilemaker isn't a Homebrew/apt formula — build it from source or use the
# official Docker image (see the install hint below / CLAUDE.md). Override with
# an explicit path when you built it without `make install`, e.g.
#   TILEMAKER=./tilemaker/tilemaker ./deploy-routing-tiles.sh
TILEMAKER="${TILEMAKER:-tilemaker}"
ZOOM="${ZOOM:-13}"
S3_PREFIX="${S3_PREFIX:-s3://alex-knowlton/pictomap/tiles}"
REGIONS_FILE="${REGIONS_FILE:-tiles/regions.json}"
SOURCES_FILE="${SOURCES_FILE:-tiles/osm-sources.json}"
TILEMAKER_CONFIG="${TILEMAKER_CONFIG:-tiles/routing/config.json}"
TILEMAKER_PROCESS="${TILEMAKER_PROCESS:-tiles/routing/process.lua}"
EMIT_MANIFEST="${EMIT_MANIFEST:-1}"
ONLY_REGION="${ONLY_REGION:-}"
SKIP_UPLOAD="${SKIP_UPLOAD:-0}"
OUT_DIR="${OUT_DIR:-./routing-tiles-out}"
MANIFEST_NAME="${MANIFEST_NAME:-routing-manifest.json}"
MAX_BYTES=32212254720   # 30 * 1024^3 — CloudFront's per-object response cap

# Geofabrik publishes "-latest" extracts, so the build date is just today.
BUILD_DATE="${BUILD_DATE:-$(date -u +%Y%m%d)}"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# Absolute (mktemp), so it survives assemble-manifest.sh's own `cd`.
FRAGMENT_DIR="${FRAGMENT_DIR:-$TMP_DIR/fragments}"
mkdir -p "$FRAGMENT_DIR"

# tilemaker may be a PATH command or an explicit path (the TILEMAKER override).
if ! command -v "$TILEMAKER" >/dev/null 2>&1; then
  echo "missing dependency: tilemaker (\`$TILEMAKER\` not found)" >&2
  echo "  tilemaker has no brew/apt formula — install one of:" >&2
  echo "  - source: brew install boost lua shapelib rapidjson \\" >&2
  echo "      && git clone https://github.com/systemed/tilemaker && cd tilemaker \\" >&2
  echo "      && make && sudo make install   (or set TILEMAKER=./tilemaker/tilemaker)" >&2
  echo "  - docker: see CLAUDE.md — wrap \`docker run … ghcr.io/systemed/tilemaker\`" >&2
  exit 1
fi

# aws is only needed when publishing; SKIP_UPLOAD builds offline.
DEPS="osmium curl jq"
[ "$SKIP_UPLOAD" = "1" ] || DEPS="$DEPS aws"
for cmd in $DEPS; do
  if ! command -v "$cmd" >/dev/null; then
    echo "missing dependency: $cmd" >&2
    case "$cmd" in
      osmium) echo "  install with: brew install osmium-tool" >&2 ;;
      jq)     echo "  install with: brew install jq" >&2 ;;
    esac
    exit 1
  fi
done

for f in "$REGIONS_FILE" "$SOURCES_FILE" "$TILEMAKER_CONFIG" "$TILEMAKER_PROCESS"; do
  if [ ! -f "$f" ]; then
    echo "required file not found: $f" >&2
    exit 1
  fi
done

# Build every region, or just one (matrix shard) when ONLY_REGION is set.
if [ -n "$ONLY_REGION" ]; then
  REGIONS_JSON=$(jq -c --arg id "$ONLY_REGION" '[.[] | select(.id == $id)]' "$REGIONS_FILE")
  if [ "$(jq 'length' <<<"$REGIONS_JSON")" -eq 0 ]; then
    echo "ONLY_REGION='$ONLY_REGION' not found in $REGIONS_FILE" >&2
    exit 1
  fi
else
  REGIONS_JSON=$(jq -c '.' "$REGIONS_FILE")
fi

REGION_COUNT=$(jq 'length' <<<"$REGIONS_JSON")
echo "Build date: $BUILD_DATE"
echo "Zoom:       z${ZOOM} (high-resolution extent ~= z14 ground precision)"
echo "Regions:    $REGION_COUNT$( [ -n "$ONLY_REGION" ] && echo " (only: $ONLY_REGION)" || echo " (from $REGIONS_FILE)" )"
echo

i=0
while IFS= read -r region; do
  i=$((i + 1))
  REGION_ID=$(jq -r '.id' <<<"$region")
  REGION_NAME=$(jq -r '.name' <<<"$region")
  BBOX=$(jq -r '.bbox | join(",")' <<<"$region")

  # Source extract URLs for this region (bash 3.2-safe array build — no mapfile).
  SOURCES=()
  while IFS= read -r url; do
    [ -n "$url" ] && SOURCES+=("$url")
  done < <(jq -r --arg id "$REGION_ID" '.[$id].sources[]?' "$SOURCES_FILE")
  if [ "${#SOURCES[@]}" -eq 0 ]; then
    echo "no OSM sources for region '$REGION_ID' in $SOURCES_FILE" >&2
    exit 1
  fi

  echo "[${i}/${REGION_COUNT}] ${REGION_NAME} (${BBOX}) — ${#SOURCES[@]} source(s)"

  # 1. Download.
  LOCAL_FILES=()
  n=0
  for url in "${SOURCES[@]}"; do
    n=$((n + 1))
    f="${TMP_DIR}/${REGION_ID}-src${n}.osm.pbf"
    echo "    download ${url}"
    # -s drops curl's progress meter (a new line per chunk on CI's non-TTY
    # logs over multi-GB extracts); -S keeps real errors visible.
    curl -fsSL --retry 3 --retry-delay 5 -o "$f" "$url"
    LOCAL_FILES+=("$f")
  done

  # 2. Merge multi-source regions; otherwise feed the single extract directly.
  #    tilemaker's --bbox does the spatial clipping, so no osmium extract step
  #    is needed even when a region is only a sub-area of its source continent.
  if [ "${#LOCAL_FILES[@]}" -gt 1 ]; then
    INPUT="${TMP_DIR}/${REGION_ID}-merged.osm.pbf"
    echo "    osmium merge ${#LOCAL_FILES[@]} sources"
    osmium merge "${LOCAL_FILES[@]}" -o "$INPUT" --overwrite
    rm -f "${LOCAL_FILES[@]}"   # reclaim disk before tilemaker
  else
    INPUT="${LOCAL_FILES[0]}"
  fi

  # 3. tilemaker -> PMTiles. --store keeps the node index on disk so large
  #    continents stay within the RAM budget. Chatty on stderr; capture and
  #    only surface on failure (mirrors deploy-tiles.sh).
  OUTPUT_NAME="pictomap-routing-${REGION_ID}-${BUILD_DATE}-z${ZOOM}.pmtiles"
  OUTPUT_PATH="${TMP_DIR}/${OUTPUT_NAME}"
  STORE_DIR="${TMP_DIR}/store-${REGION_ID}"
  rm -rf "$STORE_DIR"
  TM_LOG="${TMP_DIR}/tilemaker-${REGION_ID}.log"
  echo "    tilemaker -> ${OUTPUT_NAME}"
  if ! "$TILEMAKER" \
      --input "$INPUT" \
      --output "$OUTPUT_PATH" \
      --config "$TILEMAKER_CONFIG" \
      --process "$TILEMAKER_PROCESS" \
      --bbox "$BBOX" \
      --store "$STORE_DIR" >"$TM_LOG" 2>&1; then
    cat "$TM_LOG" >&2
    exit 1
  fi
  rm -f "$INPUT"
  rm -rf "$STORE_DIR"

  SIZE_BYTES=$(stat -f%z "$OUTPUT_PATH" 2>/dev/null || stat -c%s "$OUTPUT_PATH")
  SIZE_HUMAN=$(du -h "$OUTPUT_PATH" | cut -f1)
  echo "    -> ${OUTPUT_NAME} (${SIZE_HUMAN})"

  if [ "$SIZE_BYTES" -gt "$MAX_BYTES" ]; then
    echo "    ERROR: region exceeds 30GB CloudFront limit — split this region's bbox in tiles/regions.json" >&2
    exit 1
  fi

  if [ "$SKIP_UPLOAD" = "1" ]; then
    mkdir -p "$OUT_DIR"
    mv "$OUTPUT_PATH" "${OUT_DIR}/${OUTPUT_NAME}"
    echo "    (SKIP_UPLOAD) saved ${OUT_DIR}/${OUTPUT_NAME}"
  else
    aws s3 cp "$OUTPUT_PATH" "${S3_PREFIX}/${OUTPUT_NAME}" \
      --content-type application/octet-stream \
      --cache-control "public, max-age=31536000, immutable" \
      --only-show-errors
    rm -f "$OUTPUT_PATH"
  fi

  # Bare filename so the app resolves the URL relative to routing-manifest.json
  # (same scheme as the display manifest). One fragment per region; merged below.
  jq -n \
    --argjson region "$region" \
    --arg filename "$OUTPUT_NAME" \
    --argjson size "$SIZE_BYTES" \
    '$region + {filename: $filename, sizeBytes: $size}' \
    > "${FRAGMENT_DIR}/${REGION_ID}.json"

  echo
done < <(jq -c '.[]' <<<"$REGIONS_JSON")

# Matrix shards run with EMIT_MANIFEST=0 and leave the merge to the assemble
# job; a full/standalone run writes the manifest itself from its fragments.
# SKIP_UPLOAD never publishes a manifest (it would point at unuploaded tiles).
if [ "$SKIP_UPLOAD" = "1" ]; then
  echo "SKIP_UPLOAD=1 — built archive(s) into $OUT_DIR, skipping upload + manifest."
  exit 0
fi
if [ "$EMIT_MANIFEST" = "0" ]; then
  echo "EMIT_MANIFEST=0 — wrote fragment(s) to $FRAGMENT_DIR, skipping manifest."
  exit 0
fi

MIN_ZOOM="$ZOOM" MAX_ZOOM="$ZOOM" SOURCE_DATE="$BUILD_DATE" \
S3_PREFIX="$S3_PREFIX" REGIONS_FILE="$REGIONS_FILE" FRAGMENT_DIR="$FRAGMENT_DIR" \
MANIFEST_NAME="$MANIFEST_NAME" \
  ./assemble-manifest.sh
