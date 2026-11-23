import { ApiError, type ConverterApi, type FormatInfo } from './api';
import type { Bridge } from './bridge';
import { convertToBlob, type Step } from './convert';
import { NO_KEY_MESSAGE } from './exporter';
import type { Picture, Raster } from './raster';
import {
  FIGMA_NATIVE,
  cloudPlan,
  extensionOf,
  formatBytes,
  layerName,
  type Catalog,
  type PlaceSettings,
} from './targets';
import { FIGMA_MAX_IMAGE_SIDE, MAX_IMAGE_BYTES, type Destination } from '../shared/messages';

/**
 * A picked file placed on the canvas. What happens depends on the file:
 *
 * - Figma places it itself (PNG, JPG, GIF, WebP, HEIC, SVG): the panel says so.
 * - The browser reads it (AVIF, BMP, ICO; TIFF in Safari): it becomes a PNG in the panel and is
 *   placed, on this computer.
 * - Converter Studio converts it (camera RAW, TIFF, AI, EPS…): only when the user presses the
 *   cloud button; the file is uploaded, converted to PNG (or to SVG, editable vector layers) on
 *   the account's credits and placed.
 */

export type PlacePlan =
  | { readonly kind: 'native'; readonly extension: string }
  | { readonly kind: 'local'; readonly picture: Picture }
  | { readonly kind: 'cloud'; readonly format: FormatInfo }
  | { readonly kind: 'unsupported' };

export async function planPlace(file: File, catalog: Catalog, raster: Raster): Promise<PlacePlan> {
  const extension = extensionOf(file.name) ?? '';
  if (FIGMA_NATIVE.has(extension)) return { kind: 'native', extension };
  const picture = await raster.decode(file);
  if (picture) return { kind: 'local', picture };
  const format = catalog.formatOfName(file.name);
  if (format && cloudPlan(format, { longSide: '2560', drawingAs: 'svg' }, catalog))
    return { kind: 'cloud', format };
  return { kind: 'unsupported' };
}

export interface PlaceContext {
  readonly bridge: Bridge;
  readonly raster: Raster;
  readonly api: ConverterApi | null;
  readonly confirmPrice: (credits: number) => Promise<boolean>;
  readonly onStep?: (step: Step) => void;
  readonly signal?: AbortSignal;
}

export interface PlaceResult {
  readonly name: string;
  readonly destination: Destination;
  /** Credits the cloud charged (0 locally). */
  readonly credits: number;
}

/** A picture as a PNG Figma takes: at most 4096 px a side (smaller ones keep their size). */
async function figmaPicture(picture: Picture, raster: Raster): Promise<Uint8Array> {
  const fit = Math.min(1, FIGMA_MAX_IMAGE_SIDE / Math.max(picture.width, picture.height, 1));
  const size = {
    width: Math.max(1, Math.round(picture.width * fit)),
    height: Math.max(1, Math.round(picture.height * fit)),
  };
  let blob = await raster.encode(picture, 'image/png', size);
  // A photo's PNG can be very large; Figma takes a JPEG as well.
  if (blob && blob.size > MAX_IMAGE_BYTES)
    blob = await raster.encode(picture, 'image/jpeg', { ...size, quality: 0.92 });
  if (!blob) throw new Error('This app could not draw the picture.');
  if (blob.size > MAX_IMAGE_BYTES)
    throw new Error(`The picture is too large to place (${formatBytes(blob.size)}).`);
  return new Uint8Array(await blob.arrayBuffer());
}

async function placeBytes(bridge: Bridge, name: string, bytes: Uint8Array): Promise<PlaceResult> {
  const reply = await bridge.ask({ kind: 'place-image', name, bytes });
  if (reply.kind !== 'placed') throw new Error('Figma did not place the picture.');
  return { name: reply.name, destination: reply.destination, credits: 0 };
}

/** A picture the browser read, placed as a PNG. */
export async function placeLocal(
  file: File,
  picture: Picture,
  context: PlaceContext,
): Promise<PlaceResult> {
  const bytes = await figmaPicture(picture, context.raster);
  return placeBytes(context.bridge, layerName(file.name), bytes);
}

/** A file converted by Converter Studio, then placed. */
export async function placeInCloud(
  file: File,
  format: FormatInfo,
  settings: PlaceSettings,
  catalog: Catalog,
  context: PlaceContext,
): Promise<PlaceResult> {
  const api = context.api;
  if (!api) throw new ApiError('noKey', NO_KEY_MESSAGE, 0);
  const plan = cloudPlan(format, settings, catalog);
  if (!plan)
    throw new ApiError('unsupportedConversion', 'Converter Studio cannot place this file.', 0);
  const name = layerName(file.name);
  const { blob, finished } = await convertToBlob(
    api,
    { file, name: file.name, to: plan.to, options: plan.options },
    { confirmPrice: context.confirmPrice, onStep: context.onStep, signal: context.signal },
  );
  if (plan.to === 'svg') {
    const reply = await context.bridge.ask({ kind: 'place-svg', name, svg: await blob.text() });
    if (reply.kind !== 'placed') throw new Error('Figma did not place the drawing.');
    return { name: reply.name, destination: reply.destination, credits: finished.credits };
  }
  const picture = await context.raster.decode(blob);
  if (!picture) throw new Error('This app could not read the converted picture.');
  try {
    const placed = await placeBytes(
      context.bridge,
      name,
      await figmaPicture(picture, context.raster),
    );
    return { ...placed, credits: finished.credits };
  } finally {
    picture.close();
  }
}
