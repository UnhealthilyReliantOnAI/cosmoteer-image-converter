import type { Polygon } from '../geometry/polygon';

/** Same winding for compound SVG fills, including mirrored pieces.
 * Shared internal edges then cancel rather than leaving antialiasing hairlines.
 */
export function polygonPath(polygon: Polygon): string {
  const winding = polygon.reduce((sum, p, i) => {
    const next = polygon[(i + 1) % polygon.length]!;
    return sum + p.x * next.y - next.x * p.y;
  }, 0);
  const points = winding < 0 ? [...polygon].reverse() : polygon;
  return points.map(({ x, y }, i) => `${i === 0 ? 'M' : 'L'}${x},${y}`).join(' ') + 'Z';
}
