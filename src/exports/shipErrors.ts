export const ARMOR_EXPORT_ISSUE_CODES = [
  'incomplete',
  'dimensions',
  'id',
  'duplicate-id',
  'type',
  'rotation',
  'mirror',
  'position',
  'out-of-bounds',
  'overlap',
] as const;

export type ArmorExportIssueCode = typeof ARMOR_EXPORT_ISSUE_CODES[number];

export interface ArmorExportIssue {
  readonly code: ArmorExportIssueCode;
  /** Stable data path, independent of the UI language. */
  readonly path: string;
}

export class ArmorExportError extends Error {
  constructor(readonly issues: readonly ArmorExportIssue[]) {
    super(issues.map(({ code, path }) => `${path}: ${code}`).join('; '));
    this.name = 'ArmorExportError';
  }
}

/** Stable language-independent codes; the UI supplies localized explanations. */
export class ShipExportError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly context: Readonly<Record<string, unknown>> = {}
  ) {
    super(message);
    this.name = 'ShipExportError';
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ShipExportError('E_EXPORT_ABORTED', 'Ship export cancelled.');
}
