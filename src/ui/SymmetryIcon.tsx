import type { SymmetryMode } from '../construction/symmetry';

export function SymmetryIcon({ mode }: {
    mode: SymmetryMode;
  }) {
  return <svg viewBox="0 0 40 40" aria-hidden="true" className="symmetry-icon">
    <path
      d="M20 4 24 15 33 27 26 26 24 35 20 31 16 35 14 26 7 27 16 15Z"
      fill="currentColor"
      opacity="0.65"
    />
    {mode !== 'none' && <path
      d={mode === 'vertical' ? 'M20 1V39' : 'M1 20H39'}
      className="symmetry-axis"
      fill="none"
      strokeWidth="2.5"
      strokeDasharray="4 3"
    />}
  </svg>;
}
