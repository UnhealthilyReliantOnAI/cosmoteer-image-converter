import type { PieceDefinition } from '../catalog/pieces';

export function ShapeIcon({ piece }: {
    piece: PieceDefinition;
  }) {
  return <svg
    viewBox={`-0.2 -0.2 ${piece.footprint.width + 0.4} ${piece.footprint.height + 0.4}`}
    aria-hidden="true"
    className="shape-icon"
  >
    <rect
      width={piece.footprint.width}
      height={piece.footprint.height}
      fill="none"
      stroke="currentColor"
      strokeWidth="0.035"
      strokeDasharray="0.1 0.1"
      opacity="0.4"
    />
    <polygon points={piece.polygon.map(({ x, y }) => `${x},${y}`).join(' ')} fill="currentColor" />
  </svg>;
}
