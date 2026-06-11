import type { GraphService } from './service';
import type { GraphSummary } from './types';

/**
 * Singleton holding the graph worker + the most-recent build's summary.
 *
 * The full RoadGraph stays in the worker (matching, debug GeoJSON and the
 * route probe all run there); the main thread only keeps the summary —
 * bbox for rebuild checks, counts/timings for the HUD.
 *
 * `.raw` on `service` because Worker is opaque to reactivity; `.raw` on
 * `summary` because consumers re-render on identity change only.
 */
class GraphStore {
  service = $state.raw<GraphService | null>(null);
  summary = $state.raw<GraphSummary | null>(null);
  /** True while a build is in flight. */
  building = $state(false);
  /** Last build error message; null when the latest build succeeded. */
  error = $state<string | null>(null);
}

export const graphStore = new GraphStore();
