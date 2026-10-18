import { createBinaryMaskFromRows, cropToBlackBounds } from './analysis';
import { RGBA_TILE_PIXELS, validateImageDimensions } from './limits';
import type { ImageWorkerRequest, ImageWorkerResult } from './workerProtocol';

self.onmessage = async (event: MessageEvent<ImageWorkerRequest>) => {
  const { file, autoOrient } = event.data;
  let { width, height } = event.data;
  let bitmap: ImageBitmap | null = null;
  let canvas: OffscreenCanvas | null = null;
  let phase = 'decode';
  try {
    validateImageDimensions(width, height);
    bitmap = await createImageBitmap(file);
    if (bitmap.width !== width || bitmap.height !== height) {
      if (autoOrient && bitmap.width === height && bitmap.height === width) {
        width = bitmap.width;
        height = bitmap.height;
      } else {
        throw new Error('Les dimensions décodées ne correspondent pas à l’en-tête de l’image.');
      }
    }
    phase = 'pixels';
    const rowsPerChunk = Math.max(1, Math.floor(RGBA_TILE_PIXELS / width));
    canvas = new OffscreenCanvas(width, Math.min(height, rowsPerChunk));
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('La lecture des pixels n’est pas disponible dans ce navigateur.');
    const decoded = bitmap;
    const mask = await createBinaryMaskFromRows(width, height, rowsPerChunk, (firstRow, rowCount) => {
      // Transparent pixels must overwrite the previous stripe, not blend with it.
      context.clearRect(0, 0, width, canvas!.height);
      context.drawImage(decoded, 0, firstRow, width, rowCount, 0, 0, width, rowCount);
      return { width, height: rowCount, data: context.getImageData(0, 0, width, rowCount).data };
    });
    const silhouette = cropToBlackBounds(mask);
    const message: ImageWorkerResult = { kind: 'success', silhouette, dimensions: { width, height } };
    self.postMessage(message, { transfer: silhouette ? [silhouette.mask.data.buffer as ArrayBuffer] : [] });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : 'Erreur inconnue.';
    const message: ImageWorkerResult = {
      kind: 'error',
      message: phase === 'decode'
        ? `Impossible de décoder cette image : fichier endommagé, dimensions non prises en charge ou mémoire insuffisante. ${detail}`
        : `Impossible de lire les pixels de cette image : le navigateur a atteint ses capacités de traitement ou de mémoire. ${detail}`,
    };
    self.postMessage(message);
  } finally {
    bitmap?.close();
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
};
