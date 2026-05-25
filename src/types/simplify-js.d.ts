declare module 'simplify-js' {
  interface Point {
    x: number;
    y: number;
  }
  /**
   * Ramer-Douglas-Peucker polyline simplification.
   * @param points input polyline
   * @param tolerance distance threshold (default 1)
   * @param highQuality if true, use full RDP (slower, better)
   */
  export default function simplify<P extends Point>(
    points: P[],
    tolerance?: number,
    highQuality?: boolean,
  ): P[];
}
