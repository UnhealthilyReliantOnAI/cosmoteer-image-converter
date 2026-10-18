import { isValidConstruction } from '../construction/model';
import type { Construction } from '../construction/model';
import { getPieceTemplate, getPieceTemplates } from './fidelity';
import type { CoverageTarget } from './target';

export interface ComparisonRaster {
  readonly width: number;
  readonly height: number;
  readonly resolution: number;
  /** Local coverage encoded as 0..255; independent of preview colours. */
  readonly target: Uint8Array;
  readonly generated: Uint8Array;
  /** Intersection evaluated on the same fine samples as the IoU, then reduced for display. */
  readonly intersection: Uint8Array;
}

/** A bounded, reusable raster for inspection and independent contour measurements. */
export function rasterizeComparison(
  target: CoverageTarget,
  construction: Construction,
  resolution = 12,
  checkpoint: () => void = () => {}
): ComparisonRaster {
  if (!Number.isSafeInteger(resolution) || resolution < 1 || target.resolution % resolution !== 0) {
    throw new Error('Résolution de diagnostic incompatible.');
  }
  if (target.width !== construction.width || target.height !== construction.height || !isValidConstruction(construction)) {
    throw new Error('Construction invalide pour le diagnostic de surface.');
  }
  const ratio = target.resolution / resolution;
  const width = target.width * resolution;
  const height = target.height * resolution;
  const sourceWidth = target.width * target.resolution;
  const coverage = new Uint8Array(width * height);
  const generated = new Uint8Array(width * height);
  const intersection = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    if (y % resolution === 0) checkpoint();
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      for (let dy = 0; dy < ratio; dy += 1) {
        const row = (y * ratio + dy) * sourceWidth + x * ratio;
        for (let dx = 0; dx < ratio; dx += 1) sum += target.fractions[row + dx]!;
      }
      coverage[y * width + x] = Math.round(255 * sum / (ratio * ratio));
    }
  }
  const templates = getPieceTemplates(resolution);
  const fineTemplates = getPieceTemplates(target.resolution);
  const cellIntersection = new Float64Array(resolution * resolution);
  for (const piece of construction.pieces) {
    checkpoint();
    const template = getPieceTemplate(templates, piece);
    const fine = getPieceTemplate(fineTemplates, template);
    for (let c = 0; c < template.cells.length; c += 1) {
      const cell = template.cells[c]!;
      const fineCell = fine.cells[c]!;
      cellIntersection.fill(0);
      for (let sy = 0; sy < target.resolution; sy += 1) {
        const row = ((piece.position.y + cell.y) * target.resolution + sy) * sourceWidth
          + (piece.position.x + cell.x) * target.resolution;
        const reducedRow = Math.floor(sy / ratio) * resolution;
        for (let sx = 0; sx < target.resolution; sx += 1) {
          cellIntersection[reducedRow + Math.floor(sx / ratio)]! += target.fractions[row + sx]!
           * fineCell.weights[sy * target.resolution + sx]!;
        }
      }
      for (let y = 0; y < resolution; y += 1) {
        const row = ((piece.position.y + cell.y) * resolution + y) * width
          + (piece.position.x + cell.x) * resolution;
        for (let x = 0; x < resolution; x += 1) {
          generated[row + x] = Math.round(255 * cell.weights[y * resolution + x]!);
          intersection[row + x] = Math.round(255 * cellIntersection[y * resolution + x]! / (ratio * ratio));
        }
      }
    }
  }
  return { width, height, resolution, target: coverage, generated, intersection };
}

/** Material samples touching empty space or the raster boundary, using four neighbors. */
export function boundaryMask(data: Uint8Array, width: number, height: number): Uint8Array {
  return Uint8Array.from(data, (value, i) => {
    if (value < 128) return 0;
    const x = i % width;
    const y = Math.floor(i / width);
    return x === 0 || y === 0 || x === width - 1 || y === height - 1
      || data[i - 1]! < 128 || data[i + 1]! < 128 || data[i - width]! < 128 || data[i + width]! < 128 ? 1 : 0;
  });
}

/** Two directional sweeps with horizontal/vertical/diagonal costs; distances are approximate. */
export function boundaryDistances(seeds: Uint8Array, width: number, height: number): Float32Array {
  const distances = Float32Array.from(seeds, (value) => value ? 0 : width + height);
  const diagonal = Math.SQRT2;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      let d = distances[i]!;
      if (x > 0) d = Math.min(d, distances[i - 1]! + 1);
      if (y > 0) {
        d = Math.min(d, distances[i - width]! + 1);
        if (x > 0) d = Math.min(d, distances[i - width - 1]! + diagonal);
        if (x + 1 < width) d = Math.min(d, distances[i - width + 1]! + diagonal);
      }
      distances[i] = d;
    }
  }
  for (let y = height - 1; y >= 0; y -= 1) {
    for (let x = width - 1; x >= 0; x -= 1) {
      const i = y * width + x;
      let d = distances[i]!;
      if (x + 1 < width) d = Math.min(d, distances[i + 1]! + 1);
      if (y + 1 < height) {
        d = Math.min(d, distances[i + width]! + 1);
        if (x > 0) d = Math.min(d, distances[i + width - 1]! + diagonal);
        if (x + 1 < width) d = Math.min(d, distances[i + width + 1]! + diagonal);
      }
      distances[i] = d;
    }
  }
  return distances;
}

export interface ContourMetrics {
  readonly meanDistance: number | null;
  readonly p95Distance: number | null;
  readonly farMissingArea: number;
  readonly farExcessArea: number;
}

/** Symmetric contour distances in grid cells, plus errors farther than half a cell from the target edge. */
export function measureContours(raster: ComparisonRaster): ContourMetrics {
  const { width, height, resolution, target, generated } = raster;
  const a = boundaryMask(target, width, height);
  const b = boundaryMask(generated, width, height);
  const hasBothContours = a.some(Boolean) && b.some(Boolean);
  const da = boundaryDistances(a, width, height);
  const db = boundaryDistances(b, width, height);
  const errors: number[] = [];
  let farMissingArea = 0;
  let farExcessArea = 0;
  for (let i = 0; i < target.length; i += 1) {
    if (hasBothContours && a[i]) errors.push(db[i]! / resolution);
    if (hasBothContours && b[i]) errors.push(da[i]! / resolution);
    if (da[i]! > resolution / 2) {
      farMissingArea += Math.max(0, target[i]! - generated[i]!) / (255 * resolution ** 2);
      farExcessArea += Math.max(0, generated[i]! - target[i]!) / (255 * resolution ** 2);
    }
  }
  errors.sort((x, y) => x - y);
  return {
    meanDistance: errors.length ? errors.reduce((sum, value) => sum + value, 0) / errors.length : null,
    p95Distance: errors.length ? errors[Math.floor((errors.length - 1) * 0.95)]! : null,
    farMissingArea,
    farExcessArea,
  };
}
