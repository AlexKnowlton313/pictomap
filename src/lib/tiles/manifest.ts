/**
 * Tile manifest — fetched at app startup, drives runtime region selection.
 *
 * The manifest lives at a stable URL (`/tiles/manifest.json` by default) and
 * is re-uploaded by the weekly tiles workflow. Each region entry stores only
 * a bare `filename` so URLs resolve relative to wherever the manifest itself
 * is hosted — that way dev (via Vite proxy) and prod (same-origin) both work
 * with no CORS configuration.
 */

export interface ManifestRegion {
  id: string;
  name: string;
  /** [minLng, minLat, maxLng, maxLat] */
  bbox: [number, number, number, number];
  filename: string;
  sizeBytes: number;
}

export interface TileManifest {
  generatedAt: string;
  sourceDate: string;
  minZoom: number;
  maxZoom: number;
  regions: ManifestRegion[];
}

export const DEFAULT_MANIFEST_URL = '/tiles/manifest.json';

export async function fetchManifest(url: string): Promise<TileManifest> {
  const res = await fetch(url, { cache: 'default' });
  if (!res.ok) throw new Error(`Manifest fetch failed: ${res.status} ${res.statusText}`);
  return (await res.json()) as TileManifest;
}

/**
 * Resolve a region's PMTiles URL relative to the manifest URL. Self-contained
 * so a manifest hosted anywhere works without per-environment URL plumbing.
 */
export function resolveRegionUrl(manifestUrl: string, region: ManifestRegion): string {
  const manifestAbs = new URL(manifestUrl, window.location.href);
  return new URL(region.filename, manifestAbs).toString();
}

/**
 * Pick the region whose bbox contains (lng, lat). Regions are ordered
 * most-specific first in tiles/regions.json; first match wins. Falls back
 * to the nearest-centroid region when no bbox matches — covers users on
 * uncategorized islands and the like, so the app always shows something.
 */
export function selectRegion(
  manifest: TileManifest,
  lng: number,
  lat: number,
): ManifestRegion {
  for (const r of manifest.regions) {
    const [minLng, minLat, maxLng, maxLat] = r.bbox;
    if (lng >= minLng && lng <= maxLng && lat >= minLat && lat <= maxLat) {
      return r;
    }
  }
  let best = manifest.regions[0];
  let bestDist = Infinity;
  for (const r of manifest.regions) {
    const [minLng, minLat, maxLng, maxLat] = r.bbox;
    const cLng = (minLng + maxLng) / 2;
    const cLat = (minLat + maxLat) / 2;
    const d = (lng - cLng) ** 2 + (lat - cLat) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = r;
    }
  }
  return best;
}

export function isInRegion(region: ManifestRegion, lng: number, lat: number): boolean {
  const [minLng, minLat, maxLng, maxLat] = region.bbox;
  return lng >= minLng && lng <= maxLng && lat >= minLat && lat <= maxLat;
}
