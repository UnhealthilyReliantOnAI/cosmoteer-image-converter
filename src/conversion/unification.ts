import { classifyPolygonContact, diagnoseConnectivity } from '../construction/connectivity';
import { getPlacedPolygon } from '../construction/model';
import type { Construction } from '../construction/model';
import { placementKey } from '../construction/symmetry';
import type { SymmetryMode } from '../construction/symmetry';
import { orbitConstruction, reservedCells } from './orbits';
import type { PlacementOrbit } from './orbits';
import type { CoverageTarget } from './target';

export interface UnificationReport {
  readonly requested: boolean;
  readonly satisfied: boolean;
  readonly status: 'not-requested' | 'satisfied' | 'empty' | 'incompatible' | 'search-exhausted' | 'budget-reached';
  readonly bridges: number;
  readonly replacements: number;
  readonly explored: number;
  readonly refinements?: number;
  readonly repairProposals?: number;
  readonly seeded?: boolean;
  readonly message?: string;
}

interface HeapEntry {
  readonly index: number;
  readonly distance: number;
}

class MinHeap {
  private readonly entries: HeapEntry[] = [];
  push(entry: HeapEntry) {
    let i = this.entries.length;
    this.entries.push(entry);
    while (i > 0) {
      const p = Math.floor((i - 1) / 2), parent = this.entries[p]!;
      if (parent.distance < entry.distance || parent.distance === entry.distance && parent.index <= entry.index) break;
      this.entries[i] = parent;
      i = p;
    }
    this.entries[i] = entry;
  }
  pop(): HeapEntry | undefined {
    const first = this.entries[0], last = this.entries.pop();
    if (!first || !last || this.entries.length === 0) return first;
    let i = 0;
    while (2 * i + 1 < this.entries.length) {
      let child = 2 * i + 1;
      const right = this.entries[child + 1];
      if (right && (right.distance < this.entries[child]!.distance
        || right.distance === this.entries[child]!.distance && right.index < this.entries[child]!.index)) child++;
      const next = this.entries[child]!;
      if (last.distance < next.distance || last.distance === next.distance && last.index <= next.index) break;
      this.entries[i] = next;
      i = child;
    }
    this.entries[i] = last;
    return first;
  }
}

/** Search real edge-contact paths of allowed placements. Paths may replace occupied reservations;
 * their symmetric companions are committed together. Every accepted change is re-diagnosed.
 * No secondary group is simply discarded and no point/footprint contact counts as a bridge.
 */
function searchUnification(
  target: CoverageTarget,
  initial: Construction,
  orbits: readonly PlacementOrbit[],
  checkpoint: () => void,
  symmetry: SymmetryMode,
  preferSquaresInitially: boolean
): {
  construction: Construction;
  report: UnificationReport;
} {
  const impossible = (status: 'empty' | 'incompatible', message: string) => ({
    construction: initial,
    report: {
      requested: true,
      satisfied: false,
      status,
      bridges: 0,
      replacements: 0,
      explored: 0,
      message,
    },
  });
  if (initial.pieces.length === 0) return impossible('empty', 'Structure unifiée non obtenue : aucune pièce compatible retenue à cette taille.');
  if (symmetry !== 'none' && (symmetry === 'vertical' ? target.width : target.height) % 2 === 1
    && !orbits.some(({ pieces }) => pieces.length === 1)) {
    return impossible(
      'incompatible',
      'Structure unifiée impossible avec cet axe impair : aucune famille autorisée ne peut occuper seule l’axe tout en restant symétrique.'
    );
  }
  if (orbits.every(({ pieces }) => pieces.every(({ type }) => type === 'small_triangle')) && initial.pieces.length > 2) {
    return impossible(
      'incompatible',
      'Structure unifiée non obtenue : les petits triangles seuls n’ont qu’un bord accessible hors de leur emprise et ne peuvent former une chaîne de plus de deux pièces.'
    );
  }
  const lookup = new Map(orbits.flatMap((orbit) => orbit.pieces.map((piece) => [placementKey(piece), orbit] as const)));
  let active = new Map<string, PlacementOrbit>();
  for (const piece of initial.pieces) {
    const orbit = lookup.get(placementKey(piece));
    if (!orbit) throw new Error('Placement absent des alternatives de connexion.');
    active.set(orbit.key, orbit);
  }
  let construction = orbitConstruction(target, [...active.values()]);
  let diagnostic = diagnoseConnectivity(construction);
  let bridges = 0, replacements = 0, explored = 0;
  let repairProposals = 0;
  const editedCells = new Set<number>();
  const hasSquares = orbits.some((orbit) => orbit.pieces[0]?.type === 'square_1x1');
  let preferSquares = preferSquaresInitially;
  const maxExplored = 500_000, maxBridges = 256, maxRepairs = 100_000;
  // A node is one actual polygon. An orbit is NOT treated as a connected node.
  const nodes = orbits.flatMap((orbit) => orbit.pieces.map((piece) => ({
    orbit,
    piece,
    polygon: getPlacedPolygon(piece),
    cells: reservedCells(piece, target.width),
  })));
  const nodeByKey = new Map(nodes.map((node, index) => [placementKey(node.piece), index]));
  const byCell: number[][] = Array.from({ length: target.width * target.height }, () => []);
  nodes.forEach((node, index) => node.cells.forEach((cell) => byCell[cell]!.push(index)));
  const overlaps = (a: readonly number[], b: readonly number[]) => a.some((cell) => b.includes(cell));
  // Geometric adjacency is fixed for this search. Active orbits and square preference are not.
  const geometricNeighbors: (readonly number[] | undefined)[] = new Array(nodes.length);

  function neighborNodes(index: number): number[] {
    let neighbors = geometricNeighbors[index];
    if (!neighbors) {
      const node = nodes[index]!;
      const pool = new Set<number>();
      for (const cell of node.cells) {
        const x = cell % target.width, y = Math.floor(cell / target.width);
        for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
          if (x + dx < 0 || x + dx >= target.width || y + dy < 0 || y + dy >= target.height) continue;
          for (const candidate of byCell[(y + dy) * target.width + x + dx]!) pool.add(candidate);
        }
      }
      neighbors = [...pool].filter((other) => other !== index && !overlaps(node.cells, nodes[other]!.cells)
        && classifyPolygonContact(node.polygon, nodes[other]!.polygon) === 'edge');
      geometricNeighbors[index] = neighbors;
    }
    return neighbors.filter((other) => !preferSquares || nodes[other]!.piece.type === 'square_1x1'
      || active.has(nodes[other]!.orbit.key));
  }

  while (diagnostic.groups.length > 1 && explored < maxExplored && bridges < maxBridges) {
    checkpoint();
    const owner: (PlacementOrbit | null)[] = Array.from({ length: byCell.length }, () => null);
    for (const orbit of active.values()) orbit.cells.forEach((cell) => {
      owner[cell] = orbit;
    });
    const groupByKey = new Map<string, number>();
    const pieceById = new Map(construction.pieces.map((piece) => [piece.id, piece]));
    diagnostic.groups.forEach((group, index) => group.pieceIds.forEach((id) => {
      groupByKey.set(placementKey(pieceById.get(id)!), index);
    }));
    const costCache = new Map<string, number>();

    function cost(orbit: PlacementOrbit): number {
      if (active.has(orbit.key)) return 0;
      let value = costCache.get(orbit.key);
      if (value !== undefined) return value;
      const conflicts = [...new Set(orbit.cells.flatMap((cell) => owner[cell] ? [owner[cell]!] : []))];
      value = Math.max(0.02, conflicts.reduce((sum, old) => sum + old.gain, 0) - orbit.gain + 0.05 * orbit.pieces.length);
      costCache.set(orbit.key, value);
      return value;
    }

    function commit(additions: readonly PlacementOrbit[]): boolean {
      const unique = [...new Map(additions.map((orbit) => [orbit.key, orbit])).values()];
      const used = new Set<number>();
      for (const orbit of unique) {
        if (orbit.cells.some((cell) => used.has(cell))) return false;
        orbit.cells.forEach((cell) => used.add(cell));
      }
      const removed = new Set(unique.flatMap((orbit) => orbit.cells.flatMap((cell) => owner[cell] ? [owner[cell]!.key] : [])));
      const next = new Map(active);
      removed.forEach((key) => next.delete(key));
      unique.forEach((orbit) => next.set(orbit.key, orbit));
      const candidate = orbitConstruction(target, [...next.values()]);
      const d = diagnoseConnectivity(candidate);
      if (d.groups.length >= diagnostic.groups.length) return false;
      // Every old group must remain represented by an untouched piece or a replacement in its reservations.
      // This allows reorientation/expansion of an isolated tip, but forbids deleting a secondary group.
      if (diagnostic.groups.some((group) => !group.pieceIds.some((id) => {
        const piece = pieceById.get(id)!;
        return next.has(lookup.get(placementKey(piece))!.key)
          || reservedCells(piece, target.width).some((cell) => used.has(cell));
      }))) return false;
      replacements += [...removed].filter((key) => !unique.some((orbit) => orbit.key === key)).length;
      unique.forEach((orbit) => orbit.cells.forEach((cell) => editedCells.add(cell)));
      active = next;
      construction = candidate;
      diagnostic = d;
      bridges++;
      return true;
    }

    // First try inexpensive local reorientations contacting several previously separate groups.
    const repairs: PlacementOrbit[] = [];
    const groupsAtCell = new Int32Array(byCell.length).fill(-1);
    for (const piece of construction.pieces) {
      const group = groupByKey.get(placementKey(piece))!;
      reservedCells(piece, target.width).forEach((cell) => {
        groupsAtCell[cell] = group;
      });
    }
    const repairPool = new Map<string, PlacementOrbit>();
    for (let cell = 0; cell < groupsAtCell.length; cell++) {
      if (groupsAtCell[cell] !== 0) continue;
      const x = cell % target.width, y = Math.floor(cell / target.width);
      const adjacent = [[-1, 0], [1, 0], [0, -1], [0, 1]].flatMap(([dx, dy]) =>
      x + dx! < 0 || y + dy! < 0 || x + dx! >= target.width || y + dy! >= target.height
        ? [] : [(y + dy!) * target.width + x + dx!]);
      if (adjacent.every((neighbor) => groupsAtCell[neighbor] === 0)) continue;
      for (const neighbor of [cell, ...adjacent]) for (const index of byCell[neighbor]!) {
        const orbit = nodes[index]!.orbit;
        repairPool.set(orbit.key, orbit);
      }
    }
    let repairChecks = 0;
    for (const orbit of hasSquares ? repairPool.values() : orbits) {
      if (repairProposals >= maxRepairs) break;
      repairProposals++;
      if (++repairChecks % 128 === 0) checkpoint();
      if (active.has(orbit.key)) continue;
      if (preferSquares && orbit.pieces[0]?.type !== 'square_1x1') continue;
      const contacts = new Set<number>();
      if (hasSquares) for (const cell of orbit.cells) if (groupsAtCell[cell]! >= 0) contacts.add(groupsAtCell[cell]!);
      for (const piece of orbit.pieces) {
        const index = nodeByKey.get(placementKey(piece))!;
        for (const other of neighborNodes(index)) {
          const group = groupByKey.get(placementKey(nodes[other]!.piece));
          if (group !== undefined) contacts.add(group);
        }
      }
      if (contacts.size > 1) repairs.push(orbit);
    }
    repairs.sort((a, b) => cost(a) - cost(b) || a.key.localeCompare(b.key, 'en'));
    let repaired = false;
    for (const orbit of repairs.slice(0, 64)) if (commit([orbit])) {
      repaired = true;
      break;
    }
    if (repaired) continue;
    const distance = new Float64Array(nodes.length).fill(Infinity);
    const previous = new Int32Array(nodes.length).fill(-1);
    const heap = new MinHeap();
    for (const [key, group] of groupByKey) if (group === 0) {
      const index = nodeByKey.get(key)!;
      distance[index] = 0;
      heap.push({ index, distance: 0 });
    }
    let found = false, attempts = 0;
    while (explored < maxExplored) {
      const entry = heap.pop();
      if (!entry) break;
      if (entry.distance !== distance[entry.index]) continue;
      explored++;
      if (explored % 128 === 0) checkpoint();
      const node = nodes[entry.index]!;
      const group = groupByKey.get(placementKey(node.piece));
      if (group !== undefined && group > 0) {
        const path: PlacementOrbit[] = [];
        for (let index = entry.index; index >= 0; index = previous[index]!) path.push(nodes[index]!.orbit);
        if (commit(path)) {
          found = true;
          break;
        }
        // A shortest polygon path can conflict with a non-adjacent reservation or its reflected half.
        // Try other endpoints; never emit the conflicting path.
        if (++attempts >= 64) break;
      }
      for (const other of neighborNodes(entry.index)) {
        // A polygon path also reserves the full footprints of ALL symmetric companions.
        // Reject non-adjacent path conflicts during search, rather than at the final commit only.
        const nextOrbit = nodes[other]!.orbit;
        let conflict = false;
        for (let ancestor = entry.index; ancestor >= 0; ancestor = previous[ancestor]!) {
          const oldOrbit = nodes[ancestor]!.orbit;
          if (nextOrbit.key !== oldOrbit.key && overlaps(nextOrbit.cells, oldOrbit.cells)) {
            conflict = true;
            break;
          }
        }
        if (conflict) continue;
        const next = entry.distance + cost(nodes[other]!.orbit) + 0.001;
        if (next >= distance[other]! - 1e-9) continue;
        distance[other] = next;
        previous[other] = entry.index;
        heap.push({ index: other, distance: next });
      }
    }
    if (!found && hasSquares && !preferSquares) {
      preferSquares = true;
      continue;
    }
    if (!found) break;
  }
  const satisfied = diagnostic.groups.length === 1;
  let refinements = 0, refinementChecks = 0;
  if (satisfied) {
    const owner: (PlacementOrbit | null)[] = Array.from({ length: byCell.length }, () => null);
    for (const orbit of active.values()) orbit.cells.forEach((cell) => {
      owner[cell] = orbit;
    });
    for (let pass = 0; pass < 2 && refinementChecks < 2000; pass++) {
      let changed = false;
      for (const orbit of orbits) {
        if (refinementChecks >= 2000) break;
        if (active.has(orbit.key) || !orbit.cells.some((cell) => editedCells.has(cell))) continue;
        const removed = [...new Set(orbit.cells.flatMap((cell) => owner[cell] ? [owner[cell]!] : []))];
        if (orbit.gain <= removed.reduce((sum, old) => sum + old.gain, 0) + 1e-8) continue;
        refinementChecks++;
        if (refinementChecks % 32 === 0) checkpoint();
        const next = new Map(active);
        removed.forEach((old) => next.delete(old.key));
        next.set(orbit.key, orbit);
        const candidate = orbitConstruction(target, [...next.values()]);
        if (diagnoseConnectivity(candidate).groups.length !== 1) continue;
        removed.forEach((old) => old.cells.forEach((cell) => {
          owner[cell] = null;
        }));
        orbit.cells.forEach((cell) => {
          owner[cell] = orbit;
        });
        active = next;
        construction = candidate;
        refinements++;
        changed = true;
      }
      if (!changed) break;
    }
  }
  const limited = explored >= maxExplored || bridges >= maxBridges || repairProposals >= maxRepairs;
  const status = satisfied ? 'satisfied' : construction.pieces.length === 0 ? 'empty' : limited ? 'budget-reached' : 'search-exhausted';
  return {
    construction,
    report: {
      requested: true,
      satisfied,
      status,
      bridges,
      replacements,
      explored,
      refinements,
      repairProposals,
      ...(!satisfied ? {
        message: status === 'empty'
          ? 'Structure unifiée non obtenue : aucune pièce compatible retenue à cette taille.'
          : limited ? 'Structure unifiée non obtenue dans le budget de recherche. Essayez d’autres familles ou une autre taille.'
          : 'Structure unifiée non obtenue avec ces placements, familles et axe. Essayez d’autres familles ou une autre taille.',
      } : {}),
    },
  };
}

export function unifyConstruction(
  target: CoverageTarget,
  initial: Construction,
  orbits: readonly PlacementOrbit[],
  checkpoint: () => void,
  symmetry: SymmetryMode = 'none'
): {
  construction: Construction;
  report: UnificationReport;
} {
  // At a very coarse resolution the fidelity-only reference may choose no piece at all.
  // Unity still permits an allowed singleton or an edge-connected symmetric pair.
  if (initial.pieces.length === 0) {
    let seed: PlacementOrbit | undefined;
    for (let i = 0; i < orbits.length; i++) {
      if (i % 128 === 0) checkpoint();
      const orbit = orbits[i]!;
      if (seed && orbit.gain <= seed.gain + 1e-8) continue;
      if (orbit.pieces.length === 1 || orbit.pieces.length === 2
        && classifyPolygonContact(getPlacedPolygon(orbit.pieces[0]!), getPlacedPolygon(orbit.pieces[1]!)) === 'edge') seed = orbit;
    }
    if (seed) return {
      construction: orbitConstruction(target, [seed]),
      report: {
        requested: true,
        satisfied: true,
        status: 'satisfied',
        bridges: 0,
        replacements: 0,
        explored: 0,
        seeded: true,
      },
    };
  }
  const first = searchUnification(target, initial, orbits, checkpoint, symmetry, false);
  if (first.report.satisfied || first.report.status === 'empty' || first.report.status === 'incompatible'
    || !orbits.some((orbit) => orbit.pieces[0]?.type === 'square_1x1')) return first;
  // Retry from the ORIGINAL construction: an earlier narrow bridge may block the remaining route.
  const second = searchUnification(target, initial, orbits, checkpoint, symmetry, true);
  const selected = second.report.satisfied || diagnoseConnectivity(second.construction).groups.length
  < diagnoseConnectivity(first.construction).groups.length ? second : first;
  return {
    ...selected,
    report: {
      ...selected.report,
      explored: first.report.explored + second.report.explored,
      repairProposals: (first.report.repairProposals ?? 0) + (second.report.repairProposals ?? 0),
    },
  };
}
