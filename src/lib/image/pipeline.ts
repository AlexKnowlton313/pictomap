import simplify from 'simplify-js';
import { keepLargestComponent, thresholdImage, type ThresholdOptions } from './threshold';
import { traceBoundary, type Point } from './trace';

export interface ContourOptions extends ThresholdOptions {
  /** RDP starting tolerance in pixels. Auto-grows if result exceeds maxPoints. */
  simplifyTolerance?: number;
  /** Cap on output polyline length. */
  maxPoints?: number;
  /** Floor on output polyline length — for very simple shapes. */
  minPoints?: number;
}

export interface ContourResult {
  /** Boundary polyline in pixel space. Not closed (caller appends if needed). */
  contour: Point[];
  /** Original raw boundary length, pre-RDP. */
  rawLength: number;
  /** Foreground pixel count of the kept component. */
  pixelCount: number;
  /** Source dimensions in pixel space. */
  source: { width: number; height: number };
}

const DEFAULT_TOLERANCE = 1.5;
const DEFAULT_MAX_POINTS = 100;
const DEFAULT_MIN_POINTS = 30;

export function extractContour(
  imageData: ImageData,
  opts: ContourOptions,
): ContourResult | null {
  const { width, height } = imageData;
  const mask = thresholdImage(imageData.data, width, height, opts);
  const cleaned = keepLargestComponent(mask, width, height);

  let pixelCount = 0;
  for (let i = 0; i < cleaned.length; i++) pixelCount += cleaned[i];
  if (pixelCount === 0) return null;

  const boundary = traceBoundary(cleaned, width, height);
  if (boundary.length < 3) return null;

  const maxPoints = opts.maxPoints ?? DEFAULT_MAX_POINTS;
  const minPoints = opts.minPoints ?? DEFAULT_MIN_POINTS;
  let tol = opts.simplifyTolerance ?? DEFAULT_TOLERANCE;
  let simplified = simplify(boundary, tol, true);

  // Tighten tolerance if we got too many points.
  for (let i = 0; i < 12 && simplified.length > maxPoints; i++) {
    tol *= 1.6;
    simplified = simplify(boundary, tol, true);
  }
  // Loosen if too few (very simple shape).
  for (let i = 0; i < 12 && simplified.length < minPoints && tol > 0.25; i++) {
    tol /= 1.5;
    simplified = simplify(boundary, tol, true);
  }

  return {
    contour: simplified,
    rawLength: boundary.length,
    pixelCount,
    source: { width, height },
  };
}
