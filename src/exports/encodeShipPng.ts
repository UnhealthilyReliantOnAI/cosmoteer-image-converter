import type { Construction } from '../construction/model';
import { compressShipTree } from './shipCompression';
import { embedPayload, makeShipContainer, SHIP_CONTAINER_CAPACITY } from './shipContainer';
import { ShipExportError } from './shipErrors';
import type { ShipExportStage, ShipPngResult } from './shipExportWorkerProtocol';
import { adaptConstructionToNative } from './shipNative';
import { encodeRgbaPng, verifyExportEnvelope } from './shipPng';
import type { RgbaImage } from './shipPng';
import { createNativeTree, NEUTRAL_PROFILE_ID } from './shipProfile';
import {
  createConstructionThumbnailRgba,
  createNeutralThumbnailRgba,
  THUMBNAIL_SIZE
} from './shipThumbnail';
import { serializeTree } from './shipTree';

export interface ShipExportOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (stage: ShipExportStage) => void;
  /** Testable graphics boundary; a rendering failure alone may use the neutral carrier. */
  readonly thumbnail?: (construction: Construction, signal?: AbortSignal) => Promise<RgbaImage>;
}

/** Construction is the sole source. No conversion, SVG, JSON text or download occurs here. */
export async function encodeShipPng(construction: Construction, options: ShipExportOptions = {}): Promise<ShipPngResult> {
  const { signal, onProgress } = options;
  const durations = {} as Record<ShipExportStage, number>;
  signal?.throwIfAborted();
  onProgress?.('validate');
  const validationStart = performance.now();
  const native = adaptConstructionToNative(construction);
  // Capture our own values before the first await; later mutations cannot change this export.
  const snapshot: Construction = {
    width: construction.width,
    height: construction.height,
    pieces: construction.pieces.map((piece) => ({ ...piece, position: { ...piece.position } })),
  };
  durations.validate = performance.now() - validationStart;

  async function stage<T>(name: ShipExportStage, operation: () => T | Promise<T>): Promise<T> {
    signal?.throwIfAborted();
    onProgress?.(name);
    // A real checkpoint, so both the label and cancellation can reach the UI.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    signal?.throwIfAborted();
    const start = performance.now();
    const result = await operation();
    durations[name] = performance.now() - start;
    signal?.throwIfAborted();
    return result;
  }

  const plain = await stage('serialize', () => serializeTree(createNativeTree(native.components)));
  const gzip = await stage('gzip', () => compressShipTree(plain, signal));
  // Capacity errors are never treated as miniature errors.
  const container = makeShipContainer(gzip);
  let thumbnailMode: 'construction' | 'neutral' = 'construction';
  const image = await stage('thumbnail', async () => {
    try {
      const rendered = await (options.thumbnail ?? createConstructionThumbnailRgba)(snapshot, signal);
      if (rendered.width !== THUMBNAIL_SIZE || rendered.height !== THUMBNAIL_SIZE
        || rendered.data.length !== THUMBNAIL_SIZE * THUMBNAIL_SIZE * 4
        || rendered.data.some((value, index) => index % 4 === 3 && value !== 255)) {
        throw new Error('La miniature doit être un buffer RGBA opaque 512 × 512.');
      }
      return rendered;
    } catch (cause) {
      signal?.throwIfAborted();
      if (cause instanceof Error && cause.name === 'AbortError'
        || cause instanceof ShipExportError && cause.code === 'E_EXPORT_ABORTED') throw cause;
      thumbnailMode = 'neutral';
      return createNeutralThumbnailRgba();
    }
  });
  const embedded = await stage('embed', () => embedPayload(image, container));
  const png = await stage('png', () => encodeRgbaPng(embedded, signal));
  await stage('verify', () => verifyExportEnvelope(png, container, embedded, signal));
  return {
    png,
    diagnostics: {
      partsCount: native.components.length,
      plainBytes: plain.length,
      gzipBytes: gzip.length,
      containerBytes: container.length,
      capacityBytes: SHIP_CONTAINER_CAPACITY,
      profileId: NEUTRAL_PROFILE_ID,
      thumbnailMode,
      durations,
    },
  };
}
