#!/usr/bin/env bash
# Build & upload the regional DISPLAY (basemap) PMTiles archives.
#
# Approach: extract a zoom-bounded, bbox-bounded subset from Protomaps' daily
# planet PMTiles via HTTP range requests (`pmtiles extract`) for each region in
# tiles/regions.json. Each archive must stay under CloudFront's 30GB per-object
# cap — the build hard-fails otherwise (split that region's bbox into smaller
# pieces in tiles/regions.json and re-run).
#
# Each region is extracted over its *extent* bbox (ownership bbox + OVERLAP_DEG
# margin) so chunked regions are ready for multi-archive reads; the current
# client ignores extentBbox and still selects one region by ownership bbox. See
# docs/regional-chunking.md.
#
# Defaults pull only z12-z14: app minZoom is 12 (src/lib/map/Map.svelte) and the
# matcher fetches z14 tiles, so this matches exactly what the app uses. Override
# with MIN_ZOOM / MAX_ZOOM.
#
# Outputs are date-versioned and uploaded with immutable Cache-Control. A stable
# manifest.json lists every region's current URL — the app fetches it at startup
# and picks a region by geolocation, so tile refreshes need no app redeploy.
#
# Runs whole or sharded. With no args it builds every region and writes the
# manifest. CI shards it across runners (one region each) via tiles-pipeline.yml,
# setting ONLY_REGION=<id> EMIT_MANIFEST=0; each shard uploads its PMTiles and
# writes a manifest fragment, and a final assemble job (assemble-manifest.sh)
# merges them. Knobs:
#   ONLY_REGION       build just this region id (default: all in REGIONS_FILE)
#   EMIT_MANIFEST     0 to skip the manifest (matrix shards); default 1
#   FRAGMENT_DIR      where per-region manifest fragments are written
#   DOWNLOAD_THREADS  pmtiles extract parallel range-request threads (default 4)
#   SOURCE_DATE       Protomaps build date YYYYMMDD (default: yesterday UTC)
#   PROGRESS_SAMPLE   echo every Nth extract log line (default 10; 0 = silent)

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=tiles/lib.sh
. "$SCRIPT_DIR/lib.sh"
cd "$SCRIPT_DIR/.."

MIN_ZOOM="${MIN_ZOOM:-12}"
MAX_ZOOM="${MAX_ZOOM:-14}"
S3_PREFIX="${S3_PREFIX:-s3://alex-knowlton/pictomap/tiles}"
REGIONS_FILE="${REGIONS_FILE:-tiles/regions.json}"
DOWNLOAD_THREADS="${DOWNLOAD_THREADS:-4}"
EMIT_MANIFEST="${EMIT_MANIFEST:-1}"
ONLY_REGION="${ONLY_REGION:-}"
SOURCE_DATE="${SOURCE_DATE:-$(yesterday_utc)}"
SOURCE_URL="https://build.protomaps.com/${SOURCE_DATE}.pmtiles"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# Per-region manifest fragments. mktemp gives an absolute path, so this survives
# assemble-manifest.sh's own `cd` when a full run hands off to it.
FRAGMENT_DIR="${FRAGMENT_DIR:-$TMP_DIR/fragments}"
mkdir -p "$FRAGMENT_DIR"

require_cmds pmtiles aws curl jq
if [ ! -f "$REGIONS_FILE" ]; then
  echo "regions file not found: $REGIONS_FILE" >&2
  exit 1
fi

if ! curl -sfI "$SOURCE_URL" >/dev/null; then
  echo "Source not reachable — Protomaps rotates daily builds." >&2
  echo "Pick a recent date from https://build.protomaps.com/ and re-run with" >&2
  echo "  SOURCE_DATE=YYYYMMDD $0" >&2
  exit 1
fi

REGIONS_JSON=$(select_regions "$REGIONS_FILE" "$ONLY_REGION")
REGION_COUNT=$(jq 'length' <<<"$REGIONS_JSON")
echo "Source:  $SOURCE_URL"
echo "Zooms:   z${MIN_ZOOM}-z${MAX_ZOOM}"
echo "Threads: $DOWNLOAD_THREADS"
echo "Regions: $REGION_COUNT$( [ -n "$ONLY_REGION" ] && echo " (only: $ONLY_REGION)" || echo " (from $REGIONS_FILE)" )"
echo

i=0
while IFS= read -r region; do
  i=$((i + 1))
  REGION_ID=$(jq -r '.id' <<<"$region")
  REGION_NAME=$(jq -r '.name' <<<"$region")
  BBOX=$(jq -r '.bbox | join(",")' <<<"$region")
  EXTENT_BBOX=$(expand_bbox "$BBOX" "$OVERLAP_DEG")

  OUTPUT_NAME="pictomap-${REGION_ID}-${SOURCE_DATE}-z${MIN_ZOOM}-z${MAX_ZOOM}.pmtiles"
  OUTPUT_PATH="${TMP_DIR}/${OUTPUT_NAME}"

  echo "[${i}/${REGION_COUNT}] ${REGION_NAME} (extent ${EXTENT_BBOX})"

  # pmtiles extract is chatty (progress bars + per-tile counts on stderr).
  # run_logged keeps the full output in a log (surfaced on failure) and streams
  # a sample to the terminal so the extract shows progress.
  echo "    downloading + extracting z${MIN_ZOOM}-z${MAX_ZOOM} (range requests, ${DOWNLOAD_THREADS} threads)…"
  PMTILES_LOG="${TMP_DIR}/pmtiles-${REGION_ID}.log"
  if ! run_logged "$PMTILES_LOG" pmtiles extract "$SOURCE_URL" "$OUTPUT_PATH" \
      --minzoom="$MIN_ZOOM" \
      --maxzoom="$MAX_ZOOM" \
      --download-threads="$DOWNLOAD_THREADS" \
      --bbox="$EXTENT_BBOX"; then
    cat "$PMTILES_LOG" >&2
    exit 1
  fi

  SIZE_BYTES=$(file_size "$OUTPUT_PATH")
  echo "    -> ${OUTPUT_NAME} ($(du -h "$OUTPUT_PATH" | cut -f1))"
  check_size_cap "$SIZE_BYTES"

  upload_archive "$OUTPUT_PATH" "${S3_PREFIX}/${OUTPUT_NAME}"
  rm "$OUTPUT_PATH"   # free disk before the next region (small CI runners)

  write_fragment "$region" "$EXTENT_BBOX" "$OUTPUT_NAME" "$SIZE_BYTES" \
    "${FRAGMENT_DIR}/${REGION_ID}.json"
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
  "$SCRIPT_DIR/assemble-manifest.sh"
