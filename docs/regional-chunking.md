# Regional chunking + multi-chunk tile reads

**Status:** Phases 0–1 shipped (build side) + Phase 2 manifest field; client Phases 2 (selection helper)–4 pending · **Last updated:** 2026-06-01

This doc describes splitting the big continental tile regions (North America,
Europe, …) into smaller **chunks**, and teaching the webapp to read **more than
one chunk at runtime** so crossing a chunk boundary no longer forces a page
refresh. It covers *why* we need it, *how* to build it (phased, so it can be
picked up by someone who didn't write this), and *what it unlocks* for the two
tile build scripts (`tiles/build-display.sh`, `tiles/build-routing.sh`).

Related: [`migration.md`](migration.md) (tile hosting / cost), the **Tiles
architecture** section of [`../CLAUDE.md`](../CLAUDE.md), and
[`tasks.md`](tasks.md).

---

## TL;DR

- Today every region is a whole continent. The app picks **one** region at boot
  and binds the basemap source, `maxBounds`, and the graph worker to that one
  archive. Crossing a region = page refresh. That's fine when seams sit over
  oceans, which they do today.
- Two pressures push us to chunk continents into smaller pieces: CloudFront's
  **30 GB per-object cap** (forces splitting big display regions) and
  **routing build time / credential expiry** (NA/EU `tilemaker` runs blow past
  the 1 h OIDC token — see the header of `deploy-routing-tiles.yml`).
- Chunking moves seams onto **land**, where people actually run — so the
  once-a-decade refresh becomes a frequent, jarring reload, and a graph built
  near a seam gets clipped.
- Fix: build each chunk with a small **overlap**, give each chunk an
  **ownership bbox** (a partition, for selection) and an **extent bbox** (the
  overlapped coverage). At runtime, route each tile `(z,x,y)` to the chunk that
  **owns** it and read transparently across archives. The graph's existing
  cross-tile `stitch` already joins the pieces; the basemap renders identical
  tiles from either archive, so there's no visible seam.
- This is **not** a rewrite. The single load-bearing new primitive is one
  function — `ownerChunk(z, x, y) → chunkId` — shared by the basemap protocol
  handler and the graph worker.

---

## Why

### 1. The 30 GB cap forces splitting display regions

`tiles/build-display.sh` hard-fails any region whose PMTiles exceeds **30 GB**
(CloudFront's per-object response cap). The dense continents are at or near
that ceiling, so North America / Europe have to be split regardless of anything
in this doc.

### 2. Routing builds outgrow a single job

`tiles/build-routing.sh` runs `tilemaker` over a whole continent. Even after
the `osmium tags-filter` highways pre-pass, NA/EU are the slowest regions, and
they already exceeded the **1 h OIDC credential lifetime**, failing the
end-of-build `aws s3 cp` with `ExpiredToken`. We bumped the session to 4 h as a
stopgap; chunking is the structural fix (smaller jobs, more parallelism).

### 3. Chunking moves seams onto land — and that's where the refresh hurts

The app's whole region model assumes **coarse** regions:

- `selectRegion` (`src/lib/tiles/manifest.ts:67`) picks the region whose bbox
  contains the user, first match wins.
- The basemap is a single vector source bound to that region's PMTiles
  (`src/lib/map/style.ts:15-17`).
- `maxBounds` is locked to the region bbox (`src/lib/map/Map.svelte:476`).
- The graph worker holds **one** `PMTiles` client (`src/lib/graph/worker.ts:51`)
  and reads every tile from it.

Crossing into another region re-picks all of the above, which today is done by
reloading the page. With continental regions a "crossing" means physically
moving across an ocean or a continent edge — effectively never — so the reload
is free. **Chunking inverts that:** seams now cut through populated land, so:

- **Frequent jarring reloads.** Any user near a seam, or who travels across one,
  hits the `maxBounds` wall + "out of region" banner
  (`src/lib/map/Map.svelte:149,588`) that is essentially dead code today.
- **Clipped graphs at seams.** The worker builds the graph for
  `needed = viewport + GRAPH_BUFFER_M` (1 km, `src/lib/map/Map.svelte:70,377`),
  reading from one archive. A user within ~`needed` of a seam gets a graph
  truncated at the chunk edge: roads dead-end and matched routes can't cross.

So chunking is desirable for builds but degrades the UX **unless** the client
can read across chunks at a seam. That's what this design adds.

---

## Background: how the client uses regions today

Read this before the design; the whole plan is shaped by it.

- **One manifest pick drives everything.** `selectRegion` chooses from the
  **display** manifest by bbox-contains. Routing is **not** selected
  independently — `resolveGraphSource` looks up the *same id* in the routing
  manifest (`src/lib/map/Map.svelte:439`, `findRegionById`). So basemap and
  graph agree **for free**, as long as both manifests carry the same ids/bboxes.
  This is why both pipelines must build from the same `tiles/regions.json`.
- **Single-archive bindings.** Basemap source (`style.ts`), `maxBounds`, and the
  worker's `PMTiles` client are each wired once at boot and never rebound.
- **The graph builder is already source-agnostic.** `worker.ts` `stitch` snaps
  vertices within ~2 m to a canonical node and splits linestrings at shared
  nodes, joining adjacent **tiles** into one graph. It does not care which file
  a tile came from — joining across **archives** is the identical operation,
  because a node on a seam comes from the same OSM coordinate in both chunks and
  de-quantizes to the same point, well within the 2 m snap.
- **The matcher is per-build, not per-region.** The local-meter frame
  (`src/lib/graph/projection.ts`) is anchored at the `needed` bbox center each
  build; nothing about it is tied to a chunk.

The two facts in bold are why this is tractable: the graph half reuses existing
machinery, and the basemap half is plumbing (no geometry to join).

---

## Design

### Terminology

| Term | Meaning |
|------|---------|
| **chunk** | A sub-region of a continent. Replaces today's continental region as the unit in `tiles/regions.json`. Has a stable `id`. |
| **ownership bbox** | A chunk's authoritative footprint. Ownership bboxes **partition** space — no overlaps. Used for region *selection* and for deciding which chunk *owns* a tile. This is the existing `bbox` field. |
| **extent bbox** | The geographic span a chunk's archive actually covers = ownership bbox **+ overlap margin**. Used for `maxBounds` and to guarantee a chunk's archive contains every tile it owns. New `extentBbox` field. |
| **owner of a tile** | The single chunk whose *ownership* bbox contains the tile's center. The function `ownerChunk(z, x, y) → chunkId`. |

### The core idea

Because ownership bboxes partition space, **every tile has exactly one owner**.
Because each chunk's extent = ownership + overlap, **a chunk's archive contains
every tile it owns, complete**, even seam tiles whose cells spill past the
ownership edge. So:

> To read across chunks, route each tile `(z,x,y)` to its owner's archive and
> fetch it there. No tile is ever fetched from two archives (no double-counting),
> and every fetched tile is complete (no clipped seams).

`ownerChunk` is the one new primitive, shared by the basemap protocol handler
and the graph worker. Everything else is wiring.

### How big does the overlap margin need to be?

It depends on which runtime approach ships (see *Alternatives*):

- **Full multi-chunk reads (this design).** The fetch fans out *per tile*, so no
  single archive has to cover the whole `needed` bbox. A chunk only needs to
  contain the tiles **it owns**. A tile owned by chunk A has its center in A's
  ownership bbox and extends at most half a tile beyond that center, so:

  > **extent margin ≥ ½ tile** at the publish zoom (~2.5 km at z13).

  Round up to a whole tile (~5 km) for safety. Cheap — a one-tile apron.
- **Overlap-only, single-archive (the cheaper alternative, no multi-read).** One
  archive must cover an entire seam-straddling build, so the margin must exceed
  the graph's reach from the seam: viewport at the lowest graph zoom + 1 km
  `GRAPH_BUFFER_M`. Larger, and still can't route *across* the far overlap edge.

### Manifest schema change

`ManifestRegion` (`src/lib/tiles/manifest.ts:11`) gains one optional field:

```ts
export interface ManifestRegion {
  id: string;
  name: string;
  /** Ownership bbox — the partition. Selection + tile ownership. */
  bbox: [number, number, number, number];
  /** Extent bbox — ownership + overlap. Coverage + maxBounds.
   *  Absent ⇒ falls back to `bbox` (old single-region behavior). */
  extentBbox?: [number, number, number, number];
  filename: string;
  sizeBytes: number;
}
```

`extentBbox` is **optional** on purpose: an old manifest (or an un-chunked
region) without it behaves exactly as today (`extentBbox ?? bbox`), so the
client and the pipelines can roll out independently.

### What changes, by surface

**Selection** (`manifest.ts`). `selectRegion` keeps using `bbox` (ownership) —
unchanged, and correct because ownership bboxes partition. The only new helper
is *the set of chunks a viewport touches* (a bbox-overlap loop over a few dozen
entries) so the basemap/worker know which archives to keep open. Trivial.

**Graph worker** (`src/lib/graph/worker.ts`, `service.ts`). Instead of one URL:

- `init` receives a **chunk registry** — `{ id, url, ownershipBbox, extentBbox }[]`
  — not a single `pmtilesUrl`. `GraphService`'s constructor signature changes to
  match (`src/lib/graph/service.ts:22`).
- Keep a lazily-populated `Map<chunkId, PMTiles>`; open a chunk's archive on
  first use.
- In the tile loop (`buildGraph` → `fetchTileRoads`, `worker.ts:153,198`),
  resolve each `(z,x,y)` via `ownerChunk` and read from that owner's client.
- `TileCache` (keyed by `pmtilesUrl` today, `worker.ts:53`) becomes keyed per
  archive (or by chunkId).
- `stitch`, `pruneSmallComponents`, the matcher, and the local frame are
  **unchanged**.

**Basemap** (`src/lib/map/style.ts`, `protocol.ts`, `Map.svelte`). Register a
**fan-out protocol** alongside `pmtiles://`:

- A handler for, say, `pictomap://{z}/{x}/{y}` that owns the same
  `Map<chunkId, PMTiles>`, calls `ownerChunk(z,x,y)`, and returns
  `archive.getZxy(...)` (returning empty for tiles outside every chunk → renders
  as blank, no error). This is a thin wrapper over what `pmtiles`'
  `Protocol.tile` already does.
- The style keeps a **single** source named `protomaps` (so
  `layers('protomaps', …)` in `style.ts:22` is unchanged) whose `url` is the
  `pictomap://…` template instead of one archive.
- `maxBounds` is set to the **union** of loaded chunk extent bboxes (continent),
  or dropped entirely in favor of lazy-opening chunk archives as the viewport
  approaches them — which is the bigger UX win (continent-wide free pan).

**What does NOT change:** `stitch`, `pruneSmallComponents`, the matcher cost
function, the local-meter frame, the debounce/generation-counter snap
orchestration in `App.svelte`, and the display↔routing id-pairing.

### Where to cut the seams

Ownership-bbox seams should fall where **few people run**, to minimize how often
a build straddles a seam and how often a user sits on one: large water, mountain
spines (Rockies, Appalachians, Alps), sparse plains/desert, and thinly populated
national borders. The chunking is also a **cost knob** — per the
[S3 lifecycle note](migration.md), *uploads* drive cost, so more chunks = more
weekly `PutObject`s. Use the **coarsest** chunking that clears the 30 GB display
cap and the routing build-time target, not the finest.

---

## Implementation plan (phased)

Each phase is independently shippable and leaves the app working.

> **Status (2026-06-01).** Phases 0 and 1 have shipped on the build side, plus
> the Phase 2 manifest field:
> - **Phase 0 ✅** — `na` split into `na-w`/`na-c`/`na-e` (ownership seams at
>   103°W and 82°W) and `eu` into `eu-w`/`eu-e` (seam at 16°E) in
>   `tiles/regions.json`, with matching `tiles/osm-sources.json` entries. Each
>   chunk currently re-reads its whole continent extract and lets `--bbox` clip
>   (same pattern as `me`/`sas` on Asia); the download-once/fan-out restructure
>   under *What it unlocks* is still future work. The 16°E / 82°W seams cut
>   through populated land — pick better ones empirically before relying on the
>   refresh-free UX (Phases 3–4).
> - **Phase 1 ✅** — both build scripts expand each region's ownership bbox by
>   `OVERLAP_DEG` (0.05°, ≈1 tile; in `tiles/lib.sh`) to an extent bbox, extract
>   over it, and emit `extentBbox` into the fragment (`write_fragment` in
>   `tiles/lib.sh`); `tiles/assemble-manifest.sh` passes it through unchanged.
> - **Phase 2 (partial) ✅** — `extentBbox?` added to `ManifestRegion`. The
>   "chunks touching a viewport" helper and all of Phases 3–4 are **not** done,
>   so the client still selects one chunk and a seam crossing needs a refresh.

### Phase 0 — Chunk definitions

- Split the NA/EU entries in `tiles/regions.json` into chunks with stable ids
  (e.g. `na-w`, `na-c`, `na-e`) and **non-overlapping** ownership bboxes that
  tile the old continent exactly. Add the matching source extract(s) per chunk
  in `tiles/osm-sources.json` (Geofabrik sub-extracts where they exist, e.g.
  `us-west`, `us-midwest`, `canada`).
- Pick seams per *Where to cut the seams* above.

### Phase 1 — Build scripts emit overlap + both bboxes

- **`tiles/build-routing.sh`**: expand each chunk's `tilemaker --bbox` by the
  overlap margin (≥ ½ tile) to produce the **extent**; emit both `bbox`
  (ownership, from `regions.json`) and `extentBbox` into the manifest fragment.
- **`tiles/build-display.sh`**: same regional rollout — `pmtiles extract --bbox` over
  the extent bbox; emit both bboxes. (Display tiles are copied whole-cell from
  the planet build, so a tile is byte-identical whichever chunk extracts it →
  no visible seam.)
- `tiles/assemble-manifest.sh`: pass `extentBbox` through.
- Ships safely **before any client change** — the optional `extentBbox` is
  ignored by the current client, which still selects one chunk and refreshes to
  cross. (Now with smaller, faster, under-cap builds.)

### Phase 2 — Manifest schema + selection

- Add `extentBbox?` to `ManifestRegion`; add the "chunks touching a viewport"
  helper. `selectRegion` unchanged. No behavior change yet.

### Phase 3 — Graph multi-archive reads

- Implement `ownerChunk(z, x, y)`.
- Change `GraphService`/`worker` `init` to take the chunk registry; lazy
  `Map<chunkId, PMTiles>`; route tile reads through `ownerChunk`; per-archive
  `TileCache`.
- **Now a graph build straddling a seam is complete and connected.** Routes can
  cross seams. `maxBounds` can already be widened to the union here.

### Phase 4 — Basemap fan-out + free pan

- Register the `pictomap://` fan-out protocol; point the `protomaps` source at
  it; lazy-open chunk archives; set `maxBounds` to the union (or drop it).
- **Now panning across a seam needs no refresh.** The "out of region" banner
  becomes "outside all chunks" (genuinely off-map).

> Phases 3 and 4 are independent — either can ship first. Shipping only 3 gives
> seamless *routing* across seams while basemap pan still walls; only 4 gives
> seamless *pan* while a graph near a seam still clips. Ship both for the full
> experience.

---

## What it unlocks: better build scripts

Multi-chunk reads make the build pipelines strictly better, because the client
no longer cares how the planet is sliced — only that every tile has one owner.

### `tiles/build-routing.sh`

The `osmium tags-filter` pre-pass already shrinks the filtered continent to a
small highways-only PBF. That makes the natural next step cheap — **decouple the
source download from the output region**:

1. **Per source/continent (download once):** download → `osmium tags-filter`
   → publish the small `*-roads.pbf` as a CI artifact (hundreds of MB — small
   enough to hand between jobs, which the raw 16–28 GB continent never was).
2. **Per chunk (fan out):** pull that artifact → `tilemaker --bbox <extent>` →
   upload the chunk's PMTiles.

This single restructure delivers three wins at once:

- **Dedupe redundant downloads.** `me`, `sas`, `eas`, `sea-oc` currently each
  download the full ~13 GB `asia-latest.osm.pbf`. Phase 1 downloads+filters Asia
  **once** and fans out to all four. (See `tiles/osm-sources.json`.)
- **Chunk NA/EU.** Splitting a continent for the 30 GB cap or build-time becomes
  "add another `--bbox`", not "another full download". Each chunk is small,
  fast, well under the cap, and parallel across runners.
- **Kill the credential-expiry class of failure.** Per-chunk `tilemaker` jobs
  finish well inside any session lifetime; the 4 h stopgap in
  `deploy-routing-tiles.yml` stops being load-bearing.

### `tiles/build-display.sh`

The display pipeline follows the **same** `tiles/regions.json` chunking (it must,
or the display↔routing id-pairing breaks — see *Background*). Benefits:

- Big regions drop under the **30 GB cap** by construction instead of by manual
  bbox surgery when a build trips the hard-fail.
- The display and routing manifests stay structurally identical (same ids, same
  ownership bboxes, both carrying `extentBbox`), so the client's single
  selection + id-pairing keeps working unchanged.

---

## Alternatives considered

| Approach | Cross-seam routes | Seamless pan | Client cost | When it's enough |
|----------|-------------------|--------------|-------------|------------------|
| **Status quo (refresh)** | no | no (reload) | none | Seams over water only — i.e. don't chunk. |
| **Overlap-only, single archive** | no | within overlap | manifest field + `maxBounds` reads extent | Seams cross land but routes never span them; accept a (large) overlap. |
| **Seamless re-init** | no | yes (no reload) | teardown/rebind on crossing | Want to kill the reload without multi-archive reads. |
| **Full multi-chunk (this doc)** | **yes** | **yes** | `ownerChunk` + worker registry + fan-out protocol | Want both, and/or continent-wide free pan. |

The honest middle path is **overlap-only + seamless re-init**: it removes the
jarring reload and covers seams, for a fraction of the cost, and is right if a
running route that genuinely *straddles* a chunk seam is rare (likely, given
chunks are state-sized and inputs are few-km local shapes). Full multi-chunk is
warranted only if cross-seam routes or true infinite pan are real requirements.
This doc specs the full version because the incremental cost over overlap-only is
small once `ownerChunk` exists, and Phases 1–2 are shared by every option.

---

## Open questions / risks

- **`tilemaker --bbox` clip semantics.** Whether `--bbox` limits the output tile
  *range* or also clips input geometry at the edge changes how complete a raw
  (non-overlapped) seam tile is. The overlap margin in Phase 1 sidesteps this by
  construction — **build the overlap regardless** rather than depend on the
  semantics. Verify empirically on one seam before trusting it.
- **Owner rule at tile-grid vs bbox edges.** If an ownership bbox edge doesn't
  fall on a tile boundary, a tile's center still resolves to exactly one owner —
  but confirm `ownerChunk` uses the tile **center** (not a corner) so it's
  unambiguous, and that the extent margin (≥ ½ tile) guarantees that owner's
  archive holds the whole cell.
- **Number of open archives.** Lazy-opening many `PMTiles` clients during a long
  pan: cap with an LRU if memory becomes a concern (each client is light, but
  bound it).
- **Granularity vs upload cost.** More chunks = more weekly uploads (the cost
  driver). Choose the coarsest chunking that meets the cap + build-time targets.
- **`maxBounds` union vs lazy-load.** Decide whether to lock `maxBounds` to the
  union of loaded extents or drop it and lazy-load on approach. The latter is the
  better UX but needs a "no tiles here yet" affordance while archives open.
