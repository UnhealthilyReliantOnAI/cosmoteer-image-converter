import type { Construction } from '../construction/model';
import type { ShipExportOptions } from './encodeShipPng';
import { ShipExportError } from './shipErrors';
import { SHIP_EXPORT_STAGES } from './shipExportWorkerProtocol';
import type {
  ShipPngResult,
  ShipExportWorkerRequest,
  ShipExportWorkerResponse
} from './shipExportWorkerProtocol';

export const SHIP_EXPORT_TIMEOUT_MS = 60_000;

export type ShipExportWorkerOptions = Pick<ShipExportOptions, 'signal' | 'onProgress'>;

/** Browser facade: isolated work, immediate termination on cancellation, no DOM in the encoder. */
export function encodeShipPngInWorker(construction: Construction,
  options: ShipExportWorkerOptions = {}): Promise<ShipPngResult> {
  const { signal, onProgress } = options;
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./shipExport.worker.ts', import.meta.url), { type: 'module' });
    }
    catch {
      reject(new ShipExportError('E_EXPORT_WORKER', 'Local export Worker is unavailable.', { phase: 'create' }));
      return;
    }
    let settled = false;
    const cleanup = () => {
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      worker.terminate();
    };
    const fail = (cause: unknown) => {
      if (!settled) {
        cleanup();
        reject(cause);
      }
    };
    const abort = () => fail(new DOMException('Ship export cancelled.', 'AbortError'));
    const timeout = setTimeout(() => fail(new ShipExportError('E_EXPORT_TIMEOUT',
    'Ship export exceeded 60 seconds and was stopped.', { timeoutMs: SHIP_EXPORT_TIMEOUT_MS })), SHIP_EXPORT_TIMEOUT_MS);
    signal?.addEventListener('abort', abort, { once: true });
    worker.onmessage = (event: MessageEvent<ShipExportWorkerResponse>) => {
      if (settled) return;
      const message = event.data;
      if (!message || typeof message !== 'object') {
        fail(new ShipExportError('E_EXPORT_WORKER', 'Invalid export Worker response.', { phase: 'receive' }));
      } else if (message.kind === 'progress') {
        if (!SHIP_EXPORT_STAGES.includes(message.stage)) {
          fail(new ShipExportError('E_EXPORT_WORKER', 'Unknown export progress stage.', { phase: 'receive' }));
          return;
        }
        try {
          onProgress?.(message.stage);
        } catch (cause) {
          fail(cause);
        }
      } else if (message.kind === 'success' && message.result?.png instanceof Uint8Array && message.result.diagnostics) {
        cleanup();
        resolve(message.result);
      } else if (message.kind === 'failure' && typeof message.code === 'string' && typeof message.message === 'string') {
        fail(new ShipExportError(message.code, message.message, message.context));
      } else {
        fail(new ShipExportError('E_EXPORT_WORKER', 'Invalid export Worker response.', { phase: 'receive' }));
      }
    };
    worker.onerror = () => fail(new ShipExportError('E_EXPORT_WORKER', 'Local export Worker failed.', { phase: 'execute' }));
    worker.onmessageerror = () => fail(new ShipExportError('E_EXPORT_WORKER', 'Unable to receive the local export.', { phase: 'receive' }));
    // Cover an abort during Worker construction/handler setup before starting any work.
    if (signal?.aborted) {
      abort();
      return;
    }
    const request: ShipExportWorkerRequest = { kind: 'encode', construction };
    try {
      // Structured cloning only: no transfer list may detach any preview data.
      worker.postMessage(request);
    } catch {
      fail(new ShipExportError('E_EXPORT_WORKER', 'Unable to send the construction to local export.', { phase: 'send' }));
    }
  });
}
