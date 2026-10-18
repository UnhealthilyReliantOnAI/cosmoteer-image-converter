import type { BinaryMask } from '../image/analysis';
import type { ConversionResult, ConversionSettings } from './types';

export interface ConversionRequest extends ConversionSettings {
  readonly mask: BinaryMask;
}

export type ConversionResponse = {
  readonly kind: 'success';
  readonly result: ConversionResult;
}
  | {
  readonly kind: 'error';
  readonly message: string;
};
