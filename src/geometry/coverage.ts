import { polygonArea } from './polygon';
import type { Point, Polygon } from './polygon';

/** Clip a convex catalog polygon to an axis-aligned sample; edges keep fractional coordinates. */
export function polygonRectangleArea(polygon: Polygon, x: number, y: number, size: number): number {
  let points: readonly Point[] = polygon;
  for (const [axis, edge, sign] of [
    ['x', x, 1],
    ['x', x + size, -1],
    ['y', y, 1],
    ['y', y + size, -1],
  ] as const) {
    const clipped: Point[] = [];
    for (let index = 0; index < points.length; index += 1) {
      const start = points[index]!;
      const end = points[(index + 1) % points.length]!;
      const insideStart = sign * (start[axis] - edge) >= 0;
      const insideEnd = sign * (end[axis] - edge) >= 0;
      if (insideStart) clipped.push(start);
      if (insideStart !== insideEnd) {
        const t = (edge - start[axis]) / (end[axis] - start[axis]);
        clipped.push({ x: start.x + t * (end.x - start.x), y: start.y + t * (end.y - start.y) });
      }
    }
    points = clipped;
    if (points.length < 3) return 0;
  }
  return polygonArea(points);
}
