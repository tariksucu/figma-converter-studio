import { describe, expect, it } from 'vitest';
import type { FormatInfo } from '../src/ui/api';
import {
  Catalog,
  DEFAULT_EXPORT,
  DEFAULT_JOB,
  DEFAULT_PLACE,
  EXPORT_TARGETS,
  acceptList,
  canMakeInCloud,
  clampKb,
  cloudIconScale,
  cloudOptions,
  cloudPlan,
  exportFields,
  exportSize,
  fileName,
  formatBytes,
  iconSides,
  jobOf,
  layerName,
  routeOf,
  scaleSuffix,
  scalesFor,
  settingsFrom,
  type ExportId,
} from '../src/ui/targets';
import formatsFixture from './fixtures/formats.json';

const FORMATS = (formatsFixture as { formats: FormatInfo[] }).formats;
const catalog = new Catalog(FORMATS);
const offline = new Catalog(null);
const target = (id: ExportId) => EXPORT_TARGETS.find((t) => t.id === id)!;
const chromium = { encodes: new Set(['image/jpeg', 'image/webp']) };
const safari = { encodes: new Set<string>(['image/jpeg']) };

describe('where each export is made', () => {
  it('in Figma when this app can, in the cloud otherwise', () => {
    expect(EXPORT_TARGETS.map((t) => [t.id, routeOf(t, chromium, catalog)])).toEqual([
      ['jpg', 'local'],
      ['png', 'local'],
      ['webp', 'local'],
      ['avif', 'cloud'],
      ['tiff', 'local'],
      ['ico', 'local'],
      ['pdf', 'cloud'],
    ]);
    // Safari writes no WebP from a canvas: the cloud does it.
    expect(routeOf(target('webp'), safari, catalog)).toBe('cloud');
    expect(routeOf(target('jpg'), safari, catalog)).toBe('local');
    // A browser that writes AVIF would make it locally.
    expect(routeOf(target('avif'), { encodes: new Set(['image/avif']) }, catalog)).toBe('local');
  });

  it('offline, only what is made in Figma; PNG is never sent to the cloud', () => {
    expect(EXPORT_TARGETS.map((t) => routeOf(t, chromium, offline))).toEqual([
      'local',
      'local',
      'local',
      null,
      'local',
      'local',
      null,
    ]);
    expect(canMakeInCloud(target('tiff'), catalog)).toBe(true);
    expect(canMakeInCloud(target('tiff'), offline)).toBe(false);
    expect(canMakeInCloud(target('jpg'), catalog)).toBe(true);
    expect(canMakeInCloud(target('png'), catalog)).toBe(false);
  });

  it("shows each target's settings and turns them into the API's options", () => {
    expect(exportFields(target('jpg'))).toEqual({
      scale: 'several',
      quality: true,
      maxKb: true,
      maxSize: true,
      iconSize: false,
      compression: false,
      reduceColors: false,
    });
    expect(exportFields(target('png'))).toMatchObject({
      scale: 'several',
      quality: false,
      maxKb: true,
      maxSize: true,
      reduceColors: true,
    });
    expect(exportFields(target('webp'))).toMatchObject({ scale: 'several', quality: true });
    expect(exportFields(target('avif'))).toMatchObject({ scale: 'one', maxSize: true });
    expect(exportFields(target('tiff'))).toMatchObject({ scale: 'several', maxSize: false });
    expect(exportFields(target('ico')).scale).toBe(false);
    expect(cloudOptions(target('avif'), { ...DEFAULT_JOB, quality: 'small', maxKb: 2 })).toEqual({
      quality: 'small',
      maxKb: 5,
    });
    expect(cloudOptions(target('jpg'), { ...DEFAULT_JOB, maxKb: 150 })).toEqual({
      quality: 'high',
      maxKb: 150,
    });
    expect(cloudOptions(target('ico'), { ...DEFAULT_JOB, iconSize: '64' })).toEqual({
      iconSize: '64',
    });
    expect(cloudOptions(target('pdf'), { ...DEFAULT_JOB, compression: 'strong' })).toEqual({
      compression: 'strong',
    });
    expect(cloudOptions(target('tiff'), DEFAULT_JOB)).toEqual({});
  });

  it('several scales at once where a target takes them, named as Figma names them', () => {
    const three = { ...DEFAULT_EXPORT, scales: [1, 2, 3] };
    expect(scalesFor(target('jpg'), three)).toEqual([1, 2, 3]);
    expect(scalesFor(target('tiff'), three)).toEqual([1, 2, 3]);
    // One AVIF conversion at a time; ICO and PDF have no scale.
    expect(scalesFor(target('avif'), three)).toEqual([1]);
    expect(scalesFor(target('ico'), three)).toEqual([1]);
    expect(scalesFor(target('png'), { ...DEFAULT_EXPORT, scales: [] })).toEqual([1]);
    expect([1, 2, 3].map((s) => scaleSuffix(s, true))).toEqual(['', '@2x', '@3x']);
    expect(scaleSuffix(2, false)).toBe('');
    expect(jobOf(three, 2)).toEqual({ ...DEFAULT_JOB, scale: 2 });
  });

  it('fits the export in the maximum size by asking Figma for that width or height', () => {
    const hero = { width: 1440, height: 900 };
    const none = { maxWidth: null, maxHeight: null };
    expect(exportSize(hero, 2, none)).toEqual({
      constraint: { type: 'SCALE', value: 2 },
      width: 2880,
      height: 1800,
    });
    // Wider than allowed: exactly the width, the height in proportion.
    expect(exportSize(hero, 2, { maxWidth: 1600, maxHeight: null })).toEqual({
      constraint: { type: 'WIDTH', value: 1600 },
      width: 1600,
      height: 1000,
    });
    // Both limits: the one that shrinks it more.
    expect(exportSize(hero, 1, { maxWidth: 1200, maxHeight: 600 })).toEqual({
      constraint: { type: 'HEIGHT', value: 600 },
      width: 960,
      height: 600,
    });
    // Already within: the scale as it is (no enlarging).
    expect(exportSize(hero, 1, { maxWidth: 4000, maxHeight: 4000 }).constraint).toEqual({
      type: 'SCALE',
      value: 1,
    });
    expect(exportSize({ width: 100.4, height: 20 }, 1, none)).toMatchObject({ width: 101 });
  });

  it('remembered settings over the defaults', () => {
    expect(settingsFrom(null)).toEqual(DEFAULT_EXPORT);
    expect(settingsFrom({ format: 'png', maxKb: 150, scales: [1, 2] })).toEqual({
      ...DEFAULT_EXPORT,
      maxKb: 150,
      scales: [1, 2],
    });
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
