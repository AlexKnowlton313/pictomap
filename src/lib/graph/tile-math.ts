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
