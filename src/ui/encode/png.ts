import type { Deflate, Pixels } from './tiff';
import { crc32 } from './zip';

/**
 * A PNG writer for the smallest lossless file of a picture, and for a palette picture (what
 * quantize.ts makes when fewer colours are allowed). Lossless means every visible pixel stays
 * exactly as it is; only fully transparent pixels are written as transparent black, which
 * nothing shows.
 *
 * - The smallest colour type that holds every pixel: a palette (1, 2, 4 or 8 bits a pixel) when
 *   there are at most 256 colours, grey, grey and alpha, RGB, or RGB and alpha (with up to 256
 *   colours, both a palette and the direct colours are tried).
 * - Each row's filter chosen by the usual rule (the smallest sum of the filtered bytes); none for
 *   palettes, as libpng and the PNG specification advise.
 * - The browser's own zlib Deflate (`CompressionStream`), the same as for TIFF.
 *
 * No metadata: no colour profile (the panel asks Figma for sRGB, which browsers assume of an
 * untagged PNG), no text, no time. Our own code from the PNG specification (W3C, third edition);
 * it runs in the plugin's panel, on the user's computer.
 */

/** A picture as palette indices: `palette` holds RGBA, four bytes an entry (at most 256). */
export interface IndexedPicture {
  readonly width: number;
  readonly height: number;
  readonly palette: Uint8Array;
  readonly indices: Uint8Array;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const GREY = 0;
const RGB = 2;
const INDEXED = 3;
const GREY_ALPHA = 4;
const RGBA = 6;

/** A copy of the pixels with every fully transparent pixel as transparent black. */
export function normalized(pixels: Pixels): Pixels {
  const { width, height, data } = pixels;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1)
    throw new Error('The picture has no size.');
  if (data.length !== width * height * 4)
    throw new Error('The picture data does not fit its size.');
  const out = new Uint8Array(data);
  for (let i = 3; i < out.length; i += 4)
    if (out[i] === 0) out[i - 3] = out[i - 2] = out[i - 1] = 0;
  return { width, height, data: out };
}

/**
 * The picture's colours as a palette, when it has at most `max` of them (each pixel's RGBA, as
 * it is); `null` when it has more. Entries with transparency come first, so PNG's `tRNS` stays
 * short.
 */
export function exactPalette(pixels: Pixels, max = 256): IndexedPicture | null {
  const { width, height, data } = pixels;
  const count = width * height;
  const seen = new Map<number, number>();
  const firsts: number[] = [];
  const indices = new Uint8Array(count);
  for (let p = 0, i = 0; p < count; p++, i += 4) {
    // The four bytes as one number (any byte order: only equality matters).
    const key = (data[i]! | (data[i + 1]! << 8) | (data[i + 2]! << 16)) + data[i + 3]! * 0x1000000;
    let index = seen.get(key);
    if (index === undefined) {
      if (seen.size === max) return null;
      index = seen.size;
      seen.set(key, index);
      firsts.push(i);
    }
    indices[p] = index;
  }
  // Translucent entries first.
  const order = firsts
    .map((at, index) => ({ at, index }))
    .sort((a, b) => Number(data[a.at + 3] === 255) - Number(data[b.at + 3] === 255));
  const remap = new Uint8Array(order.length);
  const palette = new Uint8Array(order.length * 4);
  order.forEach(({ at, index }, entry) => {
    remap[index] = entry;
    palette.set(data.subarray(at, at + 4), entry * 4);
  });
  for (let p = 0; p < count; p++) indices[p] = remap[indices[p]!]!;
  return { width, height, palette, indices };
}

/**
 * The smallest lossless PNG this writer makes of the picture: a palette of 1 to 4 bits when 16
 * colours or fewer do; with up to 256 colours, the smaller of a palette and the direct colours
 * (a grey ramp or a smooth gradient compresses better with row filters, which a palette cannot
 * use); otherwise the direct colours.
 */
export async function encodePng(pixels: Pixels, deflate: Deflate): Promise<Uint8Array> {
  const clean = normalized(pixels);
  const indexed = exactPalette(clean);
  const palette = indexed ? await encodeIndexedPng(indexed, deflate) : null;
  if (palette && indexed!.palette.length / 4 <= 16) return palette;
  const direct = await encodeDirect(clean, deflate);
  return palette && palette.length <= direct.length ? palette : direct;
}

/** Grey, grey and alpha, RGB, or RGB and alpha: the fewest channels that hold every pixel. */
async function encodeDirect(clean: Pixels, deflate: Deflate): Promise<Uint8Array> {
  const { width, height, data } = clean;
  let opaque = true;
  let grey = true;
  for (let i = 0; i < data.length && (opaque || grey); i += 4) {
    if (data[i + 3] !== 255) opaque = false;
    if (data[i] !== data[i + 1] || data[i] !== data[i + 2]) grey = false;
  }
  const type = grey ? (opaque ? GREY : GREY_ALPHA) : opaque ? RGB : RGBA;
  const channels = { [GREY]: [0], [GREY_ALPHA]: [0, 3], [RGB]: [0, 1, 2], [RGBA]: [0, 1, 2, 3] }[
    type
  ]!;
  const bpp = channels.length;
  const rowBytes = width * bpp;
  // Each row's samples, as PNG stores them.
  const rows = new Uint8Array(rowBytes * height);
  for (let p = 0, o = 0; p < width * height; p++)
    for (const c of channels) rows[o++] = data[p * 4 + c]!;
  const idat = await deflate(filterRows(rows, width, height, bpp));
  return assemble([
    chunk('IHDR', header(width, height, 8, type)),
    chunk('IDAT', idat),
    chunk('IEND', new Uint8Array()),
  ]);
}

/** A palette PNG: 1, 2, 4 or 8 bits a pixel, whichever the number of entries needs. */
export async function encodeIndexedPng(
  picture: IndexedPicture,
  deflate: Deflate,
): Promise<Uint8Array> {
  const { width, height, palette, indices } = picture;
  const entries = palette.length / 4;
  if (!Number.isInteger(entries) || entries < 1 || entries > 256)
    throw new Error('A PNG palette holds 1 to 256 colours.');
  if (indices.length !== width * height) throw new Error('The picture does not fit its size.');
  const depth = entries <= 2 ? 1 : entries <= 4 ? 2 : entries <= 16 ? 4 : 8;
  const perByte = 8 / depth;
  const rowBytes = Math.ceil(width / perByte);
  // Filter type 0 (none) before each row, then the indices packed from the high bits.
  const raw = new Uint8Array((rowBytes + 1) * height);
  for (let y = 0; y < height; y++) {
    const at = y * (rowBytes + 1) + 1;
    for (let x = 0; x < width; x++) {
      const index = indices[y * width + x]!;
      if (index >= entries) throw new Error('A pixel points outside the palette.');
      const shift = 8 - depth * ((x % perByte) + 1);
      raw[at + Math.floor(x / perByte)]! |= index << shift;
    }
  }
  const rgb = new Uint8Array(entries * 3);
  let translucent = 0;
  for (let e = 0; e < entries; e++) {
    rgb.set(palette.subarray(e * 4, e * 4 + 3), e * 3);
    if (palette[e * 4 + 3] !== 255) translucent = e + 1;
  }
  const alpha = new Uint8Array(translucent);
  for (let e = 0; e < translucent; e++) alpha[e] = palette[e * 4 + 3]!;
  return assemble([
    chunk('IHDR', header(width, height, depth, INDEXED)),
    chunk('PLTE', rgb),
    translucent ? chunk('tRNS', alpha) : null,
    chunk('IDAT', await deflate(raw)),
    chunk('IEND', new Uint8Array()),
  ]);
}

function header(width: number, height: number, depth: number, type: number): Uint8Array {
  const bytes = new Uint8Array(13);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  bytes[8] = depth;
  bytes[9] = type;
  // Deflate, adaptive filtering, no interlace.
  return bytes;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function assemble(chunks: ReadonlyArray<Uint8Array | null>): Uint8Array {
  const parts = chunks.filter((part): part is Uint8Array => part !== null);
  const out = new Uint8Array(8 + parts.reduce((sum, part) => sum + part.length, 0));
  out.set(SIGNATURE);
  let at = 8;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * The rows with a filter type byte before each: for every row, the filter (none, sub, up,
 * average, Paeth) whose output has the smallest sum of absolute values (bytes read as signed),
 * the heuristic the PNG specification suggests.
 */
export function filterRows(
  rows: Uint8Array,
  width: number,
  height: number,
  bpp: number,
): Uint8Array {
  const rowBytes = width * bpp;
  const out = new Uint8Array((rowBytes + 1) * height);
  const zero = new Uint8Array(rowBytes);
  const predict = (type: number, row: Uint8Array, up: Uint8Array, i: number): number => {
    const a = i >= bpp ? row[i - bpp]! : 0;
    const b = up[i]!;
    switch (type) {
      case 1:
        return a;
      case 2:
        return b;
      case 3:
        return (a + b) >> 1;
      case 4:
        return paeth(a, b, i >= bpp ? up[i - bpp]! : 0);
      default:
        return 0;
    }
  };
  for (let y = 0; y < height; y++) {
    const row = rows.subarray(y * rowBytes, (y + 1) * rowBytes);
    const up = y > 0 ? rows.subarray((y - 1) * rowBytes, y * rowBytes) : zero;
    let best = 0;
    let bestSum = Infinity;
    for (let type = 0; type < 5; type++) {
      let sum = 0;
      for (let i = 0; i < rowBytes && sum < bestSum; i++) {
        const value = (row[i]! - predict(type, row, up, i)) & 0xff;
        sum += value < 128 ? value : 256 - value;
      }
      if (sum < bestSum) {
        bestSum = sum;
        best = type;
      }
    }
    const at = y * (rowBytes + 1);
    out[at] = best;
    for (let i = 0; i < rowBytes; i++)
      out[at + 1 + i] = (row[i]! - predict(best, row, up, i)) & 0xff;
  }
  return out;
}
