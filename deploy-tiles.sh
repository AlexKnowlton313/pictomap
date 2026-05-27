#!/usr/bin/env bash
# Build & upload the basemap / road-graph PMTiles archive.
#
# Approach: extract a zoom-bounded subset from Protomaps' daily planet PMTiles
# via HTTP range requests (`pmtiles extract`). Avoids running our own planetiler
# build while keeping schema compatibility with src/lib/graph/worker.ts, which
# was written against Protomaps' MVT schema.
#
# Defaults pull only z10-z14: app minZoom is 12 (src/lib/map/Map.svelte) and
# the matcher fetches z14 tiles, so z10-z14 covers what we render plus a small
# buffer. Override with MIN_ZOOM / MAX_ZOOM env vars.
#
# Output object is uniquely named (date + zoom range) and uploaded with a long
# immutable Cache-Control, so no CloudFront invalidation is needed. The S3 URL
# is printed at the end — wire it into VITE_PMTILES_URL once the CDN backs it.

set -euo pipefail
cd "$(dirname "$0")"

MIN_ZOOM="${MIN_ZOOM:-10}"
MAX_ZOOM="${MAX_ZOOM:-14}"
S3_PREFIX="${S3_PREFIX:-s3://alex-knowlton/pictomap/tiles}"

# Protomaps rotates daily builds and today's may not be published yet; default
# to yesterday UTC. macOS uses BSD `date -v`; Linux (CI) uses GNU `date -d`.
yesterday_utc() {
  if date -u -v-1d +%Y%m%d >/dev/null 2>&1; then
    date -u -v-1d +%Y%m%d
  else
    date -u -d 'yesterday' +%Y%m%d
  fi
}
SOURCE_DATE="${SOURCE_DATE:-$(yesterday_utc)}"
SOURCE_URL="https://build.protomaps.com/${SOURCE_DATE}.pmtiles"

OUTPUT_NAME="pictomap-planet-${SOURCE_DATE}-z${MIN_ZOOM}-z${MAX_ZOOM}.pmtiles"
TMP_DIR="$(mktemp -d)"
OUTPUT_PATH="${TMP_DIR}/${OUTPUT_NAME}"

trap 'rm -rf "$TMP_DIR"' EXIT

for cmd in pmtiles aws curl; do
  if ! command -v "$cmd" >/dev/null; then
    echo "missing dependency: $cmd" >&2
    if [[ "$cmd" == "pmtiles" ]]; then
      echo "  install with: brew install pmtiles" >&2
    fi
    exit 1
  fi
done

echo "Source: $SOURCE_URL"
echo "Output: $OUTPUT_NAME"
echo "Zooms:  z${MIN_ZOOM}-z${MAX_ZOOM}"
echo

if ! curl -sfI "$SOURCE_URL" >/dev/null; then
  echo "Source not reachable — Protomaps rotates daily builds." >&2
  echo "Pick a recent date from https://build.protomaps.com/ and re-run with" >&2
  echo "  SOURCE_DATE=YYYYMMDD ./deploy-tiles.sh" >&2
  exit 1
fi

pmtiles extract "$SOURCE_URL" "$OUTPUT_PATH" \
  --minzoom="$MIN_ZOOM" \
  --maxzoom="$MAX_ZOOM"

SIZE=$(du -h "$OUTPUT_PATH" | cut -f1)
echo
echo "Built: $OUTPUT_NAME ($SIZE)"

DEST="${S3_PREFIX}/${OUTPUT_NAME}"
aws s3 cp "$OUTPUT_PATH" "$DEST" \
  --content-type application/octet-stream \
  --cache-control "public, max-age=31536000, immutable"

echo
echo "Uploaded: $DEST"
echo "Point VITE_PMTILES_URL at the CloudFront URL backing this object."
