import { describe, expect, it } from 'vitest';
import { fitUnder, steps } from '../src/ui/fit';

/** An encoder whose file size is `size(setting)` bytes; it counts what it made. */
function encoder(size: (setting: number) => number) {
  const made: number[] = [];
  return {
    made,
    encode: async (setting: number) => {
      made.push(setting);
      return new Blob([new Uint8Array(size(setting))]);
    },
  };
}

/** JPEG-like: the file grows with the quality, faster near the top. */
const jpegLike = (quality: number) => Math.round(2000 + 40 * quality + 0.02 * quality ** 3);

describe('the size search ("at most … KB")', () => {
  it('keeps the first setting when it fits, after one file', async () => {
    const { made, encode } = encoder(jpegLike);
    const fitted = await fitUnder(steps(90, 10), 1_000_000, encode);
    expect(fitted).toMatchObject({ setting: 90, fits: true, tries: 1 });
    expect(made).toEqual([90]);
  });

  it('finds the highest quality that fits, in at most 9 files for 86 qualities', async () => {
    const qualities = steps(90, 5);
    expect(qualities).toHaveLength(86);
    for (const limit of [2500, 4000, 5000, 7777, 10_000, 15_000, 18_500]) {
      const { made, encode } = encoder(jpegLike);
      const fitted = await fitUnder(qualities, limit, encode);
      // The best: the highest quality whose size is within the limit.
      const best = qualities.find((q) => jpegLike(q) <= limit)!;
      expect(fitted, `limit ${limit}`).toMatchObject({ setting: best, fits: true });
      expect(fitted.blob.size).toBeLessThanOrEqual(limit);
      expect(jpegLike(best + 1)).toBeGreaterThan(limit);
      expect(made.length, `limit ${limit}`).toBeLessThanOrEqual(9);
      expect(new Set(made).size).toBe(made.length);
    }
  });

  it('cannot reach the size: the smallest file, marked as not fitting', async () => {
    const { made, encode } = encoder(jpegLike);
    const fitted = await fitUnder(steps(80, 10), 1000, encode);
    expect(fitted).toMatchObject({ setting: 10, fits: false, tries: 2 });
    expect(fitted.blob.size).toBe(jpegLike(10));
    expect(made).toEqual([80, 10]);
  });

  it('sizes that do not fall evenly: what it returns still fits', async () => {
    // A bump: 60 is larger than 61.
    const bumpy = (q: number) => (q === 60 ? 9000 : q * 100);
    const { encode } = encoder(bumpy);
    for (const limit of [5000, 6050, 6100, 8999]) {
      const fitted = await fitUnder(steps(90, 10), limit, encode);
      expect(fitted.fits).toBe(true);
      expect(fitted.blob.size).toBeLessThanOrEqual(limit);
    }
  });

  it('not fitting with uneven sizes: the smallest file made, whichever setting made it', async () => {
    // The last setting is not the smallest.
    const sizes = new Map([
      [256, 9000],
      [128, 7000],
      [2, 8000],
    ]);
    const { encode } = encoder((count) => sizes.get(count) ?? 9999);
    const fitted = await fitUnder([256, 128, 2], 100, encode);
    // 256 and 2 were made (the ends); 128 was not needed to know that nothing fits.
    expect(fitted).toMatchObject({ setting: 2, fits: false, tries: 2 });
  });

  it('works through palettes as well as qualities', async () => {
    const colours = [256, 192, 128, 96, 64, 48, 32, 24, 16, 12, 8, 4, 2];
    const { encode } = encoder((count) => 1000 + count * 300);
    const fitted = await fitUnder(colours, 30_000, encode);
    expect(fitted).toMatchObject({ setting: 96, fits: true });
  });

  it('stops when canceled', async () => {
    const controller = new AbortController();
    const { made, encode } = encoder((q) => {
      controller.abort();
      return q * 1000;
    });
    await expect(fitUnder(steps(90, 10), 5000, encode, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(made).toEqual([90]);
  });

  it('counts steps down in whole numbers', async () => {
    expect(steps(5, 2)).toEqual([5, 4, 3, 2]);
    expect(steps(2, 5)).toEqual([]);
    await expect(fitUnder([], 1, async () => new Blob())).rejects.toThrow('Nothing to try');
  });
});
