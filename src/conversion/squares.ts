import { STANDARD_GRID_LIMIT } from '../construction/grid';
import type { Construction, GridSize, PiecePlacement } from '../construction/model';
import type { BinaryMask } from '../image/analysis';
import { resampleMaskInto } from '../image/coverage';

export const CELL_FILL_THRESHOLD = 0.5;

/** Round the minor dimension to the closest whole cell, with a minimum of one. */
export function calculateTargetDimensions(source: GridSize, largestDimension: number): GridSize {
  if (!Number.isSafeInteger(source.width) || !Number.isSafeInteger(source.height)
    || source.width < 1 || source.height < 1) {
    throw new Error('La silhouette doit avoir des dimensions entières positives.');
  }
  if (!Number.isInteger(largestDimension) || largestDimension < 1 || largestDimension > STANDARD_GRID_LIMIT) {
    throw new Error(`La taille doit être un entier compris entre 1 et ${STANDARD_GRID_LIMIT} cases.`);
  }
  const longestSide = Math.max(source.width, source.height);
  return {
    width: Math.max(1, Math.min(largestDimension, Math.round(source.width * largestDimension / longestSide))),
    height: Math.max(1, Math.min(largestDimension, Math.round(source.height * largestDimension / longestSide))),
  };
}

export interface CellCoverage extends GridSize {
  /** Exact black area fraction in each target cell, in row-major order. */
  readonly fractions: Float64Array;
}

/** Area sampling, without interpolation. Integer overlap lengths avoid floating-point ties. */
export function measureCellCoverage(mask: BinaryMask, largestDimension: number): CellCoverage {
  const { width, height } = calculateTargetDimensions(mask, largestDimension);
  const fractions = new Float64Array(width * height);
  resampleMaskInto(mask, { width, height }, fractions);
  return { width, height, fractions };
}

/** One square per cell with >= 50% black; stable IDs and top-to-bottom, left-to-right order. */
export function convertToSquares(mask: BinaryMask, largestDimension: number): Construction {
  const { width, height, fractions } = measureCellCoverage(mask, largestDimension);
  const pieces: PiecePlacement[] = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (fractions[y * width + x]! >= CELL_FILL_THRESHOLD) {
        pieces.push({ id: `square-${x}-${y}`, type: 'square_1x1', rotation: 0, position: { x, y } });
      }
    }
  }
  return { width, height, pieces };
}
