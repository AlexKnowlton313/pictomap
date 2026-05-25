export interface LoadedImage {
  bitmap: ImageBitmap;
  width: number;
  height: number;
  /** Downscaled data URL kept for re-display / persistence. */
  dataUrl: string;
}

/** Long-edge cap for the working bitmap. Anything bigger is downscaled — */
/** matcher cost is roughly linear in contour length, and the visual signal */
/** doesn't improve past this. */
const MAX_LONG_EDGE = 2000;

/** Long-edge cap for the persistence-friendly data URL (~ <2MB target). */
const PERSIST_LONG_EDGE = 1024;

const MAX_FILE_BYTES = 20 * 1024 * 1024;

export async function loadImageFile(file: File): Promise<LoadedImage> {
  if (!file.type.startsWith('image/')) {
    throw new Error(`Not an image file (got "${file.type || 'unknown type'}")`);
  }
  if (file.size > MAX_FILE_BYTES) {
    throw new Error(`Image too large (max ${Math.round(MAX_FILE_BYTES / 1024 / 1024)}MB)`);
  }

  let bitmap = await createImageBitmap(file);

  const longEdge = Math.max(bitmap.width, bitmap.height);
  if (longEdge > MAX_LONG_EDGE) {
    const s = MAX_LONG_EDGE / longEdge;
    const resized = await createImageBitmap(bitmap, {
      resizeWidth: Math.round(bitmap.width * s),
      resizeHeight: Math.round(bitmap.height * s),
      resizeQuality: 'high',
    });
    bitmap.close();
    bitmap = resized;
  }

  const dataUrl = bitmapToDataURL(bitmap, PERSIST_LONG_EDGE);
  return { bitmap, width: bitmap.width, height: bitmap.height, dataUrl };
}

function bitmapToDataURL(bitmap: ImageBitmap, maxLongEdge: number): string {
  let w = bitmap.width;
  let h = bitmap.height;
  const longest = Math.max(w, h);
  if (longest > maxLongEdge) {
    const s = maxLongEdge / longest;
    w = Math.round(w * s);
    h = Math.round(h * s);
  }
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get 2D canvas context');
  ctx.drawImage(bitmap, 0, 0, w, h);
  return canvas.toDataURL('image/png');
}

/** Render a bitmap into an offscreen canvas and return its ImageData. */
export function bitmapToImageData(bitmap: ImageBitmap): ImageData {
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Could not get 2D canvas context');
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
}
