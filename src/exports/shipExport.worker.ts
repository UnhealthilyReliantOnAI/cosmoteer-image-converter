import { encodeShipPng } from './encodeShipPng';
import { ShipExportError } from './shipErrors';
import type { ShipExportWorkerRequest, ShipExportWorkerResponse } from './shipExportWorkerProtocol';

function reportFailure(cause: unknown) {
  const message: ShipExportWorkerResponse = {
    kind: 'failure',
    code: cause instanceof ShipExportError ? cause.code : 'E_EXPORT_WORKER',
    message: cause instanceof Error ? cause.message : 'Local ship export failed.',
    context: cause instanceof ShipExportError ? cause.context : {},
  };
  try {
    self.postMessage(message);
  }
  catch {
    // A failure context itself must never prevent an explicit failure response.
    const fallback: ShipExportWorkerResponse = {
      kind: 'failure',
      code: 'E_EXPORT_WORKER',
      message: 'Unable to transfer the export result.',
      context: { phase: 'send' },
    };
    self.postMessage(fallback);
  }
}

self.onmessage = async (event: MessageEvent<ShipExportWorkerRequest>) => {
  try {
    if (event.data.kind !== 'encode') throw new ShipExportError('E_EXPORT_WORKER', 'Invalid local export request.');
    const result = await encodeShipPng(event.data.construction, {
      onProgress: (stage) => {
        const message: ShipExportWorkerResponse = { kind: 'progress', stage };
        self.postMessage(message);
      },
    });
    const message: ShipExportWorkerResponse = { kind: 'success', result };
    // Transfer only the final owned PNG. Preview/source/construction buffers stay on the UI side.
    self.postMessage(message, { transfer: [result.png.buffer as ArrayBuffer] });
  } catch (cause) {
    reportFailure(cause);
  }
};
