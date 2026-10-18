import type { GridSize } from '../construction/grid';
import { validateMask } from './analysis';
import type { BinaryMask } from './analysis';

/** Exact area resampling, shared by the square reference and the finer geometric target. */
export function resampleMaskInto(
  mask: BinaryMask,
  target: GridSize,
  fractions: Float32Array | Float64Array,
  checkpoint: () => void = () => {}
): void {
  checkpoint();
  validateMask(mask);
  const { width, height } = target;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
    || fractions.length !== width * height) throw new Error('Dimensions du masque de couverture invalides.');
  const stride = mask.stride ?? mask.width;
  const cellArea = mask.width * mask.height;
  for (let y = 0; y < height; y += 1) {
    checkpoint();
    const top = y * mask.height;
    const bottom = (y + 1) * mask.height;
    for (let x = 0; x < width; x += 1) {
      const left = x * mask.width;
      const right = (x + 1) * mask.width;
      let blackArea = 0;
      for (let sy = Math.floor(top / height); sy < Math.ceil(bottom / height); sy += 1) {
        const overlapY = Math.min(bottom, (sy + 1) * height) - Math.max(top, sy * height);
        for (let sx = Math.floor(left / width); sx < Math.ceil(right / width); sx += 1) {
          if (mask.data[sy * stride + sx] === 1) {
            const overlapX = Math.min(right, (sx + 1) * width) - Math.max(left, sx * width);
            blackArea += overlapX * overlapY;
          }
        }
      }
      fractions[y * width + x] = blackArea / cellArea;
    }
  }
}
