import type { ConversionOptions, FormatInfo } from './api';
import { FAVICON_SIZES } from './encode/ico';
import {
  COMPRESSIONS,
  ICON_SIZES,
  MAX_KB,
  MIN_KB,
  QUALITIES,
  SCALES,
  type Compression,
  type Constraint,
  type ExportFormat,
  type ExportPrefs,
  type IconSize,
  type Quality,
} from '../shared/messages';

export { COMPRESSIONS, ICON_SIZES, MAX_KB, MIN_KB, QUALITIES, SCALES };
export type { Compression, IconSize, Quality };

/**
 * What the plugin offers, and where each one is done.
 *
 * **Export.** Figma exports PNG, JPG, SVG and PDF, as they come. The plugin adds JPG and PNG
 * that stay under a size, and WebP, AVIF, TIFF, ICO and a smaller PDF. JPG, PNG, WebP, TIFF and
 * ICO are made **in Figma**, in the panel on the user's computer: JPG and WebP with the
 * browser's own encoder (Figma's desktop app, Chrome, Edge and Firefox write WebP; Safari does
 * not), PNG, TIFF and ICO with our own small writers (PNG's fewer colours with image-q). AVIF
 * and the smaller PDF need
 * **Converter Studio's cloud** (no browser writes AVIF from a canvas yet, and PDF compression
 * needs a PDF engine): Figma's PNG or PDF of the layer is uploaded, converted on the user's
 * credits and fetched back. A format made in Figma can also be sent to the cloud, but only when
 * the user asks ("Try in the cloud") after the local way failed.
 *
 * **Place.** Figma places PNG, JPG, GIF, WebP, HEIC and SVG files itself (drag them onto the
 * canvas); the plugin says so instead of converting them. AVIF, BMP and ICO pictures are read
 * in Figma by the browser (TIFF too, in Safari); camera RAW, Illustrator and EPS files and what
 * the browser cannot read are converted in the cloud, when the user asks.
 *
 * Only what the cloud can do right now (`/v1/formats`) is offered for the cloud.
 */

export type Route = 'local' | 'cloud';

// ── Export ────────────────────────────────────────────────────────────────────────────────

export type ExportId = ExportFormat;

export interface ExportTarget {
  readonly id: ExportId;
  readonly label: string;
  readonly extension: string;
  readonly mime: string;
  readonly hint: string;
  /** How the panel makes it on this computer: the browser's canvas (if it writes `mime`), our
   * PNG, TIFF or ICO writer, or not at all. */
  readonly local: 'canvas' | 'png' | 'tiff' | 'ico' | null;
  /** What Figma exports for the cloud, and what Converter Studio converts it from and to;
   * `null`: made on this computer only. */
  readonly cloud: {
    readonly figma: 'PNG' | 'PDF';
    readonly from: string;
    readonly to: string;
  } | null;
}

export const EXPORT_TARGETS: readonly ExportTarget[] = [
  {
    id: 'jpg',
    label: 'JPG',
    extension: 'jpg',
    mime: 'image/jpeg',
    hint: 'Photos and banners. A quality, or a size it must stay under. Transparent areas become white.',
    local: 'canvas',
    cloud: { figma: 'PNG', from: 'png', to: 'jpg' },
  },
  {
    id: 'png',
    label: 'PNG',
    extension: 'png',
    mime: 'image/png',
    hint: "Lossless, usually smaller than Figma's own, with transparency. Allow fewer colours for a smaller file.",
    local: 'png',
    cloud: null,
  },
  {
    id: 'webp',
    label: 'WebP',
    extension: 'webp',
    mime: 'image/webp',
    hint: 'Small web images with transparency. A quality, or a size it must stay under.',
    local: 'canvas',
    cloud: { figma: 'PNG', from: 'png', to: 'webp' },
  },
  {
    id: 'avif',
    label: 'AVIF',
    extension: 'avif',
    mime: 'image/avif',
    hint: 'The smallest web images, with transparency.',
    local: 'canvas',
    cloud: { figma: 'PNG', from: 'png', to: 'avif' },
  },
  {
    id: 'tiff',
    label: 'TIFF',
    extension: 'tiff',
    mime: 'image/tiff',
    hint: 'Lossless, for print and photo tools.',
    local: 'tiff',
    cloud: { figma: 'PNG', from: 'png', to: 'tiff' },
  },
  {
    id: 'ico',
    label: 'ICO (favicon)',
    extension: 'ico',
    mime: 'image/x-icon',
    hint: 'A favicon with 16, 32 and 48 px, each drawn by Figma at its size, or one size.',
    local: 'ico',
    cloud: { figma: 'PNG', from: 'png', to: 'ico' },
  },
  {
    id: 'pdf',
    label: 'PDF (smaller)',
    extension: 'pdf',
    mime: 'application/pdf',
    hint: "Figma's PDF with its pictures compressed.",
    local: null,
    cloud: { figma: 'PDF', from: 'pdf', to: 'pdf' },
  },
];

/** What this browser can write from a canvas, found out once when the panel opens. */
export interface Capabilities {
  readonly encodes: ReadonlySet<string>;
}

export class Catalog {
  private readonly byId = new Map<string, FormatInfo>();
  private readonly byExtension = new Map<string, FormatInfo>();

  /** `formats`: the cloud's list, or `null` when it could not be fetched (offline). */
  constructor(readonly formats: readonly FormatInfo[] | null) {
    for (const format of formats ?? []) {
      this.byId.set(format.id, format);
      for (const extension of format.extensions)
        this.byExtension.set(extension.toLowerCase(), format);
    }
  }

  get online(): boolean {
    return this.formats !== null;
  }

  converts(from: string, to: string): boolean {
    return (this.byId.get(from)?.to ?? []).includes(to);
  }

  get(id: string): FormatInfo | undefined {
    return this.byId.get(id);
  }

  /** A file's format, by its name's extension. */
  formatOfName(name: string): FormatInfo | undefined {
    const extension = extensionOf(name);
    return extension ? this.byExtension.get(extension) : undefined;
  }
}

export function canMakeLocally(target: ExportTarget, caps: Capabilities): boolean {
  if (target.local === 'canvas') return caps.encodes.has(target.mime);
  return target.local !== null;
}

export function canMakeInCloud(target: ExportTarget, catalog: Catalog): boolean {
  return target.cloud !== null && catalog.converts(target.cloud.from, target.cloud.to);
}

/** Where a target is made: on this computer when it can be, otherwise in the cloud. */
export function routeOf(target: ExportTarget, caps: Capabilities, catalog: Catalog): Route | null {
  if (canMakeLocally(target, caps)) return 'local';
  if (canMakeInCloud(target, catalog)) return 'cloud';
  return null;
}

/** The browser encoder's quality for each choice. */
export const LOCAL_QUALITY: Readonly<Record<Quality, number>> = {
  high: 0.9,
  balanced: 0.8,
  small: 0.65,
};
/** The lowest quality (percent) a size search goes down to (WebP's floor since 1.0.0). */
export const LOWEST_QUALITY = 5;
/** The palettes PNG's size search tries, from the most colours down. */
export const PALETTES = [256, 192, 128, 96, 64, 48, 32, 24, 16, 12, 8, 4, 2] as const;

/** The export settings, as the panel shows and remembers them. */
export type ExportSettings = Omit<ExportPrefs, 'format'>;
/** One file's settings: one of the chosen scales. */
export type JobSettings = Omit<ExportSettings, 'scales'> & { readonly scale: number };

export const DEFAULT_EXPORT: ExportSettings = {
  scales: [1],
  quality: 'high',
  maxKb: null,
  maxWidth: null,
  maxHeight: null,
  iconSize: 'favicon',
  compression: 'balanced',
  reduceColors: false,
};

export function jobOf(settings: ExportSettings, scale: number): JobSettings {
  const { scales: _scales, ...rest } = settings;
  return { ...rest, scale };
}

export const DEFAULT_JOB: JobSettings = jobOf(DEFAULT_EXPORT, 1);

/** The remembered settings (`figma.clientStorage`) over the defaults. */
export function settingsFrom(prefs: Partial<ExportPrefs> | null): ExportSettings {
  const { format: _format, ...rest } = prefs ?? {};
  return { ...DEFAULT_EXPORT, ...rest };
}

/** Which settings a target shows. `scale`: several scales at once, one, or none. */
export function exportFields(target: ExportTarget): {
  scale: 'several' | 'one' | false;
  quality: boolean;
  maxKb: boolean;
  maxSize: boolean;
  iconSize: boolean;
  compression: boolean;
  reduceColors: boolean;
} {
  const id = target.id;
  const web = id === 'jpg' || id === 'png' || id === 'webp' || id === 'avif';
  return {
    // Each AVIF is a cloud conversion: one scale at a time.
    scale: id === 'avif' ? 'one' : web || id === 'tiff' ? 'several' : false,
    quality: id === 'jpg' || id === 'webp' || id === 'avif',
    maxKb: web,
    maxSize: web,
    iconSize: id === 'ico',
    compression: id === 'pdf',
    reduceColors: id === 'png',
  };
}

/** The scales a target exports: the chosen ones, the first of them, or 1 for ICO and PDF. */
export function scalesFor(target: ExportTarget, settings: ExportSettings): number[] {
  const field = exportFields(target).scale;
  if (field === false) return [1];
  const scales = settings.scales.length ? [...settings.scales] : [1];
  return field === 'one' ? scales.slice(0, 1) : scales;
}

/** A file name's suffix for a scale, as Figma writes it (`@2x`), when several are exported. */
export function scaleSuffix(scale: number, several: boolean): string {
  return several && scale !== 1 ? `@${scale}x` : '';
}

/**
 * What Figma is asked for: the layer at the scale, or less so that it fits in the maximum
 * width and height (exactly that width or height, the other side in proportion), and the size
 * that should come back.
 */
export function exportSize(
  layer: { readonly width: number; readonly height: number },
  scale: number,
  box: { readonly maxWidth: number | null; readonly maxHeight: number | null },
): { constraint: Constraint; width: number; height: number } {
  const width = layer.width * scale;
  const height = layer.height * scale;
  const fx = box.maxWidth !== null && width > box.maxWidth ? box.maxWidth / width : 1;
  const fy = box.maxHeight !== null && height > box.maxHeight ? box.maxHeight / height : 1;
  if (fx >= 1 && fy >= 1)
    return {
      constraint: { type: 'SCALE', value: scale },
      width: Math.ceil(width),
      height: Math.ceil(height),
    };
  if (fx <= fy)
    return {
      constraint: { type: 'WIDTH', value: box.maxWidth! },
      width: box.maxWidth!,
      height: Math.max(1, Math.round(height * fx)),
    };
  return {
    constraint: { type: 'HEIGHT', value: box.maxHeight! },
    width: Math.max(1, Math.round(width * fy)),
    height: box.maxHeight!,
  };
}

/** The icon sizes an ICO holds. */
export function iconSides(size: IconSize): number[] {
  return size === 'favicon' ? [...FAVICON_SIZES] : [Number(size)];
}

/** A `maxKb` the API takes, or `null`. */
export function clampKb(value: number | null): number | null {
  if (value === null || !Number.isFinite(value) || value <= 0) return null;
  return Math.min(MAX_KB, Math.max(MIN_KB, Math.round(value)));
}

/** Converter Studio's options for a cloud export. */
export function cloudOptions(target: ExportTarget, settings: JobSettings): ConversionOptions {
  const fields = exportFields(target);
  const options: ConversionOptions = {};
  if (fields.quality) options.quality = settings.quality;
  const maxKb = fields.maxKb ? clampKb(settings.maxKb) : null;
  if (maxKb !== null) options.maxKb = maxKb;
  if (fields.iconSize) options.iconSize = settings.iconSize;
  if (fields.compression) options.compression = settings.compression;
  return options;
}

/**
 * The scale Figma exports a layer at for the cloud's ICO: at least 256 px on its longer side
 * (Converter Studio scales it down to each icon size).
 */
export function cloudIconScale(layer: { width: number; height: number }): number {
  const longer = Math.max(layer.width, layer.height, 1);
  return Math.min(4, Math.max(1, Math.ceil((256 / longer) * 100) / 100));
}

// ── Place ─────────────────────────────────────────────────────────────────────────────────

/** What Figma places on its own (Figma's help: "Add images and videos to designs"). */
export const FIGMA_NATIVE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif', 'svg']);

/** Converter Studio formats the panel sends to the cloud to place, and as what. */
export const CLOUD_PLACE: Readonly<Record<string, 'photo' | 'drawing'>> = {
  avif: 'photo',
  tiff: 'photo',
  bmp: 'photo',
  ico: 'photo',
  cr2: 'photo',
  nef: 'photo',
  arw: 'photo',
  dng: 'photo',
  eps: 'drawing',
  ai: 'drawing',
};

/** Pictures from the cloud: the longer side at most (the API's `longSide`), or Figma's limit. */
export const LONG_SIDES = ['2560', '1920', '1280', 'max'] as const;
export type LongSide = (typeof LONG_SIDES)[number];
export type DrawingAs = 'svg' | 'png';

export interface PlaceSettings {
  readonly longSide: LongSide;
  readonly drawingAs: DrawingAs;
}

export const DEFAULT_PLACE: PlaceSettings = { longSide: '2560', drawingAs: 'svg' };

export function extensionOf(name: string): string | undefined {
  const match = /\.([A-Za-z0-9]+)$/.exec(name.trim());
  return match ? match[1]!.toLowerCase() : undefined;
}

/** What the cloud makes of a picked file to place, or `null` when it does not take it. */
export function cloudPlan(
  format: FormatInfo | undefined,
  settings: PlaceSettings,
  catalog: Catalog,
): { to: 'png' | 'svg'; options: ConversionOptions } | null {
  const kind = format ? CLOUD_PLACE[format.id] : undefined;
  if (!format || !kind) return null;
  if (kind === 'drawing' && settings.drawingAs === 'svg' && catalog.converts(format.id, 'svg'))
    return { to: 'svg', options: {} };
  if (!catalog.converts(format.id, 'png')) return null;
  // Drawings: the vector engine has no size setting.
  if (kind === 'drawing') return { to: 'png', options: {} };
  return {
    to: 'png',
    options: settings.longSide === 'max' ? {} : { longSide: settings.longSide },
  };
}

/** The file picker's `accept`: what the panel places (Figma's own formats are left to Figma). */
export function acceptList(catalog: Catalog): string {
  const extensions = new Set(['avif', 'bmp', 'ico', 'tif', 'tiff']);
  for (const id of Object.keys(CLOUD_PLACE))
    for (const extension of catalog.get(id)?.extensions ?? []) extensions.add(extension);
  return [...extensions].map((e) => `.${e}`).join(',');
}

// ── Names and sizes ───────────────────────────────────────────────────────────────────────

/** A file name from a layer's name: what a file system takes, with the target's extension. */
export function fileName(layerName: string, extension: string): string {
  const base =
    layerName
      // Characters Windows, macOS or Linux refuse in a name.
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^\.+/, '')
      .slice(0, 120) || 'Layer';
  return `${base}.${extension}`;
}

/** A placed file's layer name: the file's name without its extension. */
export function layerName(file: string): string {
  return file.trim().replace(/\.[A-Za-z0-9]{1,5}$/, '') || 'Converted';
}

export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1000 * 1000) return `${Math.round(bytes / 1000)} KB`;
  return `${(bytes / (1000 * 1000)).toFixed(1).replace(/\.0$/, '')} MB`;
}
