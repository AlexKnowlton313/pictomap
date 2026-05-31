export interface LngLat {
  lng: number;
  lat: number;
}

/**
 * Fallback when the browser blocks geolocation or no fix arrives in time.
 * Chosen to be on land in a city so the basemap renders something useful.
 */
export const FALLBACK_LOCATION: LngLat = { lng: -73.9857, lat: 40.7484 }; // Manhattan
export const FALLBACK_ZOOM = 14;
export const LOCATED_ZOOM = 15;

const GEO_TIMEOUT_MS = 7000;

export async function getCurrentPosition(): Promise<LngLat> {
  if (!('geolocation' in navigator)) {
    throw new Error('Geolocation API not available');
  }
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lng: pos.coords.longitude, lat: pos.coords.latitude }),
      (err) => reject(err),
      { enableHighAccuracy: true, timeout: GEO_TIMEOUT_MS, maximumAge: 60_000 },
    );
  });
}

/** Map a geolocation rejection to a user-facing message. */
export function geolocationErrorMessage(err: unknown): string {
  const code = (err as GeolocationPositionError | undefined)?.code;
  if (code === 1) return 'Location permission denied';
  if (code === 3) return 'Location request timed out';
  return 'Could not get location';
}
