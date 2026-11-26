import { describe, expect, it, vi } from 'vitest';
import { ConverterApi } from '../src/ui/api';
import type { Ask } from '../src/ui/bridge';
import { browserDeflate } from '../src/ui/encode/tiff';
import { JPG_BACKGROUND, exportLayer, type ExportContext } from '../src/ui/exporter';
import { DEFAULT_JOB, EXPORT_TARGETS, type ExportId } from '../src/ui/targets';
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
      { ...DEFAULT_JOB, scale: 2, quality: 'balanced' },
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
      { ...DEFAULT_JOB, maxKb: 20 },
      'local',
      context(raster),
    );
    expect(out.blob.size).toBeLessThanOrEqual(20_000);
    expect(out.blob.size).toBeGreaterThan(19_000);
    expect(out).toMatchObject({ detail: 'quality 31', over: undefined });
    expect(raster.encoded.length).toBeLessThanOrEqual(9);
  });

  it('WebP under a size it cannot reach: the smallest file, marked as over (no cloud)', async () => {
    const raster = fakeRaster({ sizeOf: (q) => 40_000 + Math.round(q * 10_000) });
    const ctx = context(raster);
    const out = await exportLayer(
      hero,
      target('webp'),
      { ...DEFAULT_JOB, maxKb: 10 },
      'local',
      ctx,
    );
    expect(out).toMatchObject({
      name: 'Hero.webp',
      route: 'local',
      detail: 'quality 5',
      over: 'over 10 KB even at quality 5',
    });
    expect(out.blob.size).toBe(40_500);
    expect(raster.encoded.map((e) => e.options.quality)).toEqual([0.9, 0.05]);
  });

  it('a browser that cannot write the format: a local failure', async () => {
    await expect(
      exportLayer(hero, target('webp'), DEFAULT_JOB, 'local', context(fakeRaster({ encodes: [] }))),
    ).rejects.toThrow('could not write WebP');
  });

  it('too large for a canvas: refused before Figma renders it', async () => {
    const ctx = context(fakeRaster());
    const banner = { ...hero, width: 9000, height: 9000 };
    await expect(
      exportLayer(banner, target('tiff'), { ...DEFAULT_JOB, scale: 2 }, 'local', ctx),
    ).rejects.toThrow('too large to convert here');
    expect((ctx.bridge as ReturnType<typeof figma>).asked).toEqual([]);
  });

  it('TIFF: our writer, at 72 dpi times the scale', async () => {
    const out = await exportLayer(
      hero,
      target('tiff'),
      { ...DEFAULT_JOB, scale: 2 },
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
    const out = await exportLayer(hero, target('ico'), DEFAULT_JOB, 'local', ctx);
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
    await exportLayer(square, target('ico'), { ...DEFAULT_JOB, iconSize: '256' }, 'local', ctx);
    expect(raster.encoded).toEqual([]);
  });
});

describe('JPG on this computer', () => {
  it("Figma's PNG at the scale, written on white at the chosen quality", async () => {
    const raster = fakeRaster();
    const ctx = context(raster);
    const out = await exportLayer(hero, target('jpg'), { ...DEFAULT_JOB, scale: 2 }, 'local', ctx);
    expect(out).toMatchObject({ name: 'Hero.jpg', route: 'local', credits: 0 });
    expect(out.over).toBeUndefined();
    expect(out.blob.type).toBe('image/jpeg');
    expect(raster.encoded).toEqual([
      {
        mime: 'image/jpeg',
        options: { quality: 0.9, background: JPG_BACKGROUND },
        width: 640,
        height: 400,
      },
    ]);
    expect(JPG_BACKGROUND).toBe('#ffffff');
  });

  it('under a size: the highest quality that fits, in at most 9 files', async () => {
    // 256,000 pixels at 2×: quality q makes 256,000 × q bytes; 150 KB allows q ≤ 0.585.
    const raster = fakeRaster();
    const out = await exportLayer(
      hero,
      target('jpg'),
      { ...DEFAULT_JOB, scale: 2, maxKb: 150 },
      'local',
      context(raster),
    );
    expect(out).toMatchObject({ detail: 'quality 58', over: undefined });
    expect(out.blob.size).toBe(Math.round(256_000 * 0.58));
    expect(raster.encoded.length).toBeLessThanOrEqual(9);
    expect(raster.encoded.every((e) => e.options.background === JPG_BACKGROUND)).toBe(true);
  });

  it('a size it cannot reach: the closest file, and why', async () => {
    const raster = fakeRaster({ sizeOf: (q, w, h) => Math.round(w * h * (0.5 + q)) });
    const out = await exportLayer(
      hero,
      target('jpg'),
      { ...DEFAULT_JOB, maxKb: 5 },
      'local',
      context(raster),
    );
    expect(out.over).toBe('over 5 KB even at quality 5');
    expect(out.blob.size).toBe(Math.round(64_000 * 0.55));
  });

  it('within a maximum size: Figma renders exactly that width', async () => {
    const raster = fakeRaster();
    const ctx = context(raster);
    const out = await exportLayer(
      hero,
      target('jpg'),
      { ...DEFAULT_JOB, scale: 3, maxWidth: 400 },
      'local',
      ctx,
      '@3x',
    );
    expect(out.name).toBe('Hero@3x.jpg');
    expect((ctx.bridge as ReturnType<typeof figma>).asked[0]).toMatchObject({
      constraint: { type: 'WIDTH', value: 400 },
    });
    expect(raster.encoded.map((e) => [e.width, e.height])).toEqual([[400, 250]]);
  });

  it("a shadow makes Figma's export larger: it is drawn smaller to fit", async () => {
    const raster = fakeRaster();
    // Figma's export is 40 px wider and taller than the layer (a drop shadow).
    const shadowed = fakeBridge(() => ({
      source: SOURCE,
      kind: 'exported',
      id: 1,
      name: 'Hero',
      bytes: pngBytes(440, 290),
    }));
    await exportLayer(
      hero,
      target('jpg'),
      { ...DEFAULT_JOB, maxWidth: 400, maxHeight: 400 },
      'local',
      context(raster, { bridge: shadowed }),
    );
    expect(raster.encoded.map((e) => [e.mime, e.width, e.height])).toEqual([
      ['image/png', 400, 264],
      ['image/jpeg', 400, 264],
    ]);
    expect(raster.closed).toBe(2);
  });
});

// Fewer colours quantizes the 320×200 picture with image-q (plain JavaScript) once per palette size
// the search tries, and writes each result: the slowest test takes about 2.5 s on a fast computer
// and took 5.3 s on GitHub's shared runner, over Vitest's 5 s default. 30 s still stops a search
// that never ends.
const ENCODING_TIMEOUT = 30_000;

describe('PNG on this computer', { timeout: ENCODING_TIMEOUT }, () => {
  /** A gradient with transparent corners: more than 256 colours. */
  const gradient = (x: number, y: number) =>
    x < 4 && y < 4
      ? ([0, 0, 0, 0] as const)
      : ([(x * 7) & 255, (y * 5) & 255, (x * y) & 255, 255] as const);
  /** Figma's PNG, stood in for: the right size, and `extra` bytes long. */
  const figmaPng = (extra: number) =>
    fakeBridge((ask) => {
      const c = ask.kind === 'export' ? ask.constraint : null;
      const scale = c?.type === 'SCALE' ? c.value : 1;
      return {
        source: SOURCE,
        kind: 'exported',
        id: 1,
        name: 'Hero',
        bytes: pngBytes(hero.width * scale, hero.height * scale, extra),
      };
    });
  const read = async (blob: Blob) => new Uint8Array(await blob.arrayBuffer());

  it("lossless: ours when it is smaller than Figma's, Figma's own when that is", async () => {
    const raster = fakeRaster({ paint: gradient });
    const ours = await exportLayer(
      hero,
      target('png'),
      DEFAULT_JOB,
      'local',
      context(raster, { bridge: figmaPng(1_000_000) }),
    );
    expect(ours).toMatchObject({ name: 'Hero.png', detail: 'lossless', over: undefined });
    expect(ours.blob.size).toBeLessThan(1_000_000);
    const bytes = await read(ours.blob);
    expect(Array.from(bytes.subarray(12, 16))).toEqual([0x49, 0x48, 0x44, 0x52]);
    // Figma's PNG (33 bytes here) is smaller than anything we write: kept as it is.
    const kept = await exportLayer(
      hero,
      target('png'),
      DEFAULT_JOB,
      'local',
      context(fakeRaster({ paint: gradient }), { bridge: figmaPng(0) }),
    );
    expect(kept.blob.size).toBe(33);
    expect(kept.detail).toBe('lossless');
  });

  it('over the size without fewer colours: lossless, marked as over', async () => {
    const out = await exportLayer(
      hero,
      target('png'),
      { ...DEFAULT_JOB, maxKb: 5 },
      'local',
      context(fakeRaster({ paint: gradient }), { bridge: figmaPng(1_000_000) }),
    );
    expect(out.detail).toBe('lossless');
    expect(out.over).toBe('over 5 KB (lossless)');
  });

  it('fewer colours allowed: the most colours that fit', async () => {
    const lossless = await exportLayer(
      hero,
      target('png'),
      DEFAULT_JOB,
      'local',
      context(fakeRaster({ paint: gradient }), { bridge: figmaPng(1_000_000) }),
    );
    // Half the lossless size: some palette fits.
    const maxKb = Math.max(5, Math.floor(lossless.blob.size / 2000));
    const out = await exportLayer(
      hero,
      target('png'),
      { ...DEFAULT_JOB, maxKb, reduceColors: true },
      'local',
      context(fakeRaster({ paint: gradient }), { bridge: figmaPng(1_000_000) }),
    );
    expect(out.over).toBeUndefined();
    expect(out.detail).toMatch(/^\d+ colours$/);
    expect(out.blob.size).toBeLessThanOrEqual(maxKb * 1000);
    const bytes = await read(out.blob);
    // A palette PNG (colour type 3).
    expect(bytes[25]).toBe(3);
  });

  it('fewer colours allowed and it fits already: stays lossless', async () => {
    const out = await exportLayer(
      hero,
      target('png'),
      { ...DEFAULT_JOB, maxKb: 1000, reduceColors: true },
      'local',
      context(fakeRaster({ paint: gradient }), { bridge: figmaPng(1_000_000) }),
    );
    expect(out.detail).toBe('lossless');
  });

  it('fewer colours and no size: 256 colours, or lossless when it has no more', async () => {
    const out = await exportLayer(
      hero,
      target('png'),
      { ...DEFAULT_JOB, reduceColors: true },
      'local',
      context(fakeRaster({ paint: gradient }), { bridge: figmaPng(1_000_000) }),
    );
    expect(out.detail).toMatch(/^(25[0-6]|2[0-4]\d|1\d\d) colours$/);
    const flat = await exportLayer(
      hero,
      target('png'),
      { ...DEFAULT_JOB, reduceColors: true },
      'local',
      context(fakeRaster({ paint: (x) => (x < 100 ? [255, 84, 24, 255] : [0, 0, 0, 0]) }), {
        bridge: figmaPng(1_000_000),
      }),
    );
    expect(flat.detail).toBe('lossless');
  });

  it('a size not even 2 colours reach: the smallest file, marked as over', async () => {
    const out = await exportLayer(
      hero,
      target('png'),
      { ...DEFAULT_JOB, maxKb: 5, reduceColors: true },
      'local',
      context(
        fakeRaster({
          // Noise: every palette is large.
          paint: (x, y) => {
            // MurmurHash3's finalizer of the position.
            let v = Math.imul(x, 73_856_093) ^ Math.imul(y, 19_349_663);
            v = Math.imul(v ^ (v >>> 16), 0x85ebca6b);
            v = Math.imul(v ^ (v >>> 13), 0xc2b2ae35);
            v = (v ^ (v >>> 16)) >>> 0;
            return [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, 255];
          },
        }),
        { bridge: figmaPng(1_000_000) },
      ),
    );
    expect(out.over).toMatch(/^over 5 KB even with \d+ colours$|^over 5 KB \(lossless\)$/);
    expect(out.blob.size).toBeGreaterThan(5000);
  });

  it('without a compressor in the app: Figma’s PNG as it is', async () => {
    const out = await exportLayer(
      hero,
      target('png'),
      { ...DEFAULT_JOB, maxKb: 5 },
      'local',
      context(fakeRaster(), { bridge: figmaPng(10_000), deflate: null }),
    );
    expect(out.blob.size).toBe(10_033);
    expect(out.over).toBe('over 5 KB');
  });

  it('stops when canceled during the search', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      exportLayer(
        hero,
        target('png'),
        { ...DEFAULT_JOB, maxKb: 5, reduceColors: true },
        'local',
        context(fakeRaster({ paint: gradient }), {
          bridge: figmaPng(1_000_000),
          signal: controller.signal,
        }),
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('exports made in the cloud', () => {
  it("AVIF: Figma's PNG goes up, the result comes back as the file", async () => {
    const server = fakeServer({ output: new Uint8Array([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70]) });
    const ctx = context(fakeRaster(), { api: new ConverterApi(BASE, KEY, server.fetch) });
    const out = await exportLayer(
      hero,
      target('avif'),
      { ...DEFAULT_JOB, quality: 'small', scale: 3 },
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
    await exportLayer(hero, target('pdf'), { ...DEFAULT_JOB, compression: 'light' }, 'cloud', ctx);
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
    await exportLayer(hero, target('ico'), DEFAULT_JOB, 'cloud', ctx);
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
      exportLayer(hero, target('avif'), DEFAULT_JOB, 'cloud', ctx),
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
      exportLayer(hero, target('avif'), DEFAULT_JOB, 'cloud', ctx),
    ).rejects.toMatchObject({
      message: 'The file is damaged.',
    });
  });
});
