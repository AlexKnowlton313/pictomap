import type { Map as MapLibreMap } from 'maplibre-gl';

/**
 * Holds the live MapLibre instance so non-Map components (Overlay, matcher
 * UI) can read map state without prop-drilling through the App tree.
 *
 * `.raw` because the instance is mutable and reactivity should fire only on
 * identity changes (mount / teardown), not on internal mutations.
 */
class MapStore {
  instance = $state.raw<MapLibreMap | null>(null);
}

export const mapStore = new MapStore();
