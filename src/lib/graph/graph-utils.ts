import type { GraphEdge } from './types';

/**
 * Undirected adjacency list: node id → indices of edges incident on it.
 * Shared by the matcher, the debug router, and component pruning, which all
 * walk the same node→edge structure.
 */
export function buildEdgeAdjacency(nodeCount: number, edges: GraphEdge[]): number[][] {
  const adj: number[][] = Array.from({ length: nodeCount }, () => []);
  for (let i = 0; i < edges.length; i++) {
    adj[edges[i].a].push(i);
    adj[edges[i].b].push(i);
  }
  return adj;
}
