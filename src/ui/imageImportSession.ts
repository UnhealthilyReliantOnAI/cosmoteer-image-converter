import type { AnalyzedSilhouette } from '../image/analysis';
import { loadImage } from '../image/load';

export interface ImportedSilhouette extends AnalyzedSilhouette {
  /** Unique within this session, including repeated imports with the same filename. */
  readonly id: number;
  readonly name: string;
  readonly previewUrl: string;
  readonly originalWidth: number;
  readonly originalHeight: number;
}

export interface ImageImportState {
  readonly source: ImportedSilhouette | null;
  readonly loading: boolean;
  readonly error: string | null;
}

const initialState: ImageImportState = { source: null, loading: false, error: null };

/** Commit a replacement only after successful decoding; own exactly one valid source URL. */
export class ImageImportSession {
  private state: ImageImportState = initialState;
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private nextSourceId = 0;
  private controller: AbortController | null = null;
  constructor(
    private readonly load = loadImage,
    private readonly revoke = (url: string) => URL.revokeObjectURL(url)
  ) {}
  readonly getSnapshot = () => this.state;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(state: ImageImportState) {
    this.state = state;
    this.listeners.forEach((listener) => listener());
  }
  private abort() {
    this.generation++;
    this.controller?.abort();
    this.controller = null;
  }
  clearError() {
    if (this.state.error !== null) this.publish({ ...this.state, error: null });
  }
  async start(file: File): Promise<void> {
    this.abort();
    const generation = this.generation;
    const sourceId = ++this.nextSourceId;
    const controller = new AbortController();
    this.controller = controller;
    this.publish({ ...this.state, loading: true, error: null });
    let loadedUrl: string | null = null;
    try {
      const loaded = await this.load(file, controller.signal);
      loadedUrl = loaded.previewUrl;
      if (generation !== this.generation) {
        this.revoke(loadedUrl);
        return;
      }
      if (!loaded.silhouette) throw new Error('empty-silhouette');
      const previous = this.state.source;
      const source: ImportedSilhouette = {
        ...loaded.silhouette,
        id: sourceId,
        name: file.name,
        previewUrl: loadedUrl,
        originalWidth: loaded.width,
        originalHeight: loaded.height,
      };
      this.controller = null;
      this.publish({ source, loading: false, error: null });
      loadedUrl = null; // Ownership has moved to the current source.
      if (previous) this.revoke(previous.previewUrl);
    } catch (cause) {
      if (loadedUrl) this.revoke(loadedUrl);
      if (generation !== this.generation) return;
      this.controller = null;
      this.publish({ ...this.state, loading: false, error: cause instanceof Error ? cause.message : '' });
    }
  }
  dispose() {
    this.abort();
    if (this.state.source) this.revoke(this.state.source.previewUrl);
    this.state = initialState;
  }
}
