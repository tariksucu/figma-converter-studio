import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { FAVICON_SIZES, encodeIco, pngSize } from '../src/ui/encode/ico';
import { browserDeflate, encodeTiff, type Pixels } from '../src/ui/encode/tiff';
import { crc32, uniqueNames, zipStore } from '../src/ui/encode/zip';

// ── TIFF ──────────────────────────────────────────────────────────────────────────────────

interface Tag {
  type: number;
  count: number;
  values: number[];
}

/** A small TIFF reader: the directory's tags and the image's samples. */
function readTiff(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect([bytes[0], bytes[1], view.getUint16(2, true)]).toEqual([0x49, 0x49, 42]);
  const ifd = view.getUint32(4, true);
  expect(ifd % 2).toBe(0);
  const tags = new Map<number, Tag>();
  const count = view.getUint16(ifd, true);
  let previous = 0;
  for (let i = 0; i < count; i++) {
    const at = ifd + 2 + i * 12;
    const tag = view.getUint16(at, true);
    expect(tag).toBeGreaterThan(previous);
    previous = tag;
    const type = view.getUint16(at + 2, true);
    const n = view.getUint32(at + 4, true);
    const size = { 2: 1, 3: 2, 4: 4, 5: 8 }[type]! * n;
    const from = size > 4 ? view.getUint32(at + 8, true) : at + 8;
    const values: number[] = [];
    for (let k = 0; k < n; k++) {
      if (type === 2) values.push(bytes[from + k]!);
      else if (type === 3) values.push(view.getUint16(from + k * 2, true));
      else if (type === 4) values.push(view.getUint32(from + k * 4, true));
      else values.push(view.getUint32(from + k * 8, true), view.getUint32(from + k * 8 + 4, true));
    }
    tags.set(tag, { type, count: n, values });
  }
  expect(view.getUint32(ifd + 2 + count * 12, true)).toBe(0);
  const get = (tag: number) => tags.get(tag)?.values ?? [];
  const [width] = get(256);
  const [height] = get(257);
  const samples = get(277)[0]!;
  const deflated = get(259)[0] === 8;
  const predictor = get(317)[0] === 2;
  const rowBytes = width! * samples;
  const parts: Uint8Array[] = get(273).map((offset, i) => {
    const raw = bytes.subarray(offset, offset + get(279)[i]!);
    return deflated ? new Uint8Array(inflateSync(raw)) : raw;
  });
  const data = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let at = 0;
  for (const part of parts) {
    data.set(part, at);
    at += part.length;
  }
  if (predictor)
    for (let row = 0; row < height!; row++)
      for (let i = samples; i < rowBytes; i++)
        data[row * rowBytes + i] =
          (data[row * rowBytes + i]! + data[row * rowBytes + i - samples]!) & 0xff;
  return { tags, get, width, height, samples, data, strips: parts.length };
}

function picture(width: number, height: number, alpha: (x: number, y: number) => number): Pixels {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data.set([(x * 37) & 255, (y * 91) & 255, (x * y) & 255, alpha(x, y)], i);
    }
  return { width, height, data };
}

const rgb = (pixels: Pixels, samples: number) => {
  const out: number[] = [];
  for (let i = 0; i < pixels.data.length; i += 4)
    out.push(...Array.from(pixels.data.subarray(i, i + samples)));
  return out;
};

describe('the TIFF writer', () => {
  it('writes an opaque picture as RGB, compressed with Deflate and the predictor', async () => {
    const pixels = picture(70, 40, () => 255);
    const tiff = readTiff(await encodeTiff(pixels, { deflate: browserDeflate(), dpi: 144 }));
    expect([tiff.width, tiff.height, tiff.samples]).toEqual([70, 40, 3]);
    expect(tiff.get(258)).toEqual([8, 8, 8]);
    expect(tiff.get(259)).toEqual([8]);
    expect(tiff.get(262)).toEqual([2]);
    expect(tiff.get(282)).toEqual([144, 1]);
    expect(tiff.get(296)).toEqual([2]);
    expect(tiff.tags.has(338)).toBe(false);
    expect(Array.from(tiff.data)).toEqual(rgb(pixels, 3));
  });

  it('keeps transparency as an unassociated alpha channel', async () => {
    const pixels = picture(33, 17, (x) => (x * 8) & 255);
    const tiff = readTiff(await encodeTiff(pixels, { deflate: browserDeflate() }));
    expect(tiff.samples).toBe(4);
    expect(tiff.get(338)).toEqual([2]);
    expect(Array.from(tiff.data)).toEqual(Array.from(pixels.data));
  });

  it('writes uncompressed strips when the browser cannot compress, in several strips', async () => {
    const pixels = picture(400, 300, () => 255);
    const bytes = await encodeTiff(pixels, { deflate: null, software: 'Test' });
    const tiff = readTiff(bytes);
    expect(tiff.get(259)).toEqual([1]);
    expect(tiff.tags.has(317)).toBe(false);
    expect(tiff.strips).toBeGreaterThan(1);
    expect(String.fromCharCode(...tiff.get(305))).toBe('Test\0');
    expect(Array.from(tiff.data)).toEqual(rgb(pixels, 3));
  });

  it('refuses pixels that do not fit their size', async () => {
    await expect(encodeTiff({ width: 2, height: 2, data: new Uint8Array(15) })).rejects.toThrow(
      'does not fit',
    );
    await expect(encodeTiff({ width: 0, height: 2, data: new Uint8Array(0) })).rejects.toThrow();
  });
});

// ── ICO ───────────────────────────────────────────────────────────────────────────────────

function png(side: number, extra = 0): Uint8Array {
  const bytes = new Uint8Array(33 + extra);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, side);
  view.setUint32(20, side);
  return bytes;
}

describe('the ICO writer', () => {
  it('puts square PNGs of each size in one icon, smallest first; 256 is written as 0', () => {
    const ico = encodeIco([256, 16, 48].map((size) => ({ size, png: png(size, size) })));
    const view = new DataView(ico.buffer);
    expect([view.getUint16(0, true), view.getUint16(2, true), view.getUint16(4, true)]).toEqual([
      0, 1, 3,
    ]);
    const entries = [0, 1, 2].map((i) => {
      const at = 6 + i * 16;
      return {
        width: ico[at],
        height: ico[at + 1],
        planes: view.getUint16(at + 4, true),
        bits: view.getUint16(at + 6, true),
        size: view.getUint32(at + 8, true),
        offset: view.getUint32(at + 12, true),
      };
    });
    expect(entries.map((e) => e.width)).toEqual([16, 48, 0]);
    expect(entries.every((e) => e.planes === 1 && e.bits === 32)).toBe(true);
    expect(entries[0]!.offset).toBe(6 + 3 * 16);
    for (const entry of entries)
      expect(pngSize(ico.subarray(entry.offset, entry.offset + entry.size))).not.toBeNull();
    expect(ico.length).toBe(54 + (33 + 256) + (33 + 16) + (33 + 48));
  });

  it('refuses what is not a square PNG of its size', () => {
    expect(() => encodeIco([])).toThrow();
    expect(() => encodeIco([{ size: 16, png: new Uint8Array(40) }])).toThrow('PNG');
    expect(() => encodeIco([{ size: 32, png: png(16) }])).toThrow('32 × 32');
    expect(() => encodeIco([{ size: 512, png: png(512) }])).toThrow();
  });

  it('knows a PNG by its signature', () => {
    expect(pngSize(png(48))).toEqual({ width: 48, height: 48 });
    expect(pngSize(new Uint8Array(30))).toBeNull();
    expect(FAVICON_SIZES).toEqual([16, 32, 48]);
  });
});

// ── ZIP ───────────────────────────────────────────────────────────────────────────────────

describe('the ZIP writer', () => {
  it('computes the standard CRC-32', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });

  it('stores files with UTF-8 names and a central directory', () => {
    const files = [
      { name: 'Hero.webp', bytes: new Uint8Array([1, 2, 3]) },
      { name: 'Çiçek ✓.webp', bytes: new TextEncoder().encode('hello') },
    ];
    const zip = zipStore(files, new Date(2026, 10, 23, 14, 30, 10));
    const view = new DataView(zip.buffer);
    const end = zip.length - 22;
    expect(view.getUint32(end, true)).toBe(0x06054b50);
    expect(view.getUint16(end + 10, true)).toBe(2);
    let at = view.getUint32(end + 16, true);
    const decoder = new TextDecoder();
    for (const file of files) {
      expect(view.getUint32(at, true)).toBe(0x02014b50);
      expect(view.getUint16(at + 8, true)).toBe(0x0800);
      expect(view.getUint16(at + 10, true)).toBe(0);
      expect(view.getUint32(at + 16, true)).toBe(crc32(file.bytes));
      const nameLength = view.getUint16(at + 28, true);
      expect(decoder.decode(zip.subarray(at + 46, at + 46 + nameLength))).toBe(file.name);
      const local = view.getUint32(at + 42, true);
      expect(view.getUint32(local, true)).toBe(0x04034b50);
      // 2026-11-23 14:30:10 in MS-DOS form.
      expect(view.getUint16(local + 10, true)).toBe((14 << 11) | (30 << 5) | 5);
      expect(view.getUint16(local + 12, true)).toBe(((2026 - 1980) << 9) | (11 << 5) | 23);
      const data = local + 30 + view.getUint16(local + 26, true);
      expect(Array.from(zip.subarray(data, data + file.bytes.length))).toEqual(
        Array.from(file.bytes),
      );
      at += 46 + nameLength;
    }
    expect(at).toBe(end);
  });

  it('makes names unique the way file managers do', () => {
    expect(uniqueNames(['a.webp', 'A.webp', 'a.webp', 'b', 'b'])).toEqual([
      'a.webp',
      'A (2).webp',
      'a (3).webp',
      'b',
      'b (2)',
    ]);
  });

  it('refuses an empty ZIP', () => {
    expect(() => zipStore([])).toThrow();
  });
});
