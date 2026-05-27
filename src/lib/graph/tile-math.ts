import type { BBox } from './types';

/**
 * Web Mercator tile math. We work at a single zoom (z14) where Protomaps
 * stops simplifying road geometry — see `tasks.md` § Architecture.
 */

export const GRAPH_ZOOM = 14;

const EARTH_RADIUS_M = 6_371_008.8;

export function lngToTileX(lng: number, z: number): number {
  return Math.floor(((lng + 180) / 360) * (1 << z));
}

export function latToTileY(lat: number, z: number): number {
  const sin = Math.sin((lat * Math.PI) / 180);
  return Math.floor((0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * (1 << z));
}

export interface TileRange {
  z: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export function tilesCoveringBBox(bbox: BBox, z: number = GRAPH_ZOOM): TileRange {
  return {
    z,
    minX: lngToTileX(bbox.west, z),
    maxX: lngToTileX(bbox.east, z),
    // y grows southward, so north → smaller y
    minY: latToTileY(bbox.north, z),
    maxY: latToTileY(bbox.south, z),
  };
}

/** Great-circle distance (Haversine) in meters. */
export function haversine(
  a: [number, number],
  b: [number, number],
): number {
  const [lng1, lat1] = a;
  const [lng2, lat2] = b;
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const dφ = ((lat2 - lat1) * Math.PI) / 180;
  const dλ = ((lng2 - lng1) * Math.PI) / 180;
  const s = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(s));
}

/** Sum of haversine distances along a polyline. */
export function polylineLength(coords: [number, number][]): number {
  let sum = 0;
  for (let i = 1; i < coords.length; i++) sum += haversine(coords[i - 1], coords[i]);
  return sum;
}

/** Expand a center point into a square bbox of side `radiusM * 2` (meters). */
export function bboxAround(
  center: { lng: number; lat: number },
  radiusM: number,
): BBox {
  const dLat = (radiusM / EARTH_RADIUS_M) * (180 / Math.PI);
  const dLng = dLat / Math.cos((center.lat * Math.PI) / 180);
  return {
    west: center.lng - dLng,
    east: center.lng + dLng,
    south: center.lat - dLat,
    north: center.lat + dLat,
  };
}

/** Pad every side of a bbox by `m` meters. */
export function expandBBox(b: BBox, m: number): BBox {
  const dLat = (m / EARTH_RADIUS_M) * (180 / Math.PI);
  // Use the larger of |north|, |south| so the lng padding holds across the bbox.
  const refLat = Math.max(Math.abs(b.north), Math.abs(b.south));
  const dLng = dLat / Math.max(Math.cos((refLat * Math.PI) / 180), 1e-6);
  return {
    west: b.west - dLng,
    east: b.east + dLng,
    south: b.south - dLat,
    north: b.north + dLat,
  };
}

/** True if `outer` fully encloses `inner`. */
export function bboxContains(outer: BBox, inner: BBox): boolean {
  return (
    outer.west <= inner.west &&
    outer.east >= inner.east &&
    outer.south <= inner.south &&
    outer.north >= inner.north
  );
}

/** Inverse of lngToTileX: lng of the left edge of tile x at zoom z. */
export function tileXToLng(x: number, z: number): number {
  return (x / (1 << z)) * 360 - 180;
}

/** Inverse of latToTileY: lat of the top (north) edge of tile y at zoom z. */
export function tileYToLat(y: number, z: number): number {
  const n = Math.PI * (1 - (2 * y) / (1 << z));
  return (Math.atan(Math.sinh(n)) * 180) / Math.PI;
}

/** Geographic bounds of a single MVT tile. */
export function tileBounds(x: number, y: number, z: number): BBox {
  return {
    west: tileXToLng(x, z),
    east: tileXToLng(x + 1, z),
    north: tileYToLat(y, z),
    south: tileYToLat(y + 1, z),
  };
}

/**
 * Liang-Barsky parametric clip of segment a→b against `bbox`. Returns
 * the t-interval [t0, t1] (each ∈ [0, 1]) over which the segment is
 * inside the bbox, or `null` if the segment never enters it.
 *
 * The bbox is treated as closed on all four edges (inclusive).
 */
function liangBarsky(
  a: [number, number],
  b: [number, number],
  bbox: BBox,
): [number, number] | null {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  // p[i] = -normal·direction, q[i] = signed distance from a to the edge.
  // Order: left, right, bottom, top.
  const p = [-dx, dx, -dy, dy];
  const q = [a[0] - bbox.west, bbox.east - a[0], a[1] - bbox.south, bbox.north - a[1]];

  let t0 = 0;
  let t1 = 1;
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      // Parallel to this edge. Outside if q[i] < 0; otherwise fine.
      if (q[i] < 0) return null;
    } else {
      const t = q[i] / p[i];
      if (p[i] < 0) {
        // Entering edge: t lower bound.
        if (t > t1) return null;
        if (t > t0) t0 = t;
      } else {
        // Exiting edge: t upper bound.
        if (t < t0) return null;
        if (t < t1) t1 = t;
      }
    }
  }
  return [t0, t1];
}

/**
 * Clip a polyline against a lng/lat rectangle. Returns 0+ polyline
 * pieces, each entirely inside (or on the boundary of) the rectangle.
 *
 * The clip vertices are computed parametrically from the segment that
 * crosses the boundary, so adjacent tiles that share an edge of the
 * rectangle compute the *same* lng/lat for their respective clip points
 * (modulo float jitter that ε in `stitch` then absorbs). This is what
 * lets a road that crosses a tile boundary mid-segment reconnect when
 * the per-tile linestrings get stitched.
 */
export function clipPolylineToBBox(
  coords: [number, number][],
  bbox: BBox,
): [number, number][][] {
  if (coords.length < 2) return [];

  const lerp = (a: [number, number], b: [number, number], t: number): [number, number] => [
    a[0] + t * (b[0] - a[0]),
    a[1] + t * (b[1] - a[1]),
  ];

  const pieces: [number, number][][] = [];
  let cur: [number, number][] = [];

  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i];
    const b = coords[i + 1];
    const tt = liangBarsky(a, b, bbox);
    if (!tt) {
      if (cur.length >= 2) pieces.push(cur);
      cur = [];
      continue;
    }
    const [t0, t1] = tt;
    const enter = t0 === 0 ? a : lerp(a, b, t0);
    const exit = t1 === 1 ? b : lerp(a, b, t1);

    if (t0 > 0) {
      // New piece begins at the entry crossing.
      if (cur.length >= 2) pieces.push(cur);
      cur = [enter];
    } else if (cur.length === 0) {
      // Start of a fresh piece on an already-inside vertex.
      cur.push(enter);
    }
    cur.push(exit);

    if (t1 < 1) {
      // Closed at the exit crossing.
      pieces.push(cur);
      cur = [];
    }
  }
  if (cur.length >= 2) pieces.push(cur);
  return pieces;
}
