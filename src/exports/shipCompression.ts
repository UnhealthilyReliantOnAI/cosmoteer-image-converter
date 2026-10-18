import { byteView, bytesEqual, concatBytes, crc32 } from './shipBytes';
import { ShipExportError, throwIfAborted } from './shipErrors';

export const SHIP_GZIP_HEADER = Uint8Array.of(0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 10);

export const MAX_SHIP_TREE_BYTES = 64 * 1024 * 1024;

type CodecFormat = 'deflate' | 'deflate-raw' | 'gzip';

/** Probe each actual constructor/format. Merely finding a global does not prove format support. */
function nativeCodec(format: CodecFormat, decompress: boolean): CompressionStream | DecompressionStream {
  try {
    return decompress ? new DecompressionStream(format) : new CompressionStream(format);
  } catch {
    throw new ShipExportError('E_CODEC_UNAVAILABLE', 'Ce navigateur ne propose pas les codecs locaux nécessaires.',
    { format, operation: decompress ? 'decompress' : 'compress' });
  }
}

/** Consume during production, bound the decoded output, and cancel both sides on abort/error. */
async function transformBytes(
  input: Uint8Array,
  format: CodecFormat,
  decompress: boolean,
  maximum: number,
  signal?: AbortSignal
): Promise<Uint8Array> {
  throwIfAborted(signal);
  const codec = nativeCodec(format, decompress);
  // Own the bytes for the duration of the async stream; source callers can reuse their buffers.
  const owned = new Uint8Array(input);
  let offset = 0;
  const source = new ReadableStream<BufferSource>({
    pull(controller) {
      if (signal?.aborted) {
        controller.error(new ShipExportError('E_EXPORT_ABORTED', 'Export annulé.'));
        return;
      }
      if (offset === owned.byteLength) {
        controller.close();
        return;
      }
      const end = Math.min(offset + 65_536, owned.byteLength);
      controller.enqueue(owned.subarray(offset, end));
      offset = end;
    },
  });
  const reader = source.pipeThrough(codec).getReader();
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      throwIfAborted(signal);
      const { value, done } = await reader.read();
      throwIfAborted(signal);
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        throw new ShipExportError('E_EXPORT_INTEGRITY', 'Le flux décompressé ou compressé dépasse la taille attendue.',
        { size, maximum, format });
      }
      chunks.push(value);
    }
    return concatBytes(chunks, maximum);
  } catch (cause) {
    await reader.cancel().catch(() => undefined);
    throwIfAborted(signal);
    if (cause instanceof ShipExportError) throw cause;
    throw new ShipExportError('E_EXPORT_INTEGRITY', 'Le flux de compression est incomplet ou corrompu.', { format });
  } finally {
    signal?.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

export async function compressZlib(bytes: Uint8Array, signal?: AbortSignal): Promise<Uint8Array> {
  return transformBytes(
    bytes,
    'deflate',
    false,
    bytes.byteLength + Math.ceil(bytes.byteLength / 16_384) * 8 + 64,
    signal
  );
}

export async function decompressZlib(bytes: Uint8Array, expectedSize: number, signal?: AbortSignal): Promise<Uint8Array> {
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > 65 * 1024 * 1024) {
    throw new ShipExportError('E_EXPORT_INTEGRITY', 'Taille de décompression zlib invalide.', { expectedSize });
  }
  const plain = await transformBytes(bytes, 'deflate', true, expectedSize, signal);
  if (plain.byteLength !== expectedSize) {
    throw new ShipExportError('E_EXPORT_INTEGRITY', 'La taille décompressée zlib ne correspond pas aux lignes PNG.',
    { expectedSize, actualSize: plain.byteLength });
  }
  return plain;
}

/** A fresh GZIP member with the exact documented header and independently computed trailer. */
export async function compressShipTree(plain: Uint8Array, signal?: AbortSignal): Promise<Uint8Array> {
  if (plain.byteLength > MAX_SHIP_TREE_BYTES) {
    throw new ShipExportError('E_EXPORT_INTEGRITY', 'L’arbre dépasse la borne de sérialisation.', { plainBytes: plain.byteLength });
  }
  // The trailer and the compressed body must describe the same owned snapshot, even if
  // the caller mutates or detaches its original buffer while native compression awaits.
  const owned = new Uint8Array(plain);
  const checksum = crc32(owned);
  const plainSize = owned.byteLength;
  const deflate = await transformBytes(owned, 'deflate-raw', false, MAX_SHIP_TREE_BYTES + 1024 * 1024, signal);
  throwIfAborted(signal);
  const trailer = new Uint8Array(8);
  byteView(trailer).setUint32(0, checksum, true);
  byteView(trailer).setUint32(4, plainSize >>> 0, true);
  return concatBytes([SHIP_GZIP_HEADER, deflate, trailer]);
}

export function validateShipGzipHeader(gzip: Uint8Array): void {
  if (gzip.byteLength < 18 || !bytesEqual(gzip.subarray(0, 10), SHIP_GZIP_HEADER)) {
    throw new ShipExportError('E_EXPORT_INTEGRITY', 'Le membre GZIP ne respecte pas le profil de l’exporteur.');
  }
}

/** Native GZIP decoding is strict: CRC, ISIZE, one member, and no trailing bytes. */
export async function decompressShipTree(gzip: Uint8Array, expectedSize: number, signal?: AbortSignal): Promise<Uint8Array> {
  validateShipGzipHeader(gzip);
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > MAX_SHIP_TREE_BYTES) {
    throw new ShipExportError('E_EXPORT_INTEGRITY', 'Taille attendue de l’arbre invalide.', { expectedSize });
  }
  // Capture trailer values before yielding, for the same ownership rule as the writer.
  const trailer = byteView(gzip.subarray(gzip.byteLength - 8));
  const expectedChecksum = trailer.getUint32(0, true);
  const expectedPlainSize = trailer.getUint32(4, true);
  const plain = await transformBytes(gzip, 'gzip', true, expectedSize, signal);
  if (plain.byteLength !== expectedSize || expectedPlainSize !== plain.byteLength
    || expectedChecksum !== crc32(plain)) {
    throw new ShipExportError('E_EXPORT_INTEGRITY', 'Le contrôle CRC ou la longueur GZIP ne correspond pas à l’arbre.');
  }
  return plain;
}
