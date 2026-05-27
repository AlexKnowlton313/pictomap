import { CLASSIFIER_VERSION } from './highway';
import type { RoadClass } from './types';

/**
 * IndexedDB cache for decoded per-tile road segments.
 *
 * Keys are `<pmtilesUrl>|c<CLASSIFIER_VERSION>|<z>/<x>/<y>`. Two reasons
 * the prefix has both parts:
 *   - The PMTiles URL embeds a build date, so swapping the env var
 *     invalidates the cache when underlying OSM data rotates.
 *   - CLASSIFIER_VERSION invalidates when our classification rules
 *     change — cached entries store post-classification segments, so a
 *     classifier change without this would silently serve stale labels.
 *
 * On init we drop entries whose prefix doesn't match the current one
 * (`evictOtherPrefixes`), so the DB doesn't grow without bound.
 *
 * All ops fail silently (return null / no-op) if IndexedDB is
 * unavailable — private-browsing Safari, quota errors, etc. — so the
 * graph build always proceeds even when the cache is non-functional.
 */

export interface CachedSegment {
  coords: [number, number][];
  klass: RoadClass;
}

const DB_NAME = 'pictomap-graph';
const DB_VERSION = 1;
const STORE = 'tile-roads';

export class TileCache {
  private dbP: Promise<IDBDatabase | null>;
  private prefix: string;

  constructor(pmtilesUrl: string) {
    this.prefix = `${pmtilesUrl}|c${CLASSIFIER_VERSION}`;
    this.dbP = this.openDb();
  }

  private openDb(): Promise<IDBDatabase | null> {
    return new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  private key(z: number, x: number, y: number): string {
    return `${this.prefix}|${z}/${x}/${y}`;
  }

  async get(z: number, x: number, y: number): Promise<CachedSegment[] | null> {
    const db = await this.dbP;
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).get(this.key(z, x, y));
        req.onsuccess = () => resolve((req.result as CachedSegment[] | undefined) ?? null);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  async put(z: number, x: number, y: number, segs: CachedSegment[]): Promise<void> {
    const db = await this.dbP;
    if (!db) return;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(segs, this.key(z, x, y));
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      } catch {
        resolve();
      }
    });
  }

  /** Drop cache entries from any pmtiles URL other than the current one. */
  async evictOtherPrefixes(): Promise<void> {
    const db = await this.dbP;
    if (!db) return;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        const req = store.openKeyCursor();
        const keep = this.prefix + '|';
        let dropped = 0;
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) return;
          const k = cursor.key;
          if (typeof k === 'string' && !k.startsWith(keep)) {
            store.delete(k);
            dropped++;
          }
          cursor.continue();
        };
        tx.oncomplete = () => {
          if (dropped > 0) console.log(`[graph] evicted ${dropped} stale cache entries`);
          resolve();
        };
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      } catch {
        resolve();
      }
    });
  }
}
