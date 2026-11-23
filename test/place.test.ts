import { describe, expect, it } from 'vitest';
import { VIEW_SHARE, centerIn, fitInside, fitScale, viewArea } from '../src/code/place';

describe('where a placed file goes', () => {
  it('scales down to fit, never up', () => {
    expect(fitScale({ width: 400, height: 200 }, { width: 100, height: 100 })).toBe(0.25);
    expect(fitScale({ width: 50, height: 50 }, { width: 100, height: 100 })).toBe(1);
    expect(fitInside({ width: 400, height: 200 }, { width: 100, height: 100 })).toEqual({
      width: 100,
      height: 50,
    });
    expect(fitInside({ width: 0, height: 0 }, { width: 10, height: 10 })).toEqual({
      width: 1,
      height: 1,
    });
  });

  it('centres in a box and keeps to most of the view', () => {
    expect(centerIn({ x: 10, y: 20, width: 100, height: 50 }, { width: 40, height: 10 })).toEqual({
      x: 40,
      y: 40,
    });
    expect(viewArea({ x: 0, y: 0, width: 1000, height: 500 })).toEqual({
      x: 100,
      y: 50,
      width: 1000 * VIEW_SHARE,
      height: 500 * VIEW_SHARE,
    });
  });
});
