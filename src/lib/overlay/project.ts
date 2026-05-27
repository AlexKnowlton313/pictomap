import type { Point } from '../image/trace';
import { offsetLngLat } from './geo';
import type { OverlayState } from './state';

/**
 * Project a pixel-space contour onto world coordinates using the overlay's
 * affine transform (translation + rotation + uniform scale).
 *
 * Image frame: +x right, +y down (canvas convention). The image is
 * "rotated clockwise by `rotationDeg`" as displayed on a north-up map —
 * same sign convention as CSS rotate().
 *
 * Derivation: a clockwise rotation by θ takes image-right (1,0) to screen
 * (cos θ, sin θ) and image-down (0,1) to (−sin θ, cos θ). Screen +y is
 * south, so:
 *   east  =  dx·cosθ − dy·sinθ
 *   north = −dx·sinθ − dy·cosθ
 * (offsets in image pixels, multiplied by metersPerPixel).
 *
 * Pure function — safe to call from the worker.
 */
export function projectContourToLngLat(
  contour: Point[],
  imageWidth: number,
  imageHeight: number,
  overlay: OverlayState,
): [number, number][] {
  const cx = imageWidth / 2;
  const cy = imageHeight / 2;
  const θ = (overlay.rotationDeg * Math.PI) / 180;
  const cosθ = Math.cos(θ);
  const sinθ = Math.sin(θ);
  const mpp = overlay.metersPerPixel;
  const { lng: anchorLng, lat: anchorLat } = overlay.anchor;

  const out: [number, number][] = new Array(contour.length);
  for (let i = 0; i < contour.length; i++) {
    const dx = contour[i].x - cx;
    const dy = contour[i].y - cy;
    const eastM = (dx * cosθ - dy * sinθ) * mpp;
    const northM = (-dx * sinθ - dy * cosθ) * mpp;
    const ll = offsetLngLat(anchorLng, anchorLat, eastM, northM);
    out[i] = [ll.lng, ll.lat];
  }
  return out;
}
