# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Pictomap is a single-page Svelte 5 + TypeScript + Vite app that turns an uploaded image (silhouette/logo/drawing) into a runnable route. The image is overlaid on a MapLibre map, traced to a polyline, and snapped to nearby roads using a custom in-browser HMM matcher. No backend — everything runs in the browser. `tasks.md` is the canonical design doc and roadmap; consult it before making architectural decisions.

## Commands

```bash
npm run dev          # HTTPS dev server (HMR). HTTPS is required — see below.
npm run check        # svelte-check + TypeScript type-check, no build
npm run build        # type-check, then produce dist/
npm run preview      # serve the built dist/ locally
./deploy.sh          # build + sync dist/ to S3 + invalidate CloudFront (prod)
./deploy-tiles.sh    # extract regional PMTiles + manifest, upload to S3
```

There is no test runner configured. Verification is manual (run the app, drag an image, watch the matcher log).

## Required environment

Copy `.env.example` to `.env` before first run. Both env vars are optional:

- `VITE_TILES_MANIFEST_URL` — defaults to `/tiles/manifest.json`. The Vite dev server proxies `/tiles/*` to the production CloudFront (see `vite.config.ts`), so the default works locally without any setup. Override only when testing a staging or local manifest.
- `VITE_SENTRY_DSN` — leave blank to disable error reporting locally.

## HTTPS dev server

`navigator.geolocation` refuses to run on plain HTTP, so the dev server uses `vite-plugin-mkcert` for a self-signed cert. First run installs a local CA — accept any system prompts.

## Architecture

The app has four moving parts that communicate through small reactive stores (Svelte 5 runes — `$state`, `$state.raw`):

1. **Map** (`src/lib/map/`) — MapLibre instance with a Protomaps PMTiles basemap. Owns geolocation, the user marker, the debug graph layer, and the matched-route layer. Publishes the live `Map` to `mapStore.instance` so the Overlay can read screen ↔ lng/lat math without prop-drilling. Boot is async: fetches the tile manifest + geolocates in parallel, then picks a region and creates the map with that region's PMTiles URL and bbox-locked `maxBounds`.

2. **Image → contour pipeline** (`src/lib/image/`) — `ImageUploader` loads the file; `ContourEditor` runs `extractContour` (threshold → largest-connected-component → Moore-neighbor boundary trace → RDP simplify to 30–100 points) with a live threshold slider. Output is `Point[]` in source-image pixel space.

3. **Overlay** (`src/lib/overlay/`) — Custom drag/rotate/uniform-scale handle layer over the map. `OverlayState` is `{anchor lng/lat, rotationDeg, metersPerPixel}` — translation + rotation + uniform scale only, never perspective, so the pixel → lng/lat transform stays affine. `projectContourToLngLat` does that projection.

4. **Graph + matcher** (`src/lib/graph/`) — The product's load-bearing engineering. A dedicated Web Worker (`worker.ts`) owns the PMTiles client, builds the road graph for a bbox around the user, then keeps a `Matcher` instance alive to handle subsequent match requests without re-shipping the graph across the worker boundary on every drag. Main thread talks to it via `GraphService` (request/response correlated by `reqId`). The graph (~20k edges) is built once per location and re-used for every match.

### End-to-end data flow

```
upload → threshold → boundary trace → RDP simplify → Point[] (pixel space)
       ↓
       overlay placed at map center → OverlayState
       ↓ (on every drag/rotate/scale end, debounced 300ms in App.svelte)
       project pixels → [lng,lat][] via affine transform
       ↓ (postMessage)
       worker.Matcher.match: project lng/lat → local meters → find candidates
       → Viterbi over candidate lattice with bounded Dijkstra transitions
       → stitch route polyline → back to lng/lat
       ↓ (postMessage)
       state.matched → effect renders route layer on the map
```

### Why the matcher is custom (don't replace with a hosted API)

Hosted matchers (Mapbox, Stadia, GraphHopper) optimize for noisy GPS trajectories. Pictomap's input isn't a trajectory — it's a shape. The cost function in `matcher.ts` reflects that: emission Gaussian on perpendicular distance, route-vs-input distance term, **shape-preservation term** (heading agreement between consecutive input steps and the matched route), and a runnability penalty (motorways pre-filtered, paths preferred). This is the product differentiator. The tuning knobs at the top of `matcher.ts` (`EMISSION_SIGMA_M`, `SHAPE_WEIGHT`, `ROUTE_DEVIATION_PER_M`, `TRANSITION_CAP_*`) are deliberately first-pass guesses — Task 6e in `tasks.md` is the iteration pass.

### Graph build subtleties

- **Stitching across tile boundaries** (`worker.ts` `stitch`): vertices within ~2m snap to a canonical node via a spatial grid, then linestrings are split at any shared canonical node so cross-streets actually connect to the through-road they meet (otherwise a long arterial would be one edge and the cross-streets float free).
- **Small-component pruning** (`pruneSmallComponents`): components with fewer than 20 edges are dropped — they're parking-lot loops and orphan paths that the matcher's bounded Dijkstra can't escape, producing dead-end candidate states.
- **Local-meter frame** (`projection.ts`): the matcher converts everything to a flat plane anchored at the graph bbox center for cheap geometry. Distortion is <0.1% at the 5km scale used.

### Reactive state map

- `state.svelte.ts` (`AppState`) — the single shared `state` singleton: image, contour, overlay, matched, matching, matchStatus. `App.svelte` orchestrates the snap pipeline (debounce, generation counter for stale-result rejection).
- `map/store.svelte.ts` — live MapLibre instance.
- `graph/store.svelte.ts` — `GraphService` (worker wrapper) + most-recently-built `RoadGraph` + build status.

All three use `$state.raw` for the large/opaque values (the map, the worker, the graph) so reactivity fires only on identity change, not on internal mutation.

### Snap orchestration (App.svelte)

Two pieces of subtle logic worth knowing about:

1. **Debounce + generation counter.** `scheduleSnap` debounces transform-end events by 300ms; every match request bumps `snapGen`, and stale results are dropped on return. This prevents a slow match for an old drag from overwriting the result of a newer drag.
2. **Graph-not-ready retry.** If the user finishes placing the contour before `buildGraphAt` completes, the snap callback re-schedules itself rather than throwing.

## Coordinate conventions

- All graph + map data is `[lng, lat]` tuples (GeoJSON / MapLibre convention).
- Inside the matcher only, coords are local meters `[x, y]` via `LocalFrame`.
- Image-space points are `{x, y}` objects in source-pixel units.

Don't mix these. The boundaries are: `projectContourToLngLat` (pixel → lng/lat) and `toLocal`/`fromLocal` (lng/lat ↔ meters).

## Deployment

Two independent pipelines:

- **App** (`./deploy.sh`, GitHub Actions `deploy.yml` on push to main): builds and syncs to `s3://alex-knowlton/pictomap/`, invalidates CloudFront. Doesn't bake in tile URLs — the app fetches the manifest at runtime.
- **Tiles** (`./deploy-tiles.sh`, GitHub Actions `deploy-tiles.yml` weekly): extracts regional PMTiles from Protomaps' daily planet build via `pmtiles extract --bbox=` per region, uploads each to `s3://alex-knowlton/pictomap/tiles/`, and writes a fresh `manifest.json` at a stable URL.

### Tiles architecture

Regions are defined in `tiles/regions.json` (id, name, bbox per region). The build script hard-fails if any region exceeds **30GB** (CloudFront's per-object response cap) — split that region's bbox into smaller pieces when this happens. The app:

1. Fetches `/tiles/manifest.json` at startup.
2. Geolocates the user (falls back to Manhattan).
3. Picks the region whose bbox contains the user (first-match in the manifest order; nearest-centroid fallback for users outside every bbox).
4. Creates the MapLibre map with the region's PMTiles URL and `maxBounds` locked to the region bbox.

Crossing into another region requires a page refresh — `maxBounds` blocks panning out, and the "Re-center" button surfaces an out-of-region banner if geolocation lands the user elsewhere.

The manifest URL is stable, so tile rebuilds (weekly) don't require an app redeploy — clients just pick up the new entries on next page load.
