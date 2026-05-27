/**
 * Flat-plane (meters) geometry primitives used by the matcher.
 *
 * All inputs are [x, y] in meters from a fixed local frame (see
 * `projection.ts`). Operating in flat coords keeps the inner loops trivial
 * — no trig per vertex — at the cost of ~0.1% distortion over 5km.
 */

export type V2 = [number, number];

/** Squared distance between two points. Skips a sqrt when only comparing. */
export function dist2(a: V2, b: V2): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return dx * dx + dy * dy;
}

export interface SegmentProjection {
  /** Squared perpendicular distance from p to the segment. */
  d2: number;
  /** Closest point on the segment. */
  point: V2;
  /** Fractional position along the segment in [0, 1]; 0 at A, 1 at B. */
  t: number;
}

/** Closest point on segment AB to P. */
export function projectPointToSegment(p: V2, a: V2, b: V2): SegmentProjection {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const len2 = abx * abx + aby * aby;
  if (len2 === 0) return { d2: dist2(p, a), point: [a[0], a[1]], t: 0 };
  let t = ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / len2;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const x = a[0] + t * abx;
  const y = a[1] + t * aby;
  const dx = p[0] - x;
  const dy = p[1] - y;
  return { d2: dx * dx + dy * dy, point: [x, y], t };
}

export interface PolylineProjection {
  /** Closest point on the polyline. */
  point: V2;
  /** Squared perpendicular distance. */
  d2: number;
  /** Index of the segment that owns the closest point (0-based, i→i+1). */
  segIndex: number;
  /** Fractional position within that segment, [0, 1]. */
  segT: number;
  /** Arc-length offset from polyline[0] to the closest point, in meters. */
  offset: number;
}

/** Closest point on a multi-vertex polyline to P. */
export function projectPointToPolyline(p: V2, poly: V2[]): PolylineProjection {
  let best: PolylineProjection = {
    point: poly[0],
    d2: dist2(p, poly[0]),
    segIndex: 0,
    segT: 0,
    offset: 0,
  };
  let cumLen = 0;
  for (let i = 0; i < poly.length - 1; i++) {
    const sp = projectPointToSegment(p, poly[i], poly[i + 1]);
    if (sp.d2 < best.d2) {
      const segLen = Math.hypot(poly[i + 1][0] - poly[i][0], poly[i + 1][1] - poly[i][1]);
      best = {
        point: sp.point,
        d2: sp.d2,
        segIndex: i,
        segT: sp.t,
        offset: cumLen + sp.t * segLen,
      };
    }
    cumLen += Math.hypot(poly[i + 1][0] - poly[i][0], poly[i + 1][1] - poly[i][1]);
  }
  return best;
}

/** Compass-agnostic heading in radians, atan2-style. */
export function bearing(from: V2, to: V2): number {
  return Math.atan2(to[1] - from[1], to[0] - from[0]);
}

/** Smallest angular difference between two radian angles, in [0, π]. */
export function angleDiff(a: number, b: number): number {
  let d = Math.abs(a - b) % (2 * Math.PI);
  if (d > Math.PI) d = 2 * Math.PI - d;
  return d;
}

/**
 * Slice a polyline between two arc-length offsets along it.
 *
 * Both offsets must be in [0, total_length]; `fromOffset` may be greater
 * than `toOffset`, in which case the returned polyline is reversed.
 * Output includes the precise start and end points (interpolated).
 */
export function slicePolyline(poly: V2[], fromOffset: number, toOffset: number): V2[] {
  if (poly.length < 2) return [...poly];
  const reverse = fromOffset > toOffset;
  if (reverse) [fromOffset, toOffset] = [toOffset, fromOffset];

  const out: V2[] = [];
  let cum = 0;
  let started = false;
  for (let i = 0; i < poly.length - 1; i++) {
    const segLen = Math.hypot(poly[i + 1][0] - poly[i][0], poly[i + 1][1] - poly[i][1]);
    const segStart = cum;
    const segEnd = cum + segLen;

    if (!started && fromOffset <= segEnd) {
      const t = segLen === 0 ? 0 : (fromOffset - segStart) / segLen;
      out.push([
        poly[i][0] + t * (poly[i + 1][0] - poly[i][0]),
        poly[i][1] + t * (poly[i + 1][1] - poly[i][1]),
      ]);
      started = true;
    }
    if (started && toOffset >= segEnd) {
      out.push([poly[i + 1][0], poly[i + 1][1]]);
    }
    if (started && toOffset <= segEnd) {
      const t = segLen === 0 ? 0 : (toOffset - segStart) / segLen;
      const last: V2 = [
        poly[i][0] + t * (poly[i + 1][0] - poly[i][0]),
        poly[i][1] + t * (poly[i + 1][1] - poly[i][1]),
      ];
      // Append unless we already pushed the segment end at the exact toOffset.
      const tail = out[out.length - 1];
      if (!tail || tail[0] !== last[0] || tail[1] !== last[1]) out.push(last);
      break;
    }
    cum = segEnd;
  }
  if (reverse) out.reverse();
  return out;
}
