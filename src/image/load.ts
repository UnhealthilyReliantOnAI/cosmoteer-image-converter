import type { AnalyzedSilhouette } from './analysis';
import { readPngDimensions, readRasterDimensions } from './formats';
import { MAX_IMAGE_BYTES, IMAGE_PROCESSING_TIMEOUT_MS } from './limits';
import type { ImageWorkerResult } from './workerProtocol';

export interface LoadedImage {
  readonly silhouette: AnalyzedSilhouette | null;
  readonly width: number;
  readonly height: number;
  /** The UI owns this URL and must revoke it when no longer displayed. */
  readonly previewUrl: string;
}

/** Local browser-only adapter; pure image analysis never touches the DOM. */
export async function loadPng(file: File, signal?: AbortSignal): Promise<LoadedImage> {
  signal?.throwIfAborted();
  if (file.size > MAX_IMAGE_BYTES) {
    throw new Error('Le fichier PNG dépasse 256 Mio : limite de sécurité pour les données compressées du décodeur.');
  }
  const expected = readPngDimensions(new Uint8Array(await file.slice(0, 33).arrayBuffer()));
  signal?.throwIfAborted();
  return decodeImage(file, expected, signal);
}

export async function loadImage(file: File, signal?: AbortSignal): Promise<LoadedImage> {
  signal?.throwIfAborted();
  if (file.size > MAX_IMAGE_BYTES) throw new Error('Le fichier dépasse 256 Mio : utilisez une image moins volumineuse.');
  // JPEG metadata may precede the frame. Bound this read rather than allocating the entire file.
  const expected = readRasterDimensions(new Uint8Array(await file.slice(0, 1024 * 1024).arrayBuffer()));
  signal?.throwIfAborted();
  const mime = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' }[expected.format];
  const normalized = file.slice(0, file.size, mime);
  return decodeImage(
    normalized,
    { width: expected.width, height: expected.height },
    signal,
    expected.format === 'jpeg'
  );
}

/** Shared bounded Worker lifecycle for the supported raster formats. */
export function decodeImage(
  file: Blob,
  expected: {
    width: number;
    height: number;
  },
  signal?: AbortSignal,
  autoOrient = false
): Promise<LoadedImage> {
  signal?.throwIfAborted();
  return new Promise<LoadedImage>((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./decode.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      reject(new Error('Ce navigateur ne permet pas le traitement d’image dans un Web Worker local. Utilisez un navigateur récent.'));
      return;
    }
    let settled = false;
    const cleanup = () => {
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      worker.terminate();
    };
    const abort = () => {
      if (settled) return;
      cleanup();
      reject(new DOMException('Lecture d’image annulée.', 'AbortError'));
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Le traitement de l’image a dépassé 60 secondes et a été interrompu. Réduisez sa résolution.'));
    }, IMAGE_PROCESSING_TIMEOUT_MS);
    signal?.addEventListener('abort', abort, { once: true });
    worker.onmessage = (event: MessageEvent<ImageWorkerResult>) => {
      if (settled) return;
      cleanup();
      if (event.data.kind === 'error') {
        reject(new Error(event.data.message));
        return;
      }
      try {
        resolve({
          ...(event.data.dimensions ?? expected),
          silhouette: event.data.silhouette,
          previewUrl: URL.createObjectURL(file),
        });
      } catch {
        reject(new Error('Le navigateur ne peut pas créer la prévisualisation de cette image.'));
      }
    };
    worker.onerror = () => {
      if (settled) return;
      cleanup();
      reject(new Error('Le traitement isolé de l’image a échoué : mémoire insuffisante ou API de décodage indisponible.'));
    };
    worker.onmessageerror = () => {
      if (settled) return;
      cleanup();
      reject(new Error('Le navigateur n’a pas pu transférer le masque de l’image.'));
    };
    try {
      // File is a native Blob; the browser shares its backing data rather than reading it into JS.
      worker.postMessage({ file, ...expected, ...(autoOrient ? { autoOrient: true } : {}) });
    } catch {
      cleanup();
      reject(new Error('Impossible de transmettre cette image au traitement local.'));
    }
  });
}
