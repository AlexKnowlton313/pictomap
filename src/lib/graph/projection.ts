/**
 * Equirectangular lng/lat ⇄ local meters, anchored at a reference point.
 *
 * Used inside the matcher to convert the graph + input contour to a flat
 * Euclidean plane so per-point geometry (distance, projection, bearing)
 * is cheap. Distortion is <0.1% at the 5km scale we operate on.
 */

const M_PER_DEG_LAT = 111_320;

export interface LocalFrame {
  refLng: number;
  refLat: number;
  mPerDegLng: number;
}

export function frame(refLng: number, refLat: number): LocalFrame {
  return {
    refLng,
    refLat,
    mPerDegLng: M_PER_DEG_LAT * Math.cos((refLat * Math.PI) / 180),
  };
}

export function toLocal(f: LocalFrame, lng: number, lat: number): [number, number] {
  return [(lng - f.refLng) * f.mPerDegLng, (lat - f.refLat) * M_PER_DEG_LAT];
}

export function fromLocal(f: LocalFrame, x: number, y: number): [number, number] {
  return [f.refLng + x / f.mPerDegLng, f.refLat + y / M_PER_DEG_LAT];
}
