/**
 * In-browser HMM map matcher tuned for shape preservation, not GPS
 * trajectory plausibility (Newson & Krumm 2009 variant). State = the
 * top-K nearest road edges to each input point; cost = emission Gaussian
 * + route-vs-input distance + heading agreement + runnability penalty.
 *
 * Everything inside this module operates in local meters (see
 * `projection.ts`); the entry point converts the input lng/lat contour
 * and returns the matched route as lng/lat.
 */

import { MinHeap } from './heap';
import { frame, fromLocal, toLocal, type LocalFrame } from './projection';
import {
  angleDiff,
  bearing,
  projectPointToPolyline,
  slicePolyline,
  type V2,
  type PolylineProjection,
} from './geometry';
import type { RoadClass, RoadGraph } from './types';

// ── tuning knobs ─────────────────────────────────────────────────────────
// These are first-pass guesses; Task 6e will iterate on hand-picked inputs.

/** Search radius for candidates around each input point. */
const CANDIDATE_RADIUS_M = 40;
/** How many road candidates to consider per input point. */
const CANDIDATES_PER_POINT = 8;
/** Emission Gaussian std-dev (perpendicular distance to road, meters). */
const EMISSION_SIGMA_M = 15;
/** Cost per meter that route distance deviates from input great-circle. */
const ROUTE_DEVIATION_PER_M = 1 / 50;
/** Cost per (1 − cos(Δheading)). Max possible per-step is 2× this. */
const SHAPE_WEIGHT = 4;
/** Ceiling on transition route-distance, even across bridged points. */
const TRANSITION_CAP_M = 1500;
/** Multiplier on input-step length used to derive a per-step cap. */
const TRANSITION_CAP_MULTIPLIER = 5;
/** Minimum per-transition cap, regardless of how short the input step is. */
const TRANSITION_CAP_FLOOR_M = 400;

const RUNNABILITY_PENALTY: Record<RoadClass, number> = {
  // The three hard-blocked classes below are filtered out at graph build
  // time and should never reach the matcher; the +∞ here is defensive.
  motorway: Number.POSITIVE_INFINITY,
  rail: Number.POSITIVE_INFINITY,
  unbuilt: Number.POSITIVE_INFINITY,
  major: 0.6,
  minor: 0.15,
  residential: 0,
  path: 0,
  service: 0.1,
  other: 0.25,
};

// ── candidate types ──────────────────────────────────────────────────────

interface Candidate {
  edgeId: number;
  /** Projection onto the edge polyline, in local meters. */
  proj: PolylineProjection;
  /** Cached emission cost (set once when built). */
  emission: number;
}

// ── matcher context (stays in worker between calls) ──────────────────────

export interface MatchResult {
  /** Matched route polyline, lng/lat. */
  coords: [number, number][];
  /** Route length in meters. */
  length: number;
  /** Gap between first and last matched points (meters), for closed inputs. */
  closeGap: number;
  /** ms spent matching, for HUD. */
  matchMs: number;
}

export class Matcher {
  private frame: LocalFrame;
  /** Per-edge polyline in local meters (parallel to graph.edges). */
  private edgePoly: V2[][];
  /** Per-edge axis-aligned bbox in local meters: minX, minY, maxX, maxY. */
  private edgeBBox: Float32Array;
  /** Per-edge metadata (parallel to graph.edges). */
  private edgeA: Int32Array;
  private edgeB: Int32Array;
  private edgeLen: Float32Array;
  private edgeKlass: RoadClass[];
  /** Adjacency: nodeId → array of edge IDs incident on it. */
  private adj: number[][];

  constructor(graph: RoadGraph) {
    const cx = (graph.bbox.west + graph.bbox.east) / 2;
    const cy = (graph.bbox.south + graph.bbox.north) / 2;
    this.frame = frame(cx, cy);

    const n = graph.edges.length;
    this.edgePoly = new Array(n);
    this.edgeBBox = new Float32Array(n * 4);
    this.edgeA = new Int32Array(n);
    this.edgeB = new Int32Array(n);
    this.edgeLen = new Float32Array(n);
    this.edgeKlass = new Array(n);

    for (let i = 0; i < n; i++) {
      const e = graph.edges[i];
      const poly: V2[] = e.coords.map((c) => toLocal(this.frame, c[0], c[1]));
      this.edgePoly[i] = poly;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const [x, y] of poly) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
      this.edgeBBox[i * 4] = minX;
      this.edgeBBox[i * 4 + 1] = minY;
      this.edgeBBox[i * 4 + 2] = maxX;
      this.edgeBBox[i * 4 + 3] = maxY;
      this.edgeA[i] = e.a;
      this.edgeB[i] = e.b;
      this.edgeLen[i] = e.length;
      this.edgeKlass[i] = e.klass;
    }

    this.adj = Array.from({ length: graph.nodes.length }, () => []);
    for (let i = 0; i < n; i++) {
      this.adj[this.edgeA[i]].push(i);
      this.adj[this.edgeB[i]].push(i);
    }
  }

  match(contourLngLat: [number, number][]): MatchResult {
    const t0 = performance.now();
    if (contourLngLat.length < 2) {
      throw new Error(`Contour has ${contourLngLat.length} point(s); need ≥ 2.`);
    }

    const pts: V2[] = contourLngLat.map((c) => toLocal(this.frame, c[0], c[1]));

    const lattice: Candidate[][] = pts.map((p) => this.findCandidates(p));
    const candCounts = lattice.map((l) => l.length);
    const totalCands = candCounts.reduce((s, n) => s + n, 0);
    const emptyPts = candCounts.filter((n) => n === 0).length;
    console.log(
      `[matcher] ${pts.length} pts → ${totalCands} candidates total, ` +
      `${emptyPts} pt(s) with no road within ${CANDIDATE_RADIUS_M}m`,
    );

    if (totalCands === 0) {
      throw new Error(
        `No road candidates within ${CANDIDATE_RADIUS_M}m of any contour point. ` +
        `The image is probably outside the loaded road graph area.`,
      );
    }

    const path = this.viterbi(lattice, pts);
    if (!path || path.length < 2) {
      throw new Error(
        `Viterbi could not connect enough contour points. ` +
        `Try a different position or a less complex shape.`,
      );
    }

    const route = this.stitchRoute(lattice, path);
    const length = polylineLengthLocal(route);
    const closeGap = Math.hypot(
      route[0][0] - route[route.length - 1][0],
      route[0][1] - route[route.length - 1][1],
    );
    const coords: [number, number][] = route.map(([x, y]) => fromLocal(this.frame, x, y));
    const matchMs = Math.round(performance.now() - t0);
    console.log(
      `[matcher] match ok: ${coords.length} verts, ${Math.round(length)}m, ${matchMs}ms ` +
      `(${path.length}/${pts.length} pts kept)`,
    );
    return { coords, length, closeGap, matchMs };
  }

  // ── candidates ─────────────────────────────────────────────────────────

  private findCandidates(p: V2): Candidate[] {
    const r = CANDIDATE_RADIUS_M;
    const r2 = r * r;
    const minX = p[0] - r, minY = p[1] - r, maxX = p[0] + r, maxY = p[1] + r;
    const found: Candidate[] = [];
    const n = this.edgePoly.length;
    const bb = this.edgeBBox;
    for (let i = 0; i < n; i++) {
      if (bb[i * 4] > maxX || bb[i * 4 + 2] < minX) continue;
      if (bb[i * 4 + 1] > maxY || bb[i * 4 + 3] < minY) continue;
      const proj = projectPointToPolyline(p, this.edgePoly[i]);
      if (proj.d2 > r2) continue;
      const d = Math.sqrt(proj.d2);
      const emission = (d * d) / (2 * EMISSION_SIGMA_M * EMISSION_SIGMA_M)
        + RUNNABILITY_PENALTY[this.edgeKlass[i]];
      found.push({ edgeId: i, proj, emission });
    }
    found.sort((a, b) => a.emission - b.emission);
    return found.slice(0, CANDIDATES_PER_POINT);
  }

  // ── Viterbi ────────────────────────────────────────────────────────────

  /**
   * Per-frame Viterbi with skip-dead-points: a frame with no candidates,
   * or a frame where every transition exceeds the cap, is skipped. The
   * "live frame" pointer tracks the most recent frame with a valid DP,
   * and the next frame attempts transitions back to that one rather than
   * the immediate predecessor — so a single bad step cannot kill the
   * chain. The bridged step's cap grows with the number of skipped points.
   *
   * Returned path lists only kept (live) frames; the stitcher walks
   * between them with the road-network polyline reconstruction.
   */
  private viterbi(
    lattice: Candidate[][],
    pts: V2[],
  ): { frame: number; cand: number }[] | null {
    const N = lattice.length;
    // Find first frame with candidates.
    let firstLive = 0;
    while (firstLive < N && lattice[firstLive].length === 0) firstLive++;
    if (firstLive >= N) return null;

    let liveFrame = firstLive;
    let dp: number[] = lattice[firstLive].map((c) => c.emission);
    // backChain[i] is populated only when frame i was accepted as live.
    const backChain: ({ prevFrame: number; prevCand: number }[] | null)[] =
      new Array(N).fill(null);
    backChain[firstLive] = lattice[firstLive].map(() => ({ prevFrame: -1, prevCand: -1 }));

    let okTransitions = 0;
    let totalTransitions = 0;
    let dijkstraNodesSum = 0;
    let dijkstraCalls = 0;
    let bridgedFrames = 0;

    for (let i = firstLive + 1; i < N; i++) {
      const cur = lattice[i];
      if (cur.length === 0) {
        bridgedFrames++;
        continue;
      }
      const prev = lattice[liveFrame];
      const stepLen = Math.hypot(pts[i][0] - pts[liveFrame][0], pts[i][1] - pts[liveFrame][1]);
      const cap = Math.min(
        TRANSITION_CAP_M,
        Math.max(TRANSITION_CAP_FLOOR_M, stepLen * TRANSITION_CAP_MULTIPLIER + 200),
      );
      const inputHeading = bearing(pts[liveFrame], pts[i]);

      const newDp = new Array<number>(cur.length).fill(Number.POSITIVE_INFINITY);
      const newBack: { prevFrame: number; prevCand: number }[] = cur.map(() => ({
        prevFrame: -1,
        prevCand: -1,
      }));

      for (let j = 0; j < prev.length; j++) {
        if (!Number.isFinite(dp[j])) continue;
        const distMap = this.boundedDijkstra(prev[j], cap);
        dijkstraCalls++;
        dijkstraNodesSum += distMap.size;
        for (let k = 0; k < cur.length; k++) {
          totalTransitions++;
          const routeDist = this.routeDistance(prev[j], cur[k], distMap);
          if (!Number.isFinite(routeDist) || routeDist > cap) continue;
          okTransitions++;
          const routeTerm = ROUTE_DEVIATION_PER_M * Math.abs(routeDist - stepLen);
          const routeBearing = bearing(prev[j].proj.point, cur[k].proj.point);
          const shapeTerm = SHAPE_WEIGHT * (1 - Math.cos(angleDiff(inputHeading, routeBearing)));
          const total = dp[j] + routeTerm + shapeTerm + cur[k].emission;
          if (total < newDp[k]) {
            newDp[k] = total;
            newBack[k] = { prevFrame: liveFrame, prevCand: j };
          }
        }
      }

      if (newDp.some(Number.isFinite)) {
        dp = newDp;
        liveFrame = i;
        backChain[i] = newBack;
      } else {
        bridgedFrames++;
      }
    }

    const avgReach = dijkstraCalls > 0 ? Math.round(dijkstraNodesSum / dijkstraCalls) : 0;
    console.log(
      `[matcher] viterbi: ${okTransitions}/${totalTransitions} transitions valid, ` +
      `bounded Dijkstra avg reach ${avgReach} nodes (${dijkstraCalls} runs), ` +
      `${bridgedFrames} input pts bridged`,
    );

    // Best terminal cand on the final live frame.
    let bestK = -1;
    let bestCost = Number.POSITIVE_INFINITY;
    for (let k = 0; k < dp.length; k++) {
      if (dp[k] < bestCost) {
        bestCost = dp[k];
        bestK = k;
      }
    }
    if (bestK < 0 || !Number.isFinite(bestCost)) return null;

    // Walk back across live frames.
    const out: { frame: number; cand: number }[] = [];
    let curFrame = liveFrame;
    let curCand = bestK;
    while (curFrame >= 0 && curCand >= 0) {
      out.push({ frame: curFrame, cand: curCand });
      const back = backChain[curFrame]?.[curCand];
      if (!back || back.prevFrame < 0) break;
      curFrame = back.prevFrame;
      curCand = back.prevCand;
    }
    out.reverse();
    return out;
  }

  // ── routing ────────────────────────────────────────────────────────────

  /**
   * Network distance from candidate `src` to candidate `dst`, given a
   * pre-computed Dijkstra distance map from src's endpoints.
   */
  private routeDistance(
    src: Candidate,
    dst: Candidate,
    srcDist: Map<number, number>,
  ): number {
    // Special case: same edge — distance along the edge between offsets.
    if (src.edgeId === dst.edgeId) {
      return Math.abs(dst.proj.offset - src.proj.offset);
    }
    const dstLen = this.edgeLen[dst.edgeId];
    const offFromA = dst.proj.offset;
    const offFromB = dstLen - dst.proj.offset;
    const viaA = (srcDist.get(this.edgeA[dst.edgeId]) ?? Infinity) + offFromA;
    const viaB = (srcDist.get(this.edgeB[dst.edgeId]) ?? Infinity) + offFromB;
    return Math.min(viaA, viaB);
  }

  /**
   * Bounded Dijkstra from `src`'s two endpoint nodes, with initial costs
   * equal to the meters from src's projection to each endpoint. Returns
   * a node→cost map limited to costs ≤ maxCost.
   */
  private boundedDijkstra(src: Candidate, maxCost: number): Map<number, number> {
    const dist = new Map<number, number>();
    const heap = new MinHeap<number>();
    const len = this.edgeLen[src.edgeId];

    const seed = (nodeId: number, cost: number) => {
      if (cost > maxCost) return;
      const existing = dist.get(nodeId);
      if (existing !== undefined && existing <= cost) return;
      dist.set(nodeId, cost);
      heap.push(cost, nodeId);
    };
    seed(this.edgeA[src.edgeId], src.proj.offset);
    seed(this.edgeB[src.edgeId], len - src.proj.offset);

    while (heap.size > 0) {
      const top = heap.pop()!;
      const u = top.v;
      const du = top.p;
      if (du > (dist.get(u) ?? Infinity)) continue;
      for (const eId of this.adj[u]) {
        const v = this.edgeA[eId] === u ? this.edgeB[eId] : this.edgeA[eId];
        const nd = du + this.edgeLen[eId];
        if (nd > maxCost) continue;
        if (nd < (dist.get(v) ?? Infinity)) {
          dist.set(v, nd);
          heap.push(nd, v);
        }
      }
    }
    return dist;
  }

  // ── route reconstruction ───────────────────────────────────────────────

  /**
   * Stitch the chosen candidates into one continuous polyline (local
   * meters). Each path entry is (frame, cand); frames not in the path
   * were bridged and don't need their own segment.
   */
  private stitchRoute(
    lattice: Candidate[][],
    path: { frame: number; cand: number }[],
  ): V2[] {
    const route: V2[] = [];
    for (let i = 0; i < path.length - 1; i++) {
      const a = lattice[path[i].frame][path[i].cand];
      const b = lattice[path[i + 1].frame][path[i + 1].cand];
      const piece = this.routePolyline(a, b);
      if (i === 0) route.push(...piece);
      else for (let k = 1; k < piece.length; k++) route.push(piece[k]);
    }
    if (route.length === 0) {
      route.push(lattice[path[0].frame][path[0].cand].proj.point);
    }
    return route;
  }

  /** Polyline from one candidate's projection to another's, along the network. */
  private routePolyline(src: Candidate, dst: Candidate): V2[] {
    if (src.edgeId === dst.edgeId) {
      return slicePolyline(this.edgePoly[src.edgeId], src.proj.offset, dst.proj.offset);
    }
    // Run Dijkstra from src's endpoints with predecessor tracking.
    const pred = this.dijkstraWithPred(src);
    const dstNodes = [this.edgeA[dst.edgeId], this.edgeB[dst.edgeId]];
    let bestEnd = -1;
    let bestTotal = Infinity;
    for (const n of dstNodes) {
      const r = pred.get(n);
      if (!r) continue;
      const offsetOnDst = n === this.edgeA[dst.edgeId]
        ? dst.proj.offset
        : this.edgeLen[dst.edgeId] - dst.proj.offset;
      const total = r.cost + offsetOnDst;
      if (total < bestTotal) {
        bestTotal = total;
        bestEnd = n;
      }
    }
    if (bestEnd < 0) {
      // Disconnected — fall back to straight line so we still render something.
      return [src.proj.point, dst.proj.point];
    }

    // Walk predecessors back to src.
    const nodeChain: number[] = [];
    let cur: number | null = bestEnd;
    while (cur !== null && cur !== -1) {
      nodeChain.push(cur);
      const entry: { from: number | null; cost: number } | undefined = pred.get(cur);
      cur = entry ? entry.from : null;
    }
    nodeChain.reverse();
    // First entry in nodeChain is one of src's endpoint nodes.

    const out: V2[] = [src.proj.point];

    // src-edge slice from projection to first chain node.
    const srcStartOffset = src.proj.offset;
    const srcEndOffset = nodeChain[0] === this.edgeA[src.edgeId]
      ? 0
      : this.edgeLen[src.edgeId];
    const srcSlice = slicePolyline(this.edgePoly[src.edgeId], srcStartOffset, srcEndOffset);
    for (let i = 1; i < srcSlice.length; i++) out.push(srcSlice[i]);

    // Intermediate edges (between consecutive chain nodes).
    for (let i = 0; i < nodeChain.length - 1; i++) {
      const u = nodeChain[i];
      const v = nodeChain[i + 1];
      const eId = this.findEdgeBetween(u, v);
      if (eId < 0) continue; // shouldn't happen
      const startOff = u === this.edgeA[eId] ? 0 : this.edgeLen[eId];
      const endOff = v === this.edgeA[eId] ? 0 : this.edgeLen[eId];
      const slice = slicePolyline(this.edgePoly[eId], startOff, endOff);
      for (let k = 1; k < slice.length; k++) out.push(slice[k]);
    }

    // dst-edge slice from its endpoint node down to projection.
    const dstStartOffset = bestEnd === this.edgeA[dst.edgeId]
      ? 0
      : this.edgeLen[dst.edgeId];
    const dstSlice = slicePolyline(this.edgePoly[dst.edgeId], dstStartOffset, dst.proj.offset);
    for (let i = 1; i < dstSlice.length; i++) out.push(dstSlice[i]);

    return out;
  }

  /**
   * Dijkstra from src candidate's endpoints with predecessor + cost
   * tracking. Unbounded (caller has already chosen this is the right
   * pair, so we let it run to find a path).
   */
  private dijkstraWithPred(src: Candidate): Map<number, { from: number | null; cost: number }> {
    const result = new Map<number, { from: number | null; cost: number }>();
    const heap = new MinHeap<number>();
    const len = this.edgeLen[src.edgeId];

    const seed = (nodeId: number, cost: number) => {
      const ex = result.get(nodeId);
      if (ex && ex.cost <= cost) return;
      result.set(nodeId, { from: null, cost });
      heap.push(cost, nodeId);
    };
    seed(this.edgeA[src.edgeId], src.proj.offset);
    seed(this.edgeB[src.edgeId], len - src.proj.offset);

    while (heap.size > 0) {
      const top = heap.pop()!;
      const u = top.v;
      const du = top.p;
      const cur = result.get(u);
      if (!cur || du > cur.cost) continue;
      for (const eId of this.adj[u]) {
        const v = this.edgeA[eId] === u ? this.edgeB[eId] : this.edgeA[eId];
        const nd = du + this.edgeLen[eId];
        const ex = result.get(v);
        if (!ex || nd < ex.cost) {
          result.set(v, { from: u, cost: nd });
          heap.push(nd, v);
        }
      }
    }
    return result;
  }

  /** Linear scan over node `u`'s adjacency list for an edge to `v`. */
  private findEdgeBetween(u: number, v: number): number {
    for (const eId of this.adj[u]) {
      if (this.edgeA[eId] === v || this.edgeB[eId] === v) return eId;
    }
    return -1;
  }
}

function polylineLengthLocal(poly: V2[]): number {
  let sum = 0;
  for (let i = 1; i < poly.length; i++) {
    sum += Math.hypot(poly[i][0] - poly[i - 1][0], poly[i][1] - poly[i - 1][1]);
  }
  return sum;
}
