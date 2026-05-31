/**
 * Equirectangular lng/lat ⇄ local meters, anchored at a reference point.
 *
 * Used inside the matcher to convert the graph + input contour to a flat
 * Euclidean plane so per-point geometry (distance, projection, bearing)
 * is cheap. Distortion is <0.1% at the 5km scale we operate on.
 */

import { METERS_PER_DEG_LAT, metersPerDegLng } from '../geo';

export interface LocalFrame {
  refLng: number;
  refLat: number;
  mPerDegLng: number;
}

export function frame(refLng: number, refLat: number): LocalFrame {
  return {
    refLng,
    refLat,
    mPerDegLng: metersPerDegLng(refLat),
  };
}

export function toLocal(f: LocalFrame, lng: number, lat: number): [number, number] {
  return [(lng - f.refLng) * f.mPerDegLng, (lat - f.refLat) * METERS_PER_DEG_LAT];
}

export function fromLocal(f: LocalFrame, x: number, y: number): [number, number] {
  return [f.refLng + x / f.mPerDegLng, f.refLat + y / METERS_PER_DEG_LAT];
}
