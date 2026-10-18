import { boundaryMask, boundaryDistances, rasterizeComparison } from './diagnostics';
import { getPieceTemplate, getPieceTemplates, measureIntersection } from './fidelity';
import type { PieceTemplate } from './fidelity';
import type { CoverageTarget } from './target';

/** Scoped to a target: compact caches survive repeated search stages, then become collectible. */
export function createObjective(target: CoverageTarget, checkpoint: () => void) {
  const intersections = new Map<PieceTemplate, Float64Array>();
  let contour: {
    fractions: Uint8Array;
    distances: Float32Array;
    width: number;
  } | null = null;
  const contourGains = new Map<PieceTemplate, Float64Array>();

  function cached(
    cache: Map<PieceTemplate, Float64Array>,
    template: PieceTemplate,
    x: number,
    y: number,
    calculate: () => number
  ): number {
    let values = cache.get(template);
    if (!values) {
      values = new Float64Array(target.width * target.height).fill(NaN);
      cache.set(template, values);
    }
    const index = y * target.width + x;
    if (Number.isNaN(values[index])) values[index] = calculate();
    return values[index]!;
  }

  function intersection(template: PieceTemplate, x: number, y: number) {
    return cached(intersections, template, x, y, () => measureIntersection(target, template, x, y));
  }

  function contourGain(template: PieceTemplate, x: number, y: number) {
    return cached(contourGains, template, x, y, () => {
      if (!contour) {
        const raster = rasterizeComparison(target, { width: target.width, height: target.height, pieces: [] }, 12, checkpoint);
        const { width, height, target: fractions } = raster;
        const seeds = boundaryMask(fractions, width, height);
        contour = { fractions, width, distances: boundaryDistances(seeds, width, height) };
      }
      const coarse = getPieceTemplate(getPieceTemplates(12), template);
      let sum = 0;
      for (const cell of coarse.cells) {
        for (let sy = 0; sy < 12; sy += 1) {
          const row = ((y + cell.y) * 12 + sy) * contour.width + (x + cell.x) * 12;
          for (let sx = 0; sx < 12; sx += 1) {
            const i = row + sx;
            sum += (2 * contour.fractions[i]! / 255 - 1) * Math.min(1, contour.distances[i]! / 12)
             * cell.weights[sy * 12 + sx]!;
          }
        }
      }
      return sum / 144;
    });
  }

  function gain(template: PieceTemplate, x: number, y: number, ratio = 1, contourWeight = 0): number {
    return (1 + ratio) * intersection(template, x, y) - ratio * template.area
      + (contourWeight ? contourWeight * contourGain(template, x, y) : 0);
  }

  return { gain };
}

export type SurfaceObjective = ReturnType<typeof createObjective>;
