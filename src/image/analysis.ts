import { validateImageDimensions } from './limits';

export { validateImageDimensions } from './limits';

export interface RasterImage {
  readonly width: number;
  readonly height: number;
  /** RGBA bytes, row by row, starting at the top left. */
  readonly data: Uint8ClampedArray;
}

export interface BinaryMask {
  readonly width: number;
  readonly height: number;
  /** 1 = black, 0 = white. */
  readonly data: Uint8Array;
  /** Row spacing for a cropped view. Omitted for a tightly packed mask. */
  readonly stride?: number;
}

export interface PixelBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface AnalyzedSilhouette {
  readonly mask: BinaryMask;
  readonly bounds: PixelBounds;
}

function validateMaskLayout(mask: BinaryMask): void {
  validateImageDimensions(mask.width, mask.height);
  const stride = mask.stride ?? mask.width;
  if (!Number.isSafeInteger(stride) || stride < mask.width
    || mask.data.length !== (mask.height - 1) * stride + mask.width) {
    throw new Error('Le masque doit contenir un pixel binaire par position.');
  }
}

export function validateMask(mask: BinaryMask): void {
  validateMaskLayout(mask);
  const stride = mask.stride ?? mask.width;
  for (let y = 0; y < mask.height; y += 1) {
    for (let x = 0; x < mask.width; x += 1) {
      if (mask.data[y * stride + x]! > 1) throw new Error('Le masque doit contenir un pixel binaire par position.');
    }
  }
}

/** RGB mean composited over white; brightness strictly below 128 becomes material. */
function normalizeRgba(image: RasterImage, output: Uint8Array, outputOffset: number): void {
  validateImageDimensions(image.width, image.height);
  if (image.data.length !== image.width * image.height * 4) {
    throw new Error('Les données RGBA de l’image sont incomplètes.');
  }
  for (let pixel = 0; pixel < image.width * image.height; pixel += 1) {
    const offset = pixel * 4;
    const mean = (image.data[offset]! + image.data[offset + 1]! + image.data[offset + 2]!) / 3;
    const alpha = image.data[offset + 3]! / 255;
    const brightness = 255 + alpha * (mean - 255);
    output[outputOffset + pixel] = brightness < 128 ? 1 : 0;
  }
}

export function createBinaryMask(image: RasterImage): BinaryMask {
  validateImageDimensions(image.width, image.height);
  const data = new Uint8Array(image.width * image.height);
  normalizeRgba(image, data, 0);
  return { width: image.width, height: image.height, data };
}

/** Read source rows in bounded RGBA chunks; retain only one byte per source pixel. */
export async function createBinaryMaskFromRows(
  width: number,
  height: number,
  rowsPerChunk: number,
  readRows: (firstRow: number, rowCount: number) => RasterImage | Promise<RasterImage>
): Promise<BinaryMask> {
  validateImageDimensions(width, height);
  if (!Number.isInteger(rowsPerChunk) || rowsPerChunk < 1) throw new Error('La hauteur des bandes doit être un entier positif.');
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y += rowsPerChunk) {
    const count = Math.min(rowsPerChunk, height - y);
    const rows = await readRows(y, count);
    if (rows.width !== width || rows.height !== count) throw new Error('La bande d’image a des dimensions incohérentes.');
    normalizeRgba(rows, data, y * width);
  }
  return { width, height, data };
}

export function findBlackBounds(mask: BinaryMask): PixelBounds | null {
  validateMaskLayout(mask);
  const stride = mask.stride ?? mask.width;
  let minX = mask.width;
  let minY = mask.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < mask.height; y += 1) {
    for (let x = 0; x < mask.width; x += 1) {
      const value = mask.data[y * stride + x]!;
      if (value > 1) throw new Error('Le masque doit contenir un pixel binaire par position.');
      if (value === 1) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** Cropped view: remove only outside margins, without copying the pixel buffer. */
export function cropToBlackBounds(mask: BinaryMask): AnalyzedSilhouette | null {
  const bounds = findBlackBounds(mask);
  if (!bounds) return null;
  const stride = mask.stride ?? mask.width;
  const start = bounds.y * stride + bounds.x;
  const data = mask.data.subarray(start, start + (bounds.height - 1) * stride + bounds.width);
  return {
    bounds,
    mask: {
      width: bounds.width,
      height: bounds.height,
      data,
      ...(stride === bounds.width || bounds.height === 1 ? {} : { stride }),
    },
  };
}
