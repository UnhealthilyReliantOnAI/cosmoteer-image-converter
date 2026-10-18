/** Standard game limit. Future profiles can reuse this single configuration point. */
export const STANDARD_GRID_LIMIT = 120;

export interface GridSize {
  readonly width: number;
  readonly height: number;
}

export function isValidGridSize(grid: GridSize): boolean {
  return Number.isSafeInteger(grid.width) && Number.isSafeInteger(grid.height)
    && grid.width >= 1 && grid.height >= 1
    && grid.width <= STANDARD_GRID_LIMIT && grid.height <= STANDARD_GRID_LIMIT;
}
