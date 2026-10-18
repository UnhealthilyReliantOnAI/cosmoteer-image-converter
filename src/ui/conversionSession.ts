import { ALL_PIECE_TYPES } from '../catalog/pieces';
import type { PieceType } from '../catalog/pieces';
import type { ConversionResult, ConversionSettings } from '../conversion/types';
import { convertInWorker } from '../conversion/worker';
import type { ConversionRequest } from '../conversion/workerProtocol';

/** Empty UI selections are allowed; attempting to convert them remains an explicit engine error. */
export function toggleFamily(families: readonly PieceType[], type: PieceType): readonly PieceType[] {
  if (!ALL_PIECE_TYPES.includes(type) || families.some((entry) => !ALL_PIECE_TYPES.includes(entry))) {
    throw new Error('Famille de pièces inconnue.');
  }
  const selected = ALL_PIECE_TYPES.filter((entry) => families.includes(entry));
  const next = selected.includes(type)
    ? selected.filter((entry) => entry !== type)
    : [...selected, type];
  return ALL_PIECE_TYPES.filter((entry) => next.includes(entry));
}

export interface CompletedConversion {
  readonly result: ConversionResult;
  readonly settings: ConversionSettings;
  readonly sourceName: string;
  readonly sourceId: number;
}

export interface ConversionSessionState {
  readonly last: CompletedConversion | null;
  readonly processing: boolean;
  readonly status: 'idle' | 'running' | 'cancelled' | 'error';
  readonly error: string | null;
}

const initialState: ConversionSessionState = { last: null, processing: false, status: 'idle', error: null };

export function sameSettings(a: ConversionSettings, b: ConversionSettings): boolean {
  return a.largestDimension === b.largestDimension && (a.smoothing ?? 0) === (b.smoothing ?? 0)
    && (a.symmetry ?? 'none') === (b.symmetry ?? 'none') && !!a.forceUnified === !!b.forceUnified
    && a.allowedFamilies.length === b.allowedFamilies.length
    && a.allowedFamilies.every((family) => b.allowedFamilies.includes(family));
}

/** UI orchestration only: keep the last successful result while replacing isolated tasks. */
export class ConversionSession {
  private state: ConversionSessionState = initialState;
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private controller: AbortController | null = null;
  constructor(private readonly convert = convertInWorker) {}
  readonly getSnapshot = () => this.state;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(state: ConversionSessionState) {
    this.state = state;
    this.listeners.forEach((listener) => listener());
  }
  private abort() {
    this.generation++;
    this.controller?.abort();
    this.controller = null;
  }
  cancel() {
    if (!this.state.processing) return;
    this.abort();
    this.publish({ ...this.state, processing: false, status: 'cancelled', error: null });
  }
  settingsChanged() {
    if (this.state.processing) this.cancel();
    else this.publish({ ...this.state, status: 'idle', error: null });
  }
  replaceSource() {
    this.abort();
    this.publish({ ...this.state, processing: false, status: 'idle', error: null });
  }
  dispose() {
    this.abort();
  }
  async start(
    request: ConversionRequest,
    source: {
      readonly id: number;
      readonly name: string;
    }
  ): Promise<void> {
    this.abort();
    const generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    // Own the family list so later changes cannot relabel an in-flight request or its result.
    const settings: ConversionSettings = {
      largestDimension: request.largestDimension,
      allowedFamilies: [...request.allowedFamilies],
      smoothing: request.smoothing ?? 0,
      symmetry: request.symmetry ?? 'none',
      forceUnified: request.forceUnified ?? false,
    };
    const { id: sourceId, name: sourceName } = source;
    this.publish({ ...this.state, processing: true, status: 'running', error: null });
    try {
      const result = await this.convert({ mask: request.mask, ...settings }, controller.signal);
      if (generation !== this.generation) return;
      this.controller = null;
      this.publish({
        last: { result, settings, sourceName, sourceId },
        processing: false,
        status: 'idle',
        error: null,
      });
    } catch (cause) {
      if (generation !== this.generation) return;
      this.controller = null;
      this.publish({
        ...this.state,
        processing: false,
        status: cause instanceof Error && cause.name === 'AbortError' ? 'cancelled' : 'error',
        error: cause instanceof Error && cause.name !== 'AbortError' ? cause.message : null,
      });
    }
  }
}
