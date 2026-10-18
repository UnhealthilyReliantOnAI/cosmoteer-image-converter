import type { ConversionResult } from './types';
import type { ConversionRequest, ConversionResponse } from './workerProtocol';

export const CONVERSION_TIMEOUT_MS = 60_000;

export const QUALITY_CONVERSION_TIMEOUT_MS = 180_000;

/** One isolated task per conversion, matching the image Worker lifecycle. */
export function convertInWorker(request: ConversionRequest, signal?: AbortSignal): Promise<ConversionResult> {
  signal?.throwIfAborted();
  const timeoutMs = (request.smoothing ?? 0) > 0 || (request.symmetry ?? 'none') !== 'none' || request.forceUnified
    ? QUALITY_CONVERSION_TIMEOUT_MS : CONVERSION_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./geometric.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      reject(new Error('Ce navigateur ne permet pas la conversion dans un Web Worker local.'));
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
      reject(new DOMException('Conversion annulée.', 'AbortError'));
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`La conversion a dépassé ${timeoutMs / 1000} secondes et a été interrompue. Réduisez la taille cible.`));
    }, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    worker.onmessage = (event: MessageEvent<ConversionResponse>) => {
      if (settled) return;
      cleanup();
      if (event.data.kind === 'success') resolve(event.data.result);
      else reject(new Error(event.data.message));
    };
    worker.onerror = () => {
      if (settled) return;
      cleanup();
      reject(new Error('La conversion locale a échoué : mémoire insuffisante ou erreur du Worker.'));
    };
    worker.onmessageerror = () => {
      if (settled) return;
      cleanup();
      reject(new Error('Impossible de recevoir la construction du Worker local.'));
    };
    try {
      // Keep the original mask usable for future conversions and cancellation; only a bounded copy is sent.
      worker.postMessage(request);
    } catch {
      cleanup();
      reject(new Error('Impossible de transmettre la silhouette à la conversion locale.'));
    }
  });
}
