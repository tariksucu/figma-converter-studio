import { describe, expect, it, vi } from 'vitest';
import { ConverterApi } from '../src/ui/api';
import type { Ask } from '../src/ui/bridge';
import { browserDeflate } from '../src/ui/encode/tiff';
import { LocalError, exportLayer, type ExportContext } from '../src/ui/exporter';
import { DEFAULT_EXPORT, EXPORT_TARGETS, type ExportId } from '../src/ui/targets';
import { SOURCE, type LayerInfo } from '../src/shared/messages';
import { BASE, KEY, fakeServer } from './fake-server';
import { fakeBridge, fakeRaster, pngBytes, type FakeRaster } from './fakes';

const target = (id: ExportId) => EXPORT_TARGETS.find((t) => t.id === id)!;
const hero: LayerInfo = { id: '1:2', name: 'Hero', type: 'FRAME', width: 320, height: 200 };

/** Figma, stood in for: a PNG of the size the constraint asks for, or a PDF. */
function figma() {
  return fakeBridge((ask: Ask) => {
    if (ask.kind !== 'export') throw new Error(`unexpected ${ask.kind}`);
    if (ask.format === 'PDF')
      return {
        source: SOURCE,
        kind: 'exported',
        id: 1,
        name: 'Hero',
        bytes: new Uint8Array([0x25, 0x50]),
      };
    const c = ask.constraint ?? { type: 'SCALE', value: 1 };
    const [w, h] =
      c.type === 'SCALE'
        ? [hero.width * c.value, hero.height * c.value]
        : c.type === 'WIDTH'
          ? [c.value, Math.round((hero.height * c.value) / hero.width)]
          : [Math.round((hero.width * c.value) / hero.height), c.value];
    return { source: SOURCE, kind: 'exported', id: 1, name: 'Hero', bytes: pngBytes(w, h) };
  });
}

function context(raster: FakeRaster, extra: Partial<ExportContext> = {}): ExportContext {
  return {
    bridge: figma(),
    raster,
    deflate: browserDeflate(),
    api: null,
    confirmPrice: vi.fn(() => Promise.resolve(true)),
    ...extra,
  };
}

describe('exports made on this computer', () => {
  it("WebP: Figma's PNG at the scale, written by the browser at the chosen quality", async () => {
    const raster = fakeRaster();
    const ctx = context(raster);
    const out = await exportLayer(
      hero,
      target('webp'),
      { ...DEFAULT_EXPORT, scale: 2, quality: 'balanced' },
      'local',
      ctx,
    );
    expect(out).toMatchObject({ name: 'Hero.webp', route: 'local', credits: 0 });
    expect(out.blob.type).toBe('image/webp');
    expect((ctx.bridge as ReturnType<typeof figma>).asked).toEqual([
      { kind: 'export', layerId: '1:2', format: 'PNG', constraint: { type: 'SCALE', value: 2 } },
    ]);
    expect(raster.encoded).toEqual([
      { mime: 'image/webp', options: { quality: 0.8 }, width: 640, height: 400 },
    ]);
    expect(raster.closed).toBe(1);
  });

  it('WebP under a size: the highest quality that fits', async () => {
    // 64,000 pixels: quality q gives 64,000 × q bytes; 20 KB allows q ≤ 0.3125.
    const raster = fakeRaster();
    const out = await exportLayer(
      hero,
      target('webp'),
      { ...DEFAULT_EXPORT, maxKb: 20 },
      'local',
      context(raster),
    );
    expect(out.blob.size).toBeLessThanOrEqual(20_000);
    expect(out.blob.size).toBeGreaterThan(18_000);
    expect(raster.encoded.length).toBeLessThanOrEqual(8);
  });

  it('WebP under a size it cannot reach: says so (the cloud is not tried on its own)', async () => {
    const raster = fakeRaster({ sizeOf: () => 50_000 });
    const ctx = context(raster);
    await expect(
      exportLayer(hero, target('webp'), { ...DEFAULT_EXPORT, maxKb: 10 }, 'local', ctx),
    ).rejects.toThrow(LocalError);
  });

  it('a browser that cannot write the format: a local failure', async () => {
    await expect(
      exportLayer(
        hero,
        target('webp'),
        DEFAULT_EXPORT,
        'local',
        context(fakeRaster({ encodes: [] })),
      ),
    ).rejects.toThrow('could not write WebP');
  });

  it('too large for a canvas: refused before Figma renders it', async () => {
    const ctx = context(fakeRaster());
    const banner = { ...hero, width: 9000, height: 9000 };
    await expect(
      exportLayer(banner, target('tiff'), { ...DEFAULT_EXPORT, scale: 2 }, 'local', ctx),
    ).rejects.toThrow('too large to convert here');
    expect((ctx.bridge as ReturnType<typeof figma>).asked).toEqual([]);
  });

  it('TIFF: our writer, at 72 dpi times the scale', async () => {
    const out = await exportLayer(
      hero,
      target('tiff'),
      { ...DEFAULT_EXPORT, scale: 2 },
      'local',
      context(fakeRaster()),
    );
    const bytes = new Uint8Array(await out.blob.arrayBuffer());
    expect(out.name).toBe('Hero.tiff');
    expect(Array.from(bytes.subarray(0, 4))).toEqual([0x49, 0x49, 42, 0]);
    expect(out.blob.type).toBe('image/tiff');
  });

  it('ICO: Figma renders each size; a wide layer is centred on a square', async () => {
    const raster = fakeRaster();
    const ctx = context(raster);
    const out = await exportLayer(hero, target('ico'), DEFAULT_EXPORT, 'local', ctx);
    expect(
      (ctx.bridge as ReturnType<typeof figma>).asked.map(
        (a) => a.kind === 'export' && a.constraint,
      ),
    ).toEqual([
      { type: 'WIDTH', value: 16 },
      { type: 'WIDTH', value: 32 },
      { type: 'WIDTH', value: 48 },
    ]);
    expect(raster.encoded.map((e) => [e.width, e.height, e.options.square])).toEqual([
      [16, 10, true],
      [32, 20, true],
      [48, 30, true],
    ]);
    const ico = new Uint8Array(await out.blob.arrayBuffer());
    expect(Array.from(ico.subarray(0, 6))).toEqual([0, 0, 1, 0, 3, 0]);
    expect(out.name).toBe('Hero.ico');
  });

  it("ICO of a square layer: Figma's PNGs as they are", async () => {
    const raster = fakeRaster();
    const square = { ...hero, width: 64, height: 64 };
    const ctx = context(raster, {
      bridge: fakeBridge((ask) => ({
        source: SOURCE,
        kind: 'exported',
        id: 1,
        name: 'Icon',
        bytes: pngBytes(
          ask.kind === 'export' ? ask.constraint!.value : 1,
          ask.kind === 'export' ? ask.constraint!.value : 1,
        ),
      })),
    });
    await exportLayer(square, target('ico'), { ...DEFAULT_EXPORT, iconSize: '256' }, 'local', ctx);
    expect(raster.encoded).toEqual([]);
  });
});

describe('exports made in the cloud', () => {
  it("AVIF: Figma's PNG goes up, the result comes back as the file", async () => {
    const server = fakeServer({ output: new Uint8Array([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70]) });
    const ctx = context(fakeRaster(), { api: new ConverterApi(BASE, KEY, server.fetch) });
    const out = await exportLayer(
      hero,
      target('avif'),
      { ...DEFAULT_EXPORT, quality: 'small', scale: 3 },
      'cloud',
      ctx,
    );
    expect(out).toMatchObject({ name: 'Hero.avif', route: 'cloud', credits: 1 });
    expect(out.blob.type).toBe('image/avif');
    expect(out.blob.size).toBe(8);
    const upload = server.requests.find((r) => r.url.endsWith('/v1/uploads'))!;
    expect(upload.body).toEqual({ fileName: 'Hero.png', size: 33 });
    const convert = server.requests.find((r) => r.url.endsWith('/v1/conversions'))!;
    expect(convert.body).toMatchObject({ to: 'avif', options: { quality: 'small' } });
    expect((ctx.bridge as ReturnType<typeof figma>).asked[0]).toMatchObject({
      format: 'PNG',
      constraint: { type: 'SCALE', value: 3 },
    });
  });

  it("smaller PDF: Figma's PDF, no size", async () => {
    const server = fakeServer();
    const ctx = context(fakeRaster(), { api: new ConverterApi(BASE, KEY, server.fetch) });
    await exportLayer(
      hero,
      target('pdf'),
      { ...DEFAULT_EXPORT, compression: 'light' },
      'cloud',
      ctx,
    );
    expect((ctx.bridge as ReturnType<typeof figma>).asked[0]).toMatchObject({
      format: 'PDF',
      constraint: null,
    });
    expect(server.requests.find((r) => r.url.endsWith('/v1/uploads'))!.body).toMatchObject({
      fileName: 'Hero.pdf',
    });
  });

  it("ICO in the cloud: Figma's PNG at 256 px or more", async () => {
    const server = fakeServer();
    const ctx = context(fakeRaster(), { api: new ConverterApi(BASE, KEY, server.fetch) });
    await exportLayer(hero, target('ico'), DEFAULT_EXPORT, 'cloud', ctx);
    expect((ctx.bridge as ReturnType<typeof figma>).asked[0]).toMatchObject({
      constraint: { type: 'SCALE', value: 1 },
    });
    expect(server.requests.find((r) => r.url.endsWith('/v1/conversions'))!.body).toMatchObject({
      to: 'ico',
      options: { iconSize: 'favicon' },
    });
  });

  it('without a key: says where to add one, and nothing is exported', async () => {
    const ctx = context(fakeRaster());
    await expect(
      exportLayer(hero, target('avif'), DEFAULT_EXPORT, 'cloud', ctx),
    ).rejects.toMatchObject({
      code: 'noKey',
    });
    expect((ctx.bridge as ReturnType<typeof figma>).asked).toEqual([]);
  });

  it("a failed conversion: the API's message", async () => {
    const server = fakeServer({
      fail: { code: 'conversionFailed', message: 'The file is damaged.' },
    });
    const ctx = context(fakeRaster(), { api: new ConverterApi(BASE, KEY, server.fetch) });
    await expect(
      exportLayer(hero, target('avif'), DEFAULT_EXPORT, 'cloud', ctx),
    ).rejects.toMatchObject({
      message: 'The file is damaged.',
    });
  });
});
