/// <reference lib="webworker" />

import { PMTiles } from 'pmtiles';
import { VectorTile } from '@mapbox/vector-tile';
import Pbf from 'pbf';
import { classifyRoad, isRunnable } from './highway';
import { Matcher } from './matcher';
import { TileCache } from './tile-cache';
import {
  GRAPH_ZOOM,
  clipPolylineToBBox,
  polylineLength,
  tileBounds,
  tilesCoveringBBox,
} from './tile-math';
import type {
  BBox,
  GraphEdge,
  GraphNode,
  RoadClass,
  RoadGraph,
  WorkerRequest,
  WorkerResponse,
} from './types';

/**
 * Road graph builder worker.
 *
 * Lifecycle:
 *   1. `init` — receive PMTiles URL, instantiate PMTiles client.
 *   2. `buildGraph` — fetch all z14 tiles covering bbox, decode MVT,
 *      classify the `roads` layer, stitch endpoints into nodes, reply
 *      with a flat RoadGraph.
 */

let pmtiles: PMTiles | null = null;
let tileCache: TileCache | null = null;
let matcher: Matcher | null = null;

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;
  try {
    if (req.type === 'init') {
      pmtiles = new PMTiles(req.pmtilesUrl);
      tileCache = new TileCache(req.pmtilesUrl);
      // Fire-and-forget: drop entries from older PMTiles URLs so the
      // cache doesn't grow unbounded as the daily build rotates.
      tileCache.evictOtherPrefixes();
      reply({ type: 'ready', reqId: req.reqId });
      return;
    }

    if (req.type === 'buildGraph') {
      if (!pmtiles) throw new Error('Worker not initialized — send `init` first');
      const graph = await buildGraph(pmtiles, req.bbox);
      // Keep the latest graph live so the matcher can query it without
      // re-shipping ~20k edges from the main thread on every snap.
      matcher = new Matcher(graph);
      reply({ type: 'graph', reqId: req.reqId, graph });
      return;
    }

    if (req.type === 'match') {
      if (!matcher) throw new Error('No graph built yet — call `buildGraph` first');
      const result = matcher.match(req.contour);
      reply({ type: 'match', reqId: req.reqId, result });
      return;
    }
  } catch (err) {
    reply({
      type: 'error',
      reqId: req.reqId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
};

function reply(res: WorkerResponse): void {
  ctx.postMessage(res);
}

// --- Graph build ---------------------------------------------------------

interface RawSegment {
  coords: [number, number][];
  klass: RoadClass;
  /**
   * Vertical separation level, OSM-style. 0 = ground, +1 = bridge,
   * −1 = tunnel. Used by `stitch` so that a bridge crossing a street at
   * the same lng/lat does not get its interior vertices merged with the
   * street below. Endpoints always merge at level 0 so bridge/tunnel
   * features stay connected to their approach roads.
   */
  level: number;
}

/** Components with fewer edges than this get dropped at graph build. */
const MIN_COMPONENT_EDGES = 20;

/**
 * Max concurrent PMTiles range requests. At low zoom the buffered
 * viewport can demand hundreds of tiles; firing them all in parallel
 * would spike the host. 16 keeps the pipe saturated while staying
 * well under typical CloudFront/S3 origin limits.
 */
const TILE_FETCH_CONCURRENCY = 16;

async function buildGraph(p: PMTiles, bbox: BBox): Promise<RoadGraph> {
  const t0 = performance.now();
  const range = tilesCoveringBBox(bbox, GRAPH_ZOOM);
  const stats = { hits: 0, misses: 0 };

  const tileCoords: { x: number; y: number }[] = [];
  for (let x = range.minX; x <= range.maxX; x++) {
    for (let y = range.minY; y <= range.maxY; y++) {
      tileCoords.push({ x, y });
    }
  }

  const segments: RawSegment[] = [];
  /** Cache misses to flush in one IDB transaction after the fetch pass. */
  const cacheWrites: { z: number; x: number; y: number; segs: RawSegment[] }[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const i = next++;
      if (i >= tileCoords.length) return;
      const { x, y } = tileCoords[i];
      const { segs, fromCache } = await fetchTileRoads(p, range.z, x, y, tileCache, stats);
      for (const s of segs) segments.push(s);
      if (!fromCache) cacheWrites.push({ z: range.z, x, y, segs });
    }
  };
  const pool = Array.from(
    { length: Math.min(TILE_FETCH_CONCURRENCY, tileCoords.length) },
    () => worker(),
  );
  await Promise.all(pool);

  // Flush all cache misses in a single readwrite transaction. Fire-
  // and-forget — the graph build doesn't wait for IndexedDB to commit.
  if (tileCache && cacheWrites.length > 0) {
    void tileCache.putBatch(cacheWrites);
  }

  console.log(
    `[graph] tile cache: ${stats.hits} hits / ${stats.misses} misses in ${tileCoords.length} tiles`,
  );

  const stitched = stitch(segments, (bbox.south + bbox.north) / 2);
  const pruned = pruneSmallComponents(stitched, MIN_COMPONENT_EDGES);

  return {
    nodes: pruned.nodes,
    edges: pruned.edges,
    bbox,
    buildMs: Math.round(performance.now() - t0),
    tileCount: tileCoords.length,
  };
}

async function fetchTileRoads(
  p: PMTiles,
  z: number,
  x: number,
  y: number,
  cache: TileCache | null,
  stats: { hits: number; misses: number },
): Promise<{ segs: RawSegment[]; fromCache: boolean }> {
  if (cache) {
    const cached = await cache.get(z, x, y);
    if (cached) {
      stats.hits++;
      return { segs: cached, fromCache: true };
    }
  }
  stats.misses++;

  const res = await p.getZxy(z, x, y);
  if (!res) {
    // Empty result is cached too — saves a 404 round-trip next time.
    return { segs: [], fromCache: false };
  }

  const tile = new VectorTile(new Pbf(new Uint8Array(res.data)));
  const layer = tile.layers.roads;
  if (!layer) return { segs: [], fromCache: false };

  // Per-tile clip rectangle. MVT features include geometry inside a
  // small buffer past the tile boundary; clipping back to the actual
  // tile bounds means adjacent tiles' clip vertices coincide on the
  // shared edge, which is what lets sparsely-vertexed roads stitch
  // back together across tile boundaries.
  const bounds = tileBounds(x, y, z);

  const segs: RawSegment[] = [];
  for (let i = 0; i < layer.length; i++) {
    const feature = layer.feature(i);
    // LineString = 2; ignore points/polygons.
    if (feature.type !== 2) continue;

    const klass = classifyRoad(feature.properties);
    if (!isRunnable(klass)) continue;

    const level = featureLevel(feature.properties);

    // toGeoJSON projects tile-local coords -> lng/lat. The Feature's
    // geometry may be a single LineString or a MultiLineString.
    const gj = feature.toGeoJSON(x, y, z);
    const geom = gj.geometry;
    const lines: [number, number][][] =
      geom.type === 'LineString'
        ? [geom.coordinates as [number, number][]]
        : geom.type === 'MultiLineString'
          ? (geom.coordinates as [number, number][][])
          : [];

    for (const line of lines) {
      for (const piece of clipPolylineToBBox(line, bounds)) {
        if (piece.length >= 2) segs.push({ coords: piece, klass, level });
      }
    }
  }

  return { segs, fromCache: false };
}

/**
 * OSM-style vertical level for a road feature. Reads from `layer`
 * (numeric) when present; otherwise infers from `is_bridge`/`bridge`
 * (treated as +1) and `is_tunnel`/`tunnel` (−1). Defaults to 0.
 *
 * Protomaps schemas don't all expose these properties, so missing-data
 * resolves to the ground-level 0 — i.e. the previous behavior.
 */
function featureLevel(props: Record<string, string | number | boolean>): number {
  const raw = props.layer ?? props.level;
  if (raw !== undefined && raw !== null) {
    const n = Number(raw);
    if (Number.isFinite(n) && n !== 0) return n;
  }
  if (props.is_bridge === true || props.bridge === true || props.bridge === 'yes') return 1;
  if (props.is_tunnel === true || props.tunnel === true || props.tunnel === 'yes') return -1;
  return 0;
}

// --- Stitching -----------------------------------------------------------

/**
 * Build node + edge lists from raw per-tile linestrings.
 *
 * Three passes:
 *   1. Snap every vertex to a canonical node within ε ≈ 2 m, using a
 *      grid index. ε absorbs OSM's habit of mapping sidewalks and
 *      crosswalks with endpoints offset a meter or two from the curb,
 *      plus any float-projection jitter at tile boundaries.
 *   2. Count how many linestring vertices land on each canonical node.
 *   3. Walk each linestring and break off an edge whenever we hit a
 *      shared canonical node (count ≥ 2) or the linestring's endpoint.
 *      Without step 3, a long road through a city would be one edge
 *      with cross-streets meeting its interior vertices — leaving the
 *      cross-streets disconnected from it in the graph.
 *
 * Grade separation: the canonical-id key includes the segment's `level`
 * (bridge/tunnel) for *interior* vertices only. Endpoints always merge
 * at level 0 so a bridge feature still connects to its at-grade
 * approach road at the abutment.
 */
function stitch(
  segments: RawSegment[],
  refLat: number,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  if (segments.length === 0) return { nodes: [], edges: [] };

  // refLat is the bbox center: viewport-driven rebuilds now span tens of
  // km at low zoom, so picking a corner vertex would bias the lng scale
  // toward one side of the graph.
  const EPS_M = 2;
  const M_PER_DEG_LAT = 111_320;
  const epsLat = EPS_M / M_PER_DEG_LAT;
  const epsLng = EPS_M / (M_PER_DEG_LAT * Math.cos((refLat * Math.PI) / 180));

  // Grid cell ≈ ε. To merge across cell boundaries, look up 3×3 cells.
  // Cells are also segregated by `level` so bridge-interior vertices
  // don't get matched against street-interior vertices below.
  const grid = new Map<string, number[]>(); // cellKey → canonical node ids
  const nodes: GraphNode[] = [];

  // ε² in meters² — the distance check below rescales lng/lat back to
  // meters so the two axes are directly comparable to EPS_M.
  const eps2 = EPS_M * EPS_M;

  const canonicalId = (lng: number, lat: number, level: number): number => {
    const cx = Math.floor(lng / epsLng);
    const cy = Math.floor(lat / epsLat);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const k = `${cx + dx},${cy + dy},${level}`;
        const bucket = grid.get(k);
        if (!bucket) continue;
        for (const nodeId of bucket) {
          const n = nodes[nodeId];
          const dLngM = (n.lng - lng) / epsLng * EPS_M;
          const dLatM = (n.lat - lat) / epsLat * EPS_M;
          if (dLngM * dLngM + dLatM * dLatM <= eps2) return nodeId;
        }
      }
    }
    const id = nodes.length;
    nodes.push({ id, lng, lat });
    const k = `${cx},${cy},${level}`;
    const bucket = grid.get(k);
    if (bucket) bucket.push(id);
    else grid.set(k, [id]);
    return id;
  };

  // Pass 1+2: assign every vertex to a canonical node, then count occurrences.
  // Endpoints are placed at level 0 (ground) so they connect to anything
  // they meet; interior vertices carry their feature's level so bridges
  // and tunnels stay segregated from the surface network in between.
  const vertNodeIds: number[][] = new Array(segments.length);
  for (let s = 0; s < segments.length; s++) {
    const seg = segments[s];
    const last = seg.coords.length - 1;
    const ids = new Array<number>(seg.coords.length);
    for (let i = 0; i < seg.coords.length; i++) {
      const isEndpoint = i === 0 || i === last;
      const level = isEndpoint ? 0 : seg.level;
      ids[i] = canonicalId(seg.coords[i][0], seg.coords[i][1], level);
    }
    vertNodeIds[s] = ids;
  }
  const counts = new Int32Array(nodes.length);
  for (const ids of vertNodeIds) {
    for (const id of ids) counts[id]++;
  }

  // Pass 3: split at any canonical node with count ≥ 2 (intersection)
  // or at linestring endpoints.
  const edges: GraphEdge[] = [];
  for (let s = 0; s < segments.length; s++) {
    const seg = segments[s];
    const ids = vertNodeIds[s];
    if (seg.coords.length < 2) continue;

    let chunkStart = ids[0];
    let chunk: [number, number][] = [seg.coords[0]];
    for (let i = 1; i < seg.coords.length; i++) {
      const v = seg.coords[i];
      chunk.push(v);
      const isShared = counts[ids[i]] >= 2;
      const isLast = i === seg.coords.length - 1;
      if (!(isShared || isLast)) continue;

      const chunkEnd = ids[i];
      // Two emit conditions:
      //   - normal edge: chunkStart != chunkEnd, length >= 2
      //   - self-loop edge: chunkStart == chunkEnd with >= 3 vertices,
      //     i.e. a closed standalone way (roundabout, traffic circle,
      //     parking loop) or a linestring that doubled back to a
      //     shared node. Without this, those features would be dropped.
      const isLoop = chunkStart === chunkEnd;
      if ((!isLoop && chunk.length >= 2) || (isLoop && chunk.length >= 3)) {
        const len = polylineLength(chunk);
        if (len > 0) {
          edges.push({
            id: edges.length,
            a: chunkStart,
            b: chunkEnd,
            coords: chunk,
            length: len,
            klass: seg.klass,
          });
        }
      }
      chunkStart = chunkEnd;
      chunk = [v];
    }
  }
  return { nodes, edges };
}

/**
 * Drop connected components with fewer edges than `minEdges`. OSM
 * commonly has isolated parking-lot loops, orphan alley sidewalks, and
 * single-feature paths that don't touch the main road network — these
 * become candidates the matcher can never bridge out of (bounded
 * Dijkstra reaches only ~5 nodes), so the cleanest fix is to exclude
 * them at build time.
 *
 * After pruning, nodes and edges are re-indexed densely starting at 0.
 */
function pruneSmallComponents(
  graph: { nodes: GraphNode[]; edges: GraphEdge[] },
  minEdges: number,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const { nodes, edges } = graph;
  if (edges.length === 0) return graph;

  const adj: number[][] = Array.from({ length: nodes.length }, () => []);
  for (let i = 0; i < edges.length; i++) {
    adj[edges[i].a].push(i);
    adj[edges[i].b].push(i);
  }

  // DFS each unvisited edge (queue.pop is LIFO); tag every edge in the
  // same component. Either traversal order would give the same labels.
  const edgeComp = new Int32Array(edges.length).fill(-1);
  const compSize: number[] = [];
  for (let startE = 0; startE < edges.length; startE++) {
    if (edgeComp[startE] !== -1) continue;
    const compId = compSize.length;
    let size = 0;
    const queue: number[] = [startE];
    edgeComp[startE] = compId;
    while (queue.length > 0) {
      const eId = queue.pop()!;
      size++;
      const e = edges[eId];
      for (const node of [e.a, e.b]) {
        for (const nbr of adj[node]) {
          if (edgeComp[nbr] === -1) {
            edgeComp[nbr] = compId;
            queue.push(nbr);
          }
        }
      }
    }
    compSize.push(size);
  }

  const oldNodeToNew = new Int32Array(nodes.length).fill(-1);
  const newNodes: GraphNode[] = [];
  const newEdges: GraphEdge[] = [];
  let droppedEdges = 0;
  let droppedComps = 0;
  for (let i = 0; i < compSize.length; i++) {
    if (compSize[i] < minEdges) droppedComps++;
  }
  for (let i = 0; i < edges.length; i++) {
    if (compSize[edgeComp[i]] < minEdges) {
      droppedEdges++;
      continue;
    }
    const e = edges[i];
    let a = oldNodeToNew[e.a];
    if (a < 0) {
      a = newNodes.length;
      oldNodeToNew[e.a] = a;
      newNodes.push({ id: a, lng: nodes[e.a].lng, lat: nodes[e.a].lat });
    }
    let b = oldNodeToNew[e.b];
    if (b < 0) {
      b = newNodes.length;
      oldNodeToNew[e.b] = b;
      newNodes.push({ id: b, lng: nodes[e.b].lng, lat: nodes[e.b].lat });
    }
    newEdges.push({
      id: newEdges.length,
      a,
      b,
      coords: e.coords,
      length: e.length,
      klass: e.klass,
    });
  }

  const top = [...compSize].sort((a, b) => b - a).slice(0, 5);
  console.log(
    `[graph] ${compSize.length} components (top sizes: ${top.join(', ')}); ` +
    `dropped ${droppedComps} components / ${droppedEdges} edges below ${minEdges}-edge floor`,
  );
  return { nodes: newNodes, edges: newEdges };
}
