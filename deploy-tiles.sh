#!/usr/bin/env bash
# Build & upload regional basemap / road-graph PMTiles archives.
#
# Approach: extract a zoom-bounded, bbox-bounded subset from Protomaps' daily
# planet PMTiles via HTTP range requests (`pmtiles extract`) for each region in
# tiles/regions.json. Each regional archive must stay under CloudFront's 30GB
# per-object cap — the script hard-fails if any region exceeds it (split that
# region's bbox into smaller pieces in tiles/regions.json and re-run).
#
# Defaults pull only z12-z14: app minZoom is 12 (src/lib/map/Map.svelte) and
# the matcher fetches z14 tiles, so this matches exactly what the app uses.
# Override with MIN_ZOOM / MAX_ZOOM env vars.
#
# Outputs are date-versioned and uploaded with immutable Cache-Control. A
# manifest.json at a stable URL lists every region's current URL — the app
# fetches the manifest at startup and picks a region by geolocation, so tile
# refreshes don't require an app redeploy.
#
# Runs whole or sharded. With no args it builds every region and writes the
# manifest. The CI workflow shards it across runners (one region each) by
# setting ONLY_REGION=<id> EMIT_MANIFEST=0; each shard uploads its PMTiles and
# writes a manifest fragment, and a final assemble job (assemble-manifest.sh)
# merges the fragments into manifest.json. Knobs:
#   ONLY_REGION       build just this region id (default: all in REGIONS_FILE)
#   EMIT_MANIFEST     0 to skip the manifest (matrix shards); default 1
#   FRAGMENT_DIR      where per-region manifest fragments are written
#   DOWNLOAD_THREADS  pmtiles extract parallel range-request threads (default 4)

set -euo pipefail
cd "$(dirname "$0")"

MIN_ZOOM="${MIN_ZOOM:-12}"
MAX_ZOOM="${MAX_ZOOM:-14}"
S3_PREFIX="${S3_PREFIX:-s3://alex-knowlton/pictomap/tiles}"
REGIONS_FILE="${REGIONS_FILE:-tiles/regions.json}"
DOWNLOAD_THREADS="${DOWNLOAD_THREADS:-4}"
EMIT_MANIFEST="${EMIT_MANIFEST:-1}"
ONLY_REGION="${ONLY_REGION:-}"
MAX_BYTES=32212254720   # 30 * 1024^3 — CloudFront's per-object response cap

yesterday_utc() {
  if date -u -v-1d +%Y%m%d >/dev/null 2>&1; then
    date -u -v-1d +%Y%m%d
  else
    date -u -d 'yesterday' +%Y%m%d
  fi
}
SOURCE_DATE="${SOURCE_DATE:-$(yesterday_utc)}"
SOURCE_URL="https://build.protomaps.com/${SOURCE_DATE}.pmtiles"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# Per-region manifest fragments land here. mktemp gives an absolute path, so
# this survives assemble-manifest.sh's own `cd` when a full run hands off to it.
FRAGMENT_DIR="${FRAGMENT_DIR:-$TMP_DIR/fragments}"
mkdir -p "$FRAGMENT_DIR"

for cmd in pmtiles aws curl jq; do
  if ! command -v "$cmd" >/dev/null; then
    echo "missing dependency: $cmd" >&2
    case "$cmd" in
      pmtiles|jq) echo "  install with: brew install $cmd" >&2 ;;
    esac
    exit 1
  fi
done

if [ ! -f "$REGIONS_FILE" ]; then
  echo "regions file not found: $REGIONS_FILE" >&2
  exit 1
fi

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

if ! curl -sfI "$SOURCE_URL" >/dev/null; then
  echo "Source not reachable — Protomaps rotates daily builds." >&2
  echo "Pick a recent date from https://build.protomaps.com/ and re-run with" >&2
  echo "  SOURCE_DATE=YYYYMMDD ./deploy-tiles.sh" >&2
  exit 1
fi

REGION_COUNT=$(jq 'length' <<<"$REGIONS_JSON")
echo "Source:  $SOURCE_URL"
echo "Zooms:   z${MIN_ZOOM}-z${MAX_ZOOM}"
echo "Threads: $DOWNLOAD_THREADS"
echo "Regions: $REGION_COUNT$( [ -n "$ONLY_REGION" ] && echo " (only: $ONLY_REGION)" || echo " (from $REGIONS_FILE)" )"
echo

# Each region writes one manifest fragment (region config + filename + size) to
# FRAGMENT_DIR; the fragments are merged into manifest.json below (full run) or
# by assemble-manifest.sh in the CI assemble job (matrix shards).

i=0
while IFS= read -r region; do
  i=$((i + 1))
  REGION_ID=$(jq -r '.id' <<<"$region")
  REGION_NAME=$(jq -r '.name' <<<"$region")
  BBOX=$(jq -r '.bbox | join(",")' <<<"$region")

  OUTPUT_NAME="pictomap-${REGION_ID}-${SOURCE_DATE}-z${MIN_ZOOM}-z${MAX_ZOOM}.pmtiles"
  OUTPUT_PATH="${TMP_DIR}/${OUTPUT_NAME}"

  echo "[${i}/${REGION_COUNT}] ${REGION_NAME} (${BBOX})"

  # pmtiles extract is chatty (progress bars + per-tile counts on stderr).
  # Capture to a log and only surface it if the command fails.
  PMTILES_LOG="${TMP_DIR}/pmtiles-${REGION_ID}.log"
  if ! pmtiles extract "$SOURCE_URL" "$OUTPUT_PATH" \
      --minzoom="$MIN_ZOOM" \
      --maxzoom="$MAX_ZOOM" \
      --download-threads="$DOWNLOAD_THREADS" \
      --bbox="$BBOX" >"$PMTILES_LOG" 2>&1; then
    cat "$PMTILES_LOG" >&2
    exit 1
  fi

  SIZE_BYTES=$(stat -f%z "$OUTPUT_PATH" 2>/dev/null || stat -c%s "$OUTPUT_PATH")
  SIZE_HUMAN=$(du -h "$OUTPUT_PATH" | cut -f1)
  echo "    -> ${OUTPUT_NAME} (${SIZE_HUMAN})"

  if [ "$SIZE_BYTES" -gt "$MAX_BYTES" ]; then
    echo "    ERROR: region exceeds 30GB CloudFront limit — split this region's bbox in tiles/regions.json" >&2
    exit 1
  fi

  aws s3 cp "$OUTPUT_PATH" "${S3_PREFIX}/${OUTPUT_NAME}" \
    --content-type application/octet-stream \
    --cache-control "public, max-age=31536000, immutable" \
    --only-show-errors

  # Free disk before extracting the next region (matters on small CI runners).
  rm "$OUTPUT_PATH"

  # Manifest stores bare filename so the app resolves tile URLs relative to
  # the manifest URL — works the same in dev (Vite proxy) and prod (same-origin)
  # without any CORS configuration. One fragment per region; merged later.
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
if [ "$EMIT_MANIFEST" = "0" ]; then
  echo "EMIT_MANIFEST=0 — wrote fragment(s) to $FRAGMENT_DIR, skipping manifest."
  exit 0
fi

MIN_ZOOM="$MIN_ZOOM" MAX_ZOOM="$MAX_ZOOM" SOURCE_DATE="$SOURCE_DATE" \
S3_PREFIX="$S3_PREFIX" REGIONS_FILE="$REGIONS_FILE" FRAGMENT_DIR="$FRAGMENT_DIR" \
  ./assemble-manifest.sh
