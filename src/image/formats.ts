import { validateImageDimensions } from './limits';

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/** Check signature and IHDR before asking the browser to allocate decoded pixels. */
export function readPngDimensions(header: Uint8Array): {
  width: number;
  height: number;
} {
  if (header.length < 33 || PNG_SIGNATURE.some((byte, index) => header[index] !== byte)) {
    throw new Error('Le fichier sélectionné n’est pas une image PNG valide.');
  }
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  if (view.getUint32(8) !== 13 || String.fromCharCode(...header.subarray(12, 16)) !== 'IHDR') {
    throw new Error('L’en-tête PNG est invalide.');
  }
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  validateImageDimensions(width, height);
  return { width, height };
}

const textAt = (bytes: Uint8Array, start: number, length: number) => String.fromCharCode(...bytes.subarray(start, start + length));

const invalid = () => new Error('Format non reconnu ou en-tête endommagé. Choisissez une image PNG, JPEG ou WebP.');

/** Bounded header inspection before native decoding. MIME and filename are not trusted. */
export function readRasterDimensions(bytes: Uint8Array): {
  width: number;
  height: number;
  format: 'png' | 'jpeg' | 'webp';
} {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0, height = 0;
  let format: 'png' | 'jpeg' | 'webp';
  if (bytes[0] === 137 && textAt(bytes, 1, 3) === 'PNG') {
    return { ...readPngDimensions(bytes), format: 'png' };
  } else if (bytes[0] === 255 && bytes[1] === 216) {
    format = 'jpeg';
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 255) throw invalid();
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 217 || marker === 218 || marker === undefined) break;
      if (marker === 1 || marker >= 208 && marker <= 215) continue;
      if (offset + 2 > bytes.length) break;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)) {
        if (length < 8) throw invalid();
        height = view.getUint16(offset + 3);
        width = view.getUint16(offset + 5);
        break;
      }
      offset += length;
    }
  } else if (bytes.length >= 30 && textAt(bytes, 0, 4) === 'RIFF' && textAt(bytes, 8, 4) === 'WEBP') {
    format = 'webp';
    const chunk = textAt(bytes, 12, 4);
    if (chunk === 'VP8X') {
      if (bytes[20]! & 2) throw new Error('Les images WebP animées ne sont pas prises en charge. Utilisez une image fixe.');
      width = 1 + bytes[24]! + (bytes[25]! << 8) + (bytes[26]! << 16);
      height = 1 + bytes[27]! + (bytes[28]! << 8) + (bytes[29]! << 16);
    } else if (chunk === 'VP8L' && bytes[20] === 47) {
      const bits = view.getUint32(21, true);
      width = (bits & 0x3fff) + 1;
      height = ((bits >>> 14) & 0x3fff) + 1;
    } else if (chunk === 'VP8 ' && bytes[23] === 157 && bytes[24] === 1 && bytes[25] === 42) {
      width = view.getUint16(26, true) & 0x3fff;
      height = view.getUint16(28, true) & 0x3fff;
    }
  } else throw invalid();
  if (!width || !height) throw invalid();
  validateImageDimensions(width, height);
  return { width, height, format };
}
