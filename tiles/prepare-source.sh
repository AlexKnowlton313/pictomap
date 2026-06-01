#!/usr/bin/env bash
# Download one OSM source extract and filter it down to a small highways-only
# .osm.pbf — the per-source half of the routing build, split out so a continent
# is downloaded + filtered ONCE and fanned out to every chunk that uses it,
# instead of every chunk re-downloading its whole continent. See
# docs/regional-chunking.md ("What it unlocks").
#
# CI runs this once per distinct source (a matrix job) and hands the result to
# the build shards as an artifact; build-routing.sh also calls it inline for any
# source not already prepared (standalone / local runs), so a full local run
# gets the same dedup for free.
#
# Usage: prepare-source.sh <source-url> <output-roads.osm.pbf>

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=tiles/lib.sh
. "$SCRIPT_DIR/lib.sh"
cd "$SCRIPT_DIR/.."

URL="${1:?usage: prepare-source.sh <source-url> <output-roads.osm.pbf>}"
OUT="${2:?usage: prepare-source.sh <source-url> <output-roads.osm.pbf>}"

require_cmds osmium curl

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
RAW="${TMP_DIR}/source.osm.pbf"

# Download. Multi-GB continent extracts: curl's own progress meter doesn't
# render to a non-tty CI log legibly, so run curl in the background and print a
# periodic MB/percent line off the growing file instead. HEAD first for the
# total so we can show a percentage (bytes-only if the server won't report it).
# curl's stderr (the real errors) is kept in DL_LOG and surfaced on non-zero.
echo "    download ${URL}"
DL_LOG="${TMP_DIR}/download.log"
TOTAL=$(curl -fsSLI "$URL" 2>/dev/null \
  | awk 'tolower($1) ~ /^content-length:/ {print $2}' | tr -d '\r' | tail -1)
case "$TOTAL" in ''|*[!0-9]*) TOTAL=0 ;; esac
curl -fSL --retry 3 --retry-delay 5 -o "$RAW" "$URL" 2>"$DL_LOG" &
dlpid=$!
while kill -0 "$dlpid" 2>/dev/null; do
  cur=$(file_size "$RAW" 2>/dev/null || echo 0)
  if [ "$TOTAL" -gt 0 ]; then
    echo "      $((cur / 1048576)) / $((TOTAL / 1048576)) MB ($((cur * 100 / TOTAL))%)"
  else
    echo "      $((cur / 1048576)) MB"
  fi
  sleep 20
done
if ! wait "$dlpid"; then   # propagate curl's exit status under set -e
  cat "$DL_LOG" >&2
  exit 1
fi

# Filter to highways. process.lua keeps only highway= ways, but tilemaker still
# *reads* — and builds an on-disk node store over — every building/landuse/
# waterway node in the whole continent first (the 30GB+ store and multi-hour
# read seen in the logs). osmium strips all of it in one streaming pass; matched
# ways keep their referenced nodes (osmium's default, so geometry survives) plus
# the bridge/tunnel/layer tags the schema reads — so tilemaker emits the same
# `roads` tiles from a small fraction of the data, store no longer spilling to
# disk. The construction/raceway/etc. highway values this passes through are
# still dropped by process.lua's ROAD_KINDS gate.
echo "    osmium tags-filter -> highways only"
mkdir -p "$(dirname "$OUT")"
osmium tags-filter "$RAW" w/highway -o "$OUT" --overwrite
echo "    -> ${OUT} ($(du -h "$OUT" | cut -f1))"
