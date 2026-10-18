import { diagnoseConnectivity } from '../construction/connectivity';
import type { Construction, PiecePlacement } from '../construction/model';
import { placementKey } from '../construction/symmetry';
import { orbitConstruction } from './orbits';
import type { PlacementOrbit } from './orbits';
import { createContourGraph } from './regularity';
import type { ContourRegularity } from './regularity';
import type { CoverageTarget } from './target';

export interface SmoothingReport {
  readonly level: number;
  readonly exchanges: number;
  readonly proposals: number;
  readonly limited: boolean;
  readonly before: ContourRegularity;
  readonly after: ContourRegularity;
}

/** Coordinated replacement of reservations, including rotations, long slopes, additions and removals.
 * Each accepted exchange improves area error + level * source-aware contour penalty.
 * No family, symmetry orbit or reserved cell is relaxed during an exchange.
 */
export function smoothConstruction(
  target: CoverageTarget,
  initial: Construction,
  orbits: readonly PlacementOrbit[],
  level: number,
  checkpoint: () => void,
  preserveUnified = false
): {
  construction: Construction;
  report: SmoothingReport;
} {
  const strength = level / 100;
  const graph = createContourGraph(target, initial, checkpoint);
  const before = graph.measure();
  const lookup = new Map(orbits.flatMap((orbit) => orbit.pieces.map((piece) => [placementKey(piece), orbit] as const)));
  const active = new Map<string, PlacementOrbit>();
  for (const piece of initial.pieces) {
    const orbit = lookup.get(placementKey(piece));
    if (!orbit) throw new Error('Placement absent des alternatives de lissage.');
    active.set(orbit.key, orbit);
  }
  const owner: (PlacementOrbit | null)[] = Array.from({ length: target.width * target.height }, () => null);
  for (const orbit of active.values()) orbit.cells.forEach((cell) => {
    owner[cell] = orbit;
  });
  const singles: (PlacementOrbit | null)[] = Array.from({ length: owner.length }, () => null);
  for (const orbit of orbits) if (orbit.pieces.every((piece) => piece.type !== 'wedge_1x2' && piece.type !== 'wedge_1x3') && orbit.gain > 0) {
    for (const cell of orbit.cells) if (orbit.gain > (singles[cell]?.gain ?? 0) + 1e-8) singles[cell] = orbit;
  }
  let exchanges = 0, proposals = 0, changed = false;
  const maxProposals = 350_000;
  const gainBefore = [...active.values()].reduce((sum, orbit) => sum + orbit.gain, 0);
  let gainNow = gainBefore;
  // A second guard limits aggregate drift. This is in grid cells², independent of preview resolution.
  const maxLoss = Math.max(0.3, target.blackArea * 0.018) * strength;
  // First pass is complete. Later passes only revisit changed reservations/vertices.
  // All members of an orbit and the entire conflicting long piece must be considered.
  let previousDirty: Set<number> | null = null;
  let dirty = new Set<number>();
  // Global budget or connectivity can change after a distant exchange. Never discard these.
  const deferred = new Set<string>();

  function markChanged(orbit: PlacementOrbit): void {
    for (const cell of orbit.cells) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const x = cell % target.width + dx, y = Math.floor(cell / target.width) + dy;
      if (x >= 0 && y >= 0 && x < target.width && y < target.height) dirty.add(y * target.width + x);
    }
  }

  function relevant(orbit: PlacementOrbit): boolean {
    if (!previousDirty || deferred.has(orbit.key)) return true;
    const touched = (cell: number) => previousDirty!.has(cell) || dirty.has(cell);
    return orbit.cells.some((cell) => touched(cell) || owner[cell]?.cells.some(touched));
  }

  function attempt(seed: PlacementOrbit | null, removed: readonly PlacementOrbit[], refill: boolean): boolean {
    proposals++;
    if (proposals % 128 === 0) checkpoint();
    const additions: PlacementOrbit[] = seed ? [seed] : [];
    const used = new Set(seed?.cells ?? []);
    const removedKeys = new Set(removed.map(({ key }) => key));
    if (refill) for (const cell of [...new Set(removed.flatMap(({ cells }) => cells))].sort((a, b) => a - b)) {
      const single = singles[cell];
      if (!single || single.cells.some((c) => used.has(c) || owner[c] && !removedKeys.has(owner[c]!.key))) continue;
      additions.push(single);
      single.cells.forEach((c) => used.add(c));
    }
    const deltaGain = additions.reduce((sum, orbit) => sum + orbit.gain, 0) - removed.reduce((sum, orbit) => sum + orbit.gain, 0);
    const proposalKey = seed?.key ?? removed[0]!.key;
    if (gainNow + deltaGain < gainBefore - maxLoss - 1e-8) {
      deferred.add(proposalKey);
      return false;
    }
    const oldPieces = removed.flatMap(({ pieces }) => pieces), newPieces = additions.flatMap(({ pieces }) => pieces);
    if (deltaGain - strength * graph.evaluateExchange(oldPieces, newPieces) <= 1e-8) return false;
    if (preserveUnified) {
      const next = [...active.values()].filter((orbit) => !removedKeys.has(orbit.key));
      if (diagnoseConnectivity(orbitConstruction(target, [...next, ...additions])).groups.length !== 1) {
        deferred.add(proposalKey);
        return false;
      }
    }
    graph.change(oldPieces, -1);
    graph.change(newPieces, 1);
    removed.forEach(markChanged);
    additions.forEach(markChanged);
    removed.forEach((orbit) => {
      active.delete(orbit.key);
      orbit.cells.forEach((cell) => {
        owner[cell] = null;
      });
    });
    additions.forEach((orbit) => {
      active.set(orbit.key, orbit);
      orbit.cells.forEach((cell) => {
        owner[cell] = orbit;
      });
    });
    gainNow += deltaGain;
    exchanges++;
    return true;
  }

  let passes = 0;
  for (; passes < 6 && proposals < maxProposals; passes++) {
    checkpoint();
    changed = false;
    dirty = new Set<number>();
    for (const orbit of orbits) {
      if (proposals >= maxProposals) break;
      if (active.has(orbit.key)) continue;
      if (!relevant(orbit)) continue;
      const conflicts = [...new Map(orbit.cells.flatMap((cell) => owner[cell] ? [[owner[cell]!.key, owner[cell]!] as const] : [])).values()];
      if (orbit.gain <= 0 && conflicts.length === 0 && orbit.cells.every((cell) => [-1, 0, 1].every((dy) => [-1, 0, 1].every((dx) => {
        const x = cell % target.width + dx, y = Math.floor(cell / target.width) + dy;
        return x < 0 || y < 0 || x >= target.width || y >= target.height || !owner[y * target.width + x];
      })))) continue;
      if (orbit.pieces.every((piece) => piece.type !== 'square_1x1') && orbit.cells.every((cell) => target.cellAreas[cell] === 1
        && [-1, 0, 1].every((dy) => [-1, 0, 1].every((dx) => {
        const x = cell % target.width + dx, y = Math.floor(cell / target.width) + dy;
        return x >= 0 && y >= 0 && x < target.width && y < target.height
          && owner[y * target.width + x]?.pieces.every((piece) => piece.type === 'square_1x1');
      })))) continue;
      // Skip uniform interior: alternatives there cannot improve the silhouette boundary.
      if (orbit.gain < -1 && conflicts.length === 0) continue;
      if (attempt(orbit, conflicts, true) || attempt(orbit, conflicts, false)) changed = true;
    }
    for (const orbit of [...active.values()]) {
      if (proposals >= maxProposals) break;
      if (!relevant(orbit)) continue;
      if (orbit.pieces.every((piece) => piece.type === 'square_1x1' && [-1, 0, 1].every((dy) => [-1, 0, 1].every((dx) => {
        const x = piece.position.x + dx, y = piece.position.y + dy;
        return x >= 0 && y >= 0 && x < target.width && y < target.height
          && owner[y * target.width + x]?.pieces.every((p) => p.type === 'square_1x1');
      })))) continue;
      if (active.has(orbit.key) && attempt(null, [orbit], false)) changed = true;
    }
    previousDirty = dirty;
    if (!changed) break;
  }
  // Retain the initial IDs of untouched placements for stable structured comparisons.
  const oldIds = new Map(initial.pieces.map((piece) => [placementKey(piece), piece.id]));
  const construction = orbitConstruction(target, [...active.values()]);
  const pieces: PiecePlacement[] = construction.pieces.map((piece) => ({ ...piece, id: oldIds.get(placementKey(piece)) ?? piece.id }));
  return {
    construction: { ...construction, pieces },
    report: {
      level,
      exchanges,
      proposals,
      limited: proposals >= maxProposals || passes === 6 && changed,
      before,
      after: graph.measure(),
    },
  };
}
