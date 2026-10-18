import type { GridSize } from '../construction/grid';
import { getBounds, rotatePolygonInFootprint } from '../geometry/polygon';
import type { Polygon, Rotation } from '../geometry/polygon';

export type PieceType = 'square_1x1' | 'wedge_1x1' | 'wedge_1x2' | 'wedge_1x3' | 'small_triangle';

export interface PieceDefinition {
  readonly type: PieceType;
  readonly name: string;
  /** Reserved cells, independent of the tight bounds of the visible polygon. */
  readonly footprint: GridSize;
  readonly polygon: Polygon;
  readonly area: number;
}

/** Canonical armor silhouettes in grid cells; reservations include the empty wedge area. */
export const PIECE_CATALOG: readonly PieceDefinition[] = [
  {
    type: 'square_1x1',
    name: 'Carré 1 × 1',
    footprint: { width: 1, height: 1 },
    area: 1,
    polygon: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
  },
  {
    type: 'wedge_1x1',
    name: 'Coin 1 × 1',
    footprint: { width: 1, height: 1 },
    area: 0.5,
    polygon: [{ x: 0, y: 1 }, { x: 1, y: 0 }, { x: 1, y: 1 }],
  },
  {
    type: 'wedge_1x2',
    name: 'Coin 1 × 2',
    footprint: { width: 1, height: 2 },
    area: 1,
    polygon: [{ x: 0, y: 2 }, { x: 1, y: 0 }, { x: 1, y: 2 }],
  },
  {
    type: 'wedge_1x3',
    name: 'Coin 1 × 3',
    footprint: { width: 1, height: 3 },
    area: 1.5,
    polygon: [{ x: 0, y: 3 }, { x: 1, y: 0 }, { x: 1, y: 3 }],
  },
  {
    type: 'small_triangle',
    name: 'Petit triangle',
    footprint: { width: 1, height: 1 },
    area: 0.25,
    polygon: [{ x: 0, y: 1 }, { x: 0.5, y: 0.5 }, { x: 1, y: 1 }],
  },
];

export const ALL_PIECE_TYPES: readonly PieceType[] = PIECE_CATALOG.map(({ type }) => type);

export function getPiece(type: PieceType): PieceDefinition {
  const piece = PIECE_CATALOG.find((entry) => entry.type === type);
  if (!piece) throw new Error(`Pièce inconnue : ${type}`);
  return piece;
}

export interface OrientedPiece extends PieceDefinition {
  readonly rotation: Rotation;
  readonly mirrored: boolean;
  readonly visibleBounds: ReturnType<typeof getBounds>;
}

export function getOrientedFootprint(type: PieceType, rotation: Rotation): GridSize {
  const { footprint } = getPiece(type);
  return rotation % 180 === 0 ? footprint : { width: footprint.height, height: footprint.width };
}

export function hasMirrorVariant(type: PieceType): boolean {
  return type === 'wedge_1x2' || type === 'wedge_1x3';
}

/** Reflect X inside the canonical reserved rectangle BEFORE applying the clockwise rotation.
 * Native family IDs are assigned separately by the export adapter.
 */
export function orientPiece(type: PieceType, rotation: Rotation, mirrored = false): OrientedPiece {
  const piece = getPiece(type);
  if (mirrored && !hasMirrorVariant(type)) throw new Error('Cette famille ne possède pas de variante miroir distincte.');
  const source = mirrored ? piece.polygon.map(({ x, y }) => ({ x: piece.footprint.width - x, y })) : piece.polygon;
  const polygon = rotatePolygonInFootprint(source, rotation, piece.footprint);
  const footprint = getOrientedFootprint(type, rotation);
  return { ...piece, rotation, mirrored, polygon, footprint, visibleBounds: getBounds(polygon) };
}

export function validateAllowedFamilies(families: readonly PieceType[]): void {
  if (families.length === 0 || families.some((type) => !ALL_PIECE_TYPES.includes(type))) {
    throw new Error('Sélectionnez au moins une famille de pièces connue.');
  }
}
