import type { PluginAPI } from '@figma/plugin-typings/plugin-api-standalone';

/**
 * The parts of Figma's plugin API that src/code/plugin.ts uses, in memory: a page with nodes,
 * the selection, client storage, the panel's messages, and what gets created. Shapes follow
 * @figma/plugin-typings.
 */

export interface FakeNode {
  id: string;
  name: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  parent: FakeNode | null;
  children: FakeNode[];
  fills?: unknown[];
  locked?: boolean;
  removed?: boolean;
  exportAsync?: (settings?: unknown) => Promise<Uint8Array>;
  appendChild(child: FakeNode): void;
  resize(width: number, height: number): void;
  rescale(scale: number): void;
  lockAspectRatio(): void;
}

export interface FakeFigma {
  readonly api: PluginAPI;
  readonly page: FakeNode;
  readonly sent: unknown[];
  readonly storage: Map<string, unknown>;
  readonly exports: Array<{ node: string; settings: unknown }>;
  readonly created: FakeNode[];
  readonly notices: string[];
  readonly shown: { html: string; options: unknown } | null;
  commits: number;
  selection: FakeNode[];
  /** What the panel sends (`parent.postMessage({ pluginMessage })` arrives as this). */
  receive(message: unknown): void;
  emit(event: string): void;
  node(name: string, type: string, width: number, height: number, parent?: FakeNode): FakeNode;
  /** The image `createImage` was last given, and the size it reports. */
  images: Array<{ hash: string; bytes: Uint8Array }>;
  imageSize: { width: number; height: number };
  /** Make `createImage` or `createNodeFromSvg` throw this. */
  failCreate: Error | string | null;
}

export function fakeFigma(): FakeFigma {
  let nextId = 1;
  const listeners = new Map<string, Array<() => void>>();
  let onmessage: ((message: unknown) => void) | undefined;

  const make = (
    name: string,
    type: string,
    width: number,
    height: number,
    parent: FakeNode | null,
  ): FakeNode => {
    const node: FakeNode = {
      id: `1:${nextId++}`,
      name,
      type,
      x: 0,
      y: 0,
      width,
      height,
      parent,
      children: [],
      appendChild(child) {
        if (child.parent) child.parent.children = child.parent.children.filter((c) => c !== child);
        child.parent = node;
        node.children.push(child);
      },
      resize(w, h) {
        node.width = w;
        node.height = h;
      },
      rescale(scale) {
        node.width *= scale;
        node.height *= scale;
      },
      lockAspectRatio() {
        node.locked = true;
      },
    };
    parent?.children.push(node);
    return node;
  };

  const page = make('Page 1', 'PAGE', 0, 0, null);
  const all = () => {
    const out: FakeNode[] = [];
    const walk = (node: FakeNode) => {
      out.push(node);
      node.children.forEach(walk);
    };
    walk(page);
    return out;
  };

  const fake: FakeFigma = {
    page,
    sent: [],
    storage: new Map(),
    exports: [],
    created: [],
    notices: [],
    shown: null,
    commits: 0,
    selection: [],
    images: [],
    imageSize: { width: 400, height: 300 },
    failCreate: null,
    receive(message) {
      onmessage?.(message);
    },
    emit(event) {
      for (const listener of listeners.get(event) ?? []) listener();
    },
    node(name, type, width, height, parent = page) {
      const node = make(name, type, width, height, parent);
      node.exportAsync = async (settings) => {
        fake.exports.push({ node: name, settings });
        return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
      };
      return node;
    },
    api: undefined as unknown as PluginAPI,
  };

  const api = {
    showUI(html: string, options: unknown) {
      (fake as { shown: unknown }).shown = { html, options };
    },
    ui: {
      postMessage(message: unknown) {
        fake.sent.push(message);
      },
      set onmessage(handler: ((message: unknown) => void) | undefined) {
        onmessage = handler;
      },
      get onmessage() {
        return onmessage;
      },
    },
    on(event: string, listener: () => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
    get currentPage() {
      return {
        ...page,
        get selection() {
          return fake.selection;
        },
        set selection(value: FakeNode[]) {
          fake.selection = value;
        },
      };
    },
    viewport: { bounds: { x: 1000, y: 2000, width: 1000, height: 500 } },
    clientStorage: {
      getAsync: async (key: string) => fake.storage.get(key),
      setAsync: async (key: string, value: unknown) => {
        fake.storage.set(key, value);
      },
      deleteAsync: async (key: string) => {
        fake.storage.delete(key);
      },
    },
    getNodeByIdAsync: async (id: string) => all().find((node) => node.id === id) ?? null,
    notify(message: string) {
      fake.notices.push(message);
    },
    commitUndo() {
      fake.commits += 1;
    },
    createImage(bytes: Uint8Array) {
      if (fake.failCreate) throw fake.failCreate;
      const hash = `hash-${fake.images.length + 1}`;
      fake.images.push({ hash, bytes });
      return { hash, getSizeAsync: async () => fake.imageSize };
    },
    createRectangle() {
      const rect = make('Rectangle', 'RECTANGLE', 100, 100, page);
      fake.created.push(rect);
      return rect;
    },
    createNodeFromSvg(svg: string) {
      if (fake.failCreate) throw fake.failCreate;
      const width = Number(/width="(\d+)"/.exec(svg)?.[1] ?? 100);
      const height = Number(/height="(\d+)"/.exec(svg)?.[1] ?? 100);
      const frame = make('svg', 'FRAME', width, height, page);
      fake.created.push(frame);
      return frame;
    },
  };
  (fake as { api: unknown }).api = api;
  return fake;
}
