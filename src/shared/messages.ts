/**
 * The messages between the plugin's code inside Figma (src/code: `figma.ui.onmessage`,
 * `figma.ui.postMessage`) and its panel, the iframe Figma opens with `figma.showUI` (src/ui:
 * `parent.postMessage({ pluginMessage }, '*')`, the window's `message` event).
 *
 * Each side checks every message's shape on arrival (`parseRequest`, `parsePluginMessage`) and
 * ignores what does not fit: a message is data, never code.
 */

/** Marks our messages, so anything else that reaches a window is ignored. */
export const SOURCE = 'converter-studio';

/** The most layers one export takes (several go into one ZIP). */
export const MAX_LAYERS = 20;
/** Layer and file names are cut to this length on the way. */
export const MAX_NAME = 200;
/** Figma's limit for an image: larger ones are refused (`figma.createImage`). */
export const FIGMA_MAX_IMAGE_SIDE = 4096;
/** The largest picture the panel hands over to be placed. */
export const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
/** The longest SVG the panel hands over, in characters. */
export const MAX_SVG_CHARS = 20_000_000;
/** Export scales the panel asks Figma for (Figma's own export panel goes up to 4×). */
export const MAX_EXPORT_SCALE = 4;
/** A fixed export width or height in pixels: the ICO's sizes (16 to 256) and "Max size" (up to
 * the largest canvas the panel draws). */
export const MAX_EXPORT_SIDE = 16_384;
/** Messages Figma shows as a toast are cut to this length. */
export const MAX_NOTICE = 200;

const KEY_PATTERN = /^cvs_live_[A-Za-z0-9]{32}$/;
const MAX_BASE = 300;

/** A key as the account page shows it (`cvs_live_` and 32 letters and digits). */
export function isApiKey(value: unknown): value is string {
  return typeof value === 'string' && KEY_PATTERN.test(value);
}

/** An API base address: `http(s)://host[:port][/path]`, nothing else. */
export function isApiBase(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > MAX_BASE) return false;
  return /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._~/-]*)?$/.test(value);
}

/** A selected layer, as the panel sees it. */
export interface LayerInfo {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly width: number;
  readonly height: number;
}

/** Where a placed file goes: the selected frame, or the page in the middle of the view. */
export interface Destination {
  readonly kind: 'frame' | 'page';
  /** The frame's name (`kind: 'frame'`). */
  readonly name: string | null;
}

export interface SelectionState {
  /** The selected layers Figma can export (at most `MAX_LAYERS`). */
  readonly layers: readonly LayerInfo[];
  /** How many exportable layers are selected (more than `layers` holds when over the limit). */
  readonly count: number;
  readonly destination: Destination;
}

/** What the plugin keeps for this user on this computer (`figma.clientStorage`). */
export interface Settings {
  readonly apiKey: string | null;
  /** Another API address (advanced); `null`: https://converter.studio/api. */
  readonly apiBase: string | null;
  /** The last export's format and settings (what was stored and still makes sense), or `null`. */
  readonly exportPrefs: Partial<ExportPrefs> | null;
}

// ── Export settings ───────────────────────────────────────────────────────────────────────

/** The export formats, in the panel's order. */
export const EXPORT_FORMATS = ['jpg', 'png', 'webp', 'avif', 'tiff', 'ico', 'pdf'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];
export const QUALITIES = ['high', 'balanced', 'small'] as const;
export type Quality = (typeof QUALITIES)[number];
export const ICON_SIZES = ['favicon', '256', '128', '64', '48', '32', '16'] as const;
export type IconSize = (typeof ICON_SIZES)[number];
export const COMPRESSIONS = ['balanced', 'strong', 'light'] as const;
export type Compression = (typeof COMPRESSIONS)[number];
/** Figma's own export scales (1× and its @2x, @3x and @4x). */
export const SCALES = [1, 2, 3, 4] as const;
/** "At most … KB" (the API's `maxKb` limits). */
export const MIN_KB = 5;
export const MAX_KB = 100_000;

/**
 * The export settings the panel remembers (`figma.clientStorage`), so the same hand-off is one
 * click the next time. Nothing in them comes from the user's files.
 */
export interface ExportPrefs {
  readonly format: ExportFormat;
  /** One or more of `SCALES`, smallest first. */
  readonly scales: readonly number[];
  readonly quality: Quality;
  /** Kilobytes (1000 bytes) each file must stay under; `null`: no limit. */
  readonly maxKb: number | null;
  /** Pixels each file must fit in; `null`: no limit. */
  readonly maxWidth: number | null;
  readonly maxHeight: number | null;
  readonly iconSize: IconSize;
  readonly compression: Compression;
  /** PNG: fewer colours (a palette), lossy, are allowed. */
  readonly reduceColors: boolean;
}

const isOneOf = <T extends string | number>(list: readonly T[], value: unknown): value is T =>
  list.includes(value as T);
const isKb = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= MIN_KB && value <= MAX_KB;
const isSide = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_EXPORT_SIDE;

/**
 * Remembered export settings: each field that is well formed, the others left out (the panel
 * uses its defaults for them), so settings from another version of the plugin never get in the
 * way. `null` when nothing in it is usable.
 */
export function parseExportPrefs(value: unknown): Partial<ExportPrefs> | null {
  if (!isObject(value)) return null;
  const prefs: { -readonly [K in keyof ExportPrefs]?: ExportPrefs[K] } = {};
  if (isOneOf(EXPORT_FORMATS, value.format)) prefs.format = value.format;
  if (
    Array.isArray(value.scales) &&
    value.scales.length > 0 &&
    value.scales.length <= SCALES.length &&
    value.scales.every((scale) => isOneOf(SCALES, scale))
  )
    prefs.scales = [...new Set(value.scales as number[])].sort((a, b) => a - b);
  if (isOneOf(QUALITIES, value.quality)) prefs.quality = value.quality;
  if (value.maxKb === null || isKb(value.maxKb)) prefs.maxKb = value.maxKb;
  if (value.maxWidth === null || isSide(value.maxWidth)) prefs.maxWidth = value.maxWidth;
  if (value.maxHeight === null || isSide(value.maxHeight)) prefs.maxHeight = value.maxHeight;
  if (isOneOf(ICON_SIZES, value.iconSize)) prefs.iconSize = value.iconSize;
  if (isOneOf(COMPRESSIONS, value.compression)) prefs.compression = value.compression;
  if (typeof value.reduceColors === 'boolean') prefs.reduceColors = value.reduceColors;
  return Object.keys(prefs).length > 0 ? prefs : null;
}

export type Constraint = {
  readonly type: 'SCALE' | 'WIDTH' | 'HEIGHT';
  readonly value: number;
};

// ── Panel → plugin ────────────────────────────────────────────────────────────────────────

export type Request =
  /** The panel has loaded: answered with `context`. */
  | { readonly source: typeof SOURCE; readonly kind: 'hello'; readonly id: number }
  /** Keep (or, with `null`, forget) the API key. */
  | {
      readonly source: typeof SOURCE;
      readonly kind: 'save-key';
      readonly id: number;
      readonly apiKey: string | null;
    }
  /** Keep (or, with `null`, forget) another API address. */
  | {
      readonly source: typeof SOURCE;
      readonly kind: 'save-base';
      readonly id: number;
      readonly apiBase: string | null;
    }
  /** Keep the export settings for next time. */
  | {
      readonly source: typeof SOURCE;
      readonly kind: 'save-export';
      readonly id: number;
      readonly prefs: Partial<ExportPrefs>;
    }
  /** Figma's own export of one layer: a PNG (at a scale, width or height) or a PDF. */
  | {
      readonly source: typeof SOURCE;
      readonly kind: 'export';
      readonly id: number;
      readonly layerId: string;
      readonly format: 'PNG' | 'PDF';
      readonly constraint: Constraint | null;
    }
  /** A picture (PNG, JPEG or GIF, at most 4096 px a side) to place as an image fill. */
  | {
      readonly source: typeof SOURCE;
      readonly kind: 'place-image';
      readonly id: number;
      readonly name: string;
      readonly bytes: Uint8Array;
    }
  /** An SVG to turn into editable vector layers. */
  | {
      readonly source: typeof SOURCE;
      readonly kind: 'place-svg';
      readonly id: number;
      readonly name: string;
      readonly svg: string;
    }
  /** A short message in Figma's toast. */
  | {
      readonly source: typeof SOURCE;
      readonly kind: 'notify';
      readonly id: number;
      readonly message: string;
    };

// ── Plugin → panel ────────────────────────────────────────────────────────────────────────

export type Reply =
  | {
      readonly source: typeof SOURCE;
      readonly kind: 'context';
      readonly id: number;
      readonly selection: SelectionState;
      readonly settings: Settings;
    }
  | { readonly source: typeof SOURCE; readonly kind: 'done'; readonly id: number }
  | {
      readonly source: typeof SOURCE;
      readonly kind: 'exported';
      readonly id: number;
      readonly name: string;
      readonly bytes: Uint8Array;
    }
  | {
      readonly source: typeof SOURCE;
      readonly kind: 'placed';
      readonly id: number;
      readonly name: string;
      readonly destination: Destination;
    }
  | {
      readonly source: typeof SOURCE;
      readonly kind: 'failed';
      readonly id: number;
      readonly message: string;
    };

/** What the plugin tells the panel unasked. */
export type Notice = {
  readonly source: typeof SOURCE;
  readonly kind: 'selection';
  readonly selection: SelectionState;
};

export type PluginMessage = Reply | Notice;

// ── Checks ────────────────────────────────────────────────────────────────────────────────

type Loose = Record<string, unknown>;

const isObject = (value: unknown): value is Loose =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isId = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const isText = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max;
const isSize = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** A file or layer name, cut to `MAX_NAME` characters, never empty. */
export function cleanName(name: string, fallback = 'Converted'): string {
  // Control characters out; Figma shows the rest as it is.
  // eslint-disable-next-line no-control-regex
  const clean = name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return (clean || fallback).slice(0, MAX_NAME);
}

function parseConstraint(value: unknown): Constraint | null | undefined {
  if (value === null) return null;
  if (!isObject(value) || typeof value.value !== 'number' || !Number.isFinite(value.value))
    return undefined;
  if (value.type === 'SCALE' && value.value > 0 && value.value <= MAX_EXPORT_SCALE)
    return { type: 'SCALE', value: value.value };
  if (
    (value.type === 'WIDTH' || value.type === 'HEIGHT') &&
    Number.isInteger(value.value) &&
    value.value >= 1 &&
    value.value <= MAX_EXPORT_SIDE
  )
    return { type: value.type, value: value.value };
  return undefined;
}

/** A message from the panel, or `null` when it is not one of ours or not well formed. */
export function parseRequest(value: unknown): Request | null {
  if (!isObject(value) || value.source !== SOURCE || !isId(value.id)) return null;
  const id = value.id;
  switch (value.kind) {
    case 'hello':
      return { source: SOURCE, kind: 'hello', id };
    case 'save-key':
      if (value.apiKey !== null && !isApiKey(value.apiKey)) return null;
      return { source: SOURCE, kind: 'save-key', id, apiKey: value.apiKey };
    case 'save-base':
      if (value.apiBase !== null && !isApiBase(value.apiBase)) return null;
      return { source: SOURCE, kind: 'save-base', id, apiBase: value.apiBase };
    case 'save-export': {
      const prefs = parseExportPrefs(value.prefs);
      return prefs ? { source: SOURCE, kind: 'save-export', id, prefs } : null;
    }
    case 'export': {
      if (!isText(value.layerId, 100)) return null;
      if (value.format !== 'PNG' && value.format !== 'PDF') return null;
      const constraint = parseConstraint(value.constraint);
      if (constraint === undefined) return null;
      // A PDF has no pixel size.
      if (value.format === 'PDF' && constraint !== null) return null;
      return {
        source: SOURCE,
        kind: 'export',
        id,
        layerId: value.layerId,
        format: value.format,
        constraint,
      };
    }
    case 'place-image':
      if (!isText(value.name, MAX_NAME * 2)) return null;
      if (!(value.bytes instanceof Uint8Array) || value.bytes.byteLength === 0) return null;
      if (value.bytes.byteLength > MAX_IMAGE_BYTES) return null;
      return {
        source: SOURCE,
        kind: 'place-image',
        id,
        name: cleanName(value.name),
        bytes: value.bytes,
      };
    case 'place-svg':
      if (!isText(value.name, MAX_NAME * 2) || !isText(value.svg, MAX_SVG_CHARS)) return null;
      if (!/<svg[\s/>]/i.test(value.svg.slice(0, 4096))) return null;
      return { source: SOURCE, kind: 'place-svg', id, name: cleanName(value.name), svg: value.svg };
    case 'notify':
      if (!isText(value.message, MAX_NOTICE * 5)) return null;
      return { source: SOURCE, kind: 'notify', id, message: value.message.slice(0, MAX_NOTICE) };
    default:
      return null;
  }
}

function parseDestination(value: unknown): Destination | null {
  if (!isObject(value) || (value.kind !== 'frame' && value.kind !== 'page')) return null;
  return {
    kind: value.kind,
    name: typeof value.name === 'string' ? cleanName(value.name, 'Frame') : null,
  };
}

function parseSelection(value: unknown): SelectionState | null {
  if (!isObject(value) || !Array.isArray(value.layers) || !isSize(value.count)) return null;
  const destination = parseDestination(value.destination);
  if (!destination) return null;
  const layers: LayerInfo[] = [];
  for (const layer of value.layers.slice(0, MAX_LAYERS)) {
    if (!isObject(layer) || !isText(layer.id, 100) || typeof layer.name !== 'string') return null;
    if (typeof layer.type !== 'string' || !isSize(layer.width) || !isSize(layer.height))
      return null;
    layers.push({
      id: layer.id,
      name: cleanName(layer.name, 'Layer'),
      type: layer.type,
      width: layer.width,
      height: layer.height,
    });
  }
  return { layers, count: value.count, destination };
}

function parseSettings(value: unknown): Settings | null {
  if (!isObject(value)) return null;
  return {
    apiKey: isApiKey(value.apiKey) ? value.apiKey : null,
    apiBase: isApiBase(value.apiBase) ? value.apiBase : null,
    exportPrefs: parseExportPrefs(value.exportPrefs),
  };
}

/** A message from the plugin, or `null`. */
export function parsePluginMessage(value: unknown): PluginMessage | null {
  if (!isObject(value) || value.source !== SOURCE) return null;
  switch (value.kind) {
    case 'selection': {
      const selection = parseSelection(value.selection);
      return selection ? { source: SOURCE, kind: 'selection', selection } : null;
    }
    case 'context': {
      const selection = parseSelection(value.selection);
      const settings = parseSettings(value.settings);
      if (!isId(value.id) || !selection || !settings) return null;
      return { source: SOURCE, kind: 'context', id: value.id, selection, settings };
    }
    case 'done':
      return isId(value.id) ? { source: SOURCE, kind: 'done', id: value.id } : null;
    case 'exported':
      if (!isId(value.id) || typeof value.name !== 'string') return null;
      if (!(value.bytes instanceof Uint8Array) || value.bytes.byteLength === 0) return null;
      return {
        source: SOURCE,
        kind: 'exported',
        id: value.id,
        name: cleanName(value.name, 'Layer'),
        bytes: value.bytes,
      };
    case 'placed': {
      const destination = parseDestination(value.destination);
      if (!isId(value.id) || typeof value.name !== 'string' || !destination) return null;
      return {
        source: SOURCE,
        kind: 'placed',
        id: value.id,
        name: cleanName(value.name),
        destination,
      };
    }
    case 'failed':
      if (!isId(value.id) || typeof value.message !== 'string') return null;
      return {
        source: SOURCE,
        kind: 'failed',
        id: value.id,
        message: value.message.slice(0, 500) || 'Figma could not do that.',
      };
    default:
      return null;
  }
}
