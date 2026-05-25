import type { LoadedImage } from './image/load';
import type { Point } from './image/trace';
import type { OverlayState } from './overlay/state';

/**
 * Central reactive state for the app. Components read/write via the exported
 * `state` singleton — keeps Map, ImageUploader, ContourEditor, Overlay, and
 * (soon) the matcher coordinated without prop-drilling.
 */
class AppState {
  image = $state<LoadedImage | null>(null);
  contour = $state<Point[] | null>(null);
  overlay = $state<OverlayState | null>(null);

  reset(): void {
    this.image?.bitmap.close();
    this.image = null;
    this.contour = null;
    this.overlay = null;
  }

  /** Drop the traced contour and its placed overlay. Keeps the source image. */
  clearTrace(): void {
    this.contour = null;
    this.overlay = null;
  }
}

export const state = new AppState();
