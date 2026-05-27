import type { GraphService } from './service';
import type { RoadGraph } from './types';

/**
 * Singleton holding the graph worker + the most-recent built graph.
 *
 * The service is shared across consumers: debug overlay reads `graph` to
 * draw road lines; the matcher (Task 6c) will reach in for the same graph
 * to query candidates and shortest paths.
 *
 * `.raw` on `service` because Worker is opaque to reactivity; `.raw` on
 * `graph` because it's a large flat blob and we don't want fine-grained
 * proxying — consumers re-render on identity change only.
 */
class GraphStore {
  service = $state.raw<GraphService | null>(null);
  graph = $state.raw<RoadGraph | null>(null);
  /** True while a build is in flight. */
  building = $state(false);
  /** Last build error message; null when the latest build succeeded. */
  error = $state<string | null>(null);
}

export const graphStore = new GraphStore();
