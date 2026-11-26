import { ApiError, type ConverterApi } from './api';
import type { Bridge } from './bridge';
import { convertToBlob, type Step } from './convert';
import { encodeIco, pngSize, type IconImage } from './encode/ico';
import { encodeIndexedPng, encodePng, exactPalette, normalized } from './encode/png';
import { quantize } from './encode/quantize';
import { encodeTiff, type Deflate, type Pixels } from './encode/tiff';
import { fitUnder, steps } from './fit';
import { fitsCanvas, type Picture, type Raster } from './raster';
import {
  LOCAL_QUALITY,
  LOWEST_QUALITY,
  PALETTES,
  clampKb,
  cloudIconScale,
  cloudOptions,
  exportFields,
  exportSize,
  fileName,
  iconSides,
  type ExportTarget,
  type JobSettings,
  type Route,
} from './targets';
import type { Constraint, LayerInfo } from '../shared/messages';

/**
 * One layer exported to one file, on this computer or in Converter Studio's cloud.
 *
 * Locally, Figma renders the layer (a PNG, in sRGB) at the chosen scale, or smaller to fit the
 * maximum size, and the panel writes the target with the browser's canvas or our own writers:
 * nothing leaves the computer. With "at most … KB", JPG and WebP take the highest quality that
 * fits, and PNG stays lossless when that fits, otherwise (only when the user allows it) takes
 * the most colours that fit. When nothing fits, the smallest file is kept and marked as over.
 * In the cloud, Figma's PNG or PDF of the layer is uploaded to Converter Studio, converted on the
 * account's credits and fetched back; the panel only goes there when the target cannot be made
 * locally, or when the user asks after a local failure.
 */

export interface ExportContext {
  readonly bridge: Bridge;
  readonly raster: Raster;
  /** For TIFF's and PNG's compression; `null` writes TIFF uncompressed and keeps Figma's PNG. */
  readonly deflate: Deflate | null;
  /** The cloud, with the user's key; `null` when no key is saved. */
  readonly api: ConverterApi | null;
  /** The price is above what goes ahead on its own: resolve `true` to pay it. */
  readonly confirmPrice: (credits: number) => Promise<boolean>;
  readonly onStep?: (step: Step) => void;
  readonly signal?: AbortSignal;
}

export interface Output {
  readonly name: string;
  readonly blob: Blob;
  readonly route: Route;
  /** Credits the cloud charged (0 locally). */
  readonly credits: number;
  /** How it was made, when that matters: "quality 76", "lossless", "128 colours". */
  readonly detail?: string;
  /** Over the size asked for, and why: the closest file was kept. */
  readonly over?: string;
}

/** The local way failed; the cloud may still make it, if the user asks. */
export class LocalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalError';
  }
}

/** The cloud needs a key: the panel sends the user to Settings. */
export const NO_KEY_MESSAGE =
  'Add your Converter Studio API key in Settings to convert in the cloud.';

/** What JPG puts under transparent pixels. */
export const JPG_BACKGROUND = '#ffffff';

type Made = Pick<Output, 'blob' | 'detail' | 'over'>;
type Box = { readonly maxWidth: number | null; readonly maxHeight: number | null };
const NO_BOX: Box = { maxWidth: null, maxHeight: null };

async function figmaExport(
  bridge: Bridge,
  layer: LayerInfo,
  format: 'PNG' | 'PDF',
  constraint: Constraint | null,
): Promise<Uint8Array> {
  const reply = await bridge.ask({ kind: 'export', layerId: layer.id, format, constraint });
  if (reply.kind !== 'exported') throw new Error('Figma did not export the layer.');
  return reply.bytes;
}

const pngBlob = (bytes: Uint8Array) =>
  new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/png' });

/**
 * One layer at one scale. `suffix` goes after the layer's name in the file's (`@2x` when
 * several scales are exported).
 */
export async function exportLayer(
  layer: LayerInfo,
  target: ExportTarget,
  settings: JobSettings,
  route: Route,
  context: ExportContext,
  suffix = '',
): Promise<Output> {
  const name = fileName(`${layer.name}${suffix}`, target.extension);
  if (route === 'cloud') return exportInCloud(layer, target, settings, name, context);
  const made: Made =
    target.local === 'ico'
      ? { blob: await localIcon(layer, settings, context) }
      : await withPicture(layer, target, settings, context, async (picture, figmaPng) => {
          if (target.local === 'tiff') return { blob: await localTiff(picture, settings, context) };
          if (target.local === 'png') return localPng(picture, figmaPng, settings, context);
          return localLossy(picture, target, settings, context);
        });
  return { name, ...made, route: 'local', credits: 0 };
}

/** The size to draw a `width` × `height` picture at so it fits in the box, or `null` if it does. */
function shrinkToFit(
  width: number,
  height: number,
  box: Box,
): { width: number; height: number } | null {
  const fx = box.maxWidth !== null && width > box.maxWidth ? box.maxWidth / width : 1;
  const fy = box.maxHeight !== null && height > box.maxHeight ? box.maxHeight / height : 1;
  const f = Math.min(fx, fy);
  if (f >= 1) return null;
  return { width: Math.max(1, Math.round(width * f)), height: Math.max(1, Math.round(height * f)) };
}

/**
 * Figma's PNG of the layer at the job's scale (or fitted to the maximum size), read by the
 * browser. `use` also gets Figma's PNG itself, while the picture is exactly that PNG.
 */
async function withPicture(
  layer: LayerInfo,
  target: ExportTarget,
  settings: JobSettings,
  context: ExportContext,
  use: (picture: Picture, figmaPng: Uint8Array | null) => Promise<Made>,
): Promise<Made> {
  const box = exportFields(target).maxSize ? settings : NO_BOX;
  const { constraint, width, height } = exportSize(layer, settings.scale, box);
  if (!fitsCanvas(width, height))
    throw new LocalError(
      `At ${settings.scale}× this layer is ${width} × ${height} px, too large to convert here. Choose a smaller scale.`,
    );
  const png = await figmaExport(context.bridge, layer, 'PNG', constraint);
  let picture = await context.raster.decode(pngBlob(png));
  if (!picture) throw new LocalError("This app could not read Figma's export of the layer.");
  let figmaPng: Uint8Array | null = png;
  // A shadow or a blur makes Figma's export larger than the layer: still within the maximum size.
  const smaller = shrinkToFit(picture.width, picture.height, box);
  if (smaller) {
    const drawn = await context.raster.encode(picture, 'image/png', smaller);
    picture.close();
    picture = drawn ? await context.raster.decode(drawn) : null;
    if (!picture) throw new LocalError('This app could not make the layer smaller.');
    figmaPng = null;
  }
  try {
    return await use(picture, figmaPng);
  } finally {
    picture.close();
  }
}

/** JPG or WebP with the browser's encoder: the chosen quality, or the highest that fits. */
async function localLossy(
  picture: Picture,
  target: ExportTarget,
  settings: JobSettings,
  context: ExportContext,
): Promise<Made> {
  const background = target.id === 'jpg' ? JPG_BACKGROUND : undefined;
  const encode = async (percent: number) => {
    const blob = await context.raster.encode(picture, target.mime, {
      quality: percent / 100,
      ...(background ? { background } : {}),
    });
    if (!blob)
      throw new LocalError(`This app could not write ${target.label} for a picture of this size.`);
    return blob;
  };
  const chosen = Math.round(LOCAL_QUALITY[settings.quality] * 100);
  const maxKb = clampKb(settings.maxKb);
  if (maxKb === null) return { blob: await encode(chosen) };
  const fitted = await fitUnder(
    steps(chosen, LOWEST_QUALITY),
    maxKb * 1000,
    encode,
    context.signal,
  );
  return {
    blob: fitted.blob,
    detail: `quality ${fitted.setting}`,
    over: fitted.fits ? undefined : `over ${maxKb} KB even at quality ${fitted.setting}`,
  };
}

/**
 * PNG: the smaller of Figma's own and our lossless writer's. With "at most … KB" and fewer
 * colours allowed, the most colours that fit; with fewer colours allowed and no size, 256.
 */
async function localPng(
  picture: Picture,
  figmaPng: Uint8Array | null,
  settings: JobSettings,
  context: ExportContext,
): Promise<Made> {
  const { raster, deflate, signal } = context;
  const maxKb = clampKb(settings.maxKb);
  const maxBytes = maxKb === null ? Infinity : maxKb * 1000;
  const figma = figmaPng ? pngBlob(figmaPng) : await raster.encode(picture, 'image/png');
  if (!deflate) {
    // No compressor in this app: Figma's PNG as it is.
    if (!figma) throw new LocalError('This app could not write PNG.');
    return { blob: figma, over: figma.size > maxBytes ? `over ${maxKb} KB` : undefined };
  }
  let pixels: Pixels;
  try {
    pixels = normalized(raster.pixels(picture));
  } catch (error) {
    throw new LocalError(error instanceof Error ? error.message : 'Could not read the picture.');
  }
  const ours = pngBlob(await encodePng(pixels, deflate));
  const lossless = figma && figma.size <= ours.size ? figma : ours;
  const keepLossless = (over: string | undefined): Made => ({
    blob: lossless,
    detail: 'lossless',
    over,
  });
  if (!settings.reduceColors)
    return keepLossless(lossless.size > maxBytes ? `over ${maxKb} KB (lossless)` : undefined);
  if (lossless.size <= maxBytes && maxKb !== null) return keepLossless(undefined);

  // Fewer colours than the picture has (a picture with at most 256 is a lossless palette PNG
  // already).
  const exact = exactPalette(pixels);
  const colours = exact ? exact.palette.length / 4 : Infinity;
  if (maxKb === null && exact) return keepLossless(undefined);
  const candidates = PALETTES.filter((count) => count < colours);
  if (candidates.length === 0)
    return keepLossless(lossless.size > maxBytes ? `over ${maxKb} KB` : undefined);
  const entries = new Map<number, number>();
  const encodeColours = async (count: number) => {
    const indexed = await quantize(pixels, count, signal);
    entries.set(count, indexed.palette.length / 4);
    return pngBlob(await encodeIndexedPng(indexed, deflate));
  };
  const describe = (count: number) => `${entries.get(count) ?? count} colours`;
  if (maxKb === null) {
    const blob = await encodeColours(candidates[0]!);
    return blob.size < lossless.size
      ? { blob, detail: describe(candidates[0]!) }
      : keepLossless(undefined);
  }
  const fitted = await fitUnder(candidates, maxBytes, encodeColours, signal);
  if (!fitted.fits && lossless.size <= fitted.blob.size)
    return keepLossless(`over ${maxKb} KB (lossless)`);
  return {
    blob: fitted.blob,
    detail: describe(fitted.setting),
    over: fitted.fits ? undefined : `over ${maxKb} KB even with ${describe(fitted.setting)}`,
  };
}

/** TIFF with our writer: RGB, or RGB and alpha when the layer has transparent pixels. */
async function localTiff(
  picture: Picture,
  settings: JobSettings,
  context: ExportContext,
): Promise<Blob> {
  let pixels;
  try {
    pixels = context.raster.pixels(picture);
  } catch (error) {
    throw new LocalError(error instanceof Error ? error.message : 'Could not read the picture.');
  }
  const bytes = await encodeTiff(pixels, {
    deflate: context.deflate,
    dpi: 72 * settings.scale,
    software: 'Converter Studio for Figma',
  });
  return new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/tiff' });
}

/** An ICO: Figma renders the layer at each icon size; non-square layers are centred. */
async function localIcon(
  layer: LayerInfo,
  settings: JobSettings,
  context: ExportContext,
): Promise<Blob> {
  const images: IconImage[] = [];
  for (const side of iconSides(settings.iconSize)) {
    const constraint: Constraint =
      layer.width >= layer.height
        ? { type: 'WIDTH', value: side }
        : { type: 'HEIGHT', value: side };
    const png = await figmaExport(context.bridge, layer, 'PNG', constraint);
    const size = pngSize(png);
    if (size && size.width === side && size.height === side) {
      images.push({ size: side, png });
      continue;
    }
    const picture = await context.raster.decode(pngBlob(png));
    if (!picture) throw new LocalError("This app could not read Figma's export of the layer.");
    try {
      // The longer side becomes the icon's side, on a transparent square.
      const fit = side / Math.max(picture.width, picture.height, 1);
      const square = await context.raster.encode(picture, 'image/png', {
        width: Math.max(1, Math.round(picture.width * fit)),
        height: Math.max(1, Math.round(picture.height * fit)),
        square: true,
      });
      if (!square) throw new LocalError('This app could not draw the icon.');
      images.push({ size: side, png: new Uint8Array(await square.arrayBuffer()) });
    } finally {
      picture.close();
    }
  }
  const bytes = encodeIco(images);
  return new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'image/x-icon' });
}

async function exportInCloud(
  layer: LayerInfo,
  target: ExportTarget,
  settings: JobSettings,
  name: string,
  context: ExportContext,
): Promise<Output> {
  const api = context.api;
  if (!api) throw new ApiError('noKey', NO_KEY_MESSAGE, 0);
  if (!target.cloud) throw new LocalError(`${target.label} is made on this computer only.`);
  const { figma, from, to } = target.cloud;
  const constraint: Constraint | null =
    figma === 'PDF'
      ? null
      : target.id === 'ico'
        ? { type: 'SCALE', value: cloudIconScale(layer) }
        : exportSize(layer, settings.scale, exportFields(target).maxSize ? settings : NO_BOX)
            .constraint;
  const bytes = await figmaExport(context.bridge, layer, figma, constraint);
  const file = new Blob([bytes as Uint8Array<ArrayBuffer>], {
    type: figma === 'PDF' ? 'application/pdf' : 'image/png',
  });
  const { blob, finished } = await convertToBlob(
    api,
    { file, name: fileName(layer.name, from), to, options: cloudOptions(target, settings) },
    { confirmPrice: context.confirmPrice, onStep: context.onStep, signal: context.signal },
  );
  return {
    name,
    blob: new Blob([blob], { type: target.mime }),
    route: 'cloud',
    credits: finished.credits,
  };
}
