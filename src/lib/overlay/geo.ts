/**
 * Equirectangular meter-to-degree helpers. Good enough at city scale
 * (<10km); the matcher uses MapLibre's own projection for anything precise.
 */

import { METERS_PER_DEG_LAT, metersPerDegLng } from '../geo';

export function degreesLngPerMeter(lat: number): number {
  return 1 / metersPerDegLng(lat);
}

export function degreesLatPerMeter(): number {
  return 1 / METERS_PER_DEG_LAT;
}

export function offsetLngLat(
  lng: number,
  lat: number,
  eastMeters: number,
  northMeters: number,
): { lng: number; lat: number } {
  return {
    lng: lng + eastMeters * degreesLngPerMeter(lat),
    lat: lat + northMeters * degreesLatPerMeter(),
  };
}
