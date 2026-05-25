# Pictomap

A web app that turns an uploaded image (silhouette, logo, drawing) into a runnable route. The image is overlaid on a map at the user's location; the user can drag, rotate, and scale it. As they manipulate the image, the app traces its outline, snaps that outline to nearby roads/trails using a custom HMM matcher tuned for shape preservation, and renders the resulting route so they can run it.

## Stack

- **Frontend:** Svelte + TypeScript + Vite
- **Map:** MapLibre GL JS + Protomaps PMTiles (vector tiles served from S3 via HTTP range requests)
- **Image overlay:** custom MapLibre layer with drag / rotate / uniform-scale handles (no off-the-shelf equivalent of `Leaflet.DistortableImage`)
- **Road graph:** extracted client-side from vector tiles, built in a Web Worker, cached in IndexedDB
- **Snap-to-roads:** in-browser HMM map matcher (Newson & Krumm 2009) tuned for shape preservation, not GPS trajectory plausibility
- **Persistence:** localStorage (current route state) + IndexedDB (tile / graph cache)
- **Hosting:** AWS S3 + CloudFront (static site, including the PMTiles archive)
- **Export:** GPX download (Strava/Garmin compatible)
- **Error reporting:** Sentry (free tier) — wired from day one

## Architecture

```
+---------------------+        +-----------------------+
|  Image upload       |        |  Geolocation API      |
|  -> canvas          |        |  -> initial map view  |
|  -> threshold       |        +-----------+-----------+
|  -> contour trace   |                    |
|  -> simplify (RDP)  |                    v
+----------+----------+        +-----------------------+
           |                   |  MapLibre map         |
           v                   |  (Protomaps PMTiles)  |
+---------------------+        +-----------+-----------+
|  Pixel-space        |                    |
|  polyline           |                    v
+----------+----------+        +-----------------------+
           |                   |  Custom overlay layer |
           +-----------------> |  (drag / rotate /     |
                               |  uniform scale)       |
                               +-----------+-----------+
                                           |
                                           v   (debounced on transform-end)
                               +-----------------------+
                               |  Project polyline     |
                               |  pixels -> lat/lng    |
                               |  (affine)             |
                               +-----------+-----------+
                                           |
                                           v
                               +-----------------------+    +-----------------------+
                               |  HMM matcher          |<---|  Road graph           |
                               |  (Viterbi over road   |    |  (built from PMTiles  |
                               |  candidates; custom   |    |  in Web Worker;       |
                               |  cost = emission +    |    |  cached in IndexedDB) |
                               |  shape-preserve +     |    +-----------------------+
                               |  runnability)         |
                               +-----------+-----------+
                                           |
                                           v
                               +-----------------------+
                               |  Render route + show  |
                               |  live distance + gap, |
                               |  enable GPX export    |
                               +-----------------------+
```

## Key design decisions

- **Image type assumption (v1):** clean silhouettes / high-contrast drawings (logos, hearts, letters, animals). Photos are out of scope until we add OpenCV.js.
- **Edge detection:** canvas-based threshold + contour tracing, simplified with Ramer-Douglas-Peucker to ~30-100 waypoints. No heavy deps.
- **Why own the matcher.** Hosted matching APIs (Mapbox, Stadia, GraphHopper) optimize for "noisy GPS from a real trajectory" — an assumption that doesn't apply to Pictomap's input. Owning the matcher lets us tune the cost function for our case: drop the trajectory-plausibility prior, add a shape-preservation term, hard-block unrunnable roads, re-match live as the user drags with no rate limit. This is the product differentiator, not just a backend choice.
- **HMM matching (Newson & Krumm 2009).** State = candidate road segments near each input point (~10 per point). Emission probability = Gaussian on point-to-segment distance. Transition probability = combination of (a) classic route-distance vs. great-circle term, (b) shape-preservation term (local curvature / heading alignment between input and matched route), (c) runnability penalty (motorway = ∞, unpaved/unlit = soft penalty). Viterbi finds best sequence.
- **Road graph from vector tiles.** PMTiles at z14+ contain full road geometry. Stitch segments across tile boundaries with epsilon endpoint matching, identify junctions by shared coordinates, filter by `highway` tag. Built in a Web Worker, cached in IndexedDB keyed by tile coords.
- **Bounded matchable area.** v1 builds the graph for a ~5km box around the user's location. Panning beyond triggers a background re-fetch / re-build. Caps memory and first-load time.
- **Overlay transform: translation + rotation + uniform scale only.** Keeps the pixel→lat/lng transform affine AND simplifies the custom overlay layer's implementation. No perspective distortion.
- **Closed shapes are returned open.** HMM matching has no "close the loop" constraint. For closed inputs (hearts, letters like O), v1 displays the route open and shows the gap distance; user runs the connector freeform. Synthetic loop-closing is a v2 problem.
- **Persistence is local-only.** No backend, no accounts. Route state in localStorage; tile/graph cache in IndexedDB.
- **Geolocation requires HTTPS.** Vite dev server must run with `--https` (self-signed) for `navigator.geolocation`.

## Tile data

We serve a single PMTiles archive from S3. One-time setup per region:

1. Download OSM extract (Geofabrik) for the target region
2. Run `planetiler` with a minimal road-focused schema (highway classes for the matcher + a basemap style)
3. Output `pictomap-<region>.pmtiles` → upload to S3 (CloudFront in front, long TTL since URL is versioned)
4. MapLibre fetches basemap tiles + matcher fetches road geometry from the same archive via HTTP range requests

For v1, ship one metro area. Multi-region is a v2 deployment concern.

## Tasks

### 0. Pipeline spike (2-week GO/NO-GO)
**Before any product UI.** Prove the routing infrastructure works end-to-end on a toy case.

**Week 1 — graph extraction:**
- Build a Protomaps PMTiles archive for one metro area (planetiler from Geofabrik OSM extract — or start from the public Protomaps build if its schema is sufficient)
- Web Worker that fetches tiles in a bounding box, parses MVT, extracts road geometries
- Stitch segments across tile boundaries; identify junctions; build adjacency list
- Debug viewer: draw the extracted graph (nodes as dots, edges as lines) overlaid on MapLibre

**Week 2 — routing:**
- Implement Dijkstra (or A* with great-circle heuristic) on the extracted graph
- UI: click point A, click point B, render shortest path between them
- Verify on 10+ test cases across different neighborhood types (urban grid, suburb, river crossings, parks)

**Success criteria:**
- Graph extraction completes for a 5km box in <5s on a typical laptop
- Dijkstra returns sensible paths for all 10 test cases (no obvious gaps, dead-ends, or wrong-side-of-the-river bugs)
- Memory footprint <100MB for a 5km box

**GO:** continue to Tasks 1-8 with the matcher as a known-shape engineering problem
**NO-GO:** fall back to a hosted matcher (Stadia / Mapbox), revisit `tasks.md`

### 1. Scaffold Svelte + Vite + TS project
Initialize in current directory. Configure `vite.config.ts` (HTTPS dev flag, Web Worker support), `tsconfig.json`, `svelte.config.js`, `.gitignore`, `.env.example` (`VITE_PMTILES_URL`, `VITE_SENTRY_DSN`).

### 2. Install dependencies
- `maplibre-gl`
- `pmtiles` (Protomaps client)
- `@protomaps/basemaps` (style)
- `@sentry/svelte`
- Small RDP util (`simplify-js` or inline)
- No Leaflet, no Mapbox SDK

### 3. Map view + geolocation
- Full-viewport MapLibre map with PMTiles basemap
- Request `navigator.geolocation` on load; center on user with fallback; re-center button
- Document HTTPS dev-server requirement in README

### 4. Image upload + contour extraction
- File picker (drag-and-drop + click)
- **Validate image dimensions:** reject or downscale anything over ~2000px on long edge
- Load to offscreen canvas; threshold to binary (configurable, default favors dark-on-light)
- Trace outline (Moore-neighbor or marching squares)
- Simplify with RDP to ~30-100 points
- **Threshold preview UI:** traced contour overlaid on source image with live slider
- Output: array of `{x, y}` in pixel space

### 5. Custom draggable/rotatable image overlay
MapLibre doesn't ship a `DistortableImage` equivalent — we build it.

- Custom layer rendering the image (WebGL via MapLibre's custom layer API, or a positioned `<canvas>` over the map keyed to a lat/lng + rotation + scale)
- Drag handles: translate (center), rotate (one handle), uniform scale (corner handle)
- **No perspective handles.** Translation + rotation + uniform scale only.
- Initial position at user location; default scale targeting ~5K perimeter
- **Anchor-at-point affordance:** pin one point of the shape to a chosen lat/lng (e.g. front door); subsequent rotate/scale operations preserve the anchor
- Image stays visible (semi-transparent) after route resolves

### 6. Road graph + HMM matcher (core product work)
The biggest task. Broken into sub-milestones.

**6a — Road graph service:**
- Web Worker fetches PMTiles, extracts roads, builds graph for a bounding box around the user
- Cache built graph chunks in IndexedDB, keyed by tile coords
- Re-fetch on pan beyond loaded box (background, debounced)
- API: `getCandidatesNear(latlng, radius)`, `shortestPath(nodeA, nodeB, maxDistance)`, `getRoadClass(edgeId)`

**6b — Affine projection:**
- Read overlay state (lat/lng + rotation + scale); compute affine transform
- Project each contour pixel → lat/lng

**6c — HMM matcher:**
- For each projected point, fetch top ~10 candidate road segments within ~30m
- Emission probability: Gaussian on point-to-segment distance
- Transition probability:
  - Classic term: `|route_distance - great_circle_distance|`
  - Shape-preservation term: angular difference between input-segment heading and route-segment heading
  - Runnability: motorway = -∞; unpaved/private = soft penalty
- Viterbi over candidate lattice
- Output: continuous polyline along matched road segments

**6d — Live re-match:**
- Debounce overlay transform-end (~300ms), trigger re-match in Web Worker
- Show live route length (km + mi) prominently
- For closed inputs, show start↔end gap distance

**6e — Tuning pass:**
- Test harness: 10 hand-picked input shapes × 3 geographies (urban grid, suburb, mixed-with-park)
- Iterate on cost-function weights until ≥6 of the 30 (shape, geography) pairs produce a recognizable route
- This is where owning the matcher pays off — it's the difference between "snap-to-roads demo" and "tool runners actually want"

### 7. GPX export + persistence
- "Download GPX" serializes route to GPX 1.1 `<trk>` and triggers download
- localStorage: current image (data URL, capped ~2MB — downscale before persist if larger), overlay state, matched route. Debounced writes; warn on quota-exceeded
- IndexedDB: tile + graph cache (built in Task 6a)
- "New route" clears localStorage but preserves the tile cache

### 8. UI polish
- Floating control panel (upload, recenter, download, clear)
- Image translucent, route bold/colored
- Loading states: tile fetch, graph build, matching in flight
- Error states: geolocation denied, no contour found, image too large, matcher failed (no candidates, disconnected graph), tile fetch failed
- Live route length always visible

## Sequencing

This is a multi-month effort, not weeks. Task 0 and Task 6 are the load-bearing engineering work; everything else is plumbing.

- **Weeks 1-2:** Task 0 (pipeline spike). **GO/NO-GO.**
- **Weeks 3-4:** Tasks 1-3 (scaffold + basemap + geolocation); Task 4 in parallel (no map dependency)
- **Weeks 5-7:** Task 5 (custom overlay layer) + Task 6a (road graph service) in parallel
- **Weeks 8-10:** Tasks 6b-d (projection + HMM + live re-match)
- **Week 11:** Task 6e (tuning pass)
- **Week 12:** Tasks 7-8 (export + polish)

Realistic ship target: ~3 months from start, assuming focused work and no major architecture rework after the spike.

## Deployment

After v1 works locally:
1. `npm run build` → `dist/`
2. Build PMTiles archive once per region: planetiler + Geofabrik OSM extract → `pictomap-<region>.pmtiles` → S3
3. `aws s3 sync dist/ s3://<bucket> --delete`
4. CloudFront in front for HTTPS + custom domain + caching (long TTL on the versioned PMTiles URL)
5. Sentry DSN restricted to production origin

## Out of scope for v1

- User accounts / cloud sync
- Photo input (would need OpenCV.js)
- Multi-region tile coverage (one metro area only)
- Multiple routes saved at once
- Mobile-specific UX beyond responsive layout
- Elevation-aware routing
- Loop-closing for closed shapes (display open with gap shown)
- Freeform perspective distortion of overlay
- Manual waypoint editing post-snap
- Manual road graph edits ("force route through this footpath")
- Live OSM data refresh (PMTiles archive rebuilt manually as needed)
