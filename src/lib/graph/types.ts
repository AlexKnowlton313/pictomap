/**
 * Road graph types and the worker message protocol.
 *
 * Coordinates are [lng, lat] tuples throughout — matches MapLibre + GeoJSON
 * and avoids an x/y vs lat/lng mix-up.
 */

export type RoadClass =
  | 'motorway'    // hard-block: not runnable
  | 'major'       // busy arterials — soft penalty
  | 'minor'       // secondary/tertiary — neutral
  | 'residential' // preferred
  | 'path'        // footway/cycleway — preferred
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

/** Matched-route payload returned by the worker. */
export interface MatchResultMsg {
  coords: [number, number][];
  length: number;
  closeGap: number;
  matchMs: number;
}

// --- Worker message protocol ---------------------------------------------

export type WorkerRequest =
  | { type: 'init'; reqId: number; pmtilesUrl: string }
  | { type: 'buildGraph'; reqId: number; bbox: BBox }
  | { type: 'match'; reqId: number; contour: [number, number][] };

export type WorkerResponse =
  | { type: 'ready'; reqId: number }
  | { type: 'graph'; reqId: number; graph: RoadGraph }
  | { type: 'match'; reqId: number; result: MatchResultMsg }
  | { type: 'error'; reqId: number; message: string };
