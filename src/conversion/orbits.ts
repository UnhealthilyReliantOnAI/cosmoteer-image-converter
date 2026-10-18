import { getPiece } from '../catalog/pieces';
import type { PieceType } from '../catalog/pieces';
import { getPlacedFootprint } from '../construction/model';
import type { Construction, PiecePlacement } from '../construction/model';
import { placementKey, placementOrbit } from '../construction/symmetry';
import type { SymmetryMode } from '../construction/symmetry';
import { getPieceTemplate, getPieceTemplates } from './fidelity';
import type { PieceTemplate } from './fidelity';
import type { SurfaceObjective } from './objective';
import { optimizePacking } from './packing';
import type { CoverageTarget } from './target';

export interface PlacementOrbit {
  readonly key: string;
  readonly pieces: readonly PiecePlacement[];
  readonly cells: readonly number[];
  readonly gain: number;
}

interface OrbitGeometry {
  readonly orbit: PlacementOrbit;
  readonly templates: readonly PieceTemplate[];
}

interface OrbitPlan {
  rows?: readonly (readonly OrbitGeometry[])[];
}

/** Local to one immutable target/family/axis selection. Scores are recomputed, never inferred
 * from an old gain: that would change floating-point rounding between IoU stages.
 * Keep the original row checkpoints, including empty rows, on every enumeration.
 */
export function createOrbitEnumerator(
  target: CoverageTarget,
  families: readonly PieceType[],
  mode: SymmetryMode,
  objective: SurfaceObjective,
  checkpoint: () => void
): (ratio?: number, contourOnly?: boolean) => PlacementOrbit[] {
  const plan: OrbitPlan | undefined = mode === 'none' ? undefined : {};
  return (ratio = 1, contourOnly = false) => enumerate(target, families, mode, objective, checkpoint, ratio, contourOnly, plan);
}

export function reservedCells(piece: PiecePlacement, width: number): number[] {
  const f = getPlacedFootprint(piece);
  const cells: number[] = [];
  for (let y = f.minY; y < f.minY + f.height; y++) {
    for (let x = f.minX; x < f.minX + f.width; x++) cells.push(y * width + x);
  }
  return cells;
}

export function enumerateOrbits(
  target: CoverageTarget,
  families: readonly PieceType[],
  mode: SymmetryMode,
  objective: SurfaceObjective,
  checkpoint: () => void,
  ratio = 1,
  contourOnly = false
): PlacementOrbit[] {
  return enumerate(target, families, mode, objective, checkpoint, ratio, contourOnly);
}

function enumerate(
  target: CoverageTarget,
  families: readonly PieceType[],
  mode: SymmetryMode,
  objective: SurfaceObjective,
  checkpoint: () => void,
  ratio: number,
  contourOnly: boolean,
  plan?: OrbitPlan
): PlacementOrbit[] {
  if (!contourOnly && plan?.rows) {
    const result: PlacementOrbit[] = [];
    for (const row of plan.rows) {
      checkpoint();
      for (const { orbit, templates } of row) {
        const gain = orbit.pieces.reduce((sum, piece, index) =>
        sum + objective.gain(templates[index]!, piece.position.x, piece.position.y, ratio), 0);
        result.push({ ...orbit, gain });
      }
    }
    return result;
  }
  const rows: OrbitGeometry[][] | undefined = !contourOnly && plan ? [] : undefined;
  const orbits = new Map<string, PlacementOrbit>();
  for (const template of getPieceTemplates(target.resolution).filter(({ type }) => families.includes(type))) {
    for (let y = 0; y <= target.height - template.height; y++) {
      checkpoint();
      const row: OrbitGeometry[] | undefined = rows ? [] : undefined;
      if (row) rows!.push(row);
      for (let x = 0; x <= target.width - template.width; x++) {
        if (contourOnly && families.includes('square_1x1')) {
          let black = true, white = true;
          const positions = [
            { x, y },
            ...(mode === 'none' ? [] : [
              mode === 'vertical'
                ? { x: target.width - x - template.width, y } : { x, y: target.height - y - template.height },
            ]),
          ];
          for (const position of positions) {
            for (let cy = position.y - 1; cy <= position.y + template.height; cy++) {
              for (let cx = position.x - 1; cx <= position.x + template.width; cx++) {
                const area = cx < 0 || cy < 0 || cx >= target.width || cy >= target.height ? 0 : target.cellAreas[cy * target.width + cx]!;
                black &&= area >= 1 - 1e-8;
                white &&= area <= 1e-8;
              }
            }
          }
          if (white || black && template.type !== 'square_1x1') continue;
        }
        const piece: PiecePlacement = {
          id: `controlled-${template.type}-${template.rotation}-${Number(template.mirrored)}-${x}-${y}`,
          type: template.type,
          rotation: template.rotation,
          ...(template.mirrored ? { mirrored: true } : {}),
          position: { x, y },
        };
        const pieces = placementOrbit(piece, target, mode);
        if (!pieces) continue;
        const key = pieces.map(placementKey).join('|');
        if (orbits.has(key)) continue;
        const templates: PieceTemplate[] | undefined = row ? [] : undefined;
        const gain = pieces.reduce((sum, entry) => {
          const t = getPieceTemplate(getPieceTemplates(target.resolution), entry);
          templates?.push(t);
          return sum + objective.gain(t, entry.position.x, entry.position.y, ratio);
        }, 0);
        // IDs depend only on each placement, never on which half discovered it first.
        const normalized = pieces.map((entry) => ({ ...entry, id: `controlled-${placementKey(entry)}` }));
        const orbit = {
          key,
          pieces: normalized,
          gain,
          cells: pieces.flatMap((entry) => reservedCells(entry, target.width)).sort((a, b) => a - b),
        };
        orbits.set(key, orbit);
        if (row && templates) row.push({ orbit, templates });
      }
    }
  }
  if (rows && plan) plan.rows = rows;
  return [...orbits.values()];
}

export function orbitConstruction(target: CoverageTarget, orbits: readonly PlacementOrbit[]): Construction {
  return {
    width: target.width,
    height: target.height,
    pieces: orbits.flatMap(({ pieces }) => pieces)
    .sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x || placementKey(a).localeCompare(placementKey(b), 'en')),
  };
}

/** Reuse measured intersections when the final connected silhouette changes the reference IoU. */
export function reweightOrbits(orbits: readonly PlacementOrbit[], ratio: number, previousRatio = 1): PlacementOrbit[] {
  return orbits.map((orbit) => {
    const area = orbit.pieces.reduce((sum, piece) => sum + getPiece(piece.type).area, 0);
    const intersection = (orbit.gain + previousRatio * area) / (1 + previousRatio);
    return { ...orbit, gain: (1 + ratio) * intersection - ratio * area };
  });
}

/** Fold reservation cells onto half the grid; every candidate still scores BOTH original halves. */
export function packSymmetricOrbits(
  target: CoverageTarget,
  orbits: readonly PlacementOrbit[],
  mode: SymmetryMode,
  checkpoint: () => void
) {
  const width = mode === 'vertical' ? Math.ceil(target.width / 2) : target.width;
  const height = mode === 'horizontal' ? Math.ceil(target.height / 2) : target.height;
  const folded = (cell: number) => {
    const x = cell % target.width, y = Math.floor(cell / target.width);
    return (mode === 'horizontal' ? Math.min(y, target.height - 1 - y) : y) * width
      + (mode === 'vertical' ? Math.min(x, target.width - 1 - x) : x);
  };
  const baseline: (PlacementOrbit | null)[] = Array.from({ length: width * height }, () => null);
  const cellsFor = (orbit: PlacementOrbit) => [...new Set(orbit.cells.map(folded))].sort((a, b) => a - b);
  for (const orbit of orbits) {
    const cells = cellsFor(orbit);
    if (cells.length === 1 && orbit.gain > (baseline[cells[0]!] ?.gain ?? 0) + 1e-8) baseline[cells[0]!] = orbit;
  }
  const best = new Map<string, {
    orbit: PlacementOrbit;
    cells: number[];
    benefit: number;
    savings: number;
  }>();
  for (const orbit of orbits) {
    const cells = cellsFor(orbit);
    if (cells.length === 1) continue;
    const benefit = orbit.gain - cells.reduce((sum, cell) => sum + (baseline[cell]?.gain ?? 0), 0);
    const savings = cells.reduce((sum, cell) => sum + (baseline[cell]?.pieces.length ?? 0), 0) - orbit.pieces.length;
    if (benefit < -1e-8 || benefit <= 1e-8 && savings <= 0) continue;
    const key = cells.join(',');
    const previous = best.get(key);
    if (!previous || benefit > previous.benefit + 1e-8) best.set(key, { orbit, cells, benefit, savings });
  }
  const ordered = [...best.values()].sort((a, b) => b.benefit - a.benefit || b.savings - a.savings
    || a.orbit.key.localeCompare(b.orbit.key, 'en')).map((entry, index) => ({ ...entry, index }));
  const occupied = new Set<number>();
  const greedy: number[] = [];
  for (const entry of ordered) if (entry.cells.every((cell) => !occupied.has(cell))) {
    greedy.push(entry.index);
    entry.cells.forEach((cell) => occupied.add(cell));
  }
  const packed = optimizePacking(ordered, width, width * height, greedy, checkpoint);
  occupied.clear();
  const selected = packed.selected.map((index) => {
    const entry = ordered[index]!;
    entry.cells.forEach((cell) => occupied.add(cell));
    return entry.orbit;
  });
  baseline.forEach((orbit, cell) => {
    if (orbit && !occupied.has(cell)) selected.push(orbit);
  });
  return { construction: orbitConstruction(target, selected), packed, candidates: ordered.length };
}
