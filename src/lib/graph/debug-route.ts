/**
 * Debug-only point-to-point routing over the built RoadGraph, run on the
 * main thread (the graph already lives in `graphStore.graph`, so there's
 * no reason to round-trip the worker for an interactive probe).
 *
 * Unlike the matcher — which routes between *edge projections* of a whole
 * contour — this snaps each click to the nearest graph node and runs a
 * plain Dijkstra between the two. Its purpose is connectivity inspection:
 * if A and B sit on opposite sides of a tile seam that failed to stitch,
 * the route either detours absurdly or comes back null.
 */

import { MinHeap } from './heap';
import { buildEdgeAdjacency } from './graph-utils';
import { METERS_PER_DEG_LAT, metersPerDegLng } from '../geo';
import type { RoadGraph } from './types';

/** Nearest graph node to a lng/lat, by flat-earth meters. -1 if empty. */
export function nearestNode(graph: RoadGraph, lng: number, lat: number): number {
  const mPerLng = metersPerDegLng(lat);
  let best = -1;
  let bestD2 = Infinity;
  for (const n of graph.nodes) {
    const dx = (n.lng - lng) * mPerLng;
    const dy = (n.lat - lat) * METERS_PER_DEG_LAT;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = n.id;
    }
  }
  return best;
}

export interface DebugRoute {
  /** Stitched route polyline, lng/lat. */
  coords: [number, number][];
  /** Network length in meters. */
  lengthM: number;
  /** The two snapped node ids actually used as endpoints. */
  startNode: number;
  endNode: number;
  /** Meters from each click to its snapped node (snap distance). */
  startSnapM: number;
  endSnapM: number;
}

/**
 * Snap both clicks to nodes and return the shortest node-network path
 * between them, or `null` if they're in different connected components.
 */
export function routeBetweenPoints(
  graph: RoadGraph,
  a: [number, number],
  b: [number, number],
): DebugRoute | null {
  if (graph.nodes.length === 0 || graph.edges.length === 0) return null;
  const startNode = nearestNode(graph, a[0], a[1]);
  const endNode = nearestNode(graph, b[0], b[1]);
  if (startNode < 0 || endNode < 0) return null;

  const startSnapM = nodeDistM(graph, startNode, a);
  const endSnapM = nodeDistM(graph, endNode, b);

  const adj = buildEdgeAdjacency(graph.nodes.length, graph.edges);

  const dist = new Float64Array(graph.nodes.length).fill(Infinity);
  const prevEdge = new Int32Array(graph.nodes.length).fill(-1);
  dist[startNode] = 0;
  const heap = new MinHeap<number>();
  heap.push(0, startNode);

  while (heap.size > 0) {
    const top = heap.pop()!;
    const u = top.v;
    if (top.p > dist[u]) continue;
    if (u === endNode) break;
    for (const eId of adj[u]) {
      const e = graph.edges[eId];
      const w = e.a === u ? e.b : e.a;
      if (w === u) continue; // self-loop edge — no progress
      const nd = top.p + e.length;
      if (nd < dist[w]) {
        dist[w] = nd;
        prevEdge[w] = eId;
        heap.push(nd, w);
      }
    }
  }

  if (!Number.isFinite(dist[endNode])) return null;

  // Walk predecessor edges back from end to start, then replay forward.
  const edgeChain: number[] = [];
  let cur = endNode;
  while (cur !== startNode) {
    const eId = prevEdge[cur];
    if (eId < 0) return null; // unreachable (shouldn't happen given the finite check)
    edgeChain.push(eId);
    const e = graph.edges[eId];
    cur = e.a === cur ? e.b : e.a;
  }
  edgeChain.reverse();

  const coords: [number, number][] = [];
  let node = startNode;
  for (const eId of edgeChain) {
    const e = graph.edges[eId];
    const forward = e.a === node;
    const seg = forward ? e.coords : [...e.coords].reverse();
    if (coords.length === 0) coords.push(...seg);
    else for (let i = 1; i < seg.length; i++) coords.push(seg[i]);
    node = forward ? e.b : e.a;
  }

  return { coords, lengthM: dist[endNode], startNode, endNode, startSnapM, endSnapM };
}

function nodeDistM(graph: RoadGraph, nodeId: number, p: [number, number]): number {
  const n = graph.nodes[nodeId];
  const dx = (n.lng - p[0]) * metersPerDegLng(p[1]);
  const dy = (n.lat - p[1]) * METERS_PER_DEG_LAT;
  return Math.hypot(dx, dy);
}
