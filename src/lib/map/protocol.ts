import maplibregl from 'maplibre-gl';
import { Protocol } from 'pmtiles';

let registered = false;

/**
 * Wire the pmtiles:// protocol into MapLibre. Idempotent — safe to call once
 * per app boot. Without this, MapLibre cannot resolve pmtiles:// sources.
 */
export function registerPMTilesProtocol(): void {
  if (registered) return;
  const protocol = new Protocol({ metadata: true });
  maplibregl.addProtocol('pmtiles', protocol.tile);
  registered = true;
}
