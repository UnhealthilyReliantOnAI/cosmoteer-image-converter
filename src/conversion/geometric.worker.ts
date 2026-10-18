import { validateAllowedFamilies } from '../catalog/pieces';
import { convertPreparedTarget, validateControls } from './geometric';
import { convertToSquares } from './squares';
import { prepareTarget } from './target';
import type { ConversionRequest, ConversionResponse } from './workerProtocol';

function reportError(cause: unknown) {
  const message: ConversionResponse = {
    kind: 'error',
    message: cause instanceof Error ? cause.message : 'La conversion a échoué.',
  };
  self.postMessage(message);
}

self.onmessage = (event: MessageEvent<ConversionRequest>) => {
  try {
    const { mask, largestDimension, allowedFamilies, smoothing = 0, symmetry = 'none', forceUnified = false } = event.data;
    validateAllowedFamilies(allowedFamilies);
    validateControls({ smoothing, symmetry, forceUnified });
    const target = prepareTarget(mask, largestDimension);
    const squareReference = allowedFamilies.every((type) => type === 'square_1x1')
      ? convertToSquares(mask, largestDimension) : null;
    // End the source-reading stack first. This closure retains only the fine target and parameters,
    // so the source raster copy becomes collectible before the optimization starts.
    queueMicrotask(() => {
      try {
        const result = convertPreparedTarget(
          target,
          { allowedFamilies, smoothing, symmetry, forceUnified, includeComparison: true },
          squareReference
        );
        const message: ConversionResponse = { kind: 'success', result };
        self.postMessage(message, {
          transfer: result.comparison
            ? [
            result.comparison.target.buffer as ArrayBuffer,
            result.comparison.generated.buffer as ArrayBuffer,
            result.comparison.intersection.buffer as ArrayBuffer,
          ] : [],
        });
      } catch (cause) {
        reportError(cause);
      }
    });
  } catch (cause) {
    reportError(cause);
  }
};
