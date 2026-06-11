/**
 * Road graph types and the worker message protocol.
 *
 * Coordinates are [lng, lat] tuples throughout — matches MapLibre + GeoJSON
 * and avoids an x/y vs lat/lng mix-up.
 */

export type RoadClass =
  | 'motorway'    // motorway/trunk — kept in graph, heavily penalized in matcher
  | 'rail'        // hard-block: trains, subways, trams, aerialways, ferries
  | 'unbuilt'     // hard-block: construction/proposed/abandoned — not actually present
  | 'major'       // busy arterials — soft penalty
  | 'minor'       // secondary/tertiary — neutral
  | 'residential' // preferred
  | 'path'        // footway/cycleway — preferred
  | 'sidewalk'    // footway=sidewalk/crossing — demoted so the road centerline wins
  | 'service'     // alleys/driveways — neutral
  | 'other';      // catch-all — small penalty

export interface BBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface GraphNode {
  id: number;
  lng: number;
  lat: number;
}

export interface GraphEdge {
  id: number;
  /** Source/target node IDs. Undirected. */
  a: number;
  b: number;
  /** Densified polyline lng/lat including both endpoints. */
  coords: [number, number][];
  /** Total polyline length in meters. */
  length: number;
  klass: RoadClass;
}

export interface RoadGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  bbox: BBox;
  /** Wall-clock ms spent building, for debug HUD. */
  buildMs: number;
  /** Tiles fetched (for cache instrumentation later). */
  tileCount: number;
}

/**
 * Lightweight build receipt sent to the main thread. The full RoadGraph
 * (~20k edges with densified polylines) stays in the worker — structured-
 * cloning it on every pan-rebuild cost tens of ms and duplicated the
 * memory; the main thread only ever needs the bbox + HUD counts, and the
 * debug overlays fetch their data on demand.
 */
export interface GraphSummary {
  bbox: BBox;
  nodeCount: number;
  edgeCount: number;
  buildMs: number;
  tileCount: number;
}

/** Matched-route payload returned by the worker. */
export interface MatchResultMsg {
  coords: [number, number][];
  length: number;
  closeGap: number;
  matchMs: number;
}

// --- Worker message protocol ---------------------------------------------

export type WorkerRequest =
  // graphZoom = max zoom of the tileset at pmtilesUrl (routing tiles z13, or
  // display tiles z14 on fallback). The worker fetches/decodes at this zoom.
  | { type: 'init'; reqId: number; pmtilesUrl: string; graphZoom: number }
  | { type: 'buildGraph'; reqId: number; bbox: BBox }
  | { type: 'match'; reqId: number; contour: [number, number][] }
  // Debug-only requests; both read the worker-resident graph on demand.
  | { type: 'graphGeoJSON'; reqId: number }
  | { type: 'debugRoute'; reqId: number; a: [number, number]; b: [number, number] };

export type WorkerResponse =
  | { type: 'ready'; reqId: number }
  | { type: 'graph'; reqId: number; summary: GraphSummary }
  | { type: 'match'; reqId: number; result: MatchResultMsg }
  | { type: 'graphGeoJSON'; reqId: number; geojson: GeoJSON.FeatureCollection }
  | { type: 'debugRoute'; reqId: number; route: DebugRoute | null }
  | { type: 'error'; reqId: number; message: string };

// Type-only import; erased at compile time, so no runtime cycle with
// debug-route.ts (which imports RoadGraph from here).
import type { DebugRoute } from './debug-route';
export type { DebugRoute };
