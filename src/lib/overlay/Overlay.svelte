<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import type { Map as MapLibreMap } from 'maplibre-gl';
  import type { LoadedImage } from '../image/load';
  import type { Point } from '../image/trace';
  import { degreesLngPerMeter, offsetLngLat } from './geo';
  import type { OverlayState } from './state';

  interface Props {
    map: MapLibreMap;
    image: LoadedImage;
    contour: Point[];
    overlay: OverlayState;
    onchange: (next: OverlayState) => void;
    onchangeend?: () => void;
  }

  let { map, image, contour, overlay, onchange, onchangeend }: Props = $props();

  let container: HTMLDivElement;
  let canvas: HTMLCanvasElement;

  // Latest projection — used by interaction handlers without recomputing.
  interface Projection {
    center: { x: number; y: number };
    pxPerMeter: number;
    displayW: number;
    displayH: number;
  }
  let lastProjection: Projection = {
    center: { x: 0, y: 0 },
    pxPerMeter: 0,
    displayW: 0,
    displayH: 0,
  };

  function reproject(): void {
    if (!container) return;
    const center = map.project([overlay.anchor.lng, overlay.anchor.lat]);
    const eastLng = overlay.anchor.lng + degreesLngPerMeter(overlay.anchor.lat);
    const east = map.project([eastLng, overlay.anchor.lat]);
    const pxPerMeter = Math.hypot(east.x - center.x, east.y - center.y);
    const displayW = image.width * overlay.metersPerPixel * pxPerMeter;
    const displayH = image.height * overlay.metersPerPixel * pxPerMeter;

    container.style.width = `${displayW}px`;
    container.style.height = `${displayH}px`;
    container.style.transform =
      `translate(${center.x}px, ${center.y}px) ` +
      `translate(-50%, -50%) ` +
      `rotate(${overlay.rotationDeg}deg)`;

    lastProjection = { center, pxPerMeter, displayW, displayH };
  }

  // Bind map events for re-projection on pan/zoom/rotate/pitch.
  onMount(() => {
    map.on('move', reproject);
    map.on('zoom', reproject);
    map.on('rotate', reproject);
    map.on('pitch', reproject);
    map.on('resize', reproject);
    reproject();
  });

  onDestroy(() => {
    map.off('move', reproject);
    map.off('zoom', reproject);
    map.off('rotate', reproject);
    map.off('pitch', reproject);
    map.off('resize', reproject);
  });

  // Re-project whenever overlay state changes.
  $effect(() => {
    overlay.anchor.lng;
    overlay.anchor.lat;
    overlay.rotationDeg;
    overlay.metersPerPixel;
    reproject();
  });

  // Paint the image + contour onto the canvas at native resolution.
  $effect(() => {
    if (!canvas) return;
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.globalAlpha = 0.45;
    ctx.drawImage(image.bitmap, 0, 0);
    ctx.globalAlpha = 1;

    if (contour.length < 2) return;
    ctx.strokeStyle = '#ff6a3d';
    ctx.lineWidth = Math.max(2, Math.min(image.width, image.height) / 200);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(contour[0].x, contour[0].y);
    for (let i = 1; i < contour.length; i++) ctx.lineTo(contour[i].x, contour[i].y);
    ctx.closePath();
    ctx.stroke();
  });

  // ── interactions ─────────────────────────────────────────────────────────

  type Mode = 'translate' | 'rotate' | 'scale';

  interface DragStart {
    mode: Mode;
    mouse: { x: number; y: number };
    state: OverlayState;
    projection: Projection;
  }

  let drag: DragStart | null = null;

  function pointerDown(mode: Mode, e: PointerEvent): void {
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    drag = {
      mode,
      mouse: { x: e.clientX, y: e.clientY },
      state: { ...overlay, anchor: { ...overlay.anchor } },
      projection: { ...lastProjection },
    };
    e.preventDefault();
    e.stopPropagation();
  }

  function pointerMove(e: PointerEvent): void {
    if (!drag) return;
    const { projection: p0, state: s0 } = drag;

    if (drag.mode === 'translate') {
      const dx = e.clientX - drag.mouse.x;
      const dy = e.clientY - drag.mouse.y;
      if (p0.pxPerMeter === 0) return;
      const eastM = dx / p0.pxPerMeter;
      const northM = -dy / p0.pxPerMeter; // screen y is down
      const anchor = offsetLngLat(s0.anchor.lng, s0.anchor.lat, eastM, northM);
      onchange({ ...s0, anchor });
    } else if (drag.mode === 'rotate') {
      const cx = p0.center.x;
      const cy = p0.center.y;
      const startAng = Math.atan2(drag.mouse.y - cy, drag.mouse.x - cx);
      const nowAng = Math.atan2(e.clientY - cy, e.clientX - cx);
      const deltaDeg = ((nowAng - startAng) * 180) / Math.PI;
      onchange({ ...s0, rotationDeg: s0.rotationDeg + deltaDeg });
    } else if (drag.mode === 'scale') {
      const cx = p0.center.x;
      const cy = p0.center.y;
      const startDist = Math.hypot(drag.mouse.x - cx, drag.mouse.y - cy);
      const nowDist = Math.hypot(e.clientX - cx, e.clientY - cy);
      if (startDist <= 0) return;
      const factor = Math.max(0.05, Math.min(20, nowDist / startDist));
      onchange({ ...s0, metersPerPixel: s0.metersPerPixel * factor });
    }
  }

  function pointerUp(e: PointerEvent): void {
    if (!drag) return;
    const el = e.currentTarget as Element;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    drag = null;
    onchangeend?.();
  }
</script>

<div bind:this={container} class="overlay">
  <canvas
    bind:this={canvas}
    class="image"
    onpointerdown={(e) => pointerDown('translate', e)}
    onpointermove={pointerMove}
    onpointerup={pointerUp}
    onpointercancel={pointerUp}
  ></canvas>

  <div class="frame" aria-hidden="true"></div>

  <button
    type="button"
    class="handle rotate"
    aria-label="Rotate"
    title="Rotate"
    onpointerdown={(e) => pointerDown('rotate', e)}
    onpointermove={pointerMove}
    onpointerup={pointerUp}
    onpointercancel={pointerUp}
  >
    <span aria-hidden="true">↻</span>
  </button>

  <button
    type="button"
    class="handle scale"
    aria-label="Scale"
    title="Scale"
    onpointerdown={(e) => pointerDown('scale', e)}
    onpointermove={pointerMove}
    onpointerup={pointerUp}
    onpointercancel={pointerUp}
  >
    <span aria-hidden="true">⇲</span>
  </button>
</div>

<style>
  .overlay {
    position: absolute;
    left: 0;
    top: 0;
    transform-origin: 50% 50%;
    pointer-events: none;
    z-index: 5;
    will-change: transform, width, height;
  }

  .image {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    cursor: grab;
    pointer-events: auto;
    touch-action: none;
  }

  .image:active {
    cursor: grabbing;
  }

  .frame {
    position: absolute;
    inset: 0;
    border: 1.5px dashed rgba(255, 106, 61, 0.55);
    border-radius: 4px;
    pointer-events: none;
  }

  .handle {
    position: absolute;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    background: var(--accent);
    color: #000;
    border: 2px solid #fff;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
    display: grid;
    place-items: center;
    font-size: 14px;
    font-weight: 700;
    cursor: grab;
    pointer-events: auto;
    touch-action: none;
    padding: 0;
  }

  .handle:active {
    cursor: grabbing;
  }

  .handle.rotate {
    left: 50%;
    top: -44px;
    transform: translateX(-50%);
  }

  .handle.scale {
    right: -16px;
    bottom: -16px;
    cursor: nwse-resize;
  }

  .handle.scale:active {
    cursor: nwse-resize;
  }
</style>
