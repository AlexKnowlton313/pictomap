<script lang="ts">
  import Map from './lib/map/Map.svelte';
  import { mapStore } from './lib/map/store.svelte';
  import ImageUploader from './lib/image/ImageUploader.svelte';
  import ContourEditor from './lib/image/ContourEditor.svelte';
  import Overlay from './lib/overlay/Overlay.svelte';
  import { defaultOverlay, perimeterMeters } from './lib/overlay/state';
  import { state } from './lib/state.svelte';
  import type { Point } from './lib/image/trace';

  function onContourAccepted(contour: Point[]): void {
    state.contour = contour;
    const map = mapStore.instance;
    if (!map) return;
    const c = map.getCenter();
    state.overlay = defaultOverlay({ lng: c.lng, lat: c.lat }, contour);
  }

  let perimeterKm = $derived(
    state.contour && state.overlay
      ? perimeterMeters(state.contour, state.overlay) / 1000
      : null,
  );
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
      <span class="label">Approx perimeter</span>
      <span class="value">
        {perimeterKm.toFixed(2)} km
        <span class="muted">· {(perimeterKm * 0.621371).toFixed(2)} mi</span>
      </span>
      <div class="actions">
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
    align-items: center;
    gap: 16px;
    padding: 10px 16px;
    background: var(--panel);
    border: 1px solid var(--panel-border);
    border-radius: 12px;
    z-index: 15;
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
  }

  .label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--muted);
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

  .actions {
    display: flex;
    gap: 6px;
    margin-left: 4px;
  }

  .actions button {
    padding: 4px 10px;
    font-size: 12px;
  }
</style>
