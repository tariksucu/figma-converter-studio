import type { Answer, Ask, Bridge } from '../src/ui/bridge';
import { pngSize } from '../src/ui/encode/ico';
import type { EncodeOptions, Picture, Raster } from '../src/ui/raster';
import { SOURCE, type Notice } from '../src/shared/messages';

/** A PNG's first 33 bytes (signature and IHDR) for a `width` × `height` picture, and `extra` more. */
export function pngBytes(width: number, height: number, extra = 0): Uint8Array {
  const bytes = new Uint8Array(33 + extra);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

export interface FakeRaster extends Raster {
  readonly encoded: Array<{ mime: string; options: EncodeOptions; width: number; height: number }>;
  closed: number;
}

/**
 * The browser's canvas, stood in for: it "reads" PNGs (by their header) and whatever `decodes`
 * says, writes PNG and JPEG and the types in `encodes`, and a lossy file's size follows
 * `sizeOf(quality, width, height)`.
 */
export function fakeRaster(
  options: {
    encodes?: readonly string[];
    decodes?: (bytes: Uint8Array) => { width: number; height: number } | null;
    sizeOf?: (quality: number, width: number, height: number) => number;
  } = {},
): FakeRaster {
  const encodes = new Set(options.encodes ?? ['image/webp']);
  const sizeOf = options.sizeOf ?? ((quality, w, h) => Math.round(w * h * quality));
  const raster: FakeRaster = {
    encoded: [],
    closed: 0,
    async canEncode(mime) {
      return encodes.has(mime);
    },
    async decode(data) {
      const bytes = new Uint8Array(await data.arrayBuffer());
      const size = pngSize(bytes) ?? options.decodes?.(bytes) ?? null;
      if (!size) return null;
      const picture: Picture = {
        ...size,
        close: () => {
          raster.closed += 1;
        },
      };
      return picture;
    },
    async encode(picture, mime, encode = {}) {
      const width = Math.round(encode.width ?? picture.width);
      const height = Math.round(encode.height ?? picture.height);
      raster.encoded.push({ mime, options: encode, width, height });
      const side = Math.max(width, height);
      const [w, h] = encode.square ? [side, side] : [width, height];
      if (mime === 'image/png')
        return new Blob([pngBytes(w, h) as Uint8Array<ArrayBuffer>], { type: mime });
      if (mime !== 'image/jpeg' && !encodes.has(mime)) return null;
      return new Blob([new Uint8Array(sizeOf(encode.quality ?? 0.92, w, h))], { type: mime });
    },
    pixels(picture) {
      return {
        width: picture.width,
        height: picture.height,
        data: new Uint8ClampedArray(picture.width * picture.height * 4).fill(255),
      };
    },
  };
  return raster;
}

export interface FakeBridge extends Bridge {
  readonly asked: Ask[];
  notify(notice: Omit<Notice, 'source'>): void;
}

/** The plugin's code, stood in for: `answer` replies to each request (an Error: `failed`). */
export function fakeBridge(answer: (ask: Ask) => Answer | Promise<Answer>): FakeBridge {
  const listeners: Array<(notice: Notice) => void> = [];
  return {
    asked: [],
    async ask(request) {
      this.asked.push(request);
      return answer(request);
    },
    onNotice(listener) {
      listeners.push(listener);
    },
    notify(notice) {
      for (const listener of listeners) listener({ ...notice, source: SOURCE } as Notice);
    },
  };
}
