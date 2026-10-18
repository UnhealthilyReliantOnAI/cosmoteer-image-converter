export interface Viewport {
  readonly zoom: number;
  readonly x: number;
  readonly y: number;
}

export const DEFAULT_VIEW: Viewport = { zoom: 1, x: 0, y: 0 };

export function zoomView(view: Viewport, factor: number, anchor = { x: 0, y: 0 }): Viewport {
  const zoom = Math.max(0.5, Math.min(16, view.zoom * factor));
  const ratio = zoom / view.zoom;
  return {
    zoom,
    x: anchor.x - (anchor.x - view.x) * ratio,
    y: anchor.y - (anchor.y - view.y) * ratio,
  };
}
