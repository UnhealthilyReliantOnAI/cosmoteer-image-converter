import {
  getOrientedFootprint,
  hasMirrorVariant,
  orientPiece,
  PIECE_CATALOG
} from '../catalog/pieces';
import type { PieceType } from '../catalog/pieces';
import { ROTATIONS, translatePolygon } from '../geometry/polygon';
import type { Bounds, Point, Polygon, Rotation } from '../geometry/polygon';
import { isValidGridSize } from './grid';
import type { GridSize } from './grid';

export type { GridSize } from './grid';

export interface PiecePlacement {
  readonly id: string;
  readonly type: PieceType;
  readonly rotation: Rotation;
  /** Missing and false both disable mirroring. Canonical X reflection happens before rotation. */
  readonly mirrored?: boolean;
  /** Top-left corner of the reserved footprint. Valid placements use whole cells. */
  readonly position: Point;
}

export interface Construction extends GridSize {
  readonly pieces: readonly PiecePlacement[];
}

export function getPlacedPolygon(placement: PiecePlacement): Polygon {
  return translatePolygon(
    orientPiece(placement.type, placement.rotation, placement.mirrored).polygon,
    placement.position
  );
}

export function getPlacedFootprint(placement: PiecePlacement): Bounds {
  const footprint = getOrientedFootprint(placement.type, placement.rotation);
  return { minX: placement.position.x, minY: placement.position.y, ...footprint };
}

/** Checks the reserved footprint, integer cell anchors and the standard grid limit. */
export function isWithinGrid(placement: PiecePlacement, grid: GridSize): boolean {
  if (!isValidGridSize(grid)) return false;
  if (!PIECE_CATALOG.some(({ type }) => type === placement.type) || !ROTATIONS.includes(placement.rotation)) return false;
  if (placement.mirrored !== undefined && typeof placement.mirrored !== 'boolean'
    || placement.mirrored && !hasMirrorVariant(placement.type)) return false;
  if (!Number.isSafeInteger(placement.position.x) || !Number.isSafeInteger(placement.position.y)) return false;
  const bounds = getPlacedFootprint(placement);
  return bounds.minX >= 0 && bounds.minY >= 0
    && bounds.minX + bounds.width <= grid.width
    && bounds.minY + bounds.height <= grid.height;
}

/** Shared edges are allowed. Any common reserved cell is a collision. */
export function footprintsOverlap(a: PiecePlacement, b: PiecePlacement): boolean {
  const first = getPlacedFootprint(a);
  const second = getPlacedFootprint(b);
  return first.minX < second.minX + second.width && second.minX < first.minX + first.width
    && first.minY < second.minY + second.height && second.minY < first.minY + first.height;
}

/** Check a candidate before adding it to an existing construction. */
export function canPlacePiece(placement: PiecePlacement, construction: Construction): boolean {
  return isValidConstruction(construction) && isWithinGrid(placement, construction)
    && construction.pieces.every((existing) => existing.id !== placement.id && !footprintsOverlap(existing, placement));
}

/** Validate all reservations in linear time, including duplicate IDs and occupied cells. */
export function isValidConstruction(construction: Construction): boolean {
  if (!isValidGridSize(construction)) return false;
  const ids = new Set<string>();
  const occupied = new Set<number>();
  for (const placement of construction.pieces) {
    if (ids.has(placement.id) || !isWithinGrid(placement, construction)) return false;
    ids.add(placement.id);
    const bounds = getPlacedFootprint(placement);
    for (let y = bounds.minY; y < bounds.minY + bounds.height; y += 1) {
      for (let x = bounds.minX; x < bounds.minX + bounds.width; x += 1) {
        const cell = y * construction.width + x;
        if (occupied.has(cell)) return false;
        occupied.add(cell);
      }
    }
  }
  return true;
}
