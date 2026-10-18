import type { Construction } from '../construction/model';

export const SHIP_EXPORT_STAGES = ['validate', 'serialize', 'gzip', 'thumbnail', 'embed', 'png', 'verify'] as const;

export type ShipExportStage = typeof SHIP_EXPORT_STAGES[number];

export interface ShipExportDiagnostics {
  readonly partsCount: number;
  readonly plainBytes: number;
  readonly gzipBytes: number;
  readonly containerBytes: number;
  readonly capacityBytes: number;
  readonly profileId: string;
  readonly thumbnailMode: 'construction' | 'neutral';
  readonly durations: Readonly<Record<ShipExportStage, number>>;
}

export interface ShipPngResult {
  readonly png: Uint8Array;
  readonly diagnostics: ShipExportDiagnostics;
}

/** Each local Worker owns exactly one export, so its lifetime is its job identity. */
export interface ShipExportWorkerRequest {
  readonly kind: 'encode';
  readonly construction: Construction;
}

export type ShipExportWorkerResponse =
  | {
  readonly kind: 'progress';
  readonly stage: ShipExportStage;
}
  | {
  readonly kind: 'success';
  readonly result: ShipPngResult;
}
  | {
  readonly kind: 'failure';
  readonly code: string;
  readonly message: string;
  readonly context: Readonly<Record<string, unknown>>;
};
