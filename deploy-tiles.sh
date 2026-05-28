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

set -euo pipefail
cd "$(dirname "$0")"

MIN_ZOOM="${MIN_ZOOM:-12}"
MAX_ZOOM="${MAX_ZOOM:-14}"
S3_PREFIX="${S3_PREFIX:-s3://alex-knowlton/pictomap/tiles}"
REGIONS_FILE="${REGIONS_FILE:-tiles/regions.json}"
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

if ! curl -sfI "$SOURCE_URL" >/dev/null; then
  echo "Source not reachable — Protomaps rotates daily builds." >&2
  echo "Pick a recent date from https://build.protomaps.com/ and re-run with" >&2
  echo "  SOURCE_DATE=YYYYMMDD ./deploy-tiles.sh" >&2
  exit 1
fi

REGION_COUNT=$(jq 'length' "$REGIONS_FILE")
echo "Source: $SOURCE_URL"
echo "Zooms:  z${MIN_ZOOM}-z${MAX_ZOOM}"
echo "Regions: $REGION_COUNT (from $REGIONS_FILE)"
echo

# Accumulate per-region entries for the manifest. Each entry merges the region
# config (id, name, bbox) with the published URL and on-disk size.
MANIFEST_REGIONS="[]"

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
  # without any CORS configuration.
  MANIFEST_REGIONS=$(jq \
    --argjson region "$region" \
    --arg filename "$OUTPUT_NAME" \
    --argjson size "$SIZE_BYTES" \
    '. + [$region + {filename: $filename, sizeBytes: $size}]' \
    <<<"$MANIFEST_REGIONS")

  echo
done < <(jq -c '.[]' "$REGIONS_FILE")

# Manifest URL is stable; the app hardcodes it. Short cache (5 min) so tile
# refreshes propagate without anyone having to invalidate or redeploy.
MANIFEST_PATH="${TMP_DIR}/manifest.json"
jq -n \
  --arg sourceDate "$SOURCE_DATE" \
  --argjson minZoom "$MIN_ZOOM" \
  --argjson maxZoom "$MAX_ZOOM" \
  --argjson regions "$MANIFEST_REGIONS" \
  '{
    generatedAt: (now | todateiso8601),
    sourceDate: $sourceDate,
    minZoom: $minZoom,
    maxZoom: $maxZoom,
    regions: $regions
  }' \
  > "$MANIFEST_PATH"

aws s3 cp "$MANIFEST_PATH" "${S3_PREFIX}/manifest.json" \
  --content-type application/json \
  --cache-control "public, max-age=300" \
  --only-show-errors

echo "Manifest uploaded to ${S3_PREFIX}/manifest.json"
