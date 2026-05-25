<script lang="ts">
  import { loadImageFile, type LoadedImage } from './load';

  interface Props {
    onload: (image: LoadedImage) => void;
  }

  let { onload }: Props = $props();

  let dragging = $state(false);
  let busy = $state(false);
  let error = $state<string | null>(null);
  let fileInput: HTMLInputElement;

  async function handleFile(file: File): Promise<void> {
    busy = true;
    error = null;
    try {
      const img = await loadImageFile(file);
      onload(img);
    } catch (err) {
      error = err instanceof Error ? err.message : 'Could not load image';
    } finally {
      busy = false;
    }
  }

  function onDrop(e: DragEvent): void {
    e.preventDefault();
    dragging = false;
    const file = e.dataTransfer?.files[0];
    if (file) handleFile(file);
  }

  function onPick(e: Event): void {
    const target = e.target as HTMLInputElement;
    const file = target.files?.[0];
    if (file) handleFile(file);
    target.value = '';
  }
</script>

<div
  class="dropzone"
  class:dragging
  class:busy
  ondrop={onDrop}
  ondragover={(e) => {
    e.preventDefault();
    dragging = true;
  }}
  ondragleave={() => (dragging = false)}
  role="button"
  tabindex="0"
  onclick={() => fileInput.click()}
  onkeydown={(e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInput.click();
    }
  }}
>
  <input
    bind:this={fileInput}
    type="file"
    accept="image/*"
    onchange={onPick}
    hidden
  />
  <div class="content">
    <div class="icon" aria-hidden="true">↑</div>
    <div class="title">
      {#if busy}Loading…{:else}Drop a silhouette or click to upload{/if}
    </div>
    <div class="hint">
      Clean shapes work best — logos, letters, hearts, animal silhouettes.
      Max 20MB; large images are auto-downscaled.
    </div>
    {#if error}
      <div class="err" role="alert">{error}</div>
    {/if}
  </div>
</div>

<style>
  .dropzone {
    position: absolute;
    left: 50%;
    bottom: 32px;
    transform: translateX(-50%);
    width: min(420px, calc(100% - 32px));
    padding: 24px 20px;
    background: var(--panel);
    border: 1.5px dashed var(--panel-border);
    border-radius: 16px;
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    cursor: pointer;
    transition: border-color 120ms ease, background 120ms ease, transform 160ms ease;
    z-index: 10;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  }

  .dropzone:hover,
  .dropzone:focus-visible {
    border-color: var(--accent);
    outline: none;
  }

  .dropzone.dragging {
    border-color: var(--accent);
    background: rgba(255, 106, 61, 0.08);
    transform: translateX(-50%) translateY(-2px);
  }

  .dropzone.busy {
    cursor: progress;
    opacity: 0.7;
  }

  .content {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    text-align: center;
  }

  .icon {
    font-size: 22px;
    width: 36px;
    height: 36px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.06);
    color: var(--accent);
    margin-bottom: 4px;
  }

  .title {
    font-size: 15px;
    font-weight: 500;
  }

  .hint {
    font-size: 12px;
    color: var(--muted);
    line-height: 1.4;
    max-width: 320px;
  }

  .err {
    margin-top: 6px;
    font-size: 12px;
    color: var(--accent);
  }
</style>
