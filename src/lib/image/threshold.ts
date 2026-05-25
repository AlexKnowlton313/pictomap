export interface ThresholdOptions {
  /** 0-255. Pixels darker than this are foreground (when invert is false). */
  threshold: number;
  /** If true, light pixels are foreground (e.g., light-on-dark sketches). */
  invert?: boolean;
}

/** Convert RGBA pixels to a binary mask. 1 = foreground (the shape), 0 = background. */
export function thresholdImage(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  opts: ThresholdOptions,
): Uint8Array {
  const { threshold, invert = false } = opts;
  const mask = new Uint8Array(width * height);
  for (let i = 0, j = 0; j < mask.length; i += 4, j++) {
    const a = data[i + 3];
    if (a < 16) continue; // transparent → background
    const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    const isDark = lum < threshold;
    if (invert ? !isDark : isDark) mask[j] = 1;
  }
  return mask;
}

/**
 * Keep only the largest 8-connected foreground component. Drops noise / stray
 * marks so the boundary trace finds the silhouette, not a speck of dust.
 *
 * 8-conn matches the connectivity used by traceBoundary — otherwise a
 * diagonal-only "bridge" pixel could survive tracing while being filtered out
 * as a separate component here.
 */
export function keepLargestComponent(
  mask: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  const labels = new Int32Array(mask.length);
  const counts: number[] = [0];
  let nextLabel = 1;
  const stack: number[] = [];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const seed = y * width + x;
      if (mask[seed] !== 1 || labels[seed] !== 0) continue;
      let count = 0;
      stack.length = 0;
      stack.push(seed);
      labels[seed] = nextLabel;
      while (stack.length) {
        const p = stack.pop()!;
        count++;
        const px = p % width;
        const py = (p - px) / width;
        const xMin = px > 0;
        const xMax = px < width - 1;
        const yMin = py > 0;
        const yMax = py < height - 1;
        const tryPush = (q: number): void => {
          if (mask[q] === 1 && labels[q] === 0) {
            labels[q] = nextLabel;
            stack.push(q);
          }
        };
        if (xMin) tryPush(p - 1);
        if (xMax) tryPush(p + 1);
        if (yMin) tryPush(p - width);
        if (yMax) tryPush(p + width);
        if (xMin && yMin) tryPush(p - width - 1);
        if (xMax && yMin) tryPush(p - width + 1);
        if (xMin && yMax) tryPush(p + width - 1);
        if (xMax && yMax) tryPush(p + width + 1);
      }
      counts.push(count);
      nextLabel++;
    }
  }

  if (counts.length === 1) return mask;
  let largest = 1;
  for (let l = 2; l < counts.length; l++) {
    if (counts[l] > counts[largest]) largest = l;
  }

  const out = new Uint8Array(mask.length);
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] === largest) out[i] = 1;
  }
  return out;
}
