import { byteView, bytesEqual, concatBytes, crc32 } from './shipBytes';
import { compressZlib, decompressZlib } from './shipCompression';
import {
  extractShipContainer,
  SHIP_PNG_HEIGHT,
  SHIP_PNG_WIDTH,
  validateRgbaImage
} from './shipContainer';
import type { RgbaImage } from './shipContainer';
import { ShipExportError, throwIfAborted } from './shipErrors';

export type { RgbaImage } from './shipContainer';

export const PNG_SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);

const CHUNK_BLOCK_SIZE = 8192;

const ASCII = new TextEncoder();

export function pngChunk(type: 'IHDR' | 'pHYs' | 'IDAT' | 'IEND', data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(data.byteLength + 12);
  const view = byteView(chunk);
  view.setUint32(0, data.byteLength, false);
  chunk.set(ASCII.encode(type), 4);
  chunk.set(data, 8);
  view.setUint32(data.byteLength + 8, crc32(chunk.subarray(4, data.byteLength + 8)), false);
  return chunk;
}

/** Fresh RGBA8 PNG. Never sends payload-bearing pixels back through Canvas or a visual encoder. */
export async function encodeRgbaPng(image: RgbaImage, signal?: AbortSignal): Promise<Uint8Array> {
  throwIfAborted(signal);
  validateRgbaImage(image);
  const header = new Uint8Array(13);
  const view = byteView(header);
  view.setUint32(0, image.width, false);
  view.setUint32(4, image.height, false);
  header.set([8, 6, 0, 0, 0], 8);
  const physical = new Uint8Array(9);
  byteView(physical).setUint32(0, 2835, false);
  byteView(physical).setUint32(4, 2835, false);
  physical[8] = 1;
  const stride = image.width * 4;
  const scanlines = new Uint8Array((stride + 1) * image.height);
  for (let row = 0; row < image.height; row++) {
    // Filter 0 is the zero-initialized first byte of each row.
    scanlines.set(image.data.subarray(row * stride, (row + 1) * stride), row * (stride + 1) + 1);
  }
  const compressed = await compressZlib(scanlines, signal);
  throwIfAborted(signal);
  const chunks = [PNG_SIGNATURE, pngChunk('IHDR', header), pngChunk('pHYs', physical)];
  for (let offset = 0; offset < compressed.byteLength; offset += CHUNK_BLOCK_SIZE) {
    chunks.push(pngChunk('IDAT', compressed.subarray(offset, offset + CHUNK_BLOCK_SIZE)));
  }
  chunks.push(pngChunk('IEND', new Uint8Array()));
  return concatBytes(chunks);
}

export interface PngDecodeOptions {
  readonly expectedWidth?: number;
  readonly expectedHeight?: number;
  /** The runtime writer currently emits only filter 0; conformity tests exercise filters 0..4. */
  readonly onlyFilterZero?: boolean;
}

function pngFailure(message: string, context: Readonly<Record<string, unknown>> = {}): never {
  throw new ShipExportError('E_PNG_PROFILE', message, context);
}

function paeth(left: number, up: number, upperLeft: number): number {
  const predictor = left + up - upperLeft;
  const a = Math.abs(predictor - left), b = Math.abs(predictor - up), c = Math.abs(predictor - upperLeft);
  return a <= b && a <= c ? left : b <= c ? up : upperLeft;
}

/** Restricted local reader: RGBA8, non-interlaced, known chunk order, bounded zlib, PNG filters 0..4. */
export async function decodeRgbaPng(png: Uint8Array, signal?: AbortSignal,
  options: PngDecodeOptions = {}): Promise<RgbaImage> {
  throwIfAborted(signal);
  if (!bytesEqual(png.subarray(0, 8), PNG_SIGNATURE)) pngFailure('Signature PNG invalide.');
  let offset = 8, width = 0, height = 0;
  let headerSeen = false, physicalSeen = false, idatSeen = false, endSeen = false;
  const idats: Uint8Array[] = [];
  const view = byteView(png);
  while (offset < png.byteLength) {
    throwIfAborted(signal);
    if (png.byteLength - offset < 12) pngFailure('Chunk PNG tronqué.');
    const length = view.getUint32(offset, false);
    const end = offset + 12 + length;
    if (end > png.byteLength) pngFailure('Longueur de chunk PNG invalide.', { offset, length });
    const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
    const data = png.subarray(offset + 8, end - 4);
    if (view.getUint32(end - 4, false) !== crc32(png.subarray(offset + 4, end - 4))) {
      throw new ShipExportError('E_EXPORT_INTEGRITY', 'Le CRC d’un chunk PNG est incorrect.', { type, offset });
    }
    if (!headerSeen && type !== 'IHDR') pngFailure('IHDR doit être le premier chunk PNG.');
    switch (type) {
    case 'IHDR': {
      if (headerSeen || length !== 13) pngFailure('IHDR dupliqué ou invalide.');
      const header = byteView(data);
      width = header.getUint32(0, false);
      height = header.getUint32(4, false);
      if (!width || !height || width * height > 16_000_000 || !bytesEqual(data.subarray(8), Uint8Array.of(8, 6, 0, 0, 0))) {
        pngFailure('Seul le PNG RGBA8 non entrelacé est accepté.');
      }
      if (options.expectedWidth !== undefined && width !== options.expectedWidth
        || options.expectedHeight !== undefined && height !== options.expectedHeight) {
        pngFailure('Les dimensions PNG diffèrent de la miniature attendue.', { width, height });
      }
      headerSeen = true;
      break;
    }
    case 'pHYs':
    if (physicalSeen || idatSeen || length !== 9 || data[8]! > 1) pngFailure('Chunk pHYs invalide ou mal placé.');

    physicalSeen = true;

    break;
    case 'IDAT':
    if (endSeen) pngFailure('IDAT placé après IEND.');

    idatSeen = true;

    idats.push(data);

    break;
    case 'IEND':
    if (!idatSeen || length !== 0 || end !== png.byteLength) pngFailure('IEND invalide ou suivi d’octets supplémentaires.');

    endSeen = true;

    break;
    default: pngFailure('Chunk PNG non admis par le profil de contrôle.', { type });
    }
    offset = end;
  }
  if (!headerSeen || !idatSeen || !endSeen) pngFailure('PNG incomplet.');
  const stride = width * 4;
  const scanlines = await decompressZlib(concatBytes(idats), (stride + 1) * height, signal);
  throwIfAborted(signal);
  const data = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row++) {
    const filter = scanlines[row * (stride + 1)]!;
    if (filter > 4 || options.onlyFilterZero && filter !== 0) pngFailure('Filtre PNG non admis.', { row, filter });
    const source = row * (stride + 1) + 1;
    const target = row * stride;
    for (let column = 0; column < stride; column++) {
      const left = column >= 4 ? data[target + column - 4]! : 0;
      const up = row ? data[target + column - stride]! : 0;
      const upperLeft = row && column >= 4 ? data[target + column - stride - 4]! : 0;
      const predictor = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up
        : filter === 3 ? Math.floor((left + up) / 2) : paeth(left, up, upperLeft);
      data[target + column] = (scanlines[source + column]! + predictor) & 0xff;
    }
  }
  return { width, height, data };
}

/** Control the final PNG bytes, all RGBA if provided, and the exact COSMOSHIP container. */
export async function verifyExportEnvelope(
  png: Uint8Array,
  expectedContainer: Uint8Array,
  expectedImage?: RgbaImage,
  signal?: AbortSignal
): Promise<void> {
  const image = await decodeRgbaPng(png, signal, {
    expectedWidth: SHIP_PNG_WIDTH,
    expectedHeight: SHIP_PNG_HEIGHT,
    onlyFilterZero: true,
  });
  throwIfAborted(signal);
  if (expectedImage && (expectedImage.width !== image.width || expectedImage.height !== image.height
    || !bytesEqual(image.data, expectedImage.data))) {
    throw new ShipExportError('E_EXPORT_INTEGRITY', 'Les pixels RGBA du PNG final diffèrent du buffer inséré.');
  }
  if (!bytesEqual(extractShipContainer(image), expectedContainer)) {
    throw new ShipExportError('E_EXPORT_INTEGRITY', 'Le PNG final ne contient pas exactement le conteneur COSMOSHIP attendu.');
  }
}
