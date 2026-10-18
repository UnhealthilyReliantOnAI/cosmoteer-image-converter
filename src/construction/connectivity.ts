import { polygonArea } from '../geometry/polygon';
import type { Point, Polygon } from '../geometry/polygon';
import { getPlacedFootprint, getPlacedPolygon, isValidConstruction } from './model';
import type { Construction } from './model';

const EPSILON = 1e-9;

export type PolygonContact = 'none' | 'point' | 'edge';

const cross = (a: Point, b: Point) => a.x * b.y - a.y * b.x;

const difference = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });

/** For non-overlapping construction polygons: positive edge length differs from a vertex touch. */
export function classifyPolygonContact(a: Polygon, b: Polygon): PolygonContact {
  let point = false;
  for (let i = 0; i < a.length; i += 1) {
    const start = a[i]!;
    const direction = difference(a[(i + 1) % a.length]!, start);
    const lengthSquared = direction.x ** 2 + direction.y ** 2;
    for (let j = 0; j < b.length; j += 1) {
      const other = b[j]!;
      const delta = difference(other, start);
      const vector = difference(b[(j + 1) % b.length]!, other);
      const determinant = cross(direction, vector);
      if (Math.abs(determinant) < EPSILON) {
        if (Math.abs(cross(delta, direction)) > EPSILON || lengthSquared === 0) continue;
        const t = (delta.x * direction.x + delta.y * direction.y) / lengthSquared;
        const u = t + (vector.x * direction.x + vector.y * direction.y) / lengthSquared;
        const overlap = Math.min(1, Math.max(t, u)) - Math.max(0, Math.min(t, u));
        if (overlap > EPSILON) return 'edge';
        if (overlap >= -EPSILON) point = true;
      } else {
        const t = cross(delta, vector) / determinant;
        const u = cross(delta, direction) / determinant;
        if (t >= -EPSILON && t <= 1 + EPSILON && u >= -EPSILON && u <= 1 + EPSILON) point = true;
      }
    }
  }
  return point ? 'point' : 'none';
}

export interface ConnectivityGroup {
  readonly pieceIds: readonly string[];
  readonly visibleArea: number;
}

export interface ConnectivityDiagnostic {
  readonly basis: 'provisional-geometric-edges';
  readonly gameConnectionsVerified: false;
  readonly groups: readonly ConnectivityGroup[];
  readonly isolatedPieces: number;
  readonly pointContacts: number;
  readonly pointContactsBetweenGroups: number;
  readonly footprintOnlyContacts: number;
}

/** A geometric diagnostic, never a claim about game attachment points. No pieces are removed. */
export function diagnoseConnectivity(construction: Construction): ConnectivityDiagnostic {
  if (!isValidConstruction(construction)) throw new Error('Construction invalide pour le diagnostic de connectivité.');
  const polygons = construction.pieces.map(getPlacedPolygon);
  const footprints = construction.pieces.map(getPlacedFootprint);
  const owner = new Int32Array(construction.width * construction.height).fill(-1);
  const parent = construction.pieces.map((_, i) => i);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root]!;
    while (index !== root) {
      const next = parent[index]!;
      parent[index] = root;
      index = next;
    }
    return root;
  };
  construction.pieces.forEach((piece, index) => {
    const bounds = getPlacedFootprint(piece);
    for (let y = bounds.minY; y < bounds.minY + bounds.height; y += 1) {
      for (let x = bounds.minX; x < bounds.minX + bounds.width; x += 1) owner[y * construction.width + x] = index;
    }
  });
  const pairs = new Set<number>();
  const count = construction.pieces.length;
  let pointContacts = 0;
  const pointPairs: [number, number][] = [];
  let footprintOnlyContacts = 0;
  for (let y = 0; y < construction.height; y += 1) {
    for (let x = 0; x < construction.width; x += 1) {
      const index = owner[y * construction.width + x]!;
      if (index < 0) continue;
      for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [-1, 1]]) {
        const nx = x + dx!;
        const ny = y + dy!;
        if (nx < 0 || nx >= construction.width || ny >= construction.height) continue;
        const other = owner[ny * construction.width + nx]!;
        if (other < 0 || index === other) continue;
        const pair = Math.min(index, other) * count + Math.max(index, other);
        if (pairs.has(pair)) continue;
        pairs.add(pair);
        const contact = classifyPolygonContact(polygons[index]!, polygons[other]!);
        if (contact === 'edge') parent[find(index)] = find(other);
        else if (contact === 'point') {
          pointContacts += 1;
          pointPairs.push([index, other]);
        }
        else {
          const a = footprints[index]!;
          const b = footprints[other]!;
          const sideContact = ((a.minX + a.width === b.minX || b.minX + b.width === a.minX)
            && Math.min(a.minY + a.height, b.minY + b.height) > Math.max(a.minY, b.minY))
            || ((a.minY + a.height === b.minY || b.minY + b.height === a.minY)
            && Math.min(a.minX + a.width, b.minX + b.width) > Math.max(a.minX, b.minX));
          if (sideContact) footprintOnlyContacts += 1;
        }
      }
    }
  }
  const groups = new Map<number, {
    pieceIds: string[];
    visibleArea: number;
  }>();
  construction.pieces.forEach((piece, index) => {
    const root = find(index);
    const group = groups.get(root) ?? { pieceIds: [], visibleArea: 0 };
    group.pieceIds.push(piece.id);
    group.visibleArea += polygonArea(polygons[index]!);
    groups.set(root, group);
  });
  const ordered = [...groups.values()].sort((a, b) => b.visibleArea - a.visibleArea
    || (a.pieceIds[0]! < b.pieceIds[0]! ? -1 : a.pieceIds[0]! > b.pieceIds[0]! ? 1 : 0));
  return {
    basis: 'provisional-geometric-edges',
    gameConnectionsVerified: false,
    groups: ordered,
    isolatedPieces: ordered.filter((group) => group.pieceIds.length === 1).length,
    pointContacts,
    pointContactsBetweenGroups: pointPairs.filter(([a, b]) => find(a) !== find(b)).length,
    footprintOnlyContacts,
  };
}
