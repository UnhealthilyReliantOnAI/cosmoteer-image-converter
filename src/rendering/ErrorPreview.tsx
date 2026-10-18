import { useEffect, useRef } from 'react';
import type { ComparisonRaster } from '../conversion/diagnostics';

interface ErrorPreviewProps {
  readonly raster: ComparisonRaster;
  readonly label?: string;
}

/** Fractional coverages retain fine diagonals; colours show both kinds of area error separately. */
export function ErrorPreview({ raster, label = 'Écarts : rose manquant, orange ajouté à tort' }: ErrorPreviewProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const context = canvas.current?.getContext('2d');
    if (!context) return;
    const pixels = new ImageData(raster.width, raster.height);
    for (let i = 0; i < raster.target.length; i += 1) {
      const source = raster.target[i]! / 255;
      const generated = raster.generated[i]! / 255;
      const intersection = Math.min(source, generated, raster.intersection[i]! / 255);
      const missing = source - intersection;
      const excess = generated - intersection;
      const error = missing + excess;
      pixels.data[i * 4] = 255;
      pixels.data[i * 4 + 1] = error ? Math.round((80 * missing + 177 * excess) / error) : 0;
      pixels.data[i * 4 + 2] = error ? Math.round((151 * missing + 53 * excess) / error) : 0;
      pixels.data[i * 4 + 3] = Math.round(255 * Math.min(1, error) * 0.85);
    }
    context.putImageData(pixels, 0, 0);
  }, [raster]);
  return <canvas
    ref={canvas}
    width={raster.width}
    height={raster.height}
    className="error-preview"
    role="img"
    aria-label={label}
    style={{ width: '100%', height: '100%', display: 'block' }}
  />;
}
