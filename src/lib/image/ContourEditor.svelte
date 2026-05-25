<script lang="ts">
  import { onDestroy } from 'svelte';
  import { bitmapToImageData, type LoadedImage } from './load';
  import { extractContour, type ContourResult } from './pipeline';
  import type { Point } from './trace';

  interface Props {
    image: LoadedImage;
    onaccept: (contour: Point[]) => void;
    oncancel: () => void;
  }

  let { image, onaccept, oncancel }: Props = $props();

  let threshold = $state(128);
  let invert = $state(false);
  let result = $state<ContourResult | null>(null);
  let traceError = $state<string | null>(null);

  // Cache ImageData per-image so slider ticks don't re-paint the bitmap.
  const sourceData = $derived(bitmapToImageData(image.bitmap));

  let canvas: HTMLCanvasElement;
  let overlay: HTMLCanvasElement;

  // Re-trace whenever sourceData / threshold / invert changes — pure, fast (<10ms for 1MP).
  $effect(() => {
    try {
      const r = extractContour(sourceData, { threshold, invert });
      result = r;
      traceError = r ? null : 'No contour found at this threshold';
    } catch (err) {
      traceError = err instanceof Error ? err.message : 'Tracing failed';
      result = null;
    }
  });

  // Paint the source image onto the base canvas (only when image changes).
  $effect(() => {
    if (!canvas) return;
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(image.bitmap, 0, 0);
  });

  // Paint the traced contour over the source on the overlay canvas.
  $effect(() => {
    if (!overlay) return;
    overlay.width = image.width;
    overlay.height = image.height;
    const ctx = overlay.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    if (!result || result.contour.length < 2) return;

    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#ff6a3d';
    ctx.lineWidth = Math.max(2, Math.min(image.width, image.height) / 320);
    ctx.beginPath();
    const pts = result.contour;
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.stroke();

    // Vertices
    ctx.fillStyle = '#ffffff';
    const r = Math.max(1.5, ctx.lineWidth * 0.6);
    for (const p of pts) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  });

  onDestroy(() => {
    // sourceData held by closure; nothing else to release.
  });

  function accept(): void {
    if (result) onaccept(result.contour);
  }
</script>

<div class="backdrop" role="dialog" aria-modal="true" aria-label="Adjust contour">
  <div class="card">
    <header>
      <div>
        <h2>Adjust the contour</h2>
        <p>Slide until the orange outline tracks the shape you want to run.</p>
      </div>
      <button class="ghost" onclick={oncancel} aria-label="Cancel">✕</button>
    </header>

    <div class="preview" style:aspect-ratio={`${image.width} / ${image.height}`}>
      <canvas bind:this={canvas} class="layer base"></canvas>
      <canvas bind:this={overlay} class="layer trace"></canvas>
    </div>

    <div class="controls">
      <label>
        <span class="row">
          <span>Threshold</span>
          <span class="value">{threshold}</span>
        </span>
        <input type="range" min="0" max="255" step="1" bind:value={threshold} />
      </label>

      <label class="toggle">
        <input type="checkbox" bind:checked={invert} />
        <span>Light shape on dark background</span>
      </label>

      <div class="meta">
        {#if result}
          {result.contour.length} points · {result.rawLength.toLocaleString()} raw · {result.pixelCount.toLocaleString()}px filled
        {:else if traceError}
          <span class="err">{traceError}</span>
        {/if}
      </div>
    </div>

    <footer>
      <button class="ghost" onclick={oncancel}>Use a different image</button>
      <button class="primary" disabled={!result} onclick={accept}>
        Use this contour →
      </button>
    </footer>
  </div>
</div>

<style>
  .backdrop {
    position: absolute;
    inset: 0;
    background: rgba(8, 10, 12, 0.78);
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    display: grid;
    place-items: center;
    padding: 16px;
    z-index: 30;
  }

  .card {
    width: min(640px, 100%);
    max-height: calc(100% - 32px);
    overflow: auto;
    background: var(--panel);
    border: 1px solid var(--panel-border);
    border-radius: 18px;
    padding: 20px;
    display: flex;
    flex-direction: column;
    gap: 16px;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.6);
  }

  header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
  }

  h2 {
    margin: 0 0 4px 0;
    font-size: 17px;
    font-weight: 600;
  }

  header p {
    margin: 0;
    font-size: 13px;
    color: var(--muted);
  }

  .preview {
    position: relative;
    width: 100%;
    background: #1a1d22 url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='16' height='16'><rect width='8' height='8' fill='%23232930'/><rect x='8' y='8' width='8' height='8' fill='%23232930'/></svg>");
    background-size: 12px 12px;
    border-radius: 10px;
    overflow: hidden;
  }

  .layer {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: block;
  }

  .controls {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  label {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 13px;
    color: var(--muted);
  }

  .row {
    display: flex;
    justify-content: space-between;
  }

  .value {
    font-family: var(--font-mono);
    color: var(--fg);
  }

  input[type='range'] {
    width: 100%;
    accent-color: var(--accent);
  }

  .toggle {
    flex-direction: row;
    align-items: center;
    gap: 8px;
    cursor: pointer;
  }

  .toggle input {
    accent-color: var(--accent);
  }

  .meta {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--muted);
  }

  .err {
    color: var(--accent);
  }

  footer {
    display: flex;
    justify-content: space-between;
    gap: 12px;
  }

  .primary {
    background: var(--accent);
    border-color: var(--accent);
    color: #000;
    font-weight: 600;
  }

  .primary:hover {
    background: #ff7d54;
  }

  .primary:disabled {
    background: rgba(255, 106, 61, 0.4);
    color: rgba(0, 0, 0, 0.5);
    cursor: not-allowed;
  }

  .ghost {
    border-color: transparent;
    color: var(--muted);
  }

  .ghost:hover {
    color: var(--fg);
  }
</style>
