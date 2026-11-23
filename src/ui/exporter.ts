import { ApiError, type ConverterApi } from './api';
import type { Bridge } from './bridge';
import { convertToBlob, type Step } from './convert';
import { encodeIco, pngSize, type IconImage } from './encode/ico';
import { encodeTiff, type Deflate } from './encode/tiff';
import { fitsCanvas, type Picture, type Raster } from './raster';
import {
  LOCAL_QUALITY,
  clampKb,
  cloudIconScale,
  cloudOptions,
  fileName,
  formatBytes,
  iconSides,
  type ExportSettings,
  type ExportTarget,
  type Route,
} from './targets';
import type { Constraint, LayerInfo } from '../shared/messages';

/**
 * One layer exported to one file, on this computer or in Converter Studio's cloud.
 *
 * Locally, Figma renders the layer (a PNG, in sRGB) and the panel writes the target with the
 * browser's canvas or our own writers: nothing leaves the computer. In the cloud, Figma's PNG
 * or PDF of the layer is uploaded to Converter Studio, converted on the account's credits and
 * fetched back; the panel only goes there when the target cannot be made locally, or when the
 * user asks after a local failure.
 */

export interface ExportContext {
  readonly bridge: Bridge;
  readonly raster: Raster;
  /** For TIFF's compression; `null` writes it uncompressed. */
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

export async function exportLayer(
  layer: LayerInfo,
  target: ExportTarget,
  settings: ExportSettings,
  route: Route,
  context: ExportContext,
): Promise<Output> {
  const name = fileName(layer.name, target.extension);
  if (route === 'cloud') return exportInCloud(layer, target, settings, name, context);
  const blob =
    target.local === 'ico'
      ? await localIcon(layer, settings, context)
      : await withPicture(layer, settings, context, (picture) =>
          target.local === 'tiff'
            ? localTiff(picture, settings, context)
            : localCanvas(picture, target, settings, context),
        );
  return { name, blob, route: 'local', credits: 0 };
}

/** Figma's PNG of the layer at the chosen scale, read by the browser. */
async function withPicture<T>(
  layer: LayerInfo,
  settings: ExportSettings,
  context: ExportContext,
  use: (picture: Picture) => Promise<T>,
): Promise<T> {
  const scale = settings.scale;
  const width = Math.ceil(layer.width * scale);
  const height = Math.ceil(layer.height * scale);
  if (!fitsCanvas(width, height))
    throw new LocalError(
      `At ${scale}× this layer is ${width} × ${height} px, too large to convert here. Choose a smaller scale.`,
    );
  const png = await figmaExport(context.bridge, layer, 'PNG', { type: 'SCALE', value: scale });
  const picture = await context.raster.decode(pngBlob(png));
  if (!picture) throw new LocalError("This app could not read Figma's export of the layer.");
  try {
    return await use(picture);
  } finally {
    picture.close();
  }
}

/** WebP (or AVIF, where the browser writes it) with the browser's encoder. */
async function localCanvas(
  picture: Picture,
  target: ExportTarget,
  settings: ExportSettings,
  context: ExportContext,
): Promise<Blob> {
  const { raster } = context;
  const encode = (quality: number) => raster.encode(picture, target.mime, { quality });
  const cannot = () =>
    new LocalError(`This app could not write ${target.label} for a picture of this size.`);
  const quality = LOCAL_QUALITY[settings.quality];
  const first = await encode(quality);
  if (!first) throw cannot();
  const maxKb = clampKb(settings.maxKb);
  if (maxKb === null || first.size <= maxKb * 1000) return first;

  // The highest quality that stays under the limit: a few halvings of the quality range.
  let low = 0.05;
  let high = quality;
  let best: Blob | null = null;
  const lowest = await encode(low);
  if (!lowest) throw cannot();
  if (lowest.size > maxKb * 1000)
    throw new LocalError(
      `Even at the lowest quality this is ${formatBytes(lowest.size)}, over ${maxKb} KB. Choose a smaller scale or a larger limit.`,
    );
  best = lowest;
  for (let step = 0; step < 6; step++) {
    const middle = (low + high) / 2;
    const blob = await encode(middle);
    if (!blob) throw cannot();
    if (blob.size <= maxKb * 1000) {
      best = blob;
      low = middle;
    } else high = middle;
  }
  return best;
}

/** TIFF with our writer: RGB, or RGB and alpha when the layer has transparent pixels. */
async function localTiff(
  picture: Picture,
  settings: ExportSettings,
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
  settings: ExportSettings,
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
  settings: ExportSettings,
  name: string,
  context: ExportContext,
): Promise<Output> {
  const api = context.api;
  if (!api) throw new ApiError('noKey', NO_KEY_MESSAGE, 0);
  const { figma, from, to } = target.cloud;
  const scale = target.id === 'ico' ? cloudIconScale(layer) : settings.scale;
  const bytes = await figmaExport(
    context.bridge,
    layer,
    figma,
    figma === 'PDF' ? null : { type: 'SCALE', value: scale },
  );
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
