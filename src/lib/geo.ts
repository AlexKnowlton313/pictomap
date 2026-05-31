/**
 * Flat-earth scale shared by every local-meter computation in the app.
 *
 * One degree of latitude is ~this many meters everywhere; one degree of
 * longitude shrinks by cos(latitude). Good to ~0.1% at city scale, which is
 * all the matcher, overlay, and debug router need.
 *
 * Distinct from `graph/tile-math.ts`'s `EARTH_RADIUS_M`, which backs the
 * spherical haversine used for tile/bbox sizing — don't conflate the two.
 */

export const METERS_PER_DEG_LAT = 111_320;

/** Meters per degree of longitude at the given latitude. */
export function metersPerDegLng(lat: number): number {
  return METERS_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
}
