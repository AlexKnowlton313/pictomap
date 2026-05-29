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
  import {
    DEFAULT_MANIFEST_URL,
    fetchManifest,
    isInRegion,
    resolveRegionUrl,
    selectRegion,
    type ManifestRegion,
  } from '../tiles/manifest';

  let container: HTMLDivElement;
  let map: maplibregl.Map | null = null;
  let userMarker: maplibregl.Marker | null = null;
  let userLocation = $state<LngLat | null>(null);
  let locating = $state(false);
  let geoError = $state<string | null>(null);
  let booting = $state(true);
  let bootError = $state<string | null>(null);
  let currentRegion = $state<ManifestRegion | null>(null);
  let outOfRegion = $state(false);
  let showGraph = $state(false);

  const MANIFEST_URL =
    import.meta.env.VITE_TILES_MANIFEST_URL || DEFAULT_MANIFEST_URL;

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
    if (!map || !currentRegion) return;
    locating = true;
    geoError = null;
    outOfRegion = false;
    try {
      const pos = await getCurrentPosition();
      userLocation = pos;
      if (!isInRegion(currentRegion, pos.lng, pos.lat)) {
        // Outside the current region's maxBounds — flyTo would clamp and
        // the marker would be invisible. Prompt the user to refresh so we
        // can pick the right region on next boot.
        outOfRegion = true;
        return;
      }
      showUserMarker(pos);
      map.flyTo({ center: [pos.lng, pos.lat], zoom: LOCATED_ZOOM, essential: true });
    } catch (err) {
      const code = (err as GeolocationPositionError | undefined)?.code;
      if (code === 1) geoError = 'Location permission denied';
      else if (code === 3) geoError = 'Location request timed out';
      else geoError = 'Could not get location';
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
          'motorway', '#f43f5e',
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

  function initMap(region: ManifestRegion, center: LngLat, located: boolean): void {
    const pmtilesUrl = resolveRegionUrl(MANIFEST_URL, region);
    registerPMTilesProtocol();

    map = new maplibregl.Map({
      container,
      style: buildBasemapStyle(pmtilesUrl),
      center: [center.lng, center.lat],
      zoom: located ? LOCATED_ZOOM : FALLBACK_ZOOM,
      minZoom: MIN_ZOOM,
      // Lock panning to the region we have tiles for. Crossing into another
      // region requires a page refresh so we can re-pick the manifest entry.
      maxBounds: [
        [region.bbox[0], region.bbox[1]],
        [region.bbox[2], region.bbox[3]],
      ],
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

    if (located) {
      showUserMarker(center);
    }
  }

  async function tryGeolocate(): Promise<{ location: LngLat | null; error: string | null }> {
    try {
      return { location: await getCurrentPosition(), error: null };
    } catch (err) {
      const code = (err as GeolocationPositionError | undefined)?.code;
      if (code === 1) return { location: null, error: 'Location permission denied' };
      if (code === 3) return { location: null, error: 'Location request timed out' };
      return { location: null, error: 'Could not get location' };
    }
  }

  onMount(async () => {
    try {
      // Fetch manifest and geolocate in parallel — boot blocks on the slower
      // of the two (usually geolocation, capped at ~7s by getCurrentPosition).
      const [manifest, geo] = await Promise.all([
        fetchManifest(MANIFEST_URL),
        tryGeolocate(),
      ]);

      const initialLocation = geo.location ?? FALLBACK_LOCATION;
      const located = geo.location !== null;
      if (geo.location) userLocation = geo.location;
      if (geo.error) geoError = geo.error;

      const region = selectRegion(manifest, initialLocation.lng, initialLocation.lat);
      currentRegion = region;

      initMap(region, initialLocation, located);
    } catch (err) {
      bootError = err instanceof Error ? err.message : String(err);
    } finally {
      booting = false;
    }
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

{#if booting}
  <div class="boot-overlay">
    <div class="boot-spinner"></div>
    <span>Loading map…</span>
  </div>
{/if}

{#if bootError}
  <div class="error-banner">
    <strong>Map failed to load.</strong>
    {bootError}
  </div>
{/if}

{#if outOfRegion && currentRegion}
  <div class="info-banner">
    Your location is outside the <strong>{currentRegion.name}</strong> tile region.
    <button class="link" onclick={() => window.location.reload()}>Refresh</button>
    to load tiles for your location.
  </div>
{/if}

<div class="panel">
  <button onclick={locate} disabled={locating || booting} title="Re-center on my location">
    {#if locating}Locating…{:else}📍 Re-center{/if}
  </button>
  <button
    onclick={toggleGraph}
    disabled={!graphStore.graph}
    title="Toggle the extracted road graph overlay"
  >
    {showGraph ? 'Hide' : 'Show'} graph
  </button>
  {#if currentRegion}
    <span class="muted" title="Active tile region">
      {currentRegion.name}
    </span>
  {/if}
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

  .info-banner {
    position: absolute;
    top: 16px;
    left: 50%;
    transform: translateX(-50%);
    max-width: 560px;
    padding: 10px 14px;
    background: var(--panel);
    border: 1px solid var(--panel-border);
    border-radius: 12px;
    color: var(--fg);
    font-size: 13px;
    z-index: 20;
  }

  .info-banner .link {
    background: none;
    border: none;
    padding: 0;
    color: var(--accent);
    text-decoration: underline;
    cursor: pointer;
    font: inherit;
  }

  .boot-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 16px;
    background: var(--panel);
    color: var(--fg);
    font-size: 14px;
    z-index: 30;
  }

  .boot-spinner {
    width: 32px;
    height: 32px;
    border: 3px solid var(--panel-border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.9s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
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
