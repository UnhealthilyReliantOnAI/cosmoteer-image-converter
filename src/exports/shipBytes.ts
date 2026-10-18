import { ShipExportError } from './shipErrors';

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});

/** Standard reflected CRC32, used separately by GZIP and by each PNG chunk. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff]!;
  return (crc ^ 0xffffffff) >>> 0;
}

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index++) if (left[index] !== right[index]) return false;
  return true;
}

export function concatBytes(parts: readonly Uint8Array[], maximum = 128 * 1024 * 1024): Uint8Array {
  let length = 0;
  for (const part of parts) {
    length += part.byteLength;
    if (!Number.isSafeInteger(length) || length > maximum) {
      throw new ShipExportError('E_EXPORT_INTEGRITY', 'La taille du buffer dépasse la borne de sécurité.', { length, maximum });
    }
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

/** Preserve the bounds of a subarray, rather than addressing its complete backing buffer. */
export function byteView(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
