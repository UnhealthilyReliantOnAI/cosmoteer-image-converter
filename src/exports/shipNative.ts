import { getOrientedFootprint } from '../catalog/pieces';
import type { PieceType } from '../catalog/pieces';
import { STANDARD_GRID_LIMIT } from '../construction/grid';
import { getPlacedPolygon } from '../construction/model';
import type { Construction } from '../construction/model';
import { translatePolygon } from '../geometry/polygon';
import type { Point, Polygon, Rotation } from '../geometry/polygon';
import { toArmorConstruction } from './armorConstruction';
import { ArmorExportError, ShipExportError } from './shipErrors';
import type { ArmorExportIssueCode } from './shipErrors';

/** Cosmoteer armor type IDs; these identify part families, never placement instances. */
export const NATIVE_ARMOR_IDS: Readonly<Record<PieceType, string>> = {
  square_1x1: 'cosmoteer.armor',
  wedge_1x1: 'cosmoteer.armor_wedge',
  wedge_1x2: 'cosmoteer.armor_1x2_wedge',
  wedge_1x3: 'cosmoteer.armor_1x3_wedge',
  small_triangle: 'cosmoteer.armor_tri',
};

export const NATIVE_GRID_MIN = -STANDARD_GRID_LIMIT / 2;

export const NATIVE_GRID_MAX = NATIVE_GRID_MIN + STANDARD_GRID_LIMIT - 1;

export interface NativeComponent {
  readonly nativeId: string;
  readonly x: number;
  readonly y: number;
  readonly rotation: 0 | 1 | 2 | 3;
  readonly flipX: boolean;
}

export interface NativeMapping {
  readonly sourceId: string;
  readonly sourceRotation: Rotation;
  readonly type: PieceType;
  readonly localPosition: Point;
  readonly component: NativeComponent;
  readonly footprint: {
    readonly width: number;
    readonly height: number;
  };
  readonly polygon: Polygon;
}

export interface NativeConstruction {
  readonly components: readonly NativeComponent[];
  readonly translation: Point;
  readonly mappings: readonly NativeMapping[];
  readonly reservedCells: number;
}

export interface NativeValidationOptions {
  readonly allowEmpty?: boolean;
}

export interface NativeAdaptOptions extends NativeValidationOptions {
  readonly translation?: Point;
}

const issueCodes: Record<ArmorExportIssueCode, string> = {
  incomplete: 'E_SCHEMA',
  dimensions: 'E_INTEGER',
  id: 'E_ID',
  'duplicate-id': 'E_ID',
  type: 'E_TYPE',
  rotation: 'E_ROTATION',
  mirror: 'E_MIRROR',
  position: 'E_INTEGER',
  'out-of-bounds': 'E_LOCAL_BOUNDS',
  overlap: 'E_COLLISION',
};

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function int32(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
    && value >= -2147483648 && value <= 2147483647;
}

/** Validate native tuples independently of React, SVG, or the local canvas model.
 * Reuses the catalogue's oriented reservation sizes, including visually empty cells. */
export function validateNativeComponents(components: readonly NativeComponent[],
  options: NativeValidationOptions = {}): number {
  if (!Array.isArray(components)) throw new ShipExportError('E_SCHEMA', 'Expected a component list.');
  if (!components.length && !options.allowEmpty) {
    throw new ShipExportError('E_EMPTY_CONSTRUCTION', 'The displayed construction contains no parts.');
  }
  if (components.length > STANDARD_GRID_LIMIT ** 2) {
    throw new ShipExportError('E_GRID', 'Too many reserved components for the standard grid.');
  }
  const occupancy = new Int32Array(STANDARD_GRID_LIMIT ** 2).fill(-1);
  let reservedCells = 0;
  for (let index = 0; index < components.length; index++) {
    const component: unknown = components[index];
    if (!object(component)) throw new ShipExportError('E_SCHEMA', 'Incomplete native component.', { index });
    const type = (Object.keys(NATIVE_ARMOR_IDS) as PieceType[])
    .find((candidate) => NATIVE_ARMOR_IDS[candidate] === component.nativeId);
    if (!type) throw new ShipExportError('E_TYPE', 'Unsupported native armor ID.', { index });
    if (!int32(component.x) || !int32(component.y)) {
      throw new ShipExportError('E_INTEGER', 'Native coordinates must be signed int32.', { index });
    }
    if (typeof component.rotation !== 'number' || ![0, 1, 2, 3].includes(component.rotation)
      || type === 'square_1x1' && component.rotation !== 0) {
      throw new ShipExportError('E_ROTATION', 'Unsupported native rotation.', { index });
    }
    if (typeof component.flipX !== 'boolean'
      || component.flipX && type !== 'wedge_1x2' && type !== 'wedge_1x3') {
      throw new ShipExportError('E_MIRROR', 'Unsupported native mirror.', { index });
    }
    const footprint = getOrientedFootprint(type, component.rotation * 90 as Rotation);
    if (component.x < NATIVE_GRID_MIN || component.y < NATIVE_GRID_MIN
      || component.x + footprint.width - 1 > NATIVE_GRID_MAX
      || component.y + footprint.height - 1 > NATIVE_GRID_MAX) {
      throw new ShipExportError('E_GRID', 'Native reserved rectangle exceeds the standard grid.', { index });
    }
    for (let y: number = component.y; y < component.y + footprint.height; y++) {
      for (let x: number = component.x; x < component.x + footprint.width; x++) {
        const cell = (y - NATIVE_GRID_MIN) * STANDARD_GRID_LIMIT + x - NATIVE_GRID_MIN;
        const previousIndex = occupancy[cell]!;
        if (previousIndex !== -1) {
          throw new ShipExportError('E_COLLISION', 'Two parts reserve the same cell.',
          { index, previousIndex, x, y });
        }
        occupancy[cell] = index;
        reservedCells++;
      }
    }
  }
  return reservedCells;
}

/** Read the canonical Construction directly; no text JSON and no recomputation of pieces.
 * The full canvas determines centering, irrespective of its occupied/visible bounds. */
export function adaptConstructionToNative(construction: Construction,
  options: NativeAdaptOptions = {}): NativeConstruction {
  let validated: ReturnType<typeof toArmorConstruction>;
  try {
    validated = toArmorConstruction(construction);
  }
  catch (error) {
    if (!(error instanceof ArmorExportError)) throw error;
    const first = error.issues[0]!;
    throw new ShipExportError(issueCodes[first.code], 'Invalid displayed construction.',
    { path: first.path, issues: error.issues });
  }
  const translation = options.translation ?? {
    x: -Math.floor(validated.width / 2),
    y: -Math.floor(validated.height / 2),
  };
  if (!object(translation) || !int32(translation.x) || !int32(translation.y)) {
    throw new ShipExportError('E_INTEGER', 'Translation must contain signed int32 coordinates.');
  }
  if (translation.x < NATIVE_GRID_MIN || translation.y < NATIVE_GRID_MIN
    || translation.x + validated.width - 1 > NATIVE_GRID_MAX
    || translation.y + validated.height - 1 > NATIVE_GRID_MAX) {
    throw new ShipExportError('E_GRID', 'The entire translated canvas must fit the standard grid.');
  }
  const mappings: NativeMapping[] = validated.pieces.map((piece) => {
    const component: NativeComponent = {
      nativeId: NATIVE_ARMOR_IDS[piece.type],
      x: piece.position.x + translation.x,
      y: piece.position.y + translation.y,
      rotation: piece.type === 'square_1x1' ? 0 : piece.rotation / 90 as 0 | 1 | 2 | 3,
      flipX: piece.mirrored,
    };
    return {
      sourceId: piece.id,
      sourceRotation: piece.rotation,
      type: piece.type,
      localPosition: { ...piece.position },
      component,
      footprint: { ...getOrientedFootprint(piece.type, piece.rotation) },
      polygon: translatePolygon(getPlacedPolygon(piece), translation),
    };
  });
  const components = mappings.map(({ component }) => component);
  const reservedCells = validateNativeComponents(components, options);
  return {
    components,
    translation: { x: translation.x, y: translation.y },
    mappings,
    reservedCells,
  };
}
