import type { Point } from '../image/trace';

export interface OverlayState {
  /** Image center in geographic coordinates. */
  anchor: { lng: number; lat: number };
  /** Clockwise rotation, degrees. 0 = image up = north. */
  rotationDeg: number;
  /** Image's real-world size: one source pixel covers this many meters. */
  metersPerPixel: number;
}

const DEFAULT_PERIMETER_METERS = 5000;

export function polylinePerimeter(pts: Point[]): number {
  if (pts.length < 2) return 0;
  let sum = 0;
  for (let i = 1; i < pts.length; i++) {
    sum += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  }
  // Treat the contour as closed for sizing — matches what users expect for
  // hearts, letters, etc., even though the matcher leaves it open (see
  // tasks.md "Closed shapes are returned open").
  sum += Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y);
  return sum;
}

export function defaultOverlay(
  anchor: { lng: number; lat: number },
  contour: Point[],
): OverlayState {
  const perimeterPx = polylinePerimeter(contour);
  return {
    anchor,
    rotationDeg: 0,
    metersPerPixel: perimeterPx > 0 ? DEFAULT_PERIMETER_METERS / perimeterPx : 1,
  };
}

/** Total real-world perimeter of the laid-down contour, in meters. */
export function perimeterMeters(contour: Point[], state: OverlayState): number {
  return polylinePerimeter(contour) * state.metersPerPixel;
}
