export interface Point {
  x: number;
  y: number;
}

// 8-connected neighborhood in clockwise order, starting at East.
// Canvas convention: +x is right, +y is down.
const NEIGHBORS: readonly [number, number][] = [
  [1, 0],   // 0 E
  [1, 1],   // 1 SE
  [0, 1],   // 2 S
  [-1, 1],  // 3 SW
  [-1, 0],  // 4 W
  [-1, -1], // 5 NW
  [0, -1],  // 6 N
  [1, -1],  // 7 NE
];

/**
 * Moore-neighbor boundary tracing. Walks the outer boundary of the first
 * foreground component encountered in raster-scan order. Assumes the input
 * mask has been cleaned (e.g., largest-component only) — otherwise the trace
 * is whichever component the scan hits first.
 *
 * Returns an open polyline of pixel coordinates. The caller can close the
 * loop by appending the first point if needed.
 */
export function traceBoundary(mask: Uint8Array, width: number, height: number): Point[] {
  let startX = -1;
  let startY = -1;
  outer: for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x] === 1) {
        startX = x;
        startY = y;
        break outer;
      }
    }
  }
  if (startX < 0) return [];

  const isFg = (x: number, y: number): boolean =>
    x >= 0 && x < width && y >= 0 && y < height && mask[y * width + x] === 1;

  const result: Point[] = [{ x: startX, y: startY }];
  let cx = startX;
  let cy = startY;
  // The leftmost foreground pixel in the topmost foreground row — by
  // construction, the pixel to its West is background. Initialize backtrack
  // to West (direction 4).
  let backDir = 4;

  const maxSteps = width * height * 4;
  for (let step = 0; step < maxSteps; step++) {
    let moved = false;
    for (let i = 1; i <= 8; i++) {
      const dir = (backDir + i) & 7;
      const [dx, dy] = NEIGHBORS[dir];
      const nx = cx + dx;
      const ny = cy + dy;
      if (isFg(nx, ny)) {
        cx = nx;
        cy = ny;
        backDir = (dir + 4) & 7;
        moved = true;
        break;
      }
    }
    if (!moved) break; // isolated pixel
    if (cx === startX && cy === startY) break; // closed the loop
    result.push({ x: cx, y: cy });
  }

  return result;
}
