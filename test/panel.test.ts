// @vitest-environment jsdom
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConverterApi } from '../src/ui/api';
import type { Answer, Ask } from '../src/ui/bridge';
import { startPanel } from '../src/ui/panel';
import { SOURCE, type SelectionState, type Settings } from '../src/shared/messages';
import { BASE, KEY, fakeServer, type Scenario } from './fake-server';
import { fakeBridge, fakeRaster, pngBytes } from './fakes';

// The fake server's answers are Node's; keep files and blobs Node's too (jsdom has its own).
vi.stubGlobal('File', NodeFile);
vi.stubGlobal('Blob', NodeBlob);

const HERO = { id: '1:2', name: 'Hero', type: 'FRAME', width: 320, height: 200 };
const LOGO = { id: '1:3', name: 'Logo', type: 'COMPONENT', width: 120, height: 80 };
const BANNER = { id: '1:4', name: 'Banner', type: 'FRAME', width: 17_000, height: 40 };
const selected = (...layers: (typeof HERO)[]): SelectionState => ({
  count: layers.length,
  layers,
  destination: layers.length
    ? { kind: 'frame', name: layers[0]!.name }
    : { kind: 'page', name: null },
});

let container: HTMLElement;
beforeEach(() => {
  document.body.replaceChildren();
  container = document.createElement('div');
  document.body.appendChild(container);
});

const until = async (what: () => unknown, message = 'condition') => {
  for (let i = 0; i < 200; i++) {
    if (what()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Timed out waiting for ${message}`);
};
const $ = <T extends Element = HTMLElement>(selector: string) =>
  container.querySelector<T>(selector);
const text = (selector: string) => $(selector)?.textContent?.trim() ?? '';

async function open(
  options: {
    selection?: SelectionState;
    settings?: Settings;
    scenario?: Partial<Scenario>;
    offline?: boolean;
  } = {},
) {
  const server = fakeServer(options.scenario);
  const fetch = options.offline
    ? () => Promise.reject(new TypeError('Failed to fetch'))
    : server.fetch;
  const storage: Record<string, string | null> = {};
  const placed: Ask[] = [];
  const bridge = fakeBridge((ask): Answer => {
    switch (ask.kind) {
      case 'hello':
        return {
          source: SOURCE,
          kind: 'context',
          id: 1,
          selection: options.selection ?? selected(),
          settings: options.settings ?? { apiKey: null, apiBase: null },
        };
      case 'save-key':
        storage.key = ask.apiKey;
        return { source: SOURCE, kind: 'done', id: 1 };
      case 'save-base':
        storage.base = ask.apiBase;
        return { source: SOURCE, kind: 'done', id: 1 };
      case 'export':
        return { source: SOURCE, kind: 'exported', id: 1, name: 'x', bytes: pngBytes(320, 200) };
      case 'place-image':
      case 'place-svg':
        placed.push(ask);
        return {
          source: SOURCE,
          kind: 'placed',
          id: 1,
          name: ask.name,
          destination: { kind: 'page', name: null },
        };
      default:
        return { source: SOURCE, kind: 'done', id: 1 };
    }
  });
  const save = vi.fn();
  const raster = fakeRaster({
    decodes: (bytes) => (bytes[0] === 0x41 ? { width: 800, height: 600 } : null),
  });
  const started = startPanel(container, {
    bridge,
    raster,
    deflate: null,
    api: (base, key) => new ConverterApi(base, key, fetch),
    defaultBase: BASE,
    save,
  });
  await started;
  return { server, bridge, storage, placed, save, raster };
}

const click = (selector: string) => $<HTMLElement>(selector)!.click();
const choose = (id: string) => click(`#target-${id}`);
const badge = (id: string) => text(`label[for=target-${id}] .badge`);

describe('the panel', () => {
  it('says where each format is made, and waits for a selection', async () => {
    await open();
    expect(badge('webp')).toBe('In Figma');
    expect(badge('tiff')).toBe('In Figma');
    expect(badge('ico')).toBe('In Figma');
    expect(badge('avif')).toBe('Converter Studio cloud · uses credits');
    expect(badge('pdf')).toBe('Converter Studio cloud · uses credits');
    expect(text('.body .muted')).toBe('Select one or more layers to export.');
    expect($<HTMLButtonElement>('#export')!.disabled).toBe(true);
    expect(text('.credits')).toBe('Cloud: not connected');
    expect(text('.note-local')).toBe('Made on this computer: nothing is uploaded.');
  });

  it('offline: what needs the cloud says it needs a connection', async () => {
    await open({ offline: true });
    expect(badge('avif')).toBe('Needs a connection to converter.studio');
    expect($<HTMLInputElement>('#target-avif')!.disabled).toBe(true);
    expect(badge('webp')).toBe('In Figma');
  });

  it('exports WebP on this computer and saves it on a click', async () => {
    const { bridge, save, server } = await open();
    bridge.notify({ kind: 'selection', selection: selected(HERO) });
    expect(text('#export')).toBe('Export 1 layer');
    click('#export');
    await until(() => $('#save'), 'the Save button');
    expect(text('.row-done .row-note')).toMatch(/KB$/);
    expect(text('#save')).toBe('Save Hero.webp');
    click('#save');
    expect(save).toHaveBeenCalledWith(expect.any(Object), 'Hero.webp');
    // Only the formats list went to the network.
    expect(server.requests.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual([
      'GET /api/v1/formats',
    ]);
  });

  it('puts several layers into one ZIP', async () => {
    const { save } = await open({ selection: selected(HERO, LOGO) });
    choose('tiff');
    click('#export');
    await until(() => $('#save'), 'the Save button');
    expect(text('#save')).toBe('Save 2 TIFF files.zip');
    click('#save');
    const [blob, name] = save.mock.calls[0]! as [Blob, string];
    expect(name).toBe('2 TIFF files.zip');
    expect(blob.type).toBe('application/zip');
  });

  it('the cloud without a key: the button is off and points to Settings', async () => {
    await open({ selection: selected(HERO) });
    choose('avif');
    expect($<HTMLButtonElement>('#export')!.disabled).toBe(true);
    expect(text('.note-cloud p')).toMatch(/uploaded to converter\.studio .* credits/);
    click('.note-cloud .link-button');
    expect($('#api-key')).not.toBeNull();
  });

  it("connects: a wrong key shows the API's message; a good one is kept by Figma", async () => {
    const { storage } = await open();
    click('#tab-settings');
    $<HTMLInputElement>('#api-key')!.value = 'nope';
    click('#connect');
    await until(() => $('.status-error'));
    expect(text('.status-error')).toMatch(/not a Converter Studio API key/);
    $<HTMLInputElement>('#api-key')!.value = `cvs_live_${'z'.repeat(32)}`;
    click('#connect');
    await until(() => /does not work/.test(text('.status-error')), 'the API message');
    expect(storage.key).toBeUndefined();
    $<HTMLInputElement>('#api-key')!.value = KEY;
    click('#connect');
    await until(() => $('#disconnect'), 'connected');
    expect(storage.key).toBe(KEY);
    expect(text('.selection')).toBe('Connected: designer@example.com · 12 credits');
    expect(text('.credits')).toBe('12 credits');
    click('#disconnect');
    await until(() => $('#api-key'), 'disconnected');
    expect(storage.key).toBeNull();
  });

  it('converts AVIF in the cloud with a saved key', async () => {
    const { save, server } = await open({
      selection: selected(HERO),
      settings: { apiKey: KEY, apiBase: null },
    });
    choose('avif');
    expect(text('#export')).toBe('Convert 1 layer in the cloud');
    click('#export');
    await until(() => $('#save'), 'the Save button');
    expect(text('.row-done .row-note')).toMatch(/· 1 credit$/);
    click('#save');
    expect(save.mock.calls[0]![1]).toBe('Hero.avif');
    expect(server.requests.some((r) => r.url.endsWith('/v1/conversions'))).toBe(true);
  });

  it('a local failure offers the cloud, which runs only when asked', async () => {
    const { server } = await open({
      selection: selected(BANNER),
      settings: { apiKey: KEY, apiBase: null },
    });
    choose('tiff');
    click('#export');
    await until(() => $('.row-failed'), 'the failure');
    expect(text('.row-failed .row-note')).toMatch(/too large to convert here/);
    expect(server.requests.some((r) => r.url.endsWith('/v1/uploads'))).toBe(false);
    click('#retry-cloud');
    await until(() => $('#save'), 'the cloud result');
    expect(server.requests.some((r) => r.url.endsWith('/v1/uploads'))).toBe(true);
    expect(text('#save')).toBe('Save Banner.tiff');
  });

  it('places: Figma formats are left to Figma; what the browser reads is placed here', async () => {
    const { placed } = await open();
    click('#tab-place');
    const input = $<HTMLInputElement>('#file')!;
    const pick = (file: File) => {
      Object.defineProperty(input, 'files', { value: [file], configurable: true });
      input.dispatchEvent(new Event('change'));
    };
    pick(new File([new Uint8Array([1])], 'IMG_0001.HEIC'));
    await until(() => $('.picked'));
    expect(text('.note')).toBe('Figma places .heic files itself: drag the file onto the canvas.');
    pick(new File([new Uint8Array([0x41])], 'photo.avif'));
    await until(() => $('#place'));
    expect(text('.option-title .badge')).toBe('In Figma');
    click('#place');
    await until(() => $('.status-done'), 'placed');
    expect(text('.status-done')).toBe('Placed “photo” on the page.');
    expect(placed[0]).toMatchObject({ kind: 'place-image', name: 'photo' });
  });

  it('places a camera RAW through the cloud when asked', async () => {
    const { placed, server } = await open({
      settings: { apiKey: KEY, apiBase: null },
      scenario: { output: pngBytes(2560, 1700) },
    });
    click('#tab-place');
    const input = $<HTMLInputElement>('#file')!;
    Object.defineProperty(input, 'files', {
      value: [new File([new Uint8Array([1])], 'IMG_9.NEF')],
    });
    input.dispatchEvent(new Event('change'));
    await until(() => $('#place'));
    expect(text('#place')).toBe('Convert in the cloud and place');
    expect(server.requests.some((r) => r.url.endsWith('/v1/uploads'))).toBe(false);
    click('#place');
    await until(() => $('.status-done'), 'placed');
    expect(text('.status-done')).toBe('Placed “IMG_9” on the page. 1 credit used.');
    expect(placed[0]).toMatchObject({ kind: 'place-image', name: 'IMG_9' });
  });

  it('keeps another API address under Advanced', async () => {
    const { storage } = await open();
    click('#tab-settings');
    $<HTMLInputElement>('#api-base')!.value = 'http://localhost:4391/api/';
    click('#save-base');
    await until(() => $('.status-done'));
    expect(storage.base).toBe('http://localhost:4391/api');
    $<HTMLInputElement>('#api-base')!.value = 'not a url';
    click('#save-base');
    await until(() => $('.status-error'));
    click('#reset-base');
    await until(() => storage.base === null, 'reset');
  });
});
