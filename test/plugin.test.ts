import { describe, expect, it } from 'vitest';
import { PANEL, STORAGE, startPlugin } from '../src/code/plugin';
import { SOURCE } from '../src/shared/messages';
import { fakeFigma, type FakeFigma } from './fake-figma';

const KEY = `cvs_live_${'b'.repeat(32)}`;

function started(): FakeFigma {
  const figma = fakeFigma();
  startPlugin(figma.api, '<html>panel</html>');
  return figma;
}

/** Sends a request as the panel does and waits for the plugin's answer. */
async function ask(figma: FakeFigma, request: Record<string, unknown>) {
  const before = figma.sent.length;
  const id = Math.floor(Math.random() * 1e6) + 1;
  figma.receive({ source: SOURCE, id, ...request });
  for (let i = 0; i < 50 && figma.sent.length === before; i++)
    await new Promise((resolve) => setTimeout(resolve, 0));
  const reply = figma.sent.at(-1) as Record<string, unknown>;
  expect(reply.id).toBe(id);
  return reply;
}

describe("the plugin's code in Figma", () => {
  it("opens the panel with Figma's theme colours and its size", () => {
    const figma = started();
    expect(figma.shown).toEqual({
      html: '<html>panel</html>',
      options: { ...PANEL, themeColors: true, title: 'Converter Studio' },
    });
  });

  it('answers hello with the exportable selection, where a file would go, and the settings', async () => {
    const figma = started();
    const hero = figma.node('Hero', 'FRAME', 320, 200);
    const text = figma.node('Title', 'TEXT', 80, 20, hero);
    figma.selection = [text];
    figma.storage.set(STORAGE.apiKey, KEY);
    figma.storage.set(STORAGE.apiBase, 'not an address');
    const reply = await ask(figma, { kind: 'hello' });
    expect(reply).toMatchObject({
      kind: 'context',
      selection: {
        count: 1,
        layers: [{ id: text.id, name: 'Title', type: 'TEXT', width: 80, height: 20 }],
        destination: { kind: 'frame', name: 'Hero' },
      },
      // A stored value that does not look right is not handed over.
      settings: { apiKey: KEY, apiBase: null },
    });
  });

  it('tells the panel when the selection or the page changes', () => {
    const figma = started();
    const frame = figma.node('Card', 'FRAME', 10, 10);
    figma.selection = [frame];
    figma.emit('selectionchange');
    figma.emit('currentpagechange');
    expect(figma.sent).toHaveLength(2);
    expect(figma.sent[0]).toMatchObject({
      source: SOURCE,
      kind: 'selection',
      selection: { count: 1, destination: { kind: 'frame', name: 'Card' } },
    });
  });

  it('lists at most 20 layers but counts them all', async () => {
    const figma = started();
    figma.selection = Array.from({ length: 25 }, (_, i) => figma.node(`L${i}`, 'FRAME', 1, 1));
    const reply = await ask(figma, { kind: 'hello' });
    const selection = reply.selection as { count: number; layers: unknown[] };
    expect(selection.count).toBe(25);
    expect(selection.layers).toHaveLength(20);
  });

  it('keeps and forgets the key and the API address in client storage', async () => {
    const figma = started();
    expect(await ask(figma, { kind: 'save-key', apiKey: KEY })).toMatchObject({ kind: 'done' });
    expect(figma.storage.get(STORAGE.apiKey)).toBe(KEY);
    await ask(figma, { kind: 'save-base', apiBase: 'http://localhost:4391/api' });
    expect(figma.storage.get(STORAGE.apiBase)).toBe('http://localhost:4391/api');
    await ask(figma, { kind: 'save-key', apiKey: null });
    await ask(figma, { kind: 'save-base', apiBase: null });
    expect([...figma.storage.keys()]).toEqual([]);
  });

  it('ignores what is not a well-formed request of ours (a wrong key is never stored)', async () => {
    const figma = started();
    figma.receive({ source: SOURCE, id: 1, kind: 'save-key', apiKey: 'sk-something' });
    figma.receive({ source: 'other', id: 2, kind: 'hello' });
    figma.receive('hello');
    figma.receive({ source: SOURCE, id: 3, kind: 'export', layerId: '1:1', format: 'SVG' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(figma.sent).toEqual([]);
    expect(figma.storage.size).toBe(0);
  });

  it("exports a layer as Figma's PNG in sRGB at the asked size, or as a PDF", async () => {
    const figma = started();
    const hero = figma.node('Hero', 'FRAME', 320, 200);
    const png = await ask(figma, {
      kind: 'export',
      layerId: hero.id,
      format: 'PNG',
      constraint: { type: 'WIDTH', value: 48 },
    });
    expect(png).toMatchObject({ kind: 'exported', name: 'Hero' });
    expect(png.bytes).toBeInstanceOf(Uint8Array);
    await ask(figma, { kind: 'export', layerId: hero.id, format: 'PDF', constraint: null });
    expect(figma.exports).toEqual([
      {
        node: 'Hero',
        settings: { format: 'PNG', colorProfile: 'SRGB', constraint: { type: 'WIDTH', value: 48 } },
      },
      { node: 'Hero', settings: { format: 'PDF' } },
    ]);
  });

  it('answers a layer that is gone, or an empty export, with a sentence', async () => {
    const figma = started();
    expect(
      await ask(figma, { kind: 'export', layerId: '9:9', format: 'PNG', constraint: null }),
    ).toMatchObject({
      kind: 'failed',
      message: 'That layer is no longer in this file. Select it again.',
    });
    const empty = figma.node('Empty', 'FRAME', 1, 1);
    empty.exportAsync = async () => new Uint8Array();
    expect(
      await ask(figma, { kind: 'export', layerId: empty.id, format: 'PNG', constraint: null }),
    ).toMatchObject({ kind: 'failed', message: 'Figma exported nothing for this layer.' });
    const broken = figma.node('Broken', 'FRAME', 1, 1);
    broken.exportAsync = () => Promise.reject(new Error('Node has no visible content'));
    expect(
      await ask(figma, { kind: 'export', layerId: broken.id, format: 'PNG', constraint: null }),
    ).toMatchObject({ kind: 'failed', message: 'Node has no visible content' });
  });

  it('places a picture in the selected frame: fitted, centred, selected, one undo step', async () => {
    const figma = started();
    const frame = figma.node('Hero', 'FRAME', 200, 100);
    figma.selection = [frame];
    figma.imageSize = { width: 400, height: 400 };
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const reply = await ask(figma, { kind: 'place-image', name: 'photo', bytes });
    expect(reply).toMatchObject({
      kind: 'placed',
      name: 'photo',
      destination: { kind: 'frame', name: 'Hero' },
    });
    const rect = figma.created[0]!;
    expect(rect.parent).toBe(frame);
    expect(rect).toMatchObject({
      name: 'photo',
      width: 100,
      height: 100,
      x: 50,
      y: 0,
      locked: true,
    });
    expect(rect.fills).toEqual([{ type: 'IMAGE', imageHash: 'hash-1', scaleMode: 'FILL' }]);
    expect(figma.images[0]!.bytes).toEqual(bytes);
    expect(figma.selection).toEqual([rect]);
    expect(figma.commits).toBe(1);
  });

  it('places it on the page in the middle of the view when no frame is selected', async () => {
    const figma = started();
    figma.imageSize = { width: 2000, height: 500 };
    await ask(figma, { kind: 'place-image', name: 'wide', bytes: new Uint8Array([1]) });
    const rect = figma.created[0]!;
    // 80% of the 1000 × 500 view, centred on it.
    expect(rect.parent).toBe(figma.page);
    expect(rect).toMatchObject({ width: 800, height: 200, x: 1100, y: 2150 });
  });

  it('never puts a file inside an instance: the frame around the instance takes it', async () => {
    const figma = started();
    const outer = figma.node('Screen', 'FRAME', 300, 300);
    const instance = figma.node('Button', 'INSTANCE', 100, 40, outer);
    const inner = figma.node('Content', 'FRAME', 80, 20, instance);
    figma.selection = [inner];
    const reply = await ask(figma, { kind: 'place-image', name: 'x', bytes: new Uint8Array([1]) });
    expect(reply).toMatchObject({ destination: { kind: 'frame', name: 'Screen' } });
    expect(figma.created[0]!.parent).toBe(outer);
  });

  it("places an SVG as vector layers, and passes Figma's reason when it cannot", async () => {
    const figma = started();
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="50" height="20"></svg>';
    expect(await ask(figma, { kind: 'place-svg', name: 'logo', svg })).toMatchObject({
      kind: 'placed',
      name: 'logo',
      destination: { kind: 'page' },
    });
    expect(figma.created[0]).toMatchObject({ type: 'FRAME', name: 'logo', width: 50 });
    figma.failCreate = 'Image is too large';
    expect(
      await ask(figma, { kind: 'place-image', name: 'big', bytes: new Uint8Array([1]) }),
    ).toMatchObject({ kind: 'failed', message: 'Image is too large' });
  });

  it("shows a message in Figma's toast", async () => {
    const figma = started();
    await ask(figma, { kind: 'notify', message: 'Saved.' });
    expect(figma.notices).toEqual(['Saved.']);
  });
});
