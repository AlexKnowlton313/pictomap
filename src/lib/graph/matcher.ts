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
  // rail / unbuilt are hard-blocked at graph build time and should
  // never reach the matcher; the +∞ here is defensive.
  rail: Number.POSITIVE_INFINITY,
  unbuilt: Number.POSITIVE_INFINITY,
  // Motorways are kept in the graph and selectable. Heavy penalty so
  // a parallel surface street is preferred whenever one exists, but
  // not infinite — the runner gets what they asked for if the contour
  // really wants the highway.
  motorway: 1.5,
  major: 0.6,
  minor: 0.15,
  residential: 0,
  path: 0,
  service: 0.1,
  other: 0.25,
};

// ── candidate spatial hash ───────────────────────────────────────────────

/**
 * Cell size for the edge-bbox spatial hash used by findCandidates. Coarse
 * relative to CANDIDATE_RADIUS_M so a query touches at most ~2×2 cells,
 * fine enough that a cell holds only nearby edges.
 */
const CAND_CELL_M = 128;
const CAND_CELL_BIAS = 32768; // cells span ±4194 km in local meters — plenty
const candCellKey = (cx: number, cy: number): number =>
  (cx + CAND_CELL_BIAS) * 65536 + (cy + CAND_CELL_BIAS);

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
  /**
   * Adjacency in CSR layout: edge ids incident on node n are
   * adjEdge[adjOff[n] .. adjOff[n+1]). Flat typed arrays keep the Dijkstra
   * inner loop free of per-node array allocations and pointer chasing.
   */
  private adjOff: Int32Array;
  private adjEdge: Int32Array;
  /**
   * Epoch-stamped Dijkstra scratch, allocated once per graph. A slot is
   * valid only when its distEpoch equals the current epoch, so "clearing"
   * between runs is a counter bump instead of a reallocation — Map
   * get/set was the dominant constant factor in the hot loops.
   */
  private dist: Float64Array;
  private distEpoch: Int32Array;
  private predFrom: Int32Array;
  private epoch = 0;
  /** Spatial hash: cell key → edge ids whose bbox overlaps the cell. */
  private cellEdges: Map<number, number[]>;
  /** Epoch-stamped dedupe for edges spanning several queried cells. */
  private edgeSeen: Int32Array;
  private seenEpoch = 0;

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

    // CSR adjacency: count degrees, prefix-sum into offsets, then fill
    // with a per-node cursor.
    const nodeCount = graph.nodes.length;
    this.adjOff = new Int32Array(nodeCount + 1);
    for (let i = 0; i < n; i++) {
      this.adjOff[this.edgeA[i] + 1]++;
      this.adjOff[this.edgeB[i] + 1]++;
    }
    for (let v = 0; v < nodeCount; v++) this.adjOff[v + 1] += this.adjOff[v];
    this.adjEdge = new Int32Array(n * 2);
    const cursor = this.adjOff.slice(0, nodeCount);
    for (let i = 0; i < n; i++) {
      this.adjEdge[cursor[this.edgeA[i]]++] = i;
      this.adjEdge[cursor[this.edgeB[i]]++] = i;
    }

    this.dist = new Float64Array(nodeCount);
    this.distEpoch = new Int32Array(nodeCount);
    this.predFrom = new Int32Array(nodeCount);

    // Index every edge bbox into the candidate spatial hash.
    this.cellEdges = new Map();
    for (let i = 0; i < n; i++) {
      const minCx = Math.floor(this.edgeBBox[i * 4] / CAND_CELL_M);
      const minCy = Math.floor(this.edgeBBox[i * 4 + 1] / CAND_CELL_M);
      const maxCx = Math.floor(this.edgeBBox[i * 4 + 2] / CAND_CELL_M);
      const maxCy = Math.floor(this.edgeBBox[i * 4 + 3] / CAND_CELL_M);
      for (let cx = minCx; cx <= maxCx; cx++) {
        for (let cy = minCy; cy <= maxCy; cy++) {
          const k = candCellKey(cx, cy);
          const bucket = this.cellEdges.get(k);
          if (bucket) bucket.push(i);
          else this.cellEdges.set(k, [i]);
        }
      }
    }
    this.edgeSeen = new Int32Array(n);
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
    const bb = this.edgeBBox;
    const epoch = ++this.seenEpoch;
    const minCx = Math.floor(minX / CAND_CELL_M);
    const maxCx = Math.floor(maxX / CAND_CELL_M);
    const minCy = Math.floor(minY / CAND_CELL_M);
    const maxCy = Math.floor(maxY / CAND_CELL_M);
    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        const bucket = this.cellEdges.get(candCellKey(cx, cy));
        if (!bucket) continue;
        for (const i of bucket) {
          if (this.edgeSeen[i] === epoch) continue;
          this.edgeSeen[i] = epoch;
          if (bb[i * 4] > maxX || bb[i * 4 + 2] < minX) continue;
          if (bb[i * 4 + 1] > maxY || bb[i * 4 + 3] < minY) continue;
          const proj = projectPointToPolyline(p, this.edgePoly[i]);
          if (proj.d2 > r2) continue;
          const d = Math.sqrt(proj.d2);
          const emission = (d * d) / (2 * EMISSION_SIGMA_M * EMISSION_SIGMA_M)
            + RUNNABILITY_PENALTY[this.edgeKlass[i]];
          found.push({ edgeId: i, proj, emission });
        }
      }
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

      // The only distances routeDistance reads are to the endpoint nodes of
      // this frame's candidate edges — let Dijkstra stop once those settle
      // instead of flooding the whole cap radius.
      const targets: number[] = [];
      for (const c of cur) {
        const a = this.edgeA[c.edgeId];
        const b = this.edgeB[c.edgeId];
        if (!targets.includes(a)) targets.push(a);
        if (!targets.includes(b)) targets.push(b);
      }

      for (let j = 0; j < prev.length; j++) {
        if (!Number.isFinite(dp[j])) continue;
        const reached = this.boundedDijkstra(prev[j], cap, targets);
        dijkstraCalls++;
        dijkstraNodesSum += reached;
        for (let k = 0; k < cur.length; k++) {
          totalTransitions++;
          const routeDist = this.routeDistance(prev[j], cur[k]);
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

  /** Distance for node `nodeId` from the most recent Dijkstra run. */
  private nodeDist(nodeId: number): number {
    return this.distEpoch[nodeId] === this.epoch ? this.dist[nodeId] : Infinity;
  }

  /**
   * Network distance from candidate `src` to candidate `dst`, reading the
   * distances left in scratch by the preceding boundedDijkstra run from
   * src's endpoints.
   */
  private routeDistance(src: Candidate, dst: Candidate): number {
    // Special case: same edge — distance along the edge between offsets.
    if (src.edgeId === dst.edgeId) {
      return Math.abs(dst.proj.offset - src.proj.offset);
    }
    const dstLen = this.edgeLen[dst.edgeId];
    const offFromA = dst.proj.offset;
    const offFromB = dstLen - dst.proj.offset;
    const viaA = this.nodeDist(this.edgeA[dst.edgeId]) + offFromA;
    const viaB = this.nodeDist(this.edgeB[dst.edgeId]) + offFromB;
    return Math.min(viaA, viaB);
  }

  /**
   * Bounded Dijkstra from `src`'s two endpoint nodes, with initial costs
   * equal to the meters from src's projection to each endpoint. Distances
   * are written into the epoch-stamped scratch (read back via nodeDist),
   * limited to costs ≤ maxCost. Terminates early once every node in
   * `targets` is settled — settled distances are final, so the callers'
   * reads are unaffected by the truncated frontier. Returns the number of
   * nodes reached, for the HUD stats.
   */
  private boundedDijkstra(src: Candidate, maxCost: number, targets: number[]): number {
    const epoch = ++this.epoch;
    const { dist, distEpoch } = this;
    const heap = new MinHeap<number>();
    const len = this.edgeLen[src.edgeId];
    const unsettled = new Set(targets);
    let reached = 0;

    const seed = (nodeId: number, cost: number) => {
      if (cost > maxCost) return;
      if (distEpoch[nodeId] === epoch && dist[nodeId] <= cost) return;
      if (distEpoch[nodeId] !== epoch) reached++;
      distEpoch[nodeId] = epoch;
      dist[nodeId] = cost;
      heap.push(cost, nodeId);
    };
    seed(this.edgeA[src.edgeId], src.proj.offset);
    seed(this.edgeB[src.edgeId], len - src.proj.offset);

    while (heap.size > 0) {
      const top = heap.pop()!;
      const u = top.v;
      const du = top.p;
      if (du > dist[u]) continue; // stale heap entry
      if (unsettled.delete(u) && unsettled.size === 0) break;
      for (let ai = this.adjOff[u]; ai < this.adjOff[u + 1]; ai++) {
        const eId = this.adjEdge[ai];
        const v = this.edgeA[eId] === u ? this.edgeB[eId] : this.edgeA[eId];
        const nd = du + this.edgeLen[eId];
        if (nd > maxCost) continue;
        if (distEpoch[v] !== epoch) {
          reached++;
          distEpoch[v] = epoch;
        } else if (nd >= dist[v]) {
          continue;
        }
        dist[v] = nd;
        heap.push(nd, v);
      }
    }
    return reached;
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
    // Run Dijkstra from src's endpoints with predecessor tracking. Viterbi
    // only accepted transitions with route distance <= TRANSITION_CAP_M, so
    // the reconstruction search can be bounded by the same ceiling instead
    // of exploring the whole component.
    const dstNodes = [this.edgeA[dst.edgeId], this.edgeB[dst.edgeId]];
    this.dijkstraWithPred(src, dstNodes, TRANSITION_CAP_M);
    let bestEnd = -1;
    let bestTotal = Infinity;
    for (const n of dstNodes) {
      const cost = this.nodeDist(n);
      if (!Number.isFinite(cost)) continue;
      const offsetOnDst = n === this.edgeA[dst.edgeId]
        ? dst.proj.offset
        : this.edgeLen[dst.edgeId] - dst.proj.offset;
      const total = cost + offsetOnDst;
      if (total < bestTotal) {
        bestTotal = total;
        bestEnd = n;
      }
    }
    if (bestEnd < 0) {
      // Disconnected (or past the cap, which Viterbi's acceptance rules out)
      // — fall back to straight line so we still render something.
      return [src.proj.point, dst.proj.point];
    }

    // Walk predecessors back to src (seeds carry predFrom = -1).
    const nodeChain: number[] = [];
    let cur = bestEnd;
    while (cur !== -1) {
      nodeChain.push(cur);
      cur = this.predFrom[cur];
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
   * Dijkstra from src candidate's endpoints with predecessor tracking
   * (into the epoch-stamped scratch; read back via nodeDist/predFrom).
   * Bounded by `maxCost`, and terminates as soon as every node in
   * `targets` is settled — the caller only ever reads the targets'
   * chains, so the rest of the frontier is wasted work.
   */
  private dijkstraWithPred(src: Candidate, targets: number[], maxCost: number): void {
    const epoch = ++this.epoch;
    const { dist, distEpoch, predFrom } = this;
    const heap = new MinHeap<number>();
    const len = this.edgeLen[src.edgeId];
    const unsettled = new Set(targets);

    const seed = (nodeId: number, cost: number) => {
      if (cost > maxCost) return;
      if (distEpoch[nodeId] === epoch && dist[nodeId] <= cost) return;
      distEpoch[nodeId] = epoch;
      dist[nodeId] = cost;
      predFrom[nodeId] = -1;
      heap.push(cost, nodeId);
    };
    seed(this.edgeA[src.edgeId], src.proj.offset);
    seed(this.edgeB[src.edgeId], len - src.proj.offset);

    while (heap.size > 0) {
      const top = heap.pop()!;
      const u = top.v;
      const du = top.p;
      if (du > dist[u]) continue; // stale heap entry
      if (unsettled.delete(u) && unsettled.size === 0) break;
      for (let ai = this.adjOff[u]; ai < this.adjOff[u + 1]; ai++) {
        const eId = this.adjEdge[ai];
        const v = this.edgeA[eId] === u ? this.edgeB[eId] : this.edgeA[eId];
        const nd = du + this.edgeLen[eId];
        if (nd > maxCost) continue;
        if (distEpoch[v] !== epoch || nd < dist[v]) {
          distEpoch[v] = epoch;
          dist[v] = nd;
          predFrom[v] = u;
          heap.push(nd, v);
        }
      }
    }
  }

  /** Linear scan over node `u`'s adjacency list for an edge to `v`. */
  private findEdgeBetween(u: number, v: number): number {
    for (let ai = this.adjOff[u]; ai < this.adjOff[u + 1]; ai++) {
      const eId = this.adjEdge[ai];
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
