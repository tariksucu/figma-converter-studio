import { describe, expect, it, vi } from 'vitest';
import { ConverterApi, type FormatInfo } from '../src/ui/api';
import { placeInCloud, placeLocal, planPlace, type PlaceContext } from '../src/ui/placer';
import { Catalog, DEFAULT_PLACE } from '../src/ui/targets';
import { SOURCE } from '../src/shared/messages';
import { BASE, KEY, fakeServer } from './fake-server';
import { fakeBridge, fakeRaster, pngBytes } from './fakes';
import formatsFixture from './fixtures/formats.json';

const catalog = new Catalog((formatsFixture as { formats: FormatInfo[] }).formats);
const file = (name: string, bytes: Uint8Array = new Uint8Array([1, 2, 3])) =>
  new File([bytes as Uint8Array<ArrayBuffer>], name);
/** Reads AVIF files (as Chromium and Firefox do), by their name's bytes here. */
const browser = () =>
  fakeRaster({ decodes: (bytes) => (bytes[0] === 0x41 ? { width: 5000, height: 2500 } : null) });

function placing() {
  return fakeBridge((ask) => {
    if (ask.kind !== 'place-image' && ask.kind !== 'place-svg') throw new Error(ask.kind);
    return {
      source: SOURCE,
      kind: 'placed',
      id: 1,
      name: ask.name,
      destination: { kind: 'page', name: null },
    };
  });
}

describe('what happens to a picked file', () => {
  it("leaves Figma's own formats to Figma", async () => {
    for (const name of ['a.png', 'b.JPG', 'c.heic', 'd.webp', 'e.svg', 'f.gif'])
      expect(await planPlace(file(name), catalog, browser())).toMatchObject({ kind: 'native' });
  });

  it('reads what the browser can, sends the rest to the cloud, refuses the others', async () => {
    expect(
      await planPlace(file('photo.avif', new Uint8Array([0x41])), catalog, browser()),
    ).toMatchObject({
      kind: 'local',
      picture: { width: 5000, height: 2500 },
    });
    expect(await planPlace(file('IMG_1.DNG'), catalog, browser())).toMatchObject({
      kind: 'cloud',
      format: { id: 'dng' },
    });
    expect(await planPlace(file('logo.eps'), catalog, browser())).toMatchObject({ kind: 'cloud' });
    expect(await planPlace(file('report.docx'), catalog, browser())).toEqual({
      kind: 'unsupported',
    });
    expect(await planPlace(file('IMG_1.DNG'), new Catalog(null), browser())).toEqual({
      kind: 'unsupported',
    });
  });
});

describe('placing', () => {
  it('a picture read here: a PNG of at most 4096 px', async () => {
    const raster = browser();
    const bridge = placing();
    const picture = (await raster.decode(new Blob([new Uint8Array([0x41])])))!;
    const placed = await placeLocal(file('photo.avif'), picture, {
      bridge,
      raster,
      api: null,
      confirmPrice: vi.fn(),
    });
    expect(placed).toMatchObject({ name: 'photo', credits: 0 });
    expect(raster.encoded).toEqual([
      { mime: 'image/png', options: { width: 4096, height: 2048 }, width: 4096, height: 2048 },
    ]);
    expect(bridge.asked[0]).toMatchObject({ kind: 'place-image', name: 'photo' });
  });

  it('a camera RAW in the cloud: converted to PNG, then placed', async () => {
    const server = fakeServer({ output: pngBytes(2560, 1707) });
    const bridge = placing();
    const context: PlaceContext = {
      bridge,
      raster: browser(),
      api: new ConverterApi(BASE, KEY, server.fetch),
      confirmPrice: vi.fn(),
    };
    const placed = await placeInCloud(
      file('IMG_1.DNG'),
      catalog.get('dng')!,
      DEFAULT_PLACE,
      catalog,
      context,
    );
    expect(placed).toMatchObject({ name: 'IMG_1', credits: 1 });
    expect(server.requests.find((r) => r.url.endsWith('/v1/conversions'))!.body).toMatchObject({
      to: 'png',
      options: { longSide: '2560' },
    });
    expect(bridge.asked[0]).toMatchObject({ kind: 'place-image', name: 'IMG_1' });
  });

  it('an EPS in the cloud: SVG, placed as vector layers', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>';
    const server = fakeServer({ output: new TextEncoder().encode(svg) });
    const bridge = placing();
    await placeInCloud(file('logo.eps'), catalog.get('eps')!, DEFAULT_PLACE, catalog, {
      bridge,
      raster: browser(),
      api: new ConverterApi(BASE, KEY, server.fetch),
      confirmPrice: vi.fn(),
    });
    expect(bridge.asked).toEqual([{ kind: 'place-svg', name: 'logo', svg }]);
  });

  it('the cloud without a key: says where to add one', async () => {
    await expect(
      placeInCloud(file('IMG_1.DNG'), catalog.get('dng')!, DEFAULT_PLACE, catalog, {
        bridge: placing(),
        raster: browser(),
        api: null,
        confirmPrice: vi.fn(),
      }),
    ).rejects.toMatchObject({ code: 'noKey' });
  });
});
