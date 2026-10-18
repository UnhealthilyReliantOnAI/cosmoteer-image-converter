import { hasMirrorVariant, PIECE_CATALOG } from '../catalog/pieces';
import type { PieceType } from '../catalog/pieces';
import { isValidGridSize } from '../construction/grid';
import { isValidConstruction, isWithinGrid } from '../construction/model';
import type { Construction, PiecePlacement } from '../construction/model';
import { ROTATIONS } from '../geometry/polygon';
import schema from './schema/armor-construction-v1.schema.json';
import { ArmorExportError } from './shipErrors';
import type { ArmorExportIssue, ArmorExportIssueCode } from './shipErrors';

export const ARMOR_CONSTRUCTION_FORMAT = 'cosmoteer-armor-construction-v1';

export interface ArmorConstructionDocument {
  readonly format: typeof ARMOR_CONSTRUCTION_FORMAT;
  readonly coordinateSpace: 'local';
  readonly width: number;
  readonly height: number;
  readonly pieces: readonly (PiecePlacement & {
    readonly mirrored: boolean;
  })[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCoordinate(value: unknown): value is number {
  const { minimum, maximum } = schema.$defs.int32;
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum;
}

/** Check runtime structure before invoking the typed geometry validators.
 * The JSON schema supplies shared bounds and ID syntax; it is not executed as a schema engine. */
function validate(value: unknown): asserts value is Construction {
  const issues: ArmorExportIssue[] = [];
  const issue = (code: ArmorExportIssueCode, path: string) => {
    issues.push({ code, path });
  };
  if (!isObject(value)) throw new ArmorExportError([{ code: 'incomplete', path: '$' }]);
  if (value.width === undefined || value.height === undefined) issue('incomplete', '$');
  else if (typeof value.width !== 'number' || typeof value.height !== 'number'
    || !isValidGridSize({ width: value.width, height: value.height })
    || value.width < schema.properties.width.minimum || value.width > schema.properties.width.maximum
    || value.height < schema.properties.height.minimum || value.height > schema.properties.height.maximum) {
    issue('dimensions', '$');
  }
  if (!Array.isArray(value.pieces)) issue('incomplete', 'pieces');
  else {
    const ids = new Set<string>();
    for (let index = 0; index < value.pieces.length; index++) {
      const piece: unknown = value.pieces[index];
      const path = `pieces[${index}]`;
      if (!isObject(piece)) {
        issue('incomplete', path);
        continue;
      }
      for (const key of ['id', 'type', 'rotation', 'position']) {
        if (piece[key] === undefined) issue('incomplete', `${path}.${key}`);
      }
      if (piece.id !== undefined) {
        if (typeof piece.id !== 'string' || !new RegExp(schema.$defs.piece.properties.id.pattern).test(piece.id)) {
          issue('id', `${path}.id`);
        } else {
          if (ids.has(piece.id)) issue('duplicate-id', `${path}.id`);
          ids.add(piece.id);
        }
      }
      const knownType = PIECE_CATALOG.some(({ type }) => type === piece.type);
      if (piece.type !== undefined && !knownType) issue('type', `${path}.type`);
      if (piece.rotation !== undefined && !ROTATIONS.some((rotation) => rotation === piece.rotation)) {
        issue('rotation', `${path}.rotation`);
      }
      if (piece.mirrored !== undefined && (typeof piece.mirrored !== 'boolean'
        || piece.mirrored && knownType && !hasMirrorVariant(piece.type as PieceType))) {
        issue('mirror', `${path}.mirrored`);
      }
      if (piece.position !== undefined) {
        if (!isObject(piece.position) || piece.position.x === undefined || piece.position.y === undefined) {
          issue('incomplete', `${path}.position`);
        } else if (!isCoordinate(piece.position.x) || !isCoordinate(piece.position.y)) {
          issue('position', `${path}.position`);
        }
      }
    }
  }
  if (issues.length) throw new ArmorExportError(issues);
  // Structural checks above establish the model's input prerequisites.
  const construction = value as unknown as Construction;
  construction.pieces.forEach((piece, index) => {
    if (!isWithinGrid(piece, construction)) issue('out-of-bounds', `pieces[${index}].position`);
  });
  // Reuse the model's linear reservation validator; no second collision engine.
  if (!issues.length && !isValidConstruction(construction)) issue('overlap', 'pieces');
  if (issues.length) throw new ArmorExportError(issues);
}

/** Exact local bridge. No cropping, translation, sorting, connectivity solving or conversion. */
export function toArmorConstruction(construction: Construction): ArmorConstructionDocument {
  validate(construction);
  return {
    format: ARMOR_CONSTRUCTION_FORMAT,
    coordinateSpace: 'local',
    width: construction.width,
    height: construction.height,
    pieces: construction.pieces.map((piece) => ({
      id: piece.id,
      type: piece.type,
      rotation: piece.rotation,
      mirrored: piece.mirrored ?? false,
      position: { x: piece.position.x, y: piece.position.y },
    })),
  };
}

export function serializeArmorConstruction(construction: Construction): string {
  return `${JSON.stringify(toArmorConstruction(construction), null, 2)}\n`;
}
