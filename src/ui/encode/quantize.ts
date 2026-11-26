import { distance, palette as quantizers, utils } from 'image-q';
import type { IndexedPicture } from './png';
import type { Pixels } from './tiff';

/**
 * Fewer colours for a smaller PNG (lossy, and only when the user allows it): a palette of at
 * most `colors` entries, then every pixel as its nearest entry, without dithering (flat design
 * colours stay flat).
 *
 * The palette comes from image-q 4.0.0 (MIT; github.com/ibezkrovnyi/image-quantization), its
 * Xiaolin Wu quantizer with the BT.709 colour distance, bundled unmodified from npm; it is built
 * from an even sample of the pixels (about 0.3 to 0.5 s). The pixels are matched to it here,
 * with the same distance, so that a large frame needs no object for each pixel. Fully
 * transparent pixels must be transparent black (png.ts `normalized`).
 *
 * Why Wu (measured on a photo, a UI frame with gradients and text, and a synthetic pattern):
 * the best colour error at 256, 64 and 16 colours on the photo, and it never fails. RGBQuant was
 * faster but kept 2 colours of 256 on a picture whose colours each occur once; NeuQuant was
 * behind on every picture. Wu works on 5 bits a channel, so a smooth UI frame may get fewer
 * entries than asked for (about 100 of 256), still within 47 dB of the original.
 */

/** The palette is built from at most this many pixels, spread evenly over the picture. */
export const SAMPLE_PIXELS = 250_000;
/** Pixels matched between two looks at `signal` (and a chance for the panel to repaint). */
const BATCH = 1 << 20;

// BT.709's weights, as image-q's EuclideanBT709 (red, green, blue, alpha).
const KR = 0.2126;
const KG = 0.7152;
const KB = 0.0722;
const KA = 1;

/** The picture, or an even grid of its pixels when it is larger than `max`. */
export function sampleOf(pixels: Pixels, max = SAMPLE_PIXELS): Pixels {
  const { width, height, data } = pixels;
  const step = Math.max(1, Math.ceil(Math.sqrt((width * height) / max)));
  if (step === 1) return pixels;
  const w = Math.ceil(width / step);
  const h = Math.ceil(height / step);
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const from = (y * step * width + x * step) * 4;
      out.set(data.subarray(from, from + 4), (y * w + x) * 4);
    }
  return { width: w, height: h, data: out };
}

const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** The picture with at most `colors` colours. */
export async function quantize(
  pixels: Pixels,
  colors: number,
  signal?: AbortSignal,
): Promise<IndexedPicture> {
  if (!Number.isInteger(colors) || colors < 2 || colors > 256)
    throw new Error('A palette holds 2 to 256 colours.');
  return compact(await matchPalette(pixels, buildPalette(sampleOf(pixels), colors), signal));
}

/** image-q's palette (RGBA, four bytes an entry) for the picture. */
export function buildPalette(pixels: Pixels, colors: number): Uint8Array {
  const container = utils.PointContainer.fromUint8Array(pixels.data, pixels.width, pixels.height);
  const quantizer = new quantizers.WuQuant(new distance.EuclideanBT709(), colors);
  quantizer.sample(container);
  const points = quantizer.quantizeSync().getPointContainer().getPointArray();
  const palette = new Uint8Array(points.length * 4);
  points.forEach((point, i) => palette.set([point.r, point.g, point.b, point.a], i * 4));
  return palette;
}

/** Every pixel as its nearest palette entry. */
export async function matchPalette(
  pixels: Pixels,
  palette: Uint8Array,
  signal?: AbortSignal,
): Promise<IndexedPicture> {
  const { width, height, data } = pixels;
  const count = width * height;
  const indices = new Uint8Array(count);
  const nearest = new Map<number, number>();
  const entries = palette.length / 4;
  for (let p = 0, i = 0; p < count; p++, i += 4) {
    if (p % BATCH === BATCH - 1) {
      await pause();
      signal?.throwIfAborted();
    }
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;
    const a = data[i + 3]!;
    const key = (r | (g << 8) | (b << 16)) + a * 0x1000000;
    let index = nearest.get(key);
    if (index === undefined) {
      let best = Infinity;
      index = 0;
      for (let e = 0; e < entries; e++) {
        const dr = palette[e * 4]! - r;
        const dg = palette[e * 4 + 1]! - g;
        const db = palette[e * 4 + 2]! - b;
        const da = palette[e * 4 + 3]! - a;
        const d = KR * dr * dr + KG * dg * dg + KB * db * db + KA * da * da;
        if (d < best) {
          best = d;
          index = e;
        }
      }
      // A photo has millions of colours: the cache stays a reasonable size.
      if (nearest.size > 1 << 20) nearest.clear();
      nearest.set(key, index);
    }
    indices[p] = index;
  }
  return { width, height, palette, indices };
}

/**
 * Only the entries some pixel uses (fewer entries can mean fewer bits a pixel), translucent ones
 * first (a shorter `tRNS`).
 */
export function compact(picture: IndexedPicture): IndexedPicture {
  const { palette, indices } = picture;
  const entries = palette.length / 4;
  const used = new Uint8Array(entries);
  for (const index of indices) used[index] = 1;
  const order = [...Array(entries).keys()]
    .filter((e) => used[e])
    .sort((a, b) => Number(palette[a * 4 + 3] === 255) - Number(palette[b * 4 + 3] === 255));
  const remap = new Uint8Array(entries);
  const out = new Uint8Array(order.length * 4);
  order.forEach((e, i) => {
    remap[e] = i;
    out.set(palette.subarray(e * 4, e * 4 + 4), i * 4);
  });
  const mapped = new Uint8Array(indices.length);
  for (let p = 0; p < indices.length; p++) mapped[p] = remap[indices[p]!]!;
  return { width: picture.width, height: picture.height, palette: out, indices: mapped };
}
