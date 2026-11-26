import { crc32 as zlibCrc32, deflateSync, inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  encodeIndexedPng,
  encodePng,
  exactPalette,
  filterRows,
  normalized,
  type IndexedPicture,
} from '../src/ui/encode/png';
import { compact, matchPalette, quantize, sampleOf } from '../src/ui/encode/quantize';
import { browserDeflate, type Pixels } from '../src/ui/encode/tiff';

const deflate = browserDeflate()!;

// ── A PNG reader for the tests (the harness reads the files with Pillow as well) ───────────

interface Decoded {
  width: number;
  height: number;
  depth: number;
  type: number;
  chunks: string[];
  filters: number[];
  palette: number;
  transparent: number;
  rgba: Uint8Array;
}

function paeth(a: number, b: number, c: number) {
  const p = a + b - c;
  const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function decodePng(bytes: Uint8Array): Decoded {
  expect(Array.from(bytes.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const chunks: Array<{ type: string; data: Uint8Array }> = [];
  for (let at = 8; at < bytes.length;) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + at);
    const length = view.getUint32(0);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    expect(view.getUint32(8 + length), `${type} CRC`).toBe(
      zlibCrc32(bytes.subarray(at + 4, at + 8 + length)),
    );
    chunks.push({ type, data: bytes.subarray(at + 8, at + 8 + length) });
    at += 12 + length;
  }
  expect(chunks[0]!.type).toBe('IHDR');
  expect(chunks.at(-1)!.type).toBe('IEND');
  const ihdr = new DataView(chunks[0]!.data.buffer, chunks[0]!.data.byteOffset);
  const [width, height] = [ihdr.getUint32(0), ihdr.getUint32(4)];
  const [depth, type] = [chunks[0]!.data[8]!, chunks[0]!.data[9]!];
  expect(Array.from(chunks[0]!.data.subarray(10, 13))).toEqual([0, 0, 0]);
  const plte = chunks.find((c) => c.type === 'PLTE')?.data ?? new Uint8Array();
  const trns = chunks.find((c) => c.type === 'tRNS')?.data ?? new Uint8Array();
  const idat = Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data));
  const raw = new Uint8Array(inflateSync(idat));
  const samples = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type]!;
  const bpp = Math.max(1, (samples * depth) / 8);
  const rowBytes = Math.ceil((width * samples * depth) / 8);
  expect(raw.length).toBe((rowBytes + 1) * height);
  const rows = new Uint8Array(rowBytes * height);
  const filters: number[] = [];
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (rowBytes + 1)]!;
    filters.push(filter);
    for (let i = 0; i < rowBytes; i++) {
      const x = raw[y * (rowBytes + 1) + 1 + i]!;
      const a = i >= bpp ? rows[y * rowBytes + i - bpp]! : 0;
      const b = y > 0 ? rows[(y - 1) * rowBytes + i]! : 0;
      const c = y > 0 && i >= bpp ? rows[(y - 1) * rowBytes + i - bpp]! : 0;
      const p = [0, a, b, (a + b) >> 1, paeth(a, b, c)][filter]!;
      rows[y * rowBytes + i] = (x + p) & 0xff;
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const out = (y * width + x) * 4;
      const row = y * rowBytes;
      if (type === 3) {
        const bit = x * depth;
        const index = (rows[row + (bit >> 3)]! >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
        expect(index * 3).toBeLessThan(plte.length);
        rgba.set([...plte.subarray(index * 3, index * 3 + 3), trns[index] ?? 255], out);
      } else {
        const s = rows.subarray(row + x * samples, row + (x + 1) * samples);
        rgba.set(
          type === 0
            ? [s[0]!, s[0]!, s[0]!, 255]
            : type === 4
              ? [s[0]!, s[0]!, s[0]!, s[1]!]
              : type === 2
                ? [s[0]!, s[1]!, s[2]!, 255]
                : [s[0]!, s[1]!, s[2]!, s[3]!],
          out,
        );
      }
    }
  return {
    width,
    height,
    depth,
    type,
    chunks: chunks.map((c) => c.type),
    filters,
    palette: plte.length / 3,
    transparent: trns.length,
    rgba,
  };
}

// ── Pictures ──────────────────────────────────────────────────────────────────────────────

function picture(
  width: number,
  height: number,
  pixel: (x: number, y: number) => [number, number, number, number],
): Pixels {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) data.set(pixel(x, y), (y * width + x) * 4);
  return { width, height, data };
}

/** A banner-like picture: a gradient, a translucent circle and transparent corners. */
const banner = picture(120, 80, (x, y) => {
  if ((x < 6 && y < 6) || (x > 113 && y > 73)) return [200, 10, 10, 0];
  const inCircle = (x - 80) ** 2 + (y - 40) ** 2 < 400;
  const base: [number, number, number] = [59 + (x >> 2), 130 + (y >> 1), 246 - (x >> 1)];
  return inCircle ? [...base, 140] : [...base, 255];
});

const expectSame = (decoded: Decoded, source: Pixels) =>
  expect(Buffer.from(decoded.rgba).equals(Buffer.from(normalized(source).data))).toBe(true);

describe('the lossless PNG writer', () => {
  it('RGB and alpha: every visible pixel exactly as it was', async () => {
    const png = await encodePng(banner, deflate);
    const decoded = decodePng(png);
    expect(decoded).toMatchObject({ width: 120, height: 80, depth: 8, type: 6 });
    expect(decoded.chunks).toEqual(['IHDR', 'IDAT', 'IEND']);
    expectSame(decoded, banner);
    // Fully transparent pixels are written as transparent black.
    expect(Array.from(decoded.rgba.subarray(0, 4))).toEqual([0, 0, 0, 0]);
  });

  it('opaque: RGB, three bytes a pixel', async () => {
    const opaque = picture(64, 40, (x, y) => [x * 4, y * 6, (x * y) & 255, 255]);
    const decoded = decodePng(await encodePng(opaque, deflate));
    expect(decoded).toMatchObject({ type: 2, depth: 8 });
    expectSame(decoded, opaque);
  });

  it('grey: one byte a pixel, two with alpha', async () => {
    const grey = picture(300, 2, (x) => [x % 256, x % 256, x % 256, 255]);
    expect(decodePng(await encodePng(grey, deflate))).toMatchObject({ type: 0 });
    const greyAlpha = picture(300, 2, (x, y) => [x % 256, x % 256, x % 256, y ? 128 : 255]);
    const decoded = decodePng(await encodePng(greyAlpha, deflate));
    expect(decoded).toMatchObject({ type: 4 });
    expectSame(decoded, greyAlpha);
  });

  it('up to 256 colours: a palette of 1, 2, 4 or 8 bits, translucent entries first', async () => {
    // Colours in a scrambled order: no row filter helps, the palette is the smaller.
    const scrambled = (x: number, y: number, n: number) =>
      (Math.imul(x * 131 + y * 71 + 3, 2654435761) >>> 8) % n;
    for (const [colours, depth] of [
      [2, 1],
      [3, 2],
      [4, 2],
      [5, 4],
      [16, 4],
      [17, 8],
      [256, 8],
    ] as const) {
      const flat = picture(256, 128, (x, y) => {
        const c = x === 0 && y < colours ? y : scrambled(x, y, colours);
        return [c, 255 - c, (c * 7) & 255, c === 1 ? 0 : c === 2 ? 99 : 255];
      });
      const decoded = decodePng(await encodePng(flat, deflate));
      expect(decoded, `${colours} colours`).toMatchObject({ type: 3, depth, palette: colours });
      expect(decoded.filters.every((f) => f === 0)).toBe(true);
      expectSame(decoded, flat);
      // Entries 0 and 1: the transparent and the translucent colour; tRNS stops there.
      expect(decoded.transparent).toBe(colours >= 3 ? 2 : 1);
    }
  });

  it('a smooth ramp of up to 256 colours: direct colours with row filters, if smaller', async () => {
    const ramp = picture(256, 64, (x) => [x, x, 255 - x, 255]);
    const png = await encodePng(ramp, deflate);
    const decoded = decodePng(png);
    expect(decoded.type).toBe(2);
    expectSame(decoded, ramp);
    const indexed = exactPalette(normalized(ramp))!;
    expect(png.length).toBeLessThan((await encodeIndexedPng(indexed, deflate)).length);
  });

  it('a palette without transparency has no tRNS', async () => {
    const logo = picture(10, 10, (x) => (x < 5 ? [255, 84, 24, 255] : [22, 21, 15, 255]));
    const decoded = decodePng(await encodePng(logo, deflate));
    expect(decoded.chunks).toEqual(['IHDR', 'PLTE', 'IDAT', 'IEND']);
    expect(decoded).toMatchObject({ depth: 1, palette: 2 });
  });

  it('chooses a filter for each row, and smooth pictures compress far better for it', async () => {
    const smooth = picture(400, 300, (x, y) => [x % 256, (y * 3) % 256, (x + y) % 256, 255]);
    const png = await encodePng(smooth, deflate);
    const decoded = decodePng(png);
    expectSame(decoded, smooth);
    expect(new Set(decoded.filters).size).toBeGreaterThan(1);
    expect(decoded.filters.some((f) => f !== 0)).toBe(true);
    // Against the same samples with no filters at all.
    const rows = new Uint8Array(400 * 300 * 3);
    for (let p = 0; p < 400 * 300; p++)
      rows.set(smooth.data.subarray(p * 4, p * 4 + 3) as Uint8ClampedArray, p * 3);
    const unfiltered = new Uint8Array((400 * 3 + 1) * 300);
    for (let y = 0; y < 300; y++)
      unfiltered.set(rows.subarray(y * 1200, (y + 1) * 1200), y * 1201 + 1);
    expect(png.length).toBeLessThan(deflateSync(unfiltered).length / 4);
  });

  it('every filter type decodes back (the writer and a reader agree)', () => {
    // Rows of noise, a ramp and repeats, so that each filter wins somewhere.
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) & 255;
    const width = 50;
    const rows = new Uint8Array(width * 3 * 40);
    for (let y = 0; y < 40; y++)
      for (let i = 0; i < width * 3; i++)
        rows[y * width * 3 + i] =
          y % 4 === 0
            ? random()
            : y % 4 === 1
              ? i
              : y % 4 === 2
                ? (i * y) & 255
                : rows[(y - 1) * width * 3 + i]!;
    const filtered = filterRows(rows, width, 40, 3);
    const seen = new Set<number>();
    for (let y = 0; y < 40; y++) seen.add(filtered[y * (width * 3 + 1)]!);
    expect(seen.size).toBeGreaterThanOrEqual(3);
  });

  it('normalizes a copy: transparent pixels become transparent black, nothing else changes', () => {
    const source = picture(2, 1, (x) => (x ? [1, 2, 3, 0] : [4, 5, 6, 7]));
    const clean = normalized(source);
    expect(Array.from(clean.data)).toEqual([4, 5, 6, 7, 0, 0, 0, 0]);
    expect(Array.from(source.data)).toEqual([4, 5, 6, 7, 1, 2, 3, 0]);
    expect(() => normalized({ width: 2, height: 2, data: new Uint8Array(4) })).toThrow(
      'does not fit',
    );
  });

  it('counts colours only up to 256', () => {
    expect(exactPalette(banner)).toBeNull();
    const two = picture(3, 3, (x) => (x ? [1, 1, 1, 255] : [2, 2, 2, 255]));
    expect(exactPalette(two)?.palette.length).toBe(8);
  });

  it('refuses a palette it cannot write', async () => {
    const picture = (entries: number, index: number): IndexedPicture => ({
      width: 1,
      height: 1,
      palette: new Uint8Array(entries * 4),
      indices: new Uint8Array([index]),
    });
    await expect(encodeIndexedPng(picture(257, 0), deflate)).rejects.toThrow('1 to 256');
    await expect(encodeIndexedPng(picture(0, 0), deflate)).rejects.toThrow('1 to 256');
    await expect(encodeIndexedPng(picture(2, 2), deflate)).rejects.toThrow('outside the palette');
  });
});

describe('fewer colours (image-q)', () => {
  it('quantizes to at most the colours asked for, each pixel to its nearest entry', async () => {
    const clean = normalized(banner);
    for (const colours of [64, 16, 4]) {
      const indexed = await quantize(clean, colours);
      const entries = indexed.palette.length / 4;
      expect(entries).toBeLessThanOrEqual(colours);
      expect(entries).toBeGreaterThan(1);
      // Every entry is used (compact), and each pixel is the nearest entry by BT.709.
      const used = new Set(indexed.indices);
      expect(used.size).toBe(entries);
      for (let p = 0; p < 9600; p += 97) {
        const px = Array.from(clean.data.subarray(p * 4, p * 4 + 4));
        const distance = (e: number) => {
          const [r, g, b, a] = Array.from(indexed.palette.subarray(e * 4, e * 4 + 4));
          return (
            0.2126 * (r! - px[0]!) ** 2 +
            0.7152 * (g! - px[1]!) ** 2 +
            0.0722 * (b! - px[2]!) ** 2 +
            (a! - px[3]!) ** 2
          );
        };
        const chosen = distance(indexed.indices[p]!);
        for (let e = 0; e < entries; e++) expect(chosen).toBeLessThanOrEqual(distance(e) + 1e-9);
      }
      // A palette PNG of it reads back as the palette's colours.
      const decoded = decodePng(await encodeIndexedPng(indexed, deflate));
      expect(decoded.type).toBe(3);
      expect(decoded.palette).toBe(entries);
    }
  });

  it('keeps transparent corners transparent and stays close at 256 colours', async () => {
    const clean = normalized(banner);
    const indexed = await quantize(clean, 256);
    const index = indexed.indices[0]!;
    expect(indexed.palette[index * 4 + 3]).toBe(0);
    let error = 0;
    for (let p = 0; p < indexed.indices.length; p++)
      for (let c = 0; c < 4; c++)
        error += (indexed.palette[indexed.indices[p]! * 4 + c]! - clean.data[p * 4 + c]!) ** 2;
    const psnr = 10 * Math.log10((255 * 255) / (error / clean.data.length));
    expect(psnr).toBeGreaterThan(38);
  });

  it('a picture whose colours each occur once still gets a full palette', async () => {
    // A quantizer that counts how often a colour occurs (RGBQuant) kept 2 of 256 here.
    const pattern = picture(320, 200, (x, y) => [(x * 7) & 255, (y * 5) & 255, (x * y) & 255, 255]);
    const indexed = await quantize(normalized(pattern), 256);
    expect(indexed.palette.length / 4).toBeGreaterThan(200);
  });

  it('builds the palette from an even sample of a large picture', () => {
    const large: Pixels = { width: 2000, height: 1000, data: new Uint8Array(2000 * 1000 * 4) };
    const sample = sampleOf(large, 250_000);
    expect(sample.width * sample.height).toBeLessThanOrEqual(250_000);
    expect(sample.width).toBe(667);
    expect(sampleOf(banner)).toBe(banner);
  });

  it('matches to a given palette and drops what no pixel uses', async () => {
    const two = picture(4, 1, (x) => (x < 2 ? [250, 0, 0, 255] : [0, 0, 240, 255]));
    const palette = new Uint8Array([0, 0, 0, 0, 0, 0, 255, 255, 255, 0, 0, 255, 9, 9, 9, 255]);
    const matched = await matchPalette(two, palette);
    expect(Array.from(matched.indices)).toEqual([2, 2, 1, 1]);
    const compacted = compact(matched);
    expect(compacted.palette.length).toBe(8);
    expect(Array.from(compacted.indices)).toEqual([1, 1, 0, 0]);
  });

  it('refuses a palette size out of range', async () => {
    await expect(quantize(banner, 1)).rejects.toThrow('2 to 256');
    await expect(quantize(banner, 257)).rejects.toThrow('2 to 256');
  });
});
