/**
 * Minimal binary min-heap keyed on a number priority. Used by bounded
 * Dijkstra. Each entry is opaque to the heap (any payload).
 *
 * push/pop are O(log n). We avoid a generic class with comparators because
 * the hot loop benefits from inline numeric comparison.
 */

export class MinHeap<T> {
  private heap: { p: number; v: T }[] = [];

  get size(): number {
    return this.heap.length;
  }

  push(priority: number, value: T): void {
    const h = this.heap;
    h.push({ p: priority, v: value });
    let i = h.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (h[parent].p <= h[i].p) break;
      [h[parent], h[i]] = [h[i], h[parent]];
      i = parent;
    }
  }

  pop(): { p: number; v: T } | undefined {
    const h = this.heap;
    if (h.length === 0) return undefined;
    const top = h[0];
    const last = h.pop()!;
    if (h.length > 0) {
      h[0] = last;
      let i = 0;
      const n = h.length;
      while (true) {
        const l = 2 * i + 1;
        const r = 2 * i + 2;
        let best = i;
        if (l < n && h[l].p < h[best].p) best = l;
        if (r < n && h[r].p < h[best].p) best = r;
        if (best === i) break;
        [h[i], h[best]] = [h[best], h[i]];
        i = best;
      }
    }
    return top;
  }
}
