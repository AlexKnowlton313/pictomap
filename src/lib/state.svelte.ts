import type { LoadedImage } from './image/load';
import type { Point } from './image/trace';
import type { OverlayState } from './overlay/state';
import type { MatchResultMsg } from './graph/types';

/**
 * Central reactive state for the app. Components read/write via the exported
 * `state` singleton — keeps Map, ImageUploader, ContourEditor, Overlay, and
 * the matcher coordinated without prop-drilling.
 */
class AppState {
  image = $state<LoadedImage | null>(null);
  contour = $state<Point[] | null>(null);
  overlay = $state<OverlayState | null>(null);
  /** Last-snapped route (worker output). Cleared when overlay changes. */
  matched = $state.raw<MatchResultMsg | null>(null);
  /** True while a match request is in flight. */
  matching = $state(false);
  /** Last match error / reason for an empty result. Null when ok. */
  matchStatus = $state<string | null>(null);

  reset(): void {
    this.image?.bitmap.close();
    this.image = null;
    this.contour = null;
    this.overlay = null;
    this.matched = null;
    this.matchStatus = null;
  }

  /** Drop the traced contour and its placed overlay. Keeps the source image. */
  clearTrace(): void {
    this.contour = null;
    this.overlay = null;
    this.matched = null;
    this.matchStatus = null;
  }
}

export const state = new AppState();
