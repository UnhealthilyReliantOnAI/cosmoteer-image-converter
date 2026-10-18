/** Coordinates are measured in grid cells: X right, Y down. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

export type Polygon = readonly Point[];

export type Rotation = 0 | 90 | 180 | 270;

export const ROTATIONS: readonly Rotation[] = [0, 90, 180, 270];

export interface Bounds {
  readonly minX: number;
  readonly minY: number;
  readonly width: number;
  readonly height: number;
}

export function getBounds(polygon: Polygon): Bounds {
  if (polygon.length < 3 || polygon.some(({ x, y }) => !Number.isFinite(x) || !Number.isFinite(y))) {
    throw new Error('Un polygone doit contenir au moins trois sommets finis.');
  }
  const minX = Math.min(...polygon.map((point) => point.x));
  const minY = Math.min(...polygon.map((point) => point.y));
  return {
    minX,
    minY,
    width: Math.max(...polygon.map((point) => point.x)) - minX,
    height: Math.max(...polygon.map((point) => point.y)) - minY,
  };
}

/** Shoelace formula; suitable for simple polygons, regardless of winding. */
export function polygonArea(polygon: Polygon): number {
  getBounds(polygon);
  let doubledArea = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index]!;
    const next = polygon[(index + 1) % polygon.length]!;
    doubledArea += current.x * next.y - next.x * current.y;
  }
  return Math.abs(doubledArea) / 2;
}

export function translatePolygon(polygon: Polygon, offset: Point): Polygon {
  return polygon.map(({ x, y }) => ({ x: x + offset.x, y: y + offset.y }));
}

/** Exact clockwise quarter turns, then re-anchor the tight bounds at (0, 0). */
export function rotatePolygon(polygon: Polygon, rotation: Rotation): Polygon {
  const rotated = polygon.map(({ x, y }): Point => {
    switch (rotation) {
    case 0: return { x, y };
    case 90: return { x: -y, y: x };
    case 180: return { x: -x, y: -y };
    case 270: return { x: y, y: -x };
    }
  });
  const { minX, minY } = getBounds(rotated);
  return translatePolygon(rotated, { x: -minX, y: -minY });
}

/** Rotate inside the reserved rectangle, preserving the polygon's offset from its edges. */
export function rotatePolygonInFootprint(
  polygon: Polygon,
  rotation: Rotation,
  footprint: {
    readonly width: number;
    readonly height: number;
  }
): Polygon {
  return polygon.map(({ x, y }): Point => {
    switch (rotation) {
    case 0: return { x, y };
    case 90: return { x: footprint.height - y, y: x };
    case 180: return { x: footprint.width - x, y: footprint.height - y };
    case 270: return { x: y, y: footprint.width - x };
    }
  });
}
