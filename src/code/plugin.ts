import type {
  BaseNode,
  ComponentNode,
  FrameNode,
  PluginAPI,
  RectangleNode,
  SceneNode,
  SectionNode,
} from '@figma/plugin-typings/plugin-api-standalone';
import {
  MAX_LAYERS,
  SOURCE,
  isApiBase,
  isApiKey,
  parseRequest,
  type Destination,
  type LayerInfo,
  type PluginMessage,
  type Reply,
  type Request,
  type SelectionState,
  type Settings,
} from '../shared/messages';
import { centerIn, fitScale, viewArea, type Box } from './place';

/**
 * The plugin's code inside Figma (code.js). It runs in Figma's sandbox, with the `figma` object
 * and no DOM. It opens the panel (ui.html), tells it the selection, keeps the user's settings in
 * `figma.clientStorage`, and does what only Figma can: export a layer for the panel, and put a
 * picture or vector layers on the canvas. It never talks to the network: everything that talks
 * to Converter Studio happens in the panel, and only when the user asks for it.
 */

export const PANEL = { width: 340, height: 660 } as const;
/** `figma.clientStorage` keys: on this computer, for this user and this plugin only. */
export const STORAGE = { apiKey: 'converter-studio.api-key', apiBase: 'converter-studio.api-base' };

type Container = FrameNode | ComponentNode | SectionNode;
type Exportable = SceneNode & { exportAsync: SceneNode['exportAsync'] };

export function startPlugin(figma: PluginAPI, html: string): void {
  figma.showUI(html, { ...PANEL, themeColors: true, title: 'Converter Studio' });
  const send = (message: PluginMessage) => figma.ui.postMessage(message);
  const tell = () => send({ source: SOURCE, kind: 'selection', selection: selectionState(figma) });
  figma.on('selectionchange', tell);
  figma.on('currentpagechange', tell);
  figma.ui.onmessage = (raw: unknown) => {
    const request = parseRequest(raw);
    // Not ours, or not well formed: nothing to answer.
    if (!request) return;
    void answer(figma, request).then(send);
  };
}

/** What the panel asked for, done; errors become a `failed` reply with Figma's reason. */
export async function answer(figma: PluginAPI, request: Request): Promise<Reply> {
  const { id } = request;
  try {
    switch (request.kind) {
      case 'hello':
        return {
          source: SOURCE,
          kind: 'context',
          id,
          selection: selectionState(figma),
          settings: await readSettings(figma),
        };
      case 'save-key':
        await keep(figma, STORAGE.apiKey, request.apiKey);
        return { source: SOURCE, kind: 'done', id };
      case 'save-base':
        await keep(figma, STORAGE.apiBase, request.apiBase);
        return { source: SOURCE, kind: 'done', id };
      case 'export': {
        const node = await figma.getNodeByIdAsync(request.layerId);
        if (!node || !isExportable(node))
          throw new Error('That layer is no longer in this file. Select it again.');
        const bytes =
          request.format === 'PDF'
            ? await node.exportAsync({ format: 'PDF' })
            : await node.exportAsync({
                format: 'PNG',
                // The panel's encoders and Converter Studio work in sRGB.
                colorProfile: 'SRGB',
                ...(request.constraint ? { constraint: request.constraint } : {}),
              });
        if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0)
          throw new Error('Figma exported nothing for this layer.');
        return { source: SOURCE, kind: 'exported', id, name: node.name, bytes };
      }
      case 'place-image':
        return { source: SOURCE, kind: 'placed', id, ...(await placeImage(figma, request)) };
      case 'place-svg':
        return { source: SOURCE, kind: 'placed', id, ...placeSvg(figma, request) };
      case 'notify':
        figma.notify(request.message, { timeout: 4000 });
        return { source: SOURCE, kind: 'done', id };
    }
  } catch (error) {
    return { source: SOURCE, kind: 'failed', id, message: reason(error) };
  }
}

async function readSettings(figma: PluginAPI): Promise<Settings> {
  const [apiKey, apiBase] = await Promise.all([
    figma.clientStorage.getAsync(STORAGE.apiKey) as Promise<unknown>,
    figma.clientStorage.getAsync(STORAGE.apiBase) as Promise<unknown>,
  ]);
  return {
    apiKey: isApiKey(apiKey) ? apiKey : null,
    apiBase: isApiBase(apiBase) ? apiBase : null,
  };
}

async function keep(figma: PluginAPI, key: string, value: string | null): Promise<void> {
  if (value === null) await figma.clientStorage.deleteAsync(key);
  else await figma.clientStorage.setAsync(key, value);
}

function isExportable(node: BaseNode): node is Exportable {
  return (
    node.type !== 'DOCUMENT' &&
    node.type !== 'PAGE' &&
    typeof (node as Partial<Exportable>).exportAsync === 'function'
  );
}

/** The selected layers Figma can export, and where a placed file would go. */
export function selectionState(figma: PluginAPI): SelectionState {
  const exportable = figma.currentPage.selection.filter(isExportable);
  const layers: LayerInfo[] = exportable.slice(0, MAX_LAYERS).map((node) => ({
    id: node.id,
    name: node.name,
    type: node.type,
    width: 'width' in node ? node.width : 0,
    height: 'height' in node ? node.height : 0,
  }));
  return { layers, count: exportable.length, destination: destinationOf(targetFrame(figma)) };
}

const destinationOf = (frame: Container | null): Destination =>
  frame ? { kind: 'frame', name: frame.name } : { kind: 'page', name: null };

function isContainer(node: BaseNode): node is Container {
  return node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'SECTION';
}

/** An instance's layers come from its component: nothing can be added inside them. */
function insideInstance(node: BaseNode): boolean {
  let parent = node.parent;
  for (let depth = 0; parent && depth < 64; depth++) {
    if (parent.type === 'INSTANCE') return true;
    parent = parent.parent;
  }
  return false;
}

/**
 * The frame a file goes into: the selected frame (or section, or component), or the nearest
 * one around the first selected layer. `null` when nothing is selected or the layer sits on
 * the page itself.
 */
export function targetFrame(figma: PluginAPI): Container | null {
  let node: BaseNode | null = figma.currentPage.selection[0] ?? null;
  // Frames inside frames inside…: a few levels are plenty, and a loop cannot run away.
  for (let depth = 0; node && depth < 64; depth++) {
    if (node.type === 'PAGE' || node.type === 'DOCUMENT') return null;
    if (isContainer(node) && !insideInstance(node)) return node;
    node = node.parent;
  }
  return null;
}

interface Placed {
  readonly name: string;
  readonly destination: Destination;
}

/** Moves `node` into the frame (or leaves it on the page), fits it, centres it and selects it. */
function settle(
  figma: PluginAPI,
  node: RectangleNode | FrameNode,
  frame: Container | null,
  name: string,
): Placed {
  node.name = name;
  if (frame) frame.appendChild(node);
  // A frame's children are placed in the frame's own coordinates.
  const area: Box = frame
    ? { x: 0, y: 0, width: frame.width, height: frame.height }
    : viewArea(figma.viewport.bounds);
  const scale = fitScale(node, area);
  // Figma's own "scale" (K): strokes and effects follow; 0.01 is the least it takes.
  if (scale < 1) node.rescale(Math.max(0.01, scale));
  const at = centerIn(area, node);
  node.x = at.x;
  node.y = at.y;
  figma.currentPage.selection = [node];
  // One step in Figma's undo history.
  figma.commitUndo();
  return { name, destination: destinationOf(frame) };
}

/** A picture as a rectangle filled with it, like an image dropped onto the canvas. */
async function placeImage(
  figma: PluginAPI,
  request: Extract<Request, { kind: 'place-image' }>,
): Promise<Placed> {
  const frame = targetFrame(figma);
  // Throws on what Figma cannot read (anything but PNG, JPEG and GIF, or over 4096 px).
  const image = figma.createImage(request.bytes);
  const { width, height } = await image.getSizeAsync();
  const rect = figma.createRectangle();
  rect.resize(Math.max(1, width), Math.max(1, height));
  rect.fills = [{ type: 'IMAGE', imageHash: image.hash, scaleMode: 'FILL' }];
  rect.lockAspectRatio();
  return settle(figma, rect, frame, request.name);
}

/** An SVG as editable vector layers (Figma wraps them in a frame). */
function placeSvg(figma: PluginAPI, request: Extract<Request, { kind: 'place-svg' }>): Placed {
  const frame = targetFrame(figma);
  const node = figma.createNodeFromSvg(request.svg);
  return settle(figma, node, frame, request.name);
}

/** Figma rejects with an `Error` or, now and then, a plain string. */
function reason(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return 'Figma could not do that.';
}
