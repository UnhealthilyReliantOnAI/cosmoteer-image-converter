import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useI18n } from '../ui/i18n';
import { DEFAULT_VIEW, zoomView } from './viewport';

interface InteractivePreviewProps {
  readonly children: ReactNode;
  readonly revision: object | undefined;
  readonly busy?: boolean;
}

/** Navigation changes only this wrapper. The construction and conversion are untouched. */
export function InteractivePreview({ children, revision, busy = false }: InteractivePreviewProps) {
  const { t, number } = useI18n();
  const [view, setView] = useState(DEFAULT_VIEW);
  const stage = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    id: number;
    x: number;
    y: number;
  } | null>(null);
  useEffect(() => {
    setView(DEFAULT_VIEW);
  }, [revision]);
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (!revision) return;
      event.preventDefault();
      const box = element.getBoundingClientRect();
      const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? box.height : 1);
      setView((old) => zoomView(old, Math.exp(-Math.max(-1000, Math.min(1000, pixels)) * 0.002), {
        x: event.clientX - box.left - box.width / 2,
        y: event.clientY - box.top - box.height / 2,
      }));
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [revision]);
  const reset = () => setView(DEFAULT_VIEW);
  return <>
  <div className="view-toolbar" role="group" aria-label={t('navigation')}>
    <button
      type="button"
      aria-label={t('zoomOut')}
      title={t('zoomOut')}
      disabled={!revision || view.zoom <= 0.5}
      onClick={() => setView((old) => zoomView(old, 1 / 1.25))}
    >−</button>
    <output aria-live="polite">{number(view.zoom * 100)}%</output>
    <button
      type="button"
      aria-label={t('zoomIn')}
      title={t('zoomIn')}
      disabled={!revision || view.zoom >= 16}
      onClick={() => setView((old) => zoomView(old, 1.25))}
    >+</button>
    <button type="button" disabled={!revision} onClick={reset}>{t('fit')}</button>
  </div>
  <div
    ref={stage}
    className={`interactive-stage${revision ? ' has-result' : ''}${busy ? ' processing' : ''}`}
    tabIndex={0}
    aria-busy={busy}
    role="region"
    aria-label={t('navigation')}
    aria-describedby="navigation-help"
    onPointerDown={(event) => {
      if (!revision || event.button !== 0 || event.pointerType === 'touch') return;
      event.currentTarget.focus();
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
    }}
    onPointerMove={(event) => {
      const start = drag.current;
      if (!start || start.id !== event.pointerId) return;
      const dx = event.clientX - start.x, dy = event.clientY - start.y;
      drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
      setView((old) => ({ ...old, x: old.x + dx, y: old.y + dy }));
    }}
    onPointerUp={() => {
      drag.current = null;
    }}
    onPointerCancel={() => {
      drag.current = null;
    }}
    onLostPointerCapture={() => {
      drag.current = null;
    }}
    onKeyDown={(event) => {
      if (!revision) return;
      if (event.key === '+' || event.key === '=') setView((old) => zoomView(old, 1.25));
      else if (event.key === '-') setView((old) => zoomView(old, 1 / 1.25));
      else if (event.key === '0' || event.key === 'Home') reset();
      else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
        setView((old) => ({
          ...old,
          x: old.x + (event.key === 'ArrowLeft' ? 40 : event.key === 'ArrowRight' ? -40 : 0),
          y: old.y + (event.key === 'ArrowUp' ? 40 : event.key === 'ArrowDown' ? -40 : 0),
        }));
      } else return;
      event.preventDefault();
    }}
  >
    <div
      className="viewport-content"
      style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}
    >{children}</div>
    {busy && <div className="preview-processing" aria-hidden="true">
      <span className="processing-dot" />
      {t('converting')}
    </div>}
  </div>
  <p id="navigation-help" className="navigation-help">{t('navigationHelp')}</p>
  </>;
}
