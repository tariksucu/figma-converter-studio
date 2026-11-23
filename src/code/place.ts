/**
 * Where a placed file goes and how big it is: plain geometry, no Figma API (unit tested).
 *
 * A file goes into the selected frame (or the frame around the selected layer), centred and
 * scaled down to fit it; with no frame, onto the page in the middle of the view, within 80% of
 * what is on screen. It is never scaled up, and an image keeps its full resolution as the
 * layer's fill, so it stays sharp when the layer is enlarged later.
 */

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

/** How much of the visible canvas a file placed on the page may cover at most. */
export const VIEW_SHARE = 0.8;

const round = (value: number) => Math.round(value * 100) / 100;

/** How much `size` must shrink (never grow) to fit inside `max`, proportions kept. */
export function fitScale(size: Size, max: Size): number {
  const width = size.width > 0 ? size.width : 1;
  const height = size.height > 0 ? size.height : 1;
  return Math.min(
    1,
    max.width > 0 ? max.width / width : 1,
    max.height > 0 ? max.height / height : 1,
  );
}

/** `size` scaled down (never up) to fit inside `max`, proportions kept, at least 1 × 1. */
export function fitInside(size: Size, max: Size): Size {
  const scale = fitScale(size, max);
  const width = size.width > 0 ? size.width : 1;
  const height = size.height > 0 ? size.height : 1;
  return { width: Math.max(1, round(width * scale)), height: Math.max(1, round(height * scale)) };
}

/** The top-left corner that centres `size` in `box`. */
export function centerIn(box: Box, size: Size): { x: number; y: number } {
  return {
    x: round(box.x + (box.width - size.width) / 2),
    y: round(box.y + (box.height - size.height) / 2),
  };
}

/** The part of the visible canvas a file placed on the page may cover. */
export function viewArea(bounds: Box): Box {
  const width = bounds.width * VIEW_SHARE;
  const height = bounds.height * VIEW_SHARE;
  return {
    x: bounds.x + (bounds.width - width) / 2,
    y: bounds.y + (bounds.height - height) / 2,
    width,
    height,
  };
}
