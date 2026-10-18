import { orientPiece, hasMirrorVariant } from '../catalog/pieces';
import { ROTATIONS } from '../geometry/polygon';
import type { Polygon } from '../geometry/polygon';
import { footprintsOverlap, getPlacedFootprint, getPlacedPolygon, isWithinGrid } from './model';
import type { Construction, GridSize, PiecePlacement } from './model';

export type SymmetryMode = 'none' | 'vertical' | 'horizontal';

const polygonKey = (polygon: Polygon) => polygon.map(({ x, y }) => `${x},${y}`).sort().join(';');

const reflectionOrientations = new Map<string, {
  rotation: PiecePlacement['rotation'];
  mirrored: boolean;
}>();

export const placementKey = (piece: PiecePlacement) => `${piece.type}/${piece.rotation}/${Number(Boolean(piece.mirrored))}/${piece.position.x}/${piece.position.y}`;

/** Match the reflected polygon against the existing catalog, including its reserved rectangle. */
export function reflectPlacement(piece: PiecePlacement, grid: GridSize, mode: Exclude<SymmetryMode, 'none'>): PiecePlacement {
  const footprint = getPlacedFootprint(piece);
  const orientationKey = `${piece.type}/${piece.rotation}/${Number(Boolean(piece.mirrored))}/${mode}`;
  const cached = reflectionOrientations.get(orientationKey);
  if (cached) return {
    id: `${piece.id}-reflection`,
    type: piece.type,
    rotation: cached.rotation,
    ...(cached.mirrored ? { mirrored: true } : {}),
    position: mode === 'vertical'
      ? { x: grid.width - piece.position.x - footprint.width, y: piece.position.y }
      : { x: piece.position.x, y: grid.height - piece.position.y - footprint.height },
  };
  const local = orientPiece(piece.type, piece.rotation, piece.mirrored);
  const reflected = polygonKey(local.polygon.map(({ x, y }) => mode === 'vertical'
    ? { x: footprint.width - x, y } : { x, y: footprint.height - y }));
  for (const mirrored of hasMirrorVariant(piece.type) ? [false, true] : [false]) {
    for (const rotation of piece.type === 'square_1x1' ? [0] as const : ROTATIONS) {
      const candidate = orientPiece(piece.type, rotation, mirrored);
      if (candidate.footprint.width !== footprint.width || candidate.footprint.height !== footprint.height
        || polygonKey(candidate.polygon) !== reflected) continue;
      reflectionOrientations.set(orientationKey, { rotation, mirrored });
      return {
        id: `${piece.id}-reflection`,
        type: piece.type,
        rotation,
        ...(mirrored ? { mirrored: true } : {}),
        position: mode === 'vertical'
          ? { x: grid.width - piece.position.x - footprint.width, y: piece.position.y }
          : { x: piece.position.x, y: grid.height - piece.position.y - footprint.height },
      };
    }
  }
  throw new Error('Le catalogue ne contient pas la réflexion de cette pièce.');
}

/** A central piece may be used once only when BOTH its footprint and polygon reflect onto themselves. */
export function placementOrbit(piece: PiecePlacement, grid: GridSize, mode: SymmetryMode): readonly PiecePlacement[] | null {
  if (!isWithinGrid(piece, grid)) return null;
  if (mode === 'none') return [piece];
  const other = reflectPlacement(piece, grid, mode);
  if (piece.position.x === other.position.x && piece.position.y === other.position.y
    && polygonKey(getPlacedPolygon(piece)) === polygonKey(getPlacedPolygon(other))) return [piece];
  if (footprintsOverlap(piece, other)) return null;
  return [piece, other].sort((a, b) => placementKey(a).localeCompare(placementKey(b), 'en'));
}

export function isSymmetricConstruction(construction: Construction, mode: SymmetryMode): boolean {
  if (mode === 'none') return true;
  const keys = new Set(construction.pieces.map((piece) => {
    const f = getPlacedFootprint(piece);
    return `${piece.type}/${f.minX},${f.minY},${f.width},${f.height}/${polygonKey(getPlacedPolygon(piece))}`;
  }));
  return construction.pieces.every((piece) => {
    const reflected = reflectPlacement(piece, construction, mode);
    const f = getPlacedFootprint(reflected);
    return keys.has(`${piece.type}/${f.minX},${f.minY},${f.width},${f.height}/${polygonKey(getPlacedPolygon(reflected))}`);
  });
}
