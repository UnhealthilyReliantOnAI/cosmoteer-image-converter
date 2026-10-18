import { STANDARD_GRID_LIMIT } from '../construction/grid';
import type { GridSize } from '../construction/grid';
import type { BinaryMask } from '../image/analysis';
import { resampleMaskInto } from '../image/coverage';
import { calculateTargetDimensions } from './squares';

/** Divisible by 2 and 3, including the half-cell vertices and all long wedge slopes. */
export const SAMPLES_PER_CELL = 24;

const MAX_RESOLUTION = 96;

const MAX_SAMPLE_DIMENSION = STANDARD_GRID_LIMIT * SAMPLES_PER_CELL;

export interface CoverageTarget extends GridSize {
  readonly resolution: number;
  /** Area fractions in fine samples, row-major at width * resolution. */
  readonly fractions: Float32Array;
  readonly cellAreas: Float64Array;
  readonly blackArea: number;
}

/** Optimization uses only this bounded representation, never the full source raster. */
export function prepareTarget(mask: BinaryMask, largestDimension: number,
  checkpoint: () => void = () => {}): CoverageTarget {
  const grid = calculateTargetDimensions(mask, largestDimension);
  // Spend the same bounded memory budget on better contour precision for smaller grids.
  // Multiples of 12 preserve all catalog slopes; at 120 cells this is still 24 samples/cell.
  const resolution = Math.min(MAX_RESOLUTION,
  Math.max(SAMPLES_PER_CELL, 12 * Math.floor(MAX_SAMPLE_DIMENSION / (Math.max(grid.width, grid.height) * 12))));
  const sampleWidth = grid.width * resolution;
  const fractions = new Float32Array(sampleWidth * grid.height * resolution);
  resampleMaskInto(mask, { width: sampleWidth, height: grid.height * resolution }, fractions, checkpoint);
  const cellAreas = new Float64Array(grid.width * grid.height);
  for (let y = 0; y < grid.height; y += 1) {
    checkpoint();
    for (let x = 0; x < grid.width; x += 1) {
      let sum = 0;
      for (let sy = 0; sy < resolution; sy += 1) {
        const row = (y * resolution + sy) * sampleWidth + x * resolution;
        for (let sx = 0; sx < resolution; sx += 1) sum += fractions[row + sx]!;
      }
      cellAreas[y * grid.width + x] = sum / (resolution * resolution);
    }
  }
  return {
    ...grid,
    resolution,
    fractions,
    cellAreas,
    blackArea: cellAreas.reduce((sum, area) => sum + area, 0),
  };
}
