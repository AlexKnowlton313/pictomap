import type {
  BBox,
  DebugRoute,
  GraphSummary,
  MatchResultMsg,
  WorkerRequest,
  WorkerResponse,
} from './types';

/**
 * Main-thread wrapper around the graph worker. One service instance owns
 * one worker. Requests are correlated by an incrementing reqId.
 */
export class GraphService {
  private worker: Worker;
  private nextReqId = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private readyP: Promise<void>;

  constructor(pmtilesUrl: string, graphZoom: number) {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), {
      type: 'module',
      name: 'pictomap-graph',
    });
    this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => this.handle(e.data);
    this.worker.onerror = (e) => {
      for (const { reject } of this.pending.values()) reject(new Error(e.message));
      this.pending.clear();
    };

    this.readyP = new Promise((resolve, reject) => {
      const reqId = this.nextReqId++;
      this.pending.set(reqId, {
        resolve: () => resolve(),
        reject,
      });
      this.send({ type: 'init', reqId, pmtilesUrl, graphZoom });
    });
  }

  async buildGraph(bbox: BBox): Promise<GraphSummary> {
    await this.readyP;
    return new Promise((resolve, reject) => {
      const reqId = this.nextReqId++;
      this.pending.set(reqId, {
        resolve: (v) => resolve(v as GraphSummary),
        reject,
      });
      this.send({ type: 'buildGraph', reqId, bbox });
    });
  }

  async match(contour: [number, number][]): Promise<MatchResultMsg> {
    await this.readyP;
    return new Promise((resolve, reject) => {
      const reqId = this.nextReqId++;
      this.pending.set(reqId, {
        resolve: (v) => resolve(v as MatchResultMsg),
        reject,
      });
      this.send({ type: 'match', reqId, contour });
    });
  }

  /** Debug overlay: fetch the worker-resident graph as GeoJSON on demand. */
  async graphGeoJSON(): Promise<GeoJSON.FeatureCollection> {
    await this.readyP;
    return new Promise((resolve, reject) => {
      const reqId = this.nextReqId++;
      this.pending.set(reqId, {
        resolve: (v) => resolve(v as GeoJSON.FeatureCollection),
        reject,
      });
      this.send({ type: 'graphGeoJSON', reqId });
    });
  }

  /** Debug probe: shortest node-network path between two clicks. */
  async debugRoute(a: [number, number], b: [number, number]): Promise<DebugRoute | null> {
    await this.readyP;
    return new Promise((resolve, reject) => {
      const reqId = this.nextReqId++;
      this.pending.set(reqId, {
        resolve: (v) => resolve(v as DebugRoute | null),
        reject,
      });
      this.send({ type: 'debugRoute', reqId, a, b });
    });
  }

  destroy(): void {
    this.worker.terminate();
    this.pending.clear();
  }

  private send(req: WorkerRequest): void {
    this.worker.postMessage(req);
  }

  private handle(res: WorkerResponse): void {
    const p = this.pending.get(res.reqId);
    if (!p) return;
    this.pending.delete(res.reqId);
    if (res.type === 'ready') p.resolve(undefined);
    else if (res.type === 'graph') p.resolve(res.summary);
    else if (res.type === 'match') p.resolve(res.result);
    else if (res.type === 'graphGeoJSON') p.resolve(res.geojson);
    else if (res.type === 'debugRoute') p.resolve(res.route);
    else p.reject(new Error(res.message));
  }
}
