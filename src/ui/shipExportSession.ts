import type { Construction } from '../construction/model';
import { downloadShipPng } from '../exports/downloadShipPng';
import { encodeShipPngInWorker } from '../exports/shipExportWorker';
import type { ShipExportDiagnostics, ShipExportStage } from '../exports/shipExportWorkerProtocol';

export interface DisplayedShipConstruction {
  /** Identity of the completed conversion, independent of selected settings/source. */
  readonly generation: object;
  readonly construction: Construction;
}

export interface ShipExportFailure {
  readonly code: string;
  readonly context: Readonly<Record<string, unknown>>;
}

export interface ShipExportSessionState {
  readonly status: 'idle' | 'running' | 'ready' | 'cancelled' | 'stale' | 'error';
  readonly generation: object | null;
  readonly stage: ShipExportStage | null;
  readonly diagnostics: ShipExportDiagnostics | null;
  readonly error: ShipExportFailure | null;
}

const initialState: ShipExportSessionState = {
  status: 'idle',
  generation: null,
  stage: null,
  diagnostics: null,
  error: null,
};

function failure(cause: unknown): ShipExportFailure {
  if (cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string') {
    return {
      code: cause.code,
      context: 'context' in cause && cause.context !== null
        && typeof cause.context === 'object' ? cause.context as Readonly<Record<string, unknown>> : {},
    };
  }
  return { code: 'E_EXPORT', context: {} };
}

/** Own a real snapshot, without JSON serialization or retaining image-source data. */
function snapshot(construction: Construction): Construction {
  const owned = structuredClone(construction);
  owned.pieces.forEach((piece) => {
    Object.freeze(piece.position);
    Object.freeze(piece);
  });
  Object.freeze(owned.pieces);
  return Object.freeze(owned);
}

/** UI-independent job ownership: late codecs/progress can never publish an old generation. */
export class ShipExportSession {
  private state: ShipExportSessionState = initialState;
  private readonly listeners = new Set<() => void>();
  private job = 0;
  private controller: AbortController | null = null;
  private ready: {
    png: Uint8Array;
    width: number;
    height: number;
  } | null = null;
  constructor(
    private readonly isCurrentGeneration: (generation: object) => boolean,
    private readonly encode = encodeShipPngInWorker,
    private readonly download = downloadShipPng,
  ) {}
  readonly getSnapshot = () => this.state;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(state: ShipExportSessionState) {
    this.state = state;
    this.listeners.forEach((listener) => listener());
  }
  private abort() {
    this.job++;
    this.controller?.abort();
    this.controller = null;
    this.ready = null;
  }
  previewChanged() {
    if (this.state.generation && !this.isCurrentGeneration(this.state.generation)) {
      this.abort();
      this.publish({ ...initialState, status: 'stale' });
    }
  }
  cancel() {
    if (this.state.status !== 'running') return;
    this.abort();
    this.publish({ ...this.state, status: 'cancelled', stage: null, diagnostics: null, error: null });
  }
  dispose() {
    this.abort();
  }
  async start(displayed: DisplayedShipConstruction): Promise<void> {
    this.previewChanged();
    if (this.state.status === 'running') return;
    if (!this.isCurrentGeneration(displayed.generation)) {
      this.previewChanged();
      return;
    }
    this.abort();
    const job = this.job;
    const { generation } = displayed;
    const controller = new AbortController();
    this.controller = controller;
    this.publish({ ...initialState, generation, status: 'running', stage: 'validate' });
    const current = () => job === this.job && !controller.signal.aborted && this.isCurrentGeneration(generation);
    try {
      const construction = snapshot(displayed.construction);
      const result = await this.encode(construction, {
        signal: controller.signal,
        onProgress: (stage) => {
          if (current()) this.publish({ ...this.state, stage });
        },
      });
      if (!current()) {
        this.previewChanged();
        return;
      }
      this.controller = null;
      this.ready = { png: result.png, width: construction.width, height: construction.height };
      this.publish({
        ...this.state,
        status: 'ready',
        stage: null,
        diagnostics: result.diagnostics,
        error: null,
      });
      this.downloadReady();
    } catch (cause) {
      if (!current()) {
        this.previewChanged();
        return;
      }
      this.controller = null;
      this.ready = null;
      const reason = failure(cause);
      const aborted = cause instanceof Error && cause.name === 'AbortError' || reason.code === 'E_EXPORT_ABORTED';
      this.publish({
        ...this.state,
        status: aborted ? 'cancelled' : 'error',
        stage: null,
        diagnostics: null,
        error: aborted ? null : reason,
      });
    }
  }

  /** A fresh click can retry browsers that block a download following async work. */
  downloadReady(): void {
    if (!this.ready || !this.state.generation) return;
    if (!this.isCurrentGeneration(this.state.generation)) {
      this.previewChanged();
      return;
    }
    try {
      this.download(this.ready.png, this.ready.width, this.ready.height);
      if (this.state.error?.code === 'E_DOWNLOAD') this.publish({ ...this.state, error: null });
    }
    catch {
      // Keep verified bytes so delivery can be retried without a new encoding.
      this.publish({ ...this.state, error: { code: 'E_DOWNLOAD', context: {} } });
    }
  }
}
