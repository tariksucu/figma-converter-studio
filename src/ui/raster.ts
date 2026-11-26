import type { Pixels } from './encode/tiff';

/**
 * Pictures in the panel, with the browser's own image code (Figma's desktop app is Chromium):
 * decoding what the browser reads, drawing it at a size on a canvas, and writing the canvas as
 * PNG, JPG, WebP or (where the browser can) AVIF. Nothing here touches the network.
 *
 * The panel uses it through the `Raster` interface, so the tests can stand in for it; the real
 * canvas is tried in Chromium and Firefox by dev/browser-check.mjs.
 */

export interface Picture {
  readonly width: number;
  readonly height: number;
  close(): void;
}

export interface EncodeOptions {
  /** 0 to 1, for lossy formats. */
  readonly quality?: number;
  /** The size to draw it at (default: its own). */
  readonly width?: number;
  readonly height?: number;
  /** Centred on a transparent square canvas (icons). */
  readonly square?: boolean;
  /** A colour under the picture (JPG has no transparency: white, not the canvas's black). */
  readonly background?: string;
}

export interface Raster {
  /** Whether this browser writes `mime` from a canvas (Safari writes no WebP, none writes AVIF yet). */
  canEncode(mime: string): Promise<boolean>;
  /** The picture, or `null` when this browser cannot read the file. */
  decode(data: Blob): Promise<Picture | null>;
  /** The picture as `mime`, or `null` when the browser cannot write that (or that size). */
  encode(picture: Picture, mime: string, options?: EncodeOptions): Promise<Blob | null>;
  /** RGBA pixels, not premultiplied. */
  pixels(picture: Picture): Pixels;
}

/**
 * The largest canvas the panel draws. Chromium allows 16,384 px a side and 268 million pixels;
 * Safari less. Larger exports go to the cloud or a smaller scale.
 */
export const MAX_CANVAS_SIDE = 16_384;
export const MAX_CANVAS_PIXELS = 120_000_000;

export function fitsCanvas(width: number, height: number): boolean {
  return (
    width >= 1 &&
    height >= 1 &&
    width <= MAX_CANVAS_SIDE &&
    height <= MAX_CANVAS_SIDE &&
    width * height <= MAX_CANVAS_PIXELS
  );
}

interface BitmapPicture extends Picture {
  readonly bitmap: ImageBitmap;
}

function canvasOf(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function toBlob(canvas: HTMLCanvasElement, mime: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob), mime, quality);
    } catch {
      resolve(null);
    }
  });
}

/** The browser's canvas. */
export function browserRaster(): Raster {
  const probes = new Map<string, Promise<boolean>>();
  return {
    canEncode(mime) {
      let probe = probes.get(mime);
      if (!probe) {
        // A browser that cannot write `mime` gives a PNG instead.
        probe = toBlob(canvasOf(2, 2), mime, 0.8).then((blob) => blob?.type === mime);
        probes.set(mime, probe);
      }
      return probe;
    },
    async decode(data) {
      try {
        const bitmap = await createImageBitmap(data);
        const picture: BitmapPicture = {
          bitmap,
          width: bitmap.width,
          height: bitmap.height,
          close: () => bitmap.close(),
        };
        return picture;
      } catch {
        return null;
      }
    },
    async encode(picture, mime, options = {}) {
      const { bitmap } = picture as BitmapPicture;
      const width = Math.max(1, Math.round(options.width ?? picture.width));
      const height = Math.max(1, Math.round(options.height ?? picture.height));
      const side = Math.max(width, height);
      const [canvasWidth, canvasHeight] = options.square ? [side, side] : [width, height];
      if (!fitsCanvas(canvasWidth, canvasHeight)) return null;
      const canvas = canvasOf(canvasWidth, canvasHeight);
      const context = canvas.getContext('2d');
      if (!context) return null;
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      if (options.background) {
        context.fillStyle = options.background;
        context.fillRect(0, 0, canvasWidth, canvasHeight);
      }
      context.drawImage(
        bitmap,
        Math.floor((canvasWidth - width) / 2),
        Math.floor((canvasHeight - height) / 2),
        width,
        height,
      );
      const blob = await toBlob(canvas, mime, options.quality);
      // Released at once: large canvases hold a lot of memory.
      canvas.width = 0;
      canvas.height = 0;
      return blob && blob.type === mime ? blob : null;
    },
    pixels(picture) {
      const { bitmap } = picture as BitmapPicture;
      if (!fitsCanvas(picture.width, picture.height))
        throw new Error('The picture is too large to read here.');
      const canvas = canvasOf(picture.width, picture.height);
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('This browser cannot read the picture.');
      context.drawImage(bitmap, 0, 0);
      const image = context.getImageData(0, 0, picture.width, picture.height);
      canvas.width = 0;
      canvas.height = 0;
      return { width: image.width, height: image.height, data: image.data };
    },
  };
}
