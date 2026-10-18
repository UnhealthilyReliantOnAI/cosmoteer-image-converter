import { memo, useId } from 'react';
import { getPiece } from '../catalog/pieces';
import type { PieceType } from '../catalog/pieces';
import { getPlacedFootprint, getPlacedPolygon } from '../construction/model';
import type { Construction } from '../construction/model';
import type { ComparisonRaster } from '../conversion/diagnostics';
import { ErrorPreview } from './ErrorPreview';
import { polygonPath } from './paths';

const PIECE_COLORS: Record<PieceType, string> = {
  square_1x1: '#7db9ff',
  wedge_1x1: '#62d8bf',
  wedge_1x2: '#b9a0ff',
  wedge_1x3: '#f5bf73',
  small_triangle: '#ff99b8',
};

interface GridPreviewProps {
  readonly construction: Construction;
  readonly label: string;
  readonly showBounds?: boolean;
  readonly colorMode?: 'uniform' | 'families';
  readonly showOutlines?: boolean;
  readonly highlightedPieceIds?: ReadonlySet<string>;
  readonly showGrid?: boolean;
  readonly comparison?: ComparisonRaster;
  readonly pieceName?: (type: PieceType) => string;
  readonly mirrorLabel?: string;
  readonly errorsLabel?: string;
}

export const GridPreview = memo(function GridPreview({ construction, label, showBounds = false, colorMode = 'families', showOutlines = true,
  highlightedPieceIds, showGrid = true, comparison, pieceName, mirrorLabel = 'miroir', errorsLabel }: GridPreviewProps) {
  const gridId = useId();
  const titleId = useId();
  const { width, height, pieces } = construction;
  const colorFor = (id: string, type: PieceType) => highlightedPieceIds?.has(id) ? '#ff5097'
    : colorMode === 'uniform' ? '#b9d8f5' : PIECE_COLORS[type];
  const fills = new Map<string, string[]>();
  for (const placement of pieces) {
    const color = colorFor(placement.id, placement.type);
    const paths = fills.get(color) ?? [];
    paths.push(polygonPath(getPlacedPolygon(placement)));
    fills.set(color, paths);
  }
  return (
    <svg
      className="grid-preview"
      viewBox={`-0.15 -0.15 ${width + 0.3} ${height + 0.3}`}
      role="img"
      aria-labelledby={titleId}
    >
      <title id={titleId}>{label}</title>
      <defs>
        <pattern id={gridId} width="1" height="1" patternUnits="userSpaceOnUse">
          <path d="M 1 0 H 0 V 1" fill="none" stroke="#41506a" strokeWidth="0.025" />
        </pattern>
      </defs>
      <rect width={width} height={height} fill="#101827" />
      {[...fills].map(([color, paths]) => <path key={color} d={paths.join(' ')} fill={color} />)}
      {comparison && <foreignObject x="0" y="0" width={width} height={height} pointerEvents="none" data-layer="errors">
        <ErrorPreview raster={comparison} {...(errorsLabel ? { label: errorsLabel } : {})} />
      </foreignObject>}
      {showGrid && <rect
        width={width}
        height={height}
        fill={`url(#${gridId})`}
        stroke="#62748e"
        strokeWidth="0.035"
        pointerEvents="none"
        data-layer="grid"
      />}
      {pieces.map((placement) => {
        const polygon = getPlacedPolygon(placement);
        const footprint = getPlacedFootprint(placement);
        const piece = getPiece(placement.type);
        return (
          <g key={placement.id}>
            <polygon
              points={polygon.map(({ x, y }) => `${x},${y}`).join(' ')}
              fill="transparent"
              stroke={highlightedPieceIds?.has(placement.id) ? '#ff5097' : showOutlines ? '#26354a' : 'none'}
              strokeWidth={highlightedPieceIds?.has(placement.id) ? '0.07' : '0.035'}
              strokeLinejoin="round"
            >
              <title>{`${pieceName ? pieceName(piece.type) : piece.name} · ${placement.rotation}°${placement.mirrored ? ` · ${mirrorLabel}` : ''} · (${placement.position.x}, ${placement.position.y})`}</title>
            </polygon>
            {showBounds && (
            <rect
              x={placement.position.x}
              y={placement.position.y}
              width={footprint.width}
              height={footprint.height}
              fill="none"
              stroke="#e8edf5"
              strokeWidth="0.025"
              strokeDasharray="0.1 0.08"
            />
            )}
          </g>
        );
      })}
    </svg>
  );
});
