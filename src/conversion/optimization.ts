import { ALL_PIECE_TYPES, validateAllowedFamilies } from '../catalog/pieces';
import type { Construction, PiecePlacement } from '../construction/model';
import { getPieceTemplates } from './fidelity';
import type { PieceTemplate } from './fidelity';
import { createObjective } from './objective';
import type { SurfaceObjective } from './objective';
import { optimizePacking } from './packing';
import type { CoverageTarget } from './target';
import type { ConversionOptions, OptimizationStats } from './types';

export const MAX_LOCAL_PASSES = 4;

export const MAX_LOCAL_PROPOSALS = 250_000;

const EPSILON = 1e-8;

interface Candidate {
  readonly template: PieceTemplate;
  readonly x: number;
  readonly y: number;
  readonly gain: number;
}

interface MultiCandidate extends Candidate {
  readonly index: number;
  readonly cells: readonly number[];
  /** Reduction in symmetric area error compared to optimal independent 1-cell choices. */
  readonly benefit: number;
  readonly areaBenefit: number;
  readonly savings: number;
}

function improves(benefit: number, savings: number): boolean {
  return benefit > EPSILON || (Math.abs(benefit) <= EPSILON && savings > 0);
}

function placement(candidate: Candidate): PiecePlacement {
  const { type, rotation, mirrored } = candidate.template;
  return {
    id: `geometry-${type}-${rotation}${mirrored ? '-mirror' : ''}-${candidate.x}-${candidate.y}`,
    type,
    rotation,
    ...(mirrored ? { mirrored: true } : {}),
    position: { x: candidate.x, y: candidate.y },
  };
}

/** Weighted set packing of 2/3-cell wedges over the best free single-cell choices.
 * Local exchanges can remove several competing wedges and add one or two alternatives.
 * Unreserved cells always revert to their best single-cell choice (including empty).
 */
export function optimizeTarget(
  target: CoverageTarget,
  options: ConversionOptions,
  objective?: SurfaceObjective,
  ratio = 1
): {
  construction: Construction;
  optimization: OptimizationStats;
} {
  validateAllowedFamilies(options.allowedFamilies);
  const checkpoint = options.checkpoint ?? (() => {});
  const contourWeight = options.contourWeight ?? 0;
  if (!Number.isFinite(contourWeight) || contourWeight < 0 || contourWeight > 2) throw new Error('Poids de contour invalide.');
  const surface = objective ?? createObjective(target, checkpoint);
  const passLimit = options.maxLocalPasses ?? MAX_LOCAL_PASSES;
  if (!Number.isInteger(passLimit) || passLimit < 0 || passLimit > MAX_LOCAL_PASSES) {
    throw new Error(`Le budget local doit être compris entre 0 et ${MAX_LOCAL_PASSES} passes.`);
  }
  checkpoint();
  const templates = getPieceTemplates(target.resolution).filter(({ type }) => options.allowedFamilies.includes(type));
  const singles = templates.filter(({ width, height }) => width * height === 1);
  const longs = templates.filter(({ width, height }) => width * height > 1);
  const baseline: (Candidate | null)[] = Array.from({ length: target.width * target.height }, () => null);
  for (let y = 0; y < target.height; y += 1) {
    checkpoint();
    for (let x = 0; x < target.width; x += 1) {
      const cell = y * target.width + x;
      for (const template of singles) {
        const gain = surface.gain(template, x, y, ratio, contourWeight);
        if (gain > (baseline[cell]?.gain ?? 0) + EPSILON) baseline[cell] = { template, x, y, gain };
      }
    }
  }
  const reservations = new Map<number, MultiCandidate>();
  for (const template of longs) {
    for (let y = 0; y <= target.height - template.height; y += 1) {
      checkpoint();
      for (let x = 0; x <= target.width - template.width; x += 1) {
        const cells = template.cells.map((cell) => (y + cell.y) * target.width + x + cell.x);
        const gain = surface.gain(template, x, y, ratio, contourWeight);
        const benefit = gain - cells.reduce((sum, cell) => sum + (baseline[cell]?.gain ?? 0), 0);
        const savings = cells.filter((cell) => baseline[cell] !== null).length - 1;
        // A dominated long wedge cannot help: its free single-cell alternatives do not collide.
        if (improves(benefit, savings)) {
          // Identical reservations have identical conflicts: retain only their best visible polygon.
          const key = (y * target.width + x) * 4 + (cells.length === 3 ? 2 : 0) + (template.width > 1 ? 1 : 0);
          const old = reservations.get(key);
          if (!old || gain > old.gain + EPSILON) {
            const areaBenefit = surface.gain(template, x, y) - cells.reduce((sum, cell) => {
              const single = baseline[cell];
              return sum + (single ? surface.gain(single.template, single.x, single.y) : 0);
            }, 0);
            reservations.set(key, { template, x, y, cells, gain, benefit, areaBenefit, savings, index: 0 });
          }
        }
      }
    }
  }
  const candidates = [...reservations.values()];
  candidates.sort((a, b) => b.benefit - a.benefit || b.savings - a.savings
    || a.y - b.y || a.x - b.x || ALL_PIECE_TYPES.indexOf(a.template.type) - ALL_PIECE_TYPES.indexOf(b.template.type)
    || a.template.rotation - b.template.rotation || Number(a.template.mirrored) - Number(b.template.mirrored));
  const ordered = candidates.map((candidate, index) => ({ ...candidate, index }));
  const owner = new Int32Array(baseline.length).fill(-1);
  const active = new Set<number>();
  const neighbors: number[][] = Array.from({ length: baseline.length }, () => []);

  function add(candidate: MultiCandidate) {
    active.add(candidate.index);
    for (const cell of candidate.cells) owner[cell] = candidate.index;
  }

  function conflicts(additions: readonly MultiCandidate[]): Set<number> {
    const removed = new Set<number>();
    for (const candidate of additions) {
      for (const cell of candidate.cells) if (owner[cell]! >= 0) removed.add(owner[cell]!);
    }
    return removed;
  }

  for (const candidate of ordered) {
    for (const cell of candidate.cells) neighbors[cell]!.push(candidate.index);
    if (candidate.cells.every((cell) => owner[cell] === -1)) add(candidate);
  }
  const initialBenefit = [...active].reduce((sum, index) => sum + ordered[index]!.benefit, 0);
  const initialAreaBenefit = [...active].reduce((sum, index) => sum + ordered[index]!.areaBenefit, 0);
  let localExchanges = 0;
  let proposals = 0;
  let passes = 0;
  let changed = false;

  function exchange(additions: readonly MultiCandidate[]): boolean {
    proposals += 1;
    if (proposals % 256 === 0) checkpoint();
    const removed = conflicts(additions);
    let benefit = additions.reduce((sum, candidate) => sum + candidate.benefit, 0);
    let savings = additions.reduce((sum, candidate) => sum + candidate.savings, 0);
    for (const index of removed) {
      benefit -= ordered[index]!.benefit;
      savings -= ordered[index]!.savings;
    }
    if (!improves(benefit, savings)) return false;
    localExchanges += 1;
    for (const index of removed) {
      active.delete(index);
      for (const cell of ordered[index]!.cells) owner[cell] = -1;
    }
    for (const candidate of additions) add(candidate);
    return true;
  }

  for (; passes < passLimit && proposals < MAX_LOCAL_PROPOSALS;) {
    passes += 1;
    checkpoint();
    changed = false;
    for (const candidate of ordered) {
      if (proposals >= MAX_LOCAL_PROPOSALS) break;
      if (!active.has(candidate.index)) changed = exchange([candidate]) || changed;
    }
    // Try pairs around selected reservations: escape a greedy choice that blocks two better pieces.
    for (const index of [...active].sort((a, b) => a - b)) {
      if (!active.has(index) || proposals >= MAX_LOCAL_PROPOSALS) continue;
      const pool = [...new Set(ordered[index]!.cells.flatMap((cell) => neighbors[cell]!))].sort((a, b) => a - b);
      let replaced = false;
      for (let first = 0; first < pool.length && !replaced && proposals < MAX_LOCAL_PROPOSALS; first += 1) {
        const a = ordered[pool[first]!]!;
        for (let second = first + 1; second < pool.length && proposals < MAX_LOCAL_PROPOSALS; second += 1) {
          const b = ordered[pool[second]!]!;
          if (a.cells.some((cell) => b.cells.includes(cell))) continue;
          if (exchange([a, b])) {
            changed = true;
            replaced = true;
            break;
          }
        }
      }
    }
    if (!changed) break;
  }
  const pieces: PiecePlacement[] = [];
  const frontier = passLimit > 0
    ? optimizePacking(ordered, target.width, baseline.length, [...active], checkpoint) : null;
  if (frontier) {
    const previousBenefit = [...active].reduce((sum, index) => sum + ordered[index]!.benefit, 0);
    const newBenefit = frontier.selected.reduce((sum, index) => sum + ordered[index]!.benefit, 0);
    if (newBenefit > previousBenefit + EPSILON) localExchanges += 1;
    owner.fill(-1);
    active.clear();
    for (const index of frontier.selected) add(ordered[index]!);
  }
  for (let cell = 0; cell < baseline.length; cell += 1) {
    if (owner[cell] === -1 && baseline[cell]) pieces.push(placement(baseline[cell]!));
  }
  for (const index of active) pieces.push(placement(ordered[index]!));
  pieces.sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x);
  checkpoint();
  return {
    construction: { width: target.width, height: target.height, pieces },
    optimization: {
      candidates: ordered.length,
      passes,
      proposals,
      localExchanges,
      frontierStates: frontier?.states ?? 0,
      conflictComponents: frontier?.components ?? 0,
      exactComponents: frontier?.exactComponents ?? 0,
      localAreaImprovement: Math.max(0, [...active].reduce((sum, index) => sum + ordered[index]!.areaBenefit, 0) - initialAreaBenefit),
      localObjectiveImprovement: Math.max(0, [...active].reduce((sum, index) => sum + ordered[index]!.benefit, 0) - initialBenefit),
      localSearchLimited: (frontier?.limited ?? false) || proposals >= MAX_LOCAL_PROPOSALS
        || (passes === passLimit && (changed || passLimit === 0 && ordered.length > 0)),
    },
  };
}
