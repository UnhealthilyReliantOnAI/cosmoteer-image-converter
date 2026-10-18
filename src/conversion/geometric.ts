import { validateAllowedFamilies } from '../catalog/pieces';
import { diagnoseConnectivity } from '../construction/connectivity';
import type { Construction } from '../construction/model';
import { isSymmetricConstruction } from '../construction/symmetry';
import type { BinaryMask } from '../image/analysis';
import { rasterizeComparison } from './diagnostics';
import { countPieceFamilies, evaluateFidelity } from './fidelity';
import { createObjective } from './objective';
import { optimizeTarget } from './optimization';
import { createOrbitEnumerator, packSymmetricOrbits, reweightOrbits } from './orbits';
import { smoothConstruction } from './smoothing';
import type { SmoothingReport } from './smoothing';
import { convertToSquares } from './squares';
import { prepareTarget } from './target';
import type { CoverageTarget } from './target';
import type { ConversionOptions, ConversionResult } from './types';
import { unifyConstruction } from './unification';
import type { UnificationReport } from './unification';

const EPSILON = 1e-8;

export function validateControls(options: Pick<ConversionOptions, 'smoothing' | 'symmetry' | 'forceUnified'>): void {
  const smoothing = options.smoothing ?? 0;
  if (!Number.isFinite(smoothing) || smoothing < 0 || smoothing > 100) throw new Error('Le lissage doit être compris entre 0 et 100.');
  if (!['none', 'vertical', 'horizontal'].includes(options.symmetry ?? 'none')) throw new Error('Mode de symétrie inconnu.');
  if (options.forceUnified !== undefined && typeof options.forceUnified !== 'boolean') throw new Error('Option de structure unifiée invalide.');
}

/** Shared second phase: the Worker can release its source raster before optimization. */
export function convertPreparedTarget(
  target: CoverageTarget,
  options: ConversionOptions,
  squareReference: Construction | null = null
): ConversionResult {
  validateAllowedFamilies(options.allowedFamilies);
  validateControls(options);
  options.checkpoint?.();
  const checkpoint = options.checkpoint ?? (() => {});
  const symmetry = options.symmetry ?? 'none';
  const smoothing = options.smoothing ?? 0;
  const squareOnly = options.allowedFamilies.every((type) => type === 'square_1x1');
  if (squareOnly && !squareReference) throw new Error('Le mode carrés nécessite la construction historique pour conserver les égalités exactes.');
  const objective = createObjective(target, checkpoint);
  const enumerate = createOrbitEnumerator(target, options.allowedFamilies, symmetry, objective, checkpoint);
  let { construction, optimization } = squareOnly || symmetry !== 'none'
    ? {
    construction: squareReference ?? { width: target.width, height: target.height, pieces: [] },
    optimization: {
      candidates: 0,
      passes: 0,
      proposals: 0,
      localSearchLimited: false,
      localExchanges: 0,
      localAreaImprovement: 0,
    },
  }
    : optimizeTarget(target, options, objective);
  let orbits = symmetry !== 'none' ? enumerate() : null;
  let symmetricStages = 0, symmetricStates = 0, symmetricLimited = false;
  if (orbits) {
    const result = packSymmetricOrbits(target, orbits, symmetry, checkpoint);
    construction = result.construction;
    symmetricStages++;
    symmetricStates += result.packed.states;
    symmetricLimited ||= result.packed.limited;
    optimization = {
      candidates: result.candidates,
      passes: 1,
      proposals: 0,
      localExchanges: 0,
      localAreaImprovement: 0,
      frontierStates: result.packed.states,
      conflictComponents: result.packed.components,
      exactComponents: result.packed.exactComponents,
      localSearchLimited: result.packed.limited,
    };
  }
  let fidelity = evaluateFidelity(target, construction);
  if (symmetry !== 'none' && target.blackArea > 0) {
    for (let pass = 0; pass < 3; pass++) {
      const ratio = fidelity.iou && fidelity.iou > 0 ? fidelity.iou : 0.5;
      const alternatives = enumerate(ratio);
      const next = packSymmetricOrbits(target, alternatives, symmetry, checkpoint);
      symmetricStages++;
      symmetricStates += next.packed.states;
      symmetricLimited ||= next.packed.limited;
      const score = evaluateFidelity(target, next.construction);
      if ((score.iou ?? 0) <= (fidelity.iou ?? 0) + EPSILON) break;
      construction = next.construction;
      fidelity = score;
    }
  }
  let stages = symmetry === 'none' ? squareOnly ? 0 : 1 : symmetricStages;
  let totalFrontierStates = symmetry === 'none' ? optimization.frontierStates ?? 0 : symmetricStates;
  let totalProposals = optimization.proposals;
  let limited = optimization.localSearchLimited || symmetricLimited;
  // Fractional IoU objective: maximize (1 + q) * intersection - q * generatedArea.
  // At the current q, a positive gain corresponds to an actual IoU improvement.
  // Reuse measured intersections; retain the incumbent whenever bounded search does worse.
  if (symmetry === 'none' && !squareOnly && options.maxLocalPasses !== 0 && fidelity.iou !== null && fidelity.iou > 0 && fidelity.iou < 1) {
    for (let pass = 0; pass < 2; pass += 1) {
      options.checkpoint?.();
      const currentRatio = fidelity.iou;
      if (currentRatio === null) break;
      const next = optimizeTarget(target, options, objective, currentRatio);
      stages += 1;
      totalFrontierStates += next.optimization.frontierStates ?? 0;
      totalProposals += next.optimization.proposals;
      limited ||= next.optimization.localSearchLimited;
      const score = evaluateFidelity(target, next.construction);
      if (score.iou === null || score.iou <= currentRatio + EPSILON) break;
      construction = next.construction;
      optimization = next.optimization;
      fidelity = score;
    }
  }
  let smoothingReport: SmoothingReport | undefined;
  if (smoothing > 0) {
    orbits = enumerate(fidelity.iou ?? 1, true);
    const result = smoothConstruction(target, construction, orbits, smoothing, checkpoint);
    construction = result.construction;
    smoothingReport = result.report;
    limited ||= result.report.limited;
  }
  let connectivity = diagnoseConnectivity(construction);
  let smoothingAfterUnification: SmoothingReport | undefined;
  let unification: UnificationReport = {
    requested: Boolean(options.forceUnified),
    satisfied: connectivity.groups.length === 1,
    status: options.forceUnified ? 'satisfied' : 'not-requested',
    bridges: 0,
    replacements: 0,
    explored: 0,
  };
  if (options.forceUnified && connectivity.groups.length !== 1) {
    if (!orbits || smoothing > 0) orbits = enumerate();
    const result = unifyConstruction(target, construction, orbits, checkpoint, symmetry);
    construction = result.construction;
    unification = result.report;
    connectivity = diagnoseConnectivity(construction);
    if (smoothing > 0 && unification.satisfied && unification.bridges > 0) {
      const connectedRatio = evaluateFidelity(target, construction).iou ?? 1;
      const refined = smoothConstruction(target, construction, reweightOrbits(orbits, connectedRatio), smoothing, checkpoint, true);
      construction = refined.construction;
      smoothingAfterUnification = refined.report;
      limited ||= refined.report.limited;
      connectivity = diagnoseConnectivity(construction);
    }
  }
  if (!isSymmetricConstruction(construction, symmetry)) throw new Error('La construction ne respecte pas la symétrie demandée.');
  fidelity = evaluateFidelity(target, construction);
  options.checkpoint?.();
  return {
    construction,
    optimization: {
      ...optimization,
      objectiveStages: stages,
      totalFrontierStates,
      totalProposals,
      localSearchLimited: limited,
    },
    fidelity,
    counts: countPieceFamilies(construction.pieces),
    connectivity,
    controls: {
      symmetry,
      ...(smoothingReport ? { smoothing: smoothingReport } : {}),
      ...(smoothingAfterUnification ? { smoothingAfterUnification } : {}),
      unification,
    },
    ...(options.includeComparison ? { comparison: rasterizeComparison(target, construction, 12, options.checkpoint) } : {}),
  };
}

export function convertGeometrically(mask: BinaryMask, largestDimension: number, options: ConversionOptions): ConversionResult {
  validateAllowedFamilies(options.allowedFamilies);
  options.checkpoint?.();
  const target = prepareTarget(mask, largestDimension, options.checkpoint);
  const squareReference = options.allowedFamilies.every((type) => type === 'square_1x1')
    ? convertToSquares(mask, largestDimension) : null;
  return convertPreparedTarget(target, options, squareReference);
}
