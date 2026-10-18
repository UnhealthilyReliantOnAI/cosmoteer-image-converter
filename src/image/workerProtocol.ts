import type { AnalyzedSilhouette } from './analysis';

export interface ImageWorkerRequest {
  readonly file: Blob;
  readonly width: number;
  readonly height: number;
  readonly autoOrient?: boolean;
}

export type ImageWorkerResult = {
  readonly kind: 'success';
  readonly silhouette: AnalyzedSilhouette | null;
  readonly dimensions?: {
    width: number;
    height: number;
  };
}
  | {
  readonly kind: 'error';
  readonly message: string;
};
