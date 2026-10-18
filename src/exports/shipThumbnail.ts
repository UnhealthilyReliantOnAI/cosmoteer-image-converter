import { getPlacedPolygon } from '../construction/model';
import type { Construction } from '../construction/model';
import { getBounds } from '../geometry/polygon';
import type { Polygon } from '../geometry/polygon';
import { SHIP_PNG_WIDTH } from './shipContainer';
import type { RgbaImage } from './shipPng';

/** The ship carrier is square; thumbnail and envelope use the same pixel dimensions. */
export const THUMBNAIL_SIZE = SHIP_PNG_WIDTH;

export const THUMBNAIL_MARGIN = 24;

export const THUMBNAIL_BACKGROUND = [16, 24, 39, 255] as const;

export const THUMBNAIL_FOREGROUND = [185, 216, 245, 255] as const;

/** A new opaque carrier, never an image or pixels inherited from a saved ship. */
export function createNeutralThumbnailRgba(): RgbaImage {
  const data = new Uint8Array(THUMBNAIL_SIZE * THUMBNAIL_SIZE * 4);
  for (let offset = 0; offset < data.length; offset += 4) data.set(THUMBNAIL_BACKGROUND, offset);
  return { width: THUMBNAIL_SIZE, height: THUMBNAIL_SIZE, data };
}

export function fitThumbnail(polygons: readonly Polygon[]) {
  if (polygons.length === 0) throw new Error('La miniature nécessite au moins un polygone.');
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const polygon of polygons) {
    const bounds = getBounds(polygon);
    minX = Math.min(minX, bounds.minX);
    minY = Math.min(minY, bounds.minY);
    maxX = Math.max(maxX, bounds.minX + bounds.width);
    maxY = Math.max(maxY, bounds.minY + bounds.height);
  }
  const width = maxX - minX, height = maxY - minY;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('Dimensions de miniature invalides.');
  }
  const scale = Math.min((THUMBNAIL_SIZE - 2 * THUMBNAIL_MARGIN) / width,
  (THUMBNAIL_SIZE - 2 * THUMBNAIL_MARGIN) / height);
  return {
    scale,
    offsetX: (THUMBNAIL_SIZE - width * scale) / 2 - minX * scale,
    offsetY: (THUMBNAIL_SIZE - height * scale) / 2 - minY * scale,
  };
}

/** Pixel-centre scanlines, using the actual polygons, including the empty part of wedges.
 * No DOM, Canvas, textures, premultiplication or colour conversion participates in encoding.
 */
export async function createConstructionThumbnailRgba(construction: Construction, signal?: AbortSignal): Promise<RgbaImage> {
  signal?.throwIfAborted();
  const polygons = construction.pieces.map(getPlacedPolygon);
  const { scale, offsetX, offsetY } = fitThumbnail(polygons);
  const image = createNeutralThumbnailRgba();
  for (let index = 0; index < polygons.length; index++) {
    signal?.throwIfAborted();
    const polygon = polygons[index]!.map(({ x, y }) => ({ x: x * scale + offsetX, y: y * scale + offsetY }));
    const bounds = getBounds(polygon);
    const firstY = Math.max(0, Math.ceil(bounds.minY - 0.5));
    const lastY = Math.min(THUMBNAIL_SIZE, Math.ceil(bounds.minY + bounds.height - 0.5));
    for (let y = firstY; y < lastY; y++) {
      const scanY = y + 0.5;
      const intersections: number[] = [];
      for (let i = 0; i < polygon.length; i++) {
        const a = polygon[i]!, b = polygon[(i + 1) % polygon.length]!;
        if ((a.y <= scanY && b.y > scanY) || (b.y <= scanY && a.y > scanY)) {
          intersections.push(a.x + (scanY - a.y) * (b.x - a.x) / (b.y - a.y));
        }
      }
      intersections.sort((a, b) => a - b);
      for (let i = 0; i + 1 < intersections.length; i += 2) {
        const firstX = Math.max(0, Math.ceil(intersections[i]! - 0.5));
        const lastX = Math.min(THUMBNAIL_SIZE, Math.ceil(intersections[i + 1]! - 0.5));
        for (let x = firstX; x < lastX; x++) image.data.set(THUMBNAIL_FOREGROUND, (y * THUMBNAIL_SIZE + x) * 4);
      }
    }
    // Let the main thread paint and receive cancellation on large constructions.
    if ((index + 1) % 256 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  signal?.throwIfAborted();
  return image;
}
