#!/usr/bin/env bash
# Merge per-region manifest fragments into manifest.json and upload it.
#
# deploy-tiles.sh writes one fragment per region (region config + published
# filename + on-disk size) into FRAGMENT_DIR. This script orders them by their
# position in REGIONS_FILE — the app selects the first region whose bbox
# contains the user, so manifest order is significant — and publishes the
# manifest at a stable URL with a short cache so tile refreshes propagate
# without an app redeploy.
#
# Used two ways:
#   - a full deploy-tiles.sh run calls this at the end (all fragments present)
#   - the CI assemble job runs it after gathering matrix shards' fragments
#
# Required env: FRAGMENT_DIR, SOURCE_DATE. Optional: MIN_ZOOM, MAX_ZOOM,
# S3_PREFIX, REGIONS_FILE (must match the values used to build the fragments).

set -euo pipefail
cd "$(dirname "$0")"

MIN_ZOOM="${MIN_ZOOM:-12}"
MAX_ZOOM="${MAX_ZOOM:-14}"
S3_PREFIX="${S3_PREFIX:-s3://alex-knowlton/pictomap/tiles}"
REGIONS_FILE="${REGIONS_FILE:-tiles/regions.json}"
FRAGMENT_DIR="${FRAGMENT_DIR:?FRAGMENT_DIR is required}"
SOURCE_DATE="${SOURCE_DATE:?SOURCE_DATE is required}"

for cmd in aws jq; do
  if ! command -v "$cmd" >/dev/null; then
    echo "missing dependency: $cmd" >&2
    exit 1
  fi
done

if [ ! -f "$REGIONS_FILE" ]; then
  echo "regions file not found: $REGIONS_FILE" >&2
  exit 1
fi

# Collect fragments in REGIONS_FILE order; fail loudly if any region's shard
# didn't produce one (an incomplete manifest would break region selection).
FRAGMENTS=()
while IFS= read -r id; do
  frag="${FRAGMENT_DIR}/${id}.json"
  if [ ! -f "$frag" ]; then
    echo "missing manifest fragment for region '$id': $frag" >&2
    exit 1
  fi
  FRAGMENTS+=("$frag")
done < <(jq -r '.[].id' "$REGIONS_FILE")

REGIONS_JSON=$(jq -c -s '.' "${FRAGMENTS[@]}")

# Manifest URL is stable; the app hardcodes it. Short cache (5 min) so tile
# refreshes propagate without anyone having to invalidate or redeploy.
MANIFEST_PATH="$(mktemp)"
trap 'rm -f "$MANIFEST_PATH"' EXIT
jq -n \
  --arg sourceDate "$SOURCE_DATE" \
  --argjson minZoom "$MIN_ZOOM" \
  --argjson maxZoom "$MAX_ZOOM" \
  --argjson regions "$REGIONS_JSON" \
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

echo "Manifest uploaded to ${S3_PREFIX}/manifest.json ($(jq '.regions | length' "$MANIFEST_PATH") regions)"
