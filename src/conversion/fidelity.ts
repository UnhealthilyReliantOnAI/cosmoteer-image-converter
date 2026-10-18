import { PIECE_CATALOG, hasMirrorVariant, orientPiece } from '../catalog/pieces';
import type { PieceType } from '../catalog/pieces';
import { isValidConstruction } from '../construction/model';
import type { Construction, PiecePlacement } from '../construction/model';
import { polygonRectangleArea } from '../geometry/coverage';
import { ROTATIONS } from '../geometry/polygon';
import type { Rotation } from '../geometry/polygon';
import type { CoverageTarget } from './target';

interface TemplateCell {
  readonly x: number;
  readonly y: number;
  readonly area: number;
  readonly weights: Float32Array;
}

export interface PieceTemplate {
  readonly type: PieceType;
  readonly rotation: Rotation;
  readonly mirrored: boolean;
  readonly width: number;
  readonly height: number;
  readonly area: number;
  readonly cells: readonly TemplateCell[];
}

const templatesByResolution = new Map<number, readonly PieceTemplate[]>();

/** Rasterize the existing catalog once, using exact polygon/sample intersections. */
export function getPieceTemplates(resolution: number): readonly PieceTemplate[] {
  const cached = templatesByResolution.get(resolution);
  if (cached) return cached;
  const templates = PIECE_CATALOG.flatMap(({ type }) => (hasMirrorVariant(type) ? [false, true] : [false])
  .flatMap((mirrored) => (type === 'square_1x1' ? [0] as const : ROTATIONS).map((rotation) => {
    const piece = orientPiece(type, rotation, mirrored);
    const cells: TemplateCell[] = [];
    for (let y = 0; y < piece.footprint.height; y += 1) {
      for (let x = 0; x < piece.footprint.width; x += 1) {
        const weights = new Float32Array(resolution * resolution);
        for (let sy = 0; sy < resolution; sy += 1) {
          for (let sx = 0; sx < resolution; sx += 1) {
            weights[sy * resolution + sx] = Math.max(0, Math.min(1,
            polygonRectangleArea(piece.polygon, x + sx / resolution, y + sy / resolution, 1 / resolution)
             * resolution * resolution));
          }
        }
        cells.push({ x, y, weights, area: polygonRectangleArea(piece.polygon, x, y, 1) });
      }
    }
    return { type, rotation, mirrored, ...piece.footprint, area: piece.area, cells };
  })));
  templatesByResolution.set(resolution, templates);
  return templates;
}

/** Resolve a validated placement against a template set, without changing catalog order. */
export function getPieceTemplate(
  templates: readonly PieceTemplate[],
  piece: Pick<PiecePlacement, 'type' | 'rotation' | 'mirrored'>,
): PieceTemplate {
  return templates.find((entry) => entry.type === piece.type
    && entry.rotation === (piece.type === 'square_1x1' ? 0 : piece.rotation)
    && entry.mirrored === Boolean(piece.mirrored))!;
}

/** Fractional target coverage is treated as uniform only inside each fine sample. */
export function measureIntersection(target: CoverageTarget, template: PieceTemplate, x: number, y: number): number {
  const n = target.resolution;
  const sampleWidth = target.width * n;
  let intersection = 0;
  for (const cell of template.cells) {
    const cx = x + cell.x;
    const cy = y + cell.y;
    const black = target.cellAreas[cy * target.width + cx]!;
    if (black === 0) continue;
    if (black === 1) {
      intersection += cell.area;
      continue;
    }
    let sum = 0;
    for (let sy = 0; sy < n; sy += 1) {
      const row = (cy * n + sy) * sampleWidth + cx * n;
      for (let sx = 0; sx < n; sx += 1) sum += target.fractions[row + sx]! * cell.weights[sy * n + sx]!;
    }
    intersection += sum / (n * n);
  }
  return Math.max(0, Math.min(template.area, intersection));
}

export interface Fidelity {
  /** null only when both silhouettes have zero area. Empty output against black has IoU 0. */
  readonly iou: number | null;
  readonly targetArea: number;
  readonly generatedArea: number;
  readonly intersection: number;
  readonly union: number;
  readonly missingArea: number;
  readonly excessArea: number;
}

export function evaluateFidelity(target: CoverageTarget, construction: Construction): Fidelity {
  if (target.width !== construction.width || target.height !== construction.height || !isValidConstruction(construction)) {
    throw new Error('Construction invalide pour cette mesure de fidélité.');
  }
  const templates = getPieceTemplates(target.resolution);
  let generatedArea = 0;
  let intersection = 0;
  for (const placement of construction.pieces) {
    const template = getPieceTemplate(templates, placement);
    generatedArea += template.area;
    intersection += measureIntersection(target, template, placement.position.x, placement.position.y);
  }
  intersection = Math.min(target.blackArea, generatedArea, intersection);
  const union = target.blackArea + generatedArea - intersection;
  return {
    iou: union === 0 ? null : intersection / union,
    targetArea: target.blackArea,
    generatedArea,
    intersection,
    union,
    missingArea: target.blackArea - intersection,
    excessArea: generatedArea - intersection,
  };
}

export function countPieceFamilies(pieces: readonly PiecePlacement[]): Record<PieceType, number> {
  const counts: Record<PieceType, number> = { square_1x1: 0, wedge_1x1: 0, wedge_1x2: 0, wedge_1x3: 0, small_triangle: 0 };
  for (const piece of pieces) counts[piece.type] += 1;
  return counts;
}
