#!/usr/bin/env bash
# Build & upload the regional ROUTING PMTiles archives.
#
# Unlike build-display.sh (which range-extracts a subset of Protomaps' prebuilt
# display planet), this pipeline generates tiles ourselves from raw OSM so we
# control the schema: a single `roads` layer of *runnable* highways (vehicle
# roads + pedestrian paths), no simplification, high-resolution extent. That
# fixes the disconnected-edge / dropped-sidewalk fidelity loss in the display
# basemap, and — by publishing one detail-preserving zoom (z13) instead of
# z12-z14 — cuts the client's per-build tile request count ~4x.
#
# Per region (see tiles/regions.json for ids/bboxes, tiles/osm-sources.json for
# the Geofabrik source extract(s) per id):
#   1. Resolve each source to a prefiltered roads-only .osm.pbf: reuse one from
#      ROADS_DIR if present (CI prepares each distinct source ONCE and fans it
#      out via artifacts; a standalone full run reuses across regions in TMP),
#      else download + filter it on the fly via prepare-source.sh.
#   2. osmium-merge them when there's more than one (cross-continent regions).
#   3. tilemaker --bbox <extent>, using tiles/routing/{config.json,process.lua},
#      -> a date-versioned PMTiles archive.
#   4. Hard-fail if it exceeds CloudFront's 30GB per-object cap.
#   5. Upload with immutable Cache-Control; write a manifest fragment.
# A full run then assembles routing-manifest.json (assemble-manifest.sh).
#
# Each region is built over its *extent* bbox (ownership bbox + OVERLAP_DEG
# margin) so chunked regions are ready for multi-archive reads. See
# docs/regional-chunking.md.
#
# COST NOTE: still heavy, but the continent download+filter now happens once per
# distinct source rather than once per region (the old waste where every NA
# chunk re-pulled North America, every Asia region re-pulled Asia). tilemaker
# still reads every node of its input — budget tens of minutes + tens of GB of
# scratch per region; CI shards one region per runner and frees disk first.
#
# Runs whole or sharded, mirroring build-display.sh:
#   ONLY_REGION     build just this region id (default: all in REGIONS_FILE)
#   EMIT_MANIFEST   0 to skip the manifest (matrix shards); default 1
#   FRAGMENT_DIR    where per-region manifest fragments are written
#   ROADS_DIR       dir of prefiltered <key>-roads.osm.pbf (CI artifacts); any
#                   source not found there is downloaded + filtered on the fly
#   BUILD_DATE      version stamp YYYYMMDD (default: today UTC)
#   ZOOM            single publish zoom (default 13; see config.json extent note)
#   SKIP_UPLOAD     1 to build PMTiles into OUT_DIR without touching S3 (local
#                   iteration; implies no manifest, and aws creds not required)
#   OUT_DIR         where SKIP_UPLOAD writes archives (default ./routing-tiles-out)
#   PROGRESS_SAMPLE echo every Nth tilemaker log line (default 10; 0 = silent)

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=tiles/lib.sh
. "$SCRIPT_DIR/lib.sh"
cd "$SCRIPT_DIR/.."

# tilemaker isn't a Homebrew/apt formula — build it from source or use the
# official Docker image (see the install hint below / CLAUDE.md). Override with
# an explicit path when you built it without `make install`, e.g.
#   TILEMAKER=./tilemaker/tilemaker tiles/build-routing.sh
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
# Geofabrik publishes "-latest" extracts, so the version stamp is just today.
BUILD_DATE="${BUILD_DATE:-$(date -u +%Y%m%d)}"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# Absolute (mktemp), so it survives assemble-manifest.sh's own `cd`.
FRAGMENT_DIR="${FRAGMENT_DIR:-$TMP_DIR/fragments}"
mkdir -p "$FRAGMENT_DIR"

# Where prefiltered roads pbfs live. CI populates this from the prepare jobs'
# artifacts; standalone runs default to TMP so prepared sources are reused
# across regions within one run (e.g. Asia prepared once for me/sas/eas/sea-oc).
ROADS_DIR="${ROADS_DIR:-$TMP_DIR}"
mkdir -p "$ROADS_DIR"

# tilemaker may be a PATH command or an explicit path (the TILEMAKER override);
# its install hint is multi-line, so check it separately from require_cmds.
if ! command -v "$TILEMAKER" >/dev/null 2>&1; then
  echo "missing dependency: tilemaker (\`$TILEMAKER\` not found)" >&2
  echo "  tilemaker has no brew/apt formula — install one of:" >&2
  echo "  - source: brew install boost lua shapelib rapidjson \\" >&2
  echo "      && git clone https://github.com/systemed/tilemaker && cd tilemaker \\" >&2
  echo "      && make && sudo make install   (or set TILEMAKER=./tilemaker/tilemaker)" >&2
  echo "  - docker: see CLAUDE.md — wrap \`docker run … ghcr.io/systemed/tilemaker\`" >&2
  exit 1
fi

# curl is needed only for the on-the-fly download fallback; aws only when
# publishing. osmium (merge/filter) and jq are always needed.
require_cmds osmium curl jq
[ "$SKIP_UPLOAD" = "1" ] || require_cmds aws

for f in "$REGIONS_FILE" "$SOURCES_FILE" "$TILEMAKER_CONFIG" "$TILEMAKER_PROCESS"; do
  if [ ! -f "$f" ]; then
    echo "required file not found: $f" >&2
    exit 1
  fi
done

REGIONS_JSON=$(select_regions "$REGIONS_FILE" "$ONLY_REGION")
REGION_COUNT=$(jq 'length' <<<"$REGIONS_JSON")
echo "Build date: $BUILD_DATE"
echo "Zoom:       z${ZOOM} (high-resolution extent ~= z14 ground precision)"
echo "Roads dir:  $ROADS_DIR"
echo "Regions:    $REGION_COUNT$( [ -n "$ONLY_REGION" ] && echo " (only: $ONLY_REGION)" || echo " (from $REGIONS_FILE)" )"
echo

i=0
while IFS= read -r region; do
  i=$((i + 1))
  REGION_ID=$(jq -r '.id' <<<"$region")
  REGION_NAME=$(jq -r '.name' <<<"$region")
  BBOX=$(jq -r '.bbox | join(",")' <<<"$region")
  EXTENT_BBOX=$(expand_bbox "$BBOX" "$OVERLAP_DEG")

  # Source extract URLs for this region (bash 3.2-safe array build — no mapfile).
  SOURCES=()
  while IFS= read -r url; do
    [ -n "$url" ] && SOURCES+=("$url")
  done < <(jq -r --arg id "$REGION_ID" '.[$id].sources[]?' "$SOURCES_FILE")
  if [ "${#SOURCES[@]}" -eq 0 ]; then
    echo "no OSM sources for region '$REGION_ID' in $SOURCES_FILE" >&2
    exit 1
  fi

  echo "[${i}/${REGION_COUNT}] ${REGION_NAME} (extent ${EXTENT_BBOX}) — ${#SOURCES[@]} source(s)"

  # 1. Resolve each source to a prefiltered roads-only pbf, preparing any that
  #    aren't already present. Prepared files are left in place (never deleted)
  #    so they're reused by later regions sharing the same source.
  ROADS=()
  for url in "${SOURCES[@]}"; do
    key=$(source_key "$url")
    roads="${ROADS_DIR}/${key}-roads.osm.pbf"
    if [ -f "$roads" ]; then
      echo "    source ${key}: using prepared roads ($(du -h "$roads" | cut -f1))"
    else
      echo "    source ${key}: not prepared — downloading + filtering now"
      "$SCRIPT_DIR/prepare-source.sh" "$url" "$roads"
    fi
    ROADS+=("$roads")
  done

  # 2. Merge multi-source regions; otherwise feed the single roads pbf directly.
  #    Merging the small filtered files (not the full continents) is cheap.
  #    tilemaker's --bbox does the spatial clipping, so no osmium extract step
  #    is needed even when a region is only a sub-area of its source continent.
  MERGED=""
  if [ "${#ROADS[@]}" -gt 1 ]; then
    INPUT="${TMP_DIR}/${REGION_ID}-merged-roads.osm.pbf"
    MERGED="$INPUT"   # ours to delete after tilemaker (prepared roads are not)
    echo "    osmium merge ${#ROADS[@]} prepared sources"
    osmium merge "${ROADS[@]}" -o "$INPUT" --overwrite
  else
    INPUT="${ROADS[0]}"
  fi

  # 3. tilemaker -> PMTiles. --store keeps the node index on disk so large
  #    continents stay within the RAM budget. Chatty on stderr; run_logged
  #    samples it to the terminal and keeps the full log to surface on failure.
  OUTPUT_NAME="pictomap-routing-${REGION_ID}-${BUILD_DATE}-z${ZOOM}.pmtiles"
  OUTPUT_PATH="${TMP_DIR}/${OUTPUT_NAME}"
  STORE_DIR="${TMP_DIR}/store-${REGION_ID}"
  rm -rf "$STORE_DIR"
  TM_LOG="${TMP_DIR}/tilemaker-${REGION_ID}.log"
  echo "    tilemaker -> ${OUTPUT_NAME}…"
  if ! run_logged "$TM_LOG" "$TILEMAKER" \
      --input "$INPUT" \
      --output "$OUTPUT_PATH" \
      --config "$TILEMAKER_CONFIG" \
      --process "$TILEMAKER_PROCESS" \
      --bbox "$EXTENT_BBOX" \
      --store "$STORE_DIR"; then
    cat "$TM_LOG" >&2
    exit 1
  fi
  rm -rf "$STORE_DIR"
  [ -n "$MERGED" ] && rm -f "$MERGED"   # keep prepared roads; drop the merge temp

  SIZE_BYTES=$(file_size "$OUTPUT_PATH")
  echo "    -> ${OUTPUT_NAME} ($(du -h "$OUTPUT_PATH" | cut -f1))"
  check_size_cap "$SIZE_BYTES"

  if [ "$SKIP_UPLOAD" = "1" ]; then
    mkdir -p "$OUT_DIR"
    mv "$OUTPUT_PATH" "${OUT_DIR}/${OUTPUT_NAME}"
    echo "    (SKIP_UPLOAD) saved ${OUT_DIR}/${OUTPUT_NAME}"
  else
    upload_archive "$OUTPUT_PATH" "${S3_PREFIX}/${OUTPUT_NAME}"
    rm -f "$OUTPUT_PATH"
  fi

  write_fragment "$region" "$EXTENT_BBOX" "$OUTPUT_NAME" "$SIZE_BYTES" \
    "${FRAGMENT_DIR}/${REGION_ID}.json"
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
  "$SCRIPT_DIR/assemble-manifest.sh"
