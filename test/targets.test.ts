import { describe, expect, it } from 'vitest';
import type { FormatInfo } from '../src/ui/api';
import {
  Catalog,
  DEFAULT_EXPORT,
  DEFAULT_PLACE,
  EXPORT_TARGETS,
  acceptList,
  canMakeInCloud,
  clampKb,
  cloudIconScale,
  cloudOptions,
  cloudPlan,
  exportFields,
  fileName,
  formatBytes,
  iconSides,
  layerName,
  routeOf,
  type ExportId,
} from '../src/ui/targets';
import formatsFixture from './fixtures/formats.json';

const FORMATS = (formatsFixture as { formats: FormatInfo[] }).formats;
const catalog = new Catalog(FORMATS);
const offline = new Catalog(null);
const target = (id: ExportId) => EXPORT_TARGETS.find((t) => t.id === id)!;
const chromium = { encodes: new Set(['image/webp']) };
const safari = { encodes: new Set<string>() };

describe('where each export is made', () => {
  it('in Figma when this app can, in the cloud otherwise', () => {
    expect(EXPORT_TARGETS.map((t) => [t.id, routeOf(t, chromium, catalog)])).toEqual([
      ['webp', 'local'],
      ['avif', 'cloud'],
      ['tiff', 'local'],
      ['ico', 'local'],
      ['pdf', 'cloud'],
    ]);
    // Safari writes no WebP from a canvas: the cloud does it.
    expect(routeOf(target('webp'), safari, catalog)).toBe('cloud');
    // A browser that writes AVIF would make it locally.
    expect(routeOf(target('avif'), { encodes: new Set(['image/avif']) }, catalog)).toBe('local');
  });

  it('offline, only what is made in Figma', () => {
    expect(EXPORT_TARGETS.map((t) => routeOf(t, chromium, offline))).toEqual([
      'local',
      null,
      'local',
      'local',
      null,
    ]);
    expect(canMakeInCloud(target('tiff'), catalog)).toBe(true);
    expect(canMakeInCloud(target('tiff'), offline)).toBe(false);
  });

  it("shows each target's settings and turns them into the API's options", () => {
    expect(exportFields(target('webp'))).toEqual({
      scale: true,
      quality: true,
      maxKb: true,
      iconSize: false,
      compression: false,
    });
    expect(exportFields(target('ico')).scale).toBe(false);
    expect(cloudOptions(target('avif'), { ...DEFAULT_EXPORT, quality: 'small', maxKb: 2 })).toEqual(
      {
        quality: 'small',
        maxKb: 5,
      },
    );
    expect(cloudOptions(target('ico'), { ...DEFAULT_EXPORT, iconSize: '64' })).toEqual({
      iconSize: '64',
    });
    expect(cloudOptions(target('pdf'), { ...DEFAULT_EXPORT, compression: 'strong' })).toEqual({
      compression: 'strong',
    });
    expect(cloudOptions(target('tiff'), DEFAULT_EXPORT)).toEqual({});
  });

  it('sizes icons and limits', () => {
    expect(iconSides('favicon')).toEqual([16, 32, 48]);
    expect(iconSides('256')).toEqual([256]);
    expect(clampKb(null)).toBeNull();
    expect(clampKb(0)).toBeNull();
    expect(clampKb(12.4)).toBe(12);
    expect(clampKb(10_000_000)).toBe(100_000);
    expect(cloudIconScale({ width: 64, height: 32 })).toBe(4);
    expect(cloudIconScale({ width: 100, height: 100 })).toBe(2.56);
    expect(cloudIconScale({ width: 1000, height: 10 })).toBe(1);
  });
});

describe('placing a file', () => {
  it('sends photos to PNG, drawings to SVG (or PNG), only what the cloud converts', () => {
    const format = (id: string) => catalog.get(id);
    expect(cloudPlan(format('dng'), DEFAULT_PLACE, catalog)).toEqual({
      to: 'png',
      options: { longSide: '2560' },
    });
    expect(cloudPlan(format('nef'), { ...DEFAULT_PLACE, longSide: 'max' }, catalog)).toEqual({
      to: 'png',
      options: {},
    });
    expect(cloudPlan(format('eps'), DEFAULT_PLACE, catalog)).toEqual({ to: 'svg', options: {} });
    expect(cloudPlan(format('ai'), { ...DEFAULT_PLACE, drawingAs: 'png' }, catalog)).toEqual({
      to: 'png',
      options: {},
    });
    // Figma's own formats and what is not a picture are not placed through the cloud.
    expect(cloudPlan(format('png'), DEFAULT_PLACE, catalog)).toBeNull();
    expect(cloudPlan(format('docx'), DEFAULT_PLACE, catalog)).toBeNull();
    expect(cloudPlan(undefined, DEFAULT_PLACE, catalog)).toBeNull();
  });

  it("lists the file picker's extensions, without Figma's own", () => {
    const accept = acceptList(catalog).split(',');
    for (const extension of [
      '.avif',
      '.tif',
      '.tiff',
      '.dng',
      '.cr2',
      '.nef',
      '.arw',
      '.eps',
      '.ai',
      '.bmp',
      '.ico',
    ])
      expect(accept).toContain(extension);
    for (const extension of ['.png', '.jpg', '.heic', '.webp', '.svg'])
      expect(accept).not.toContain(extension);
    expect(acceptList(offline)).toBe('.avif,.bmp,.ico,.tif,.tiff');
  });

  it('finds a format by extension', () => {
    expect(catalog.formatOfName('IMG_0001.TIF')?.id).toBe('tiff');
    expect(catalog.formatOfName('noextension')).toBeUndefined();
  });
});

describe('names and sizes', () => {
  it('makes file and layer names', () => {
    expect(fileName('Hero / Desktop: v2?', 'webp')).toBe('Hero Desktop v2.webp');
    expect(fileName('...', 'ico')).toBe('Layer.ico');
    expect(layerName('IMG_0001.dng')).toBe('IMG_0001');
    expect(formatBytes(999)).toBe('999 B');
    expect(formatBytes(12_345)).toBe('12 KB');
    expect(formatBytes(3_000_000)).toBe('3 MB');
  });
});
