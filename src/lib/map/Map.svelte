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

  let container: HTMLDivElement;
  let map: maplibregl.Map | null = null;
  let userMarker: maplibregl.Marker | null = null;
  let userLocation = $state<LngLat | null>(null);
  let locating = $state(false);
  let geoError = $state<string | null>(null);
  let mapMissing = $state(false);

  const pmtilesUrl = import.meta.env.VITE_PMTILES_URL;

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
      map?.flyTo({ center: [pos.lng, pos.lat], zoom: LOCATED_ZOOM, essential: true });
    } catch (err) {
      const code = (err as GeolocationPositionError | undefined)?.code;
      if (code === 1) geoError = 'Location permission denied';
      else if (code === 3) geoError = 'Location request timed out';
      else geoError = 'Could not get location';
    } finally {
      locating = false;
    }
  }

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
      attributionControl: { compact: true },
      hash: false,
    });

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: 'metric' }), 'bottom-left');

    map.once('load', () => {
      mapStore.instance = map;
    });

    // Fire-and-forget — if it fails we keep the fallback view.
    locate();
  });

  onDestroy(() => {
    mapStore.instance = null;
    userMarker?.remove();
    userMarker = null;
    map?.remove();
    map = null;
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
  {#if userLocation}
    <span class="coords" title="Your location">
      {userLocation.lat.toFixed(4)}, {userLocation.lng.toFixed(4)}
    </span>
  {/if}
  {#if geoError}
    <span class="err" role="alert">{geoError}</span>
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
