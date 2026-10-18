import { byteView, bytesEqual } from './shipBytes';
import { validateShipGzipHeader } from './shipCompression';
import { ShipExportError } from './shipErrors';

export const SHIP_PNG_WIDTH = 512;

export const SHIP_PNG_HEIGHT = 512;

export const SHIP_CONTAINER_CAPACITY = 98_304;

export const SHIP_GZIP_CAPACITY = 98_291;

export const COSMOSHIP_MARKER = new TextEncoder().encode('COSMOSHIP');

export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

export function validateRgbaImage(image: RgbaImage): void {
  if (!Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height)
    || image.width < 1 || image.height < 1 || image.width * image.height > 16_000_000
    || !(image.data instanceof Uint8Array) || image.data.byteLength !== image.width * image.height * 4) {
    throw new ShipExportError('E_PNG_PROFILE', 'Le buffer RGBA ou ses dimensions sont invalides.');
  }
}

export function payloadCapacity(width: number, height: number): number {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
    || width * height > 16_000_000) throw new ShipExportError('E_PNG_PROFILE', 'Dimensions de miniature invalides.');
  return Math.floor(width * height * 3 / 8);
}

function requireCapacity(required: number, available: number, gzipBytes?: number): void {
  if (required > available) throw new ShipExportError('E_PAYLOAD_CAPACITY',
  `Export trop volumineux pour la miniature : ${required} octets nécessaires, ${available} disponibles.`,
  {
    containerBytes: required,
    capacityBytes: available,
    ...(gzipBytes === undefined ? {} : { gzipBytes }),
  });
}

export function makeShipContainer(gzip: Uint8Array, capacityBytes = SHIP_CONTAINER_CAPACITY): Uint8Array {
  validateShipGzipHeader(gzip);
  const length = 9 + gzip.byteLength;
  if (length > 0xffffffff || !Number.isSafeInteger(capacityBytes) || capacityBytes < 0) {
    throw new ShipExportError('E_EXPORT_INTEGRITY', 'Longueur de conteneur invalide.');
  }
  requireCapacity(length + 4, capacityBytes, gzip.byteLength);
  const container = new Uint8Array(length + 4);
  byteView(container).setUint32(0, length, false);
  container.set(COSMOSHIP_MARKER, 4);
  container.set(gzip, 13);
  return container;
}

export function readShipContainer(container: Uint8Array, capacityBytes = SHIP_CONTAINER_CAPACITY): Uint8Array {
  if (container.byteLength < 31) throw new ShipExportError('E_EXPORT_INTEGRITY', 'Conteneur COSMOSHIP tronqué.');
  const length = byteView(container).getUint32(0, false);
  requireCapacity(length + 4, capacityBytes);
  if (length + 4 !== container.byteLength || !bytesEqual(container.subarray(4, 13), COSMOSHIP_MARKER)) {
    throw new ShipExportError('E_EXPORT_INTEGRITY', 'Longueur ou marqueur COSMOSHIP incorrect.');
  }
  const gzip = container.subarray(13);
  validateShipGzipHeader(gzip);
  return gzip;
}

/** Returns an owned copy. Only RGB low bits are changed, including RGB under transparent alpha. */
export function embedPayload(image: RgbaImage, payload: Uint8Array): RgbaImage {
  validateRgbaImage(image);
  requireCapacity(payload.byteLength, payloadCapacity(image.width, image.height));
  const data = new Uint8Array(image.data);
  for (let bit = 0; bit < payload.byteLength * 8; bit++) {
    const offset = Math.floor(bit / 3) * 4 + bit % 3;
    data[offset] = (data[offset]! & 0xfe) | ((payload[Math.floor(bit / 8)]! >>> (bit % 8)) & 1);
  }
  return { width: image.width, height: image.height, data };
}

export function extractPayload(image: RgbaImage, byteLength: number): Uint8Array {
  validateRgbaImage(image);
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    throw new ShipExportError('E_EXPORT_INTEGRITY', 'Longueur d’extraction invalide.');
  }
  requireCapacity(byteLength, payloadCapacity(image.width, image.height));
  const result = new Uint8Array(byteLength);
  for (let bit = 0; bit < byteLength * 8; bit++) {
    const offset = Math.floor(bit / 3) * 4 + bit % 3;
    const index = Math.floor(bit / 8);
    result[index] = result[index]! | ((image.data[offset]! & 1) << (bit % 8));
  }
  return result;
}

export function extractShipContainer(image: RgbaImage): Uint8Array {
  const capacity = payloadCapacity(image.width, image.height);
  const prefix = extractPayload(image, 13);
  const length = byteView(prefix).getUint32(0, false);
  requireCapacity(length + 4, capacity);
  if (length < 27 || !bytesEqual(prefix.subarray(4), COSMOSHIP_MARKER)) {
    throw new ShipExportError('E_EXPORT_INTEGRITY', 'Marqueur COSMOSHIP ou longueur du payload incorrect.');
  }
  const container = extractPayload(image, length + 4);
  readShipContainer(container, capacity);
  return container;
}
