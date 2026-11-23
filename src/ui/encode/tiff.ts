/**
 * A baseline TIFF writer: 8-bit RGB (or RGB with an alpha channel when the picture has
 * transparent pixels), little-endian, in strips, compressed with Deflate (TIFF's Adobe Deflate,
 * with the horizontal predictor) when the browser can compress, otherwise uncompressed.
 * Photoshop, Affinity, GIMP, macOS Preview, Windows Photos and libtiff read both.
 *
 * Our own code from the TIFF 6.0 specification (Adobe, 1992) and its Deflate supplement; it runs
 * in the plugin's panel, on the user's computer.
 */

export interface Pixels {
  readonly width: number;
  readonly height: number;
  /** RGBA, 4 bytes a pixel, row after row, alpha not premultiplied (a canvas's ImageData). */
  readonly data: Uint8Array | Uint8ClampedArray;
}

/** zlib-wrapped Deflate (what TIFF's compression 8 holds). */
export type Deflate = (bytes: Uint8Array) => Promise<Uint8Array>;

export interface TiffOptions {
  /** Compresses the strips; `null` writes them uncompressed. */
  readonly deflate?: Deflate | null;
  /** Pixels an inch, so print tools show the design's size (72 × the export scale). */
  readonly dpi?: number;
  readonly software?: string;
}

/** The browser's own zlib Deflate (`CompressionStream('deflate')`), when it has one. */
export function browserDeflate(): Deflate | null {
  if (typeof CompressionStream !== 'function') return null;
  return async (bytes) => {
    const stream = new Blob([bytes as Uint8Array<ArrayBuffer>])
      .stream()
      .pipeThrough(new CompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  };
}

/** Roughly how much uncompressed image goes into one strip (the specification suggests ~8 KB;
 * larger strips compress better and every reader handles them). */
const STRIP_BYTES = 256 * 1024;

const SHORT = 3;
const LONG = 4;
const RATIONAL = 5;
const ASCII = 2;

interface Entry {
  readonly tag: number;
  readonly type: number;
  readonly values: readonly number[] | string;
}

export async function encodeTiff(pixels: Pixels, options: TiffOptions = {}): Promise<Uint8Array> {
  const { width, height, data } = pixels;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1)
    throw new Error('The picture has no size.');
  if (data.length !== width * height * 4)
    throw new Error('The picture data does not fit its size.');

  let opaque = true;
  for (let i = 3; i < data.length; i += 4)
    if (data[i] !== 255) {
      opaque = false;
      break;
    }
  const samples = opaque ? 3 : 4;
  const rowBytes = width * samples;
  const rowsPerStrip = Math.max(1, Math.min(height, Math.floor(STRIP_BYTES / rowBytes)));
  const deflate = options.deflate ?? null;

  const strips: Uint8Array[] = [];
  for (let top = 0; top < height; top += rowsPerStrip) {
    const rows = Math.min(rowsPerStrip, height - top);
    const strip = new Uint8Array(rows * rowBytes);
    for (let y = 0; y < rows; y++) {
      const from = (top + y) * width * 4;
      const to = y * rowBytes;
      for (let x = 0; x < width; x++)
        for (let s = 0; s < samples; s++) strip[to + x * samples + s] = data[from + x * 4 + s]!;
      // The horizontal predictor: each sample minus the same sample of the pixel to its left.
      if (deflate)
        for (let i = rowBytes - 1; i >= samples; i--)
          strip[to + i] = (strip[to + i]! - strip[to + i - samples]!) & 0xff;
    }
    strips.push(deflate ? await deflate(strip) : strip);
  }

  const dpi = Math.max(1, Math.round(options.dpi ?? 72));
  const entries: Entry[] = [
    { tag: 256, type: LONG, values: [width] },
    { tag: 257, type: LONG, values: [height] },
    { tag: 258, type: SHORT, values: new Array<number>(samples).fill(8) },
    { tag: 259, type: SHORT, values: [deflate ? 8 : 1] },
    // RGB.
    { tag: 262, type: SHORT, values: [2] },
    { tag: 273, type: LONG, values: [] },
    { tag: 277, type: SHORT, values: [samples] },
    { tag: 278, type: LONG, values: [rowsPerStrip] },
    { tag: 279, type: LONG, values: strips.map((s) => s.byteLength) },
    { tag: 282, type: RATIONAL, values: [dpi, 1] },
    { tag: 283, type: RATIONAL, values: [dpi, 1] },
    // Chunky: R, G, B(, A) of a pixel together.
    { tag: 284, type: SHORT, values: [1] },
    // Inches.
    { tag: 296, type: SHORT, values: [2] },
    { tag: 305, type: ASCII, values: `${options.software ?? 'Converter Studio'}\0` },
    ...(deflate ? [{ tag: 317, type: SHORT, values: [2] }] : []),
    // The fourth sample is alpha, not premultiplied.
    ...(opaque ? [] : [{ tag: 338, type: SHORT, values: [2] }]),
  ];

  // Header, strips, then each value too long for its entry, then the directory.
  const sizeOf = (entry: Entry) =>
    entry.tag === 273
      ? strips.length * 4
      : typeof entry.values === 'string'
        ? entry.values.length
        : entry.values.length * (entry.type === SHORT ? 2 : 4);
  let offset = 8;
  const stripOffsets = strips.map((strip) => {
    const at = offset;
    offset += strip.byteLength;
    return at;
  });
  const outside = new Map<number, number>();
  for (const entry of entries) {
    const size = sizeOf(entry);
    if (size > 4) {
      offset += offset % 2;
      outside.set(entry.tag, offset);
      offset += size;
    }
  }
  offset += offset % 2;
  const ifd = offset;
  const total = ifd + 2 + entries.length * 12 + 4;
  if (total > 0xffffffff) throw new Error('The picture is too large for a TIFF file.');

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  out.set([0x49, 0x49], 0);
  view.setUint16(2, 42, true);
  view.setUint32(4, ifd, true);
  strips.forEach((strip, i) => out.set(strip, stripOffsets[i]));

  const write = (at: number, entry: Entry) => {
    const values = entry.tag === 273 ? stripOffsets : entry.values;
    if (typeof values === 'string') {
      for (let i = 0; i < values.length; i++) out[at + i] = values.charCodeAt(i) & 0x7f;
      return;
    }
    values.forEach((value, i) => {
      if (entry.type === SHORT) view.setUint16(at + i * 2, value, true);
      else view.setUint32(at + i * 4, value, true);
    });
  };

  view.setUint16(ifd, entries.length, true);
  entries.forEach((entry, i) => {
    const at = ifd + 2 + i * 12;
    const count =
      entry.tag === 273
        ? strips.length
        : typeof entry.values === 'string'
          ? entry.values.length
          : entry.type === RATIONAL
            ? entry.values.length / 2
            : entry.values.length;
    view.setUint16(at, entry.tag, true);
    view.setUint16(at + 2, entry.type, true);
    view.setUint32(at + 4, count, true);
    const elsewhere = outside.get(entry.tag);
    if (elsewhere === undefined) write(at + 8, entry);
    else {
      view.setUint32(at + 8, elsewhere, true);
      write(elsewhere, entry);
    }
  });
  // No next directory.
  view.setUint32(ifd + 2 + entries.length * 12, 0, true);
  return out;
}
