<script lang="ts">
  import Map from './lib/map/Map.svelte';
  import { mapStore } from './lib/map/store.svelte';
  import ImageUploader from './lib/image/ImageUploader.svelte';
  import ContourEditor from './lib/image/ContourEditor.svelte';
  import Overlay from './lib/overlay/Overlay.svelte';
  import { defaultOverlay, perimeterMeters } from './lib/overlay/state';
  import { projectContourToLngLat } from './lib/overlay/project';
  import { state } from './lib/state.svelte';
  import { graphStore } from './lib/graph/store.svelte';
  import type { Point } from './lib/image/trace';

  /** Debounce window between transform-end and re-match, ms. */
  const SNAP_DEBOUNCE_MS = 300;

  let snapTimer: ReturnType<typeof setTimeout> | null = null;
  /** Generation counter — results from older snaps are discarded. */
  let snapGen = 0;

  function onContourAccepted(contour: Point[]): void {
    state.contour = contour;
    const map = mapStore.instance;
    if (!map) return;
    const c = map.getCenter();
    state.overlay = defaultOverlay({ lng: c.lng, lat: c.lat }, contour);
    scheduleSnap(0); // initial snap on placement
  }

  function scheduleSnap(delayMs: number = SNAP_DEBOUNCE_MS): void {
    if (snapTimer) clearTimeout(snapTimer);
    snapTimer = setTimeout(() => {
      snapTimer = null;
      snapToRoads();
    }, delayMs);
  }

  async function snapToRoads(): Promise<void> {
    const svc = graphStore.service;
    if (!svc || !state.image || !state.contour || !state.overlay) return;
    if (!graphStore.graph) {
      // Graph hasn't loaded yet — retry shortly.
      scheduleSnap(SNAP_DEBOUNCE_MS);
      return;
    }
    const myGen = ++snapGen;
    state.matching = true;
    state.matchStatus = null;
    try {
      const projected = projectContourToLngLat(
        state.contour,
        state.image.width,
        state.image.height,
        state.overlay,
      );
      const result = await svc.match(projected);
      if (myGen !== snapGen) return; // superseded by a newer drag
      state.matched = result;
    } catch (err) {
      if (myGen !== snapGen) return;
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[snap] failed:', msg);
      state.matched = null;
      state.matchStatus = msg;
    } finally {
      if (myGen === snapGen) state.matching = false;
    }
  }

  let perimeterKm = $derived(
    state.contour && state.overlay
      ? perimeterMeters(state.contour, state.overlay) / 1000
      : null,
  );

  let matchedKm = $derived(state.matched ? state.matched.length / 1000 : null);
</script>

<main>
  <Map />

  {#if mapStore.instance && state.image && state.contour && state.overlay}
    <Overlay
      map={mapStore.instance}
      image={state.image}
      contour={state.contour}
      overlay={state.overlay}
      onchange={(next) => (state.overlay = next)}
      onchangeend={() => scheduleSnap()}
    />
  {/if}

  {#if !state.image}
    <ImageUploader onload={(img) => (state.image = img)} />
  {:else if !state.contour && state.image}
    <ContourEditor
      image={state.image}
      onaccept={onContourAccepted}
      oncancel={() => state.reset()}
    />
  {/if}

  {#if state.overlay && perimeterKm !== null}
    <div class="status">
      <div class="row">
        <span class="label">Perimeter</span>
        <span class="value">
          {perimeterKm.toFixed(2)} km
          <span class="muted">· {(perimeterKm * 0.621371).toFixed(2)} mi</span>
        </span>
      </div>
      {#if matchedKm !== null && state.matched}
        <div class="row">
          <span class="label">Route</span>
          <span class="value">
            {matchedKm.toFixed(2)} km
            <span class="muted">· {(matchedKm * 0.621371).toFixed(2)} mi</span>
            {#if state.matched.closeGap > 5}
              <span class="muted" title="Gap between start and end of matched route">
                · gap {Math.round(state.matched.closeGap)} m
              </span>
            {/if}
          </span>
        </div>
      {/if}
      {#if state.matchStatus}
        <div class="row">
          <span class="label">Snap</span>
          <span class="err">{state.matchStatus}</span>
        </div>
      {/if}
      <div class="actions">
        <button
          onclick={() => scheduleSnap(0)}
          disabled={state.matching || !graphStore.graph}
          title="Force re-snap now"
        >
          {state.matching ? 'Snapping…' : '↻ Re-snap'}
        </button>
        <button onclick={() => state.clearTrace()}>Re-trace</button>
        <button onclick={() => state.reset()}>New image</button>
      </div>
    </div>
  {/if}
</main>

<style>
  main {
    position: fixed;
    inset: 0;
  }

  .status {
    position: absolute;
    top: 16px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 10px 16px;
    background: var(--panel);
    border: 1px solid var(--panel-border);
    border-radius: 12px;
    z-index: 15;
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
  }

  .row {
    display: flex;
    align-items: baseline;
    gap: 10px;
  }

  .label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--muted);
    min-width: 70px;
  }

  .value {
    font-family: var(--font-mono);
    font-size: 15px;
    color: var(--fg);
  }

  .muted {
    color: var(--muted);
    font-size: 13px;
  }

  .err {
    font-size: 13px;
    color: var(--accent);
    max-width: 360px;
  }

  .actions {
    display: flex;
    gap: 6px;
    margin-top: 4px;
  }

  .actions button {
    padding: 4px 10px;
    font-size: 12px;
  }

  .actions button:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
</style>
