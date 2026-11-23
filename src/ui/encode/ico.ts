/**
 * An ICO writer: square PNG pictures (16 to 256 px) in one icon file, the way Windows Vista and
 * later, and every current browser, read favicons. Each size is drawn by Figma itself at that
 * size, so small icons stay sharp instead of being shrunk from a large one.
 *
 * Our own code from Microsoft's ICO layout (ICONDIR, ICONDIRENTRY); it runs in the plugin's
 * panel, on the user's computer.
 */

export interface IconImage {
  /** The side in pixels (1 to 256). */
  readonly size: number;
  /** A square PNG of that size. */
  readonly png: Uint8Array;
}

/** A favicon: the sizes browsers and Windows ask for. */
export const FAVICON_SIZES = [16, 32, 48] as const;
export const ICON_SIDES = [256, 128, 64, 48, 32, 16] as const;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A PNG's width and height (from its IHDR), or `null` when it is not a PNG. */
export function pngSize(png: Uint8Array): { width: number; height: number } | null {
  if (png.length < 24 || PNG_SIGNATURE.some((byte, i) => png[i] !== byte)) return null;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

export function encodeIco(images: readonly IconImage[]): Uint8Array {
  if (images.length === 0) throw new Error('An icon needs at least one size.');
  const sorted = [...images].sort((a, b) => a.size - b.size);
  for (const image of sorted) {
    const size = pngSize(image.png);
    if (!size) throw new Error('Every icon size must be a PNG.');
    if (size.width !== image.size || size.height !== image.size || image.size > 256)
      throw new Error(`The ${image.size} px icon is not ${image.size} × ${image.size} pixels.`);
  }
  const header = 6 + sorted.length * 16;
  const total = header + sorted.reduce((sum, image) => sum + image.png.byteLength, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint16(0, 0, true);
  // 1: an icon (2 would be a cursor).
  view.setUint16(2, 1, true);
  view.setUint16(4, sorted.length, true);
  let offset = header;
  sorted.forEach((image, i) => {
    const at = 6 + i * 16;
    // 0 stands for 256.
    out[at] = image.size % 256;
    out[at + 1] = image.size % 256;
    // No palette, reserved.
    out[at + 2] = 0;
    out[at + 3] = 0;
    // Colour planes, bits a pixel.
    view.setUint16(at + 4, 1, true);
    view.setUint16(at + 6, 32, true);
    view.setUint32(at + 8, image.png.byteLength, true);
    view.setUint32(at + 12, offset, true);
    out.set(image.png, offset);
    offset += image.png.byteLength;
  });
  return out;
}
