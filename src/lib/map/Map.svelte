<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import maplibregl from 'maplibre-gl';
  import 'maplibre-gl/dist/maplibre-gl.css';
  import { registerPMTilesProtocol } from './protocol';
  import { buildBasemapStyle } from './style';
  import { mapStore } from './store.svelte';
  import {
    FALLBACK_LOCATION,
    FALLBACK_ZOOM,
    LOCATED_ZOOM,
    getCurrentPosition,
    type LngLat,
  } from './geolocate';
  import { GraphService } from '../graph/service';
  import { graphStore } from '../graph/store.svelte';
  import { bboxContains, expandBBox } from '../graph/tile-math';
  import type { BBox, RoadGraph } from '../graph/types';
  import { state as appState } from '../state.svelte';

  let container: HTMLDivElement;
  let map: maplibregl.Map | null = null;
  let userMarker: maplibregl.Marker | null = null;
  let userLocation = $state<LngLat | null>(null);
  let locating = $state(false);
  let geoError = $state<string | null>(null);
  let mapMissing = $state(false);
  let showGraph = $state(false);

  const pmtilesUrl = import.meta.env.VITE_PMTILES_URL;

  /**
   * Extra meters kept around the visible viewport in the graph bbox.
   * Small pans within this margin don't trigger a rebuild.
   */
  const GRAPH_BUFFER_M = 1000;
  /** Debounce on moveend → rebuild check, ms. */
  const REBUILD_DEBOUNCE_MS = 300;
  /**
   * Bottom of the zoom range. At zoom 12 the 120px scale bar reads
   * "2 km" at temperate latitudes — wider would mean a graph too large
   * to comfortably hold in memory.
   */
  const MIN_ZOOM = 12;

  const GRAPH_SOURCE_ID = 'pictomap-debug-graph';
  const GRAPH_LAYER_ID = 'pictomap-debug-graph-line';
  const ROUTE_SOURCE_ID = 'pictomap-route';
  const ROUTE_LAYER_ID = 'pictomap-route-line';

  function showUserMarker(pos: LngLat): void {
    if (!map) return;
    if (!userMarker) {
      const el = document.createElement('div');
      el.className = 'user-marker';
      userMarker = new maplibregl.Marker({ element: el }).setLngLat([pos.lng, pos.lat]).addTo(map);
    } else {
      userMarker.setLngLat([pos.lng, pos.lat]);
    }
  }

  async function locate(): Promise<void> {
    locating = true;
    geoError = null;
    try {
      const pos = await getCurrentPosition();
      userLocation = pos;
      showUserMarker(pos);
      // flyTo's moveend will trigger the graph rebuild for the user location.
      map?.flyTo({ center: [pos.lng, pos.lat], zoom: LOCATED_ZOOM, essential: true });
    } catch (err) {
      const code = (err as GeolocationPositionError | undefined)?.code;
      if (code === 1) geoError = 'Location permission denied';
      else if (code === 3) geoError = 'Location request timed out';
      else geoError = 'Could not get location';
      // No flyTo, so prime the build for whatever view we're currently on.
      scheduleRebuild(0);
    } finally {
      locating = false;
    }
  }

  function graphToGeoJSON(g: RoadGraph): GeoJSON.FeatureCollection {
    return {
      type: 'FeatureCollection',
      features: g.edges.map((e) => ({
        type: 'Feature',
        properties: { klass: e.klass, length: e.length },
        geometry: { type: 'LineString', coordinates: e.coords },
      })),
    };
  }

  function renderGraph(g: RoadGraph): void {
    if (!map) return;
    const data = graphToGeoJSON(g);
    const existing = map.getSource(GRAPH_SOURCE_ID) as
      | maplibregl.GeoJSONSource
      | undefined;
    if (existing) {
      existing.setData(data);
      return;
    }
    map.addSource(GRAPH_SOURCE_ID, { type: 'geojson', data });
    map.addLayer({
      id: GRAPH_LAYER_ID,
      type: 'line',
      source: GRAPH_SOURCE_ID,
      layout: {
        'line-cap': 'round',
        'line-join': 'round',
        visibility: showGraph ? 'visible' : 'none',
      },
      paint: {
        'line-color': [
          'match',
          ['get', 'klass'],
          'major', '#ff7a45',
          'minor', '#ffd24d',
          'residential', '#9fe870',
          'path', '#4ad6ff',
          'service', '#a78bfa',
          /* other */ '#cbd5e1',
        ],
        'line-width': [
          'interpolate',
          ['linear'],
          ['zoom'],
          12, 0.4,
          16, 2.2,
          19, 5,
        ],
        'line-opacity': 0.85,
      },
    });
  }

  function toggleGraph(): void {
    showGraph = !showGraph;
    if (!map || !map.getLayer(GRAPH_LAYER_ID)) return;
    map.setLayoutProperty(
      GRAPH_LAYER_ID,
      'visibility',
      showGraph ? 'visible' : 'none',
    );
  }

  /**
   * Build the graph for the current viewport plus a buffer. Skips work
   * when the existing graph already covers the buffered viewport.
   *
   * Single-flight: while a build is in flight, the most recent moveend
   * sets `pendingRebuild` and the post-build hook re-checks. This
   * collapses a burst of pan events into one final build.
   */
  let rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  let buildInFlight = false;
  let pendingRebuild = false;

  function viewportBBox(): BBox | null {
    if (!map) return null;
    const b = map.getBounds();
    return {
      west: b.getWest(),
      south: b.getSouth(),
      east: b.getEast(),
      north: b.getNorth(),
    };
  }

  function scheduleRebuild(delayMs: number = REBUILD_DEBOUNCE_MS): void {
    if (rebuildTimer) clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => {
      rebuildTimer = null;
      void maybeRebuild();
    }, delayMs);
  }

  async function maybeRebuild(): Promise<void> {
    const svc = graphStore.service;
    if (!svc) return;
    const vp = viewportBBox();
    if (!vp) return;
    const needed = expandBBox(vp, GRAPH_BUFFER_M);

    if (graphStore.graph && bboxContains(graphStore.graph.bbox, needed)) {
      return; // existing graph already covers viewport + buffer
    }

    if (buildInFlight) {
      pendingRebuild = true;
      return;
    }

    buildInFlight = true;
    graphStore.building = true;
    graphStore.error = null;
    try {
      const graph = await svc.buildGraph(needed);
      graphStore.graph = graph;
      renderGraph(graph);
    } catch (err) {
      graphStore.error = err instanceof Error ? err.message : String(err);
    } finally {
      buildInFlight = false;
      graphStore.building = false;
      if (pendingRebuild) {
        pendingRebuild = false;
        scheduleRebuild(0);
      }
    }
  }

  function renderRoute(coords: [number, number][] | null): void {
    if (!map) return;
    const data: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: coords && coords.length >= 2
        ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } }]
        : [],
    };
    const existing = map.getSource(ROUTE_SOURCE_ID) as
      | maplibregl.GeoJSONSource
      | undefined;
    if (existing) {
      existing.setData(data);
      return;
    }
    map.addSource(ROUTE_SOURCE_ID, { type: 'geojson', data });
    map.addLayer({
      id: ROUTE_LAYER_ID,
      type: 'line',
      source: ROUTE_SOURCE_ID,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#ff6a3d',
        'line-width': ['interpolate', ['linear'], ['zoom'], 12, 2.5, 16, 5, 19, 8],
        'line-opacity': 0.95,
      },
    });
  }

  $effect(() => {
    renderRoute(appState.matched ? appState.matched.coords : null);
  });

  onMount(async () => {
    if (!pmtilesUrl) {
      mapMissing = true;
      return;
    }
    registerPMTilesProtocol();

    map = new maplibregl.Map({
      container,
      style: buildBasemapStyle(pmtilesUrl),
      center: [FALLBACK_LOCATION.lng, FALLBACK_LOCATION.lat],
      zoom: FALLBACK_ZOOM,
      minZoom: MIN_ZOOM,
      attributionControl: { compact: true },
      hash: false,
    });

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: 'metric' }), 'bottom-left');

    map.once('load', () => {
      mapStore.instance = map;
    });

    // Track viewport pans: rebuild the graph when the visible bbox
    // (plus buffer) no longer fits inside the previously-built one.
    map.on('moveend', () => scheduleRebuild());

    graphStore.service = new GraphService(pmtilesUrl);

    // Fire-and-forget — if it fails we keep the fallback view, and
    // the catch path inside locate() will still trigger a build.
    locate();
  });

  onDestroy(() => {
    mapStore.instance = null;
    userMarker?.remove();
    userMarker = null;
    map?.remove();
    map = null;
    graphStore.service?.destroy();
    graphStore.service = null;
    graphStore.graph = null;
  });
</script>

<div class="map" bind:this={container}></div>

{#if mapMissing}
  <div class="error-banner">
    <strong>Missing <code>VITE_PMTILES_URL</code>.</strong>
    Copy <code>.env.example</code> to <code>.env</code> and set it to a PMTiles archive URL.
  </div>
{/if}

<div class="panel">
  <button onclick={locate} disabled={locating} title="Re-center on my location">
    {#if locating}Locating…{:else}📍 Re-center{/if}
  </button>
  <button
    onclick={toggleGraph}
    disabled={!graphStore.graph}
    title="Toggle the extracted road graph overlay"
  >
    {showGraph ? 'Hide' : 'Show'} graph
  </button>
  {#if userLocation}
    <span class="coords" title="Your location">
      {userLocation.lat.toFixed(4)}, {userLocation.lng.toFixed(4)}
    </span>
  {/if}
  {#if graphStore.building}
    <span class="muted">Building graph…</span>
  {:else if graphStore.graph}
    <span class="muted" title="Edges · nodes · tiles · build ms">
      {graphStore.graph.edges.length}e · {graphStore.graph.nodes.length}n ·
      {graphStore.graph.tileCount}t · {graphStore.graph.buildMs}ms
    </span>
  {/if}
  {#if geoError}
    <span class="err" role="alert">{geoError}</span>
  {/if}
  {#if graphStore.error}
    <span class="err" role="alert">Graph: {graphStore.error}</span>
  {/if}
</div>

<style>
  .map {
    position: absolute;
    inset: 0;
  }

  .panel {
    position: absolute;
    top: 16px;
    left: 16px;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 10px;
    background: var(--panel);
    border: 1px solid var(--panel-border);
    border-radius: 12px;
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.32);
    z-index: 10;
  }

  .coords {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--muted);
  }

  .muted {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--muted);
  }

  .err {
    font-size: 12px;
    color: var(--accent);
  }

  .error-banner {
    position: absolute;
    top: 16px;
    left: 50%;
    transform: translateX(-50%);
    max-width: 560px;
    padding: 12px 16px;
    background: var(--panel);
    border: 1px solid var(--accent);
    border-radius: 12px;
    color: var(--fg);
    font-size: 14px;
    z-index: 20;
  }

  .error-banner code {
    font-family: var(--font-mono);
    font-size: 13px;
    background: rgba(255, 255, 255, 0.06);
    padding: 1px 6px;
    border-radius: 4px;
  }

  :global(.user-marker) {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: #3b82f6;
    border: 2.5px solid #fff;
    box-shadow: 0 0 0 4px rgba(59, 130, 246, 0.25), 0 2px 6px rgba(0, 0, 0, 0.4);
  }
</style>
