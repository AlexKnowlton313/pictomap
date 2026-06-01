# shellcheck shell=bash
# Shared scaffolding for the tile build scripts (tiles/build-display.sh,
# tiles/build-routing.sh) and tiles/assemble-manifest.sh.
#
# Sourced, not executed — no shebang, no `set -e` (the sourcing script owns
# shell options). Bash 3.2-safe (macOS ships 3.2): no associative arrays, no
# `mapfile`, no `${var^^}`.
#
# A build script's preamble is:
#   SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
#   . "$SCRIPT_DIR/lib.sh"
#   cd "$SCRIPT_DIR/.."            # repo root — default paths are relative to it

# CloudFront caps a single object's response at 30 GB. Archives above this can't
# be served, so the build hard-fails and the region's bbox must be split.
MAX_BYTES=32212254720   # 30 * 1024^3

# Margin (degrees) added around each region's ownership bbox to produce its
# *extent* bbox — the geography its archive actually covers. >= 1/2 tile at the
# publish zoom (~0.022 deg at z13) so a chunk's archive holds every tile it owns
# complete, even seam tiles whose cells spill past the ownership edge. Rounded
# up to ~1 tile for safety. The current client ignores extentBbox; this exists
# so chunked regions are ready for multi-archive reads. See
# docs/regional-chunking.md.
OVERLAP_DEG="${OVERLAP_DEG:-0.05}"

# Sample rate for run_logged: echo every Nth line of a chatty command to the
# terminal (0 = silent). The full output is always kept in the log file.
PROGRESS_SAMPLE="${PROGRESS_SAMPLE:-10}"

# run_logged LOGFILE CMD [ARGS...]
# Run a long, chatty command with its full output saved to LOGFILE while echoing
# every PROGRESS_SAMPLE-th line to the terminal — enough to watch a download or
# extract move without the per-tile flood. Callers `cat` the log on failure;
# pipefail (set by the caller) makes this return the wrapped command's status,
# since the tee/awk tail of the pipe can't fail.
run_logged() {
  local log="$1"; shift
  "$@" 2>&1 | tee "$log" | awk -v n="$PROGRESS_SAMPLE" \
    'n > 0 && NR % n == 0 { print "      " $0; fflush() }'
}

# require_cmds CMD...
# Exit 1 with an install hint if any command is missing from PATH.
require_cmds() {
  local cmd
  for cmd in "$@"; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      echo "missing dependency: $cmd" >&2
      case "$cmd" in
        jq|pmtiles) echo "  install with: brew install $cmd" >&2 ;;
        osmium)     echo "  install with: brew install osmium-tool" >&2 ;;
      esac
      exit 1
    fi
  done
}

# yesterday_utc -> YYYYMMDD for "yesterday" in UTC, on both BSD (macOS) and GNU.
yesterday_utc() {
  if date -u -v-1d +%Y%m%d >/dev/null 2>&1; then
    date -u -v-1d +%Y%m%d            # BSD date
  else
    date -u -d 'yesterday' +%Y%m%d   # GNU date
  fi
}

# select_regions REGIONS_FILE ONLY_REGION -> prints the regions JSON array.
# With ONLY_REGION set (a matrix shard), narrows to that one id and errors if
# it isn't in the file; otherwise returns every region.
select_regions() {
  local file="$1" only="$2" json
  if [ -n "$only" ]; then
    json=$(jq -c --arg id "$only" '[.[] | select(.id == $id)]' "$file")
    if [ "$(jq 'length' <<<"$json")" -eq 0 ]; then
      echo "ONLY_REGION='$only' not found in $file" >&2
      exit 1
    fi
  else
    json=$(jq -c '.' "$file")
  fi
  printf '%s' "$json"
}

# expand_bbox "minLng,minLat,maxLng,maxLat" MARGIN_DEG
# -> "minLng,minLat,maxLng,maxLat" grown by MARGIN_DEG on every side and clamped
#    to world bounds. This is the extent bbox handed to the tile extractor.
expand_bbox() {
  awk -v b="$1" -v m="$2" 'BEGIN {
    split(b, a, ",");
    minLng = a[1] - m; minLat = a[2] - m; maxLng = a[3] + m; maxLat = a[4] + m;
    if (minLng < -180) minLng = -180; if (maxLng > 180) maxLng = 180;
    if (minLat < -90)  minLat = -90;  if (maxLat > 90)  maxLat = 90;
    printf "%.6f,%.6f,%.6f,%.6f", minLng, minLat, maxLng, maxLat;
  }'
}

# file_size PATH -> size in bytes (BSD or GNU stat).
file_size() {
  stat -f%z "$1" 2>/dev/null || stat -c%s "$1"
}

# check_size_cap BYTES — hard-fail if an archive exceeds the CloudFront cap.
check_size_cap() {
  if [ "$1" -gt "$MAX_BYTES" ]; then
    echo "    ERROR: archive exceeds 30GB CloudFront cap — split this region's bbox in tiles/regions.json" >&2
    exit 1
  fi
}

# upload_archive LOCAL_PATH S3_URI — date-versioned objects are immutable, so
# they carry a one-year immutable Cache-Control and need no invalidation.
upload_archive() {
  aws s3 cp "$1" "$2" \
    --content-type application/octet-stream \
    --cache-control "public, max-age=31536000, immutable" \
    --only-show-errors
}

# write_fragment REGION_JSON EXTENT_CSV FILENAME SIZE_BYTES OUT_PATH
# Write one region's manifest fragment: the region's regions.json entry (id,
# name, ownership bbox) plus the computed extentBbox, the published filename
# (bare, so the app resolves it relative to the manifest URL), and the byte
# size. assemble-manifest.sh concatenates these in REGIONS_FILE order.
write_fragment() {
  local region="$1" extent_csv="$2" filename="$3" size="$4" out="$5" extent_json
  extent_json=$(jq -cn --arg s "$extent_csv" '$s | split(",") | map(tonumber)')
  jq -n \
    --argjson region "$region" \
    --argjson extentBbox "$extent_json" \
    --arg filename "$filename" \
    --argjson size "$size" \
    '$region + {extentBbox: $extentBbox, filename: $filename, sizeBytes: $size}' \
    > "$out"
}
