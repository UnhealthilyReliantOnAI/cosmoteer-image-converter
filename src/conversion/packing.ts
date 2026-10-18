/** Non-overlapping rectangular reservations of at most three cells. */
export interface PackingCandidate {
  readonly index: number;
  readonly cells: readonly number[];
  readonly benefit: number;
  readonly savings: number;
}

export interface PackingResult {
  readonly selected: readonly number[];
  readonly states: number;
  readonly components: number;
  readonly exactComponents: number;
  readonly limited: boolean;
}

export interface PackingBudget {
  readonly beam: number;
  readonly transitions: number;
}

export const DEFAULT_PACKING_BUDGET: PackingBudget = { beam: 4096, transitions: 3_000_000 };

interface Path {
  readonly index: number;
  readonly previous: Path | null;
}

interface State {
  readonly value: number;
  readonly savings: number;
  readonly path: Path | null;
}

const EPSILON = 1e-8;

const better = (a: State, b: State) => a.value > b.value + EPSILON
  || Math.abs(a.value - b.value) <= EPSILON && a.savings > b.savings;

const total = (indices: readonly number[], candidates: readonly PackingCandidate[]): State => ({
  value: indices.reduce((sum, i) => sum + candidates[i]!.benefit, 0),
  savings: indices.reduce((sum, i) => sum + candidates[i]!.savings, 0),
  path: null,
});

/** Independent conflict components, then frontier dynamic programming.
 * Equivalent occupied frontiers are merged, allowing arbitrarily many coordinated replacements.
 * A deterministic beam/node budget bounds difficult components. The incumbent is always preserved.
 */
export function optimizePacking(
  candidates: readonly PackingCandidate[],
  width: number,
  cellCount: number,
  incumbent: readonly number[],
  checkpoint: () => void = () => {},
  budget: PackingBudget = DEFAULT_PACKING_BUDGET
): PackingResult {
  if (!Number.isSafeInteger(budget.beam) || budget.beam < 1
    || !Number.isSafeInteger(budget.transitions) || budget.transitions < 0) throw new Error('Budget de recherche invalide.');
  const parents = candidates.map((_, index) => index);

  function find(index: number): number {
    while (parents[index] !== index) {
      parents[index] = parents[parents[index]!]!;
      index = parents[index]!;
    }
    return index;
  }

  const first = new Int32Array(cellCount).fill(-1);
  for (const candidate of candidates) {
    for (const cell of candidate.cells) {
      if (first[cell] === -1) first[cell] = candidate.index;
      else parents[find(candidate.index)] = find(first[cell]!);
    }
  }
  const components = new Map<number, number[]>();
  for (const candidate of candidates) {
    const root = find(candidate.index);
    const group = components.get(root) ?? [];
    group.push(candidate.index);
    components.set(root, group);
  }
  const selected: number[] = [];
  const existing = new Set(incumbent);
  let states = 0;
  let exactComponents = 0;
  let limited = false;
  for (const group of components.values()) {
    checkpoint();
    const current = group.filter((index) => existing.has(index));
    const initial = total(current, candidates);
    const upper = new Map<number, number>();
    let minX = width, maxX = 0, minY = cellCount, maxY = 0;
    for (const index of group) {
      for (const cell of candidates[index]!.cells) {
        minX = Math.min(minX, cell % width);
        maxX = Math.max(maxX, cell % width);
        minY = Math.min(minY, Math.floor(cell / width));
        maxY = Math.max(maxY, Math.floor(cell / width));
        upper.set(cell, Math.max(upper.get(cell) ?? 0, candidates[index]!.benefit / candidates[index]!.cells.length));
      }
    }
    // A tight fractional cell bound avoids pointless search of perfectly tiled solid regions.
    if (initial.value >= [...upper.values()].reduce((sum, value) => sum + value, 0) - EPSILON) {
      selected.push(...current);
      exactComponents += 1;
      continue;
    }
    if (states >= budget.transitions) {
      selected.push(...current);
      limited = true;
      continue;
    }
    const transpose = maxY - minY < maxX - minX;
    const scanWidth = transpose ? maxY - minY + 1 : maxX - minX + 1;
    const coordinate = (cell: number) => transpose
      ? (cell % width - minX) * scanWidth + Math.floor(cell / width) - minY
      : (Math.floor(cell / width) - minY) * scanWidth + cell % width - minX;
    const anchors = new Map<number, {
      index: number;
      mask: bigint;
    }[]>();
    for (const index of group) {
      const cells = candidates[index]!.cells.map(coordinate);
      const anchor = Math.min(...cells);
      const entries = anchors.get(anchor) ?? [];
      entries.push({ index, mask: cells.reduce((mask, cell) => mask | 1n << BigInt(cell - anchor), 0n) });
      anchors.set(anchor, entries);
    }
    let frontier = new Map<bigint, State>([[0n, { value: 0, savings: 0, path: null }]]);
    let previous = 0;
    let pruned = false;
    frontierSearch: for (const [anchor, alternatives] of [...anchors].sort((a, b) => a[0] - b[0])) {
      checkpoint();
      const next = new Map<bigint, State>();
      const shift = BigInt(anchor - previous);

      function keep(mask: bigint, state: State) {
        const old = next.get(mask);
        if (!old || better(state, old)) next.set(mask, state);
      }

      for (const [oldMask, state] of frontier) {
        const mask = oldMask >> shift;
        keep(mask, state); // Revert this anchor to its optimal independent cell choices.
        if ((mask & 1n) !== 0n) continue;
        for (const alternative of alternatives) {
          if (states >= budget.transitions) {
            pruned = true;
            frontier = next;
            break frontierSearch;
          }
          states += 1;
          if (states % 1024 === 0) checkpoint();
          if ((mask & alternative.mask) !== 0n) continue;
          const candidate = candidates[alternative.index]!;
          keep(mask | alternative.mask, {
            value: state.value + candidate.benefit,
            savings: state.savings + candidate.savings,
            path: { index: alternative.index, previous: state.path },
          });
        }
      }
      previous = anchor;
      frontier = next;
      if (frontier.size > budget.beam) {
        pruned = true;
        frontier = new Map([...frontier].sort((a, b) => b[1].value - a[1].value || b[1].savings - a[1].savings
          || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).slice(0, budget.beam));
      }
      if (states >= budget.transitions) {
        pruned = true;
        break;
      }
    }
    let best = initial;
    for (const state of frontier.values()) if (better(state, best)) best = state;
    if (best === initial) selected.push(...current);
    else for (let path = best.path; path; path = path.previous) selected.push(path.index);
    if (!pruned) exactComponents += 1;
    limited ||= pruned;
  }
  return { selected, states, components: components.size, exactComponents, limited };
}
