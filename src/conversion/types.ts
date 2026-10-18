import type { PieceType } from '../catalog/pieces';
import type { ConnectivityDiagnostic } from '../construction/connectivity';
import type { Construction } from '../construction/model';
import type { SymmetryMode } from '../construction/symmetry';
import type { ComparisonRaster } from './diagnostics';
import type { Fidelity } from './fidelity';
import type { SmoothingReport } from './smoothing';
import type { UnificationReport } from './unification';

export interface ConversionControls {
  readonly allowedFamilies: readonly PieceType[];
  readonly smoothing?: number;
  readonly symmetry?: SymmetryMode;
  readonly forceUnified?: boolean;
}

export interface ConversionSettings extends ConversionControls {
  readonly largestDimension: number;
}

export interface ConversionOptions extends ConversionControls {
  /** Pure engine checkpoint; the browser adapter also terminates its Worker immediately. */
  readonly checkpoint?: () => void;
  /** Deterministic quality budget, bounded by the standard maximum. Zero permits a greedy comparison. */
  readonly maxLocalPasses?: number;
  /** Experimental engine-level contour penalty; zero by default, never applied to the square reference. */
  readonly contourWeight?: number;
  readonly includeComparison?: boolean;
}

export interface OptimizationStats {
  readonly candidates: number;
  readonly passes: number;
  readonly proposals: number;
  readonly localSearchLimited: boolean;
  readonly localExchanges: number;
  readonly localAreaImprovement: number;
  readonly frontierStates?: number;
  readonly conflictComponents?: number;
  readonly exactComponents?: number;
  readonly objectiveStages?: number;
  readonly totalFrontierStates?: number;
  readonly totalProposals?: number;
  readonly localObjectiveImprovement?: number;
}

export interface ConversionResult {
  readonly construction: Construction;
  readonly fidelity: Fidelity;
  readonly counts: Record<PieceType, number>;
  readonly optimization: OptimizationStats;
  readonly connectivity: ConnectivityDiagnostic;
  readonly comparison?: ComparisonRaster;
  readonly controls: {
    readonly symmetry: SymmetryMode;
    readonly smoothing?: SmoothingReport;
    readonly smoothingAfterUnification?: SmoothingReport;
    readonly unification: UnificationReport;
  };
}
