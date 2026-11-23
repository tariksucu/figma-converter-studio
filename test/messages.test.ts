import { describe, expect, it } from 'vitest';
import {
  MAX_IMAGE_BYTES,
  SOURCE,
  cleanName,
  isApiBase,
  isApiKey,
  parsePluginMessage,
  parseRequest,
} from '../src/shared/messages';

const KEY = `cvs_live_${'A1'.repeat(16)}`;
const request = (fields: Record<string, unknown>) =>
  parseRequest({ source: SOURCE, id: 7, ...fields });

describe('messages from the panel', () => {
  it('takes the well-formed ones', () => {
    expect(request({ kind: 'hello' })).toEqual({ source: SOURCE, kind: 'hello', id: 7 });
    expect(request({ kind: 'save-key', apiKey: KEY })).toMatchObject({ apiKey: KEY });
    expect(request({ kind: 'save-key', apiKey: null })).toMatchObject({ apiKey: null });
    expect(request({ kind: 'save-base', apiBase: 'https://converter.studio/api' })).toMatchObject({
      apiBase: 'https://converter.studio/api',
    });
    expect(
      request({
        kind: 'export',
        layerId: '1:2',
        format: 'PNG',
        constraint: { type: 'SCALE', value: 2 },
      }),
    ).toMatchObject({ constraint: { type: 'SCALE', value: 2 } });
    expect(
      request({ kind: 'export', layerId: '1:2', format: 'PDF', constraint: null }),
    ).toMatchObject({
      format: 'PDF',
    });
    expect(
      request({ kind: 'place-image', name: 'a\u0000b', bytes: new Uint8Array([1]) }),
    ).toMatchObject({ name: 'a b' });
    expect(request({ kind: 'place-svg', name: 'x', svg: '<svg width="1"></svg>' })).not.toBeNull();
    expect(request({ kind: 'notify', message: 'x'.repeat(300) })).toMatchObject({
      message: 'x'.repeat(200),
    });
  });

  it('refuses the rest', () => {
    for (const fields of [
      { kind: 'nope' },
      { kind: 'save-key', apiKey: 'cvs_live_short' },
      { kind: 'save-key' },
      { kind: 'save-base', apiBase: 'javascript:alert(1)' },
      { kind: 'save-base', apiBase: 'https://user:pass@converter.studio/api' },
      { kind: 'export', layerId: '1:2', format: 'SVG', constraint: null },
      { kind: 'export', layerId: '1:2', format: 'PNG', constraint: { type: 'SCALE', value: 5 } },
      { kind: 'export', layerId: '1:2', format: 'PNG', constraint: { type: 'WIDTH', value: 0 } },
      { kind: 'export', layerId: '1:2', format: 'PNG', constraint: { type: 'WIDTH', value: 1.5 } },
      { kind: 'export', layerId: '1:2', format: 'PDF', constraint: { type: 'SCALE', value: 1 } },
      { kind: 'export', layerId: '', format: 'PNG', constraint: null },
      { kind: 'place-image', name: 'x', bytes: [1, 2] },
      { kind: 'place-image', name: 'x', bytes: new Uint8Array() },
      { kind: 'place-image', name: 'x', bytes: new Uint8Array(MAX_IMAGE_BYTES + 1) },
      { kind: 'place-svg', name: 'x', svg: '<html></html>' },
      { kind: 'notify', message: '' },
    ])
      expect(request(fields), `${fields.kind} ${Object.keys(fields).join(',')}`).toBeNull();
    expect(parseRequest({ source: 'else', id: 1, kind: 'hello' })).toBeNull();
    expect(parseRequest({ source: SOURCE, id: 0, kind: 'hello' })).toBeNull();
    expect(parseRequest(null)).toBeNull();
  });
});

describe('messages from the plugin', () => {
  const selection = {
    layers: [{ id: '1:2', name: 'Hero', type: 'FRAME', width: 320, height: 200 }],
    count: 1,
    destination: { kind: 'frame', name: 'Hero' },
  };

  it('takes the well-formed ones and cleans what they carry', () => {
    expect(
      parsePluginMessage({
        source: SOURCE,
        kind: 'context',
        id: 1,
        selection,
        settings: { apiKey: KEY, apiBase: 'ftp://x' },
      }),
    ).toEqual({
      source: SOURCE,
      kind: 'context',
      id: 1,
      selection,
      settings: { apiKey: KEY, apiBase: null },
    });
    expect(parsePluginMessage({ source: SOURCE, kind: 'selection', selection })).toMatchObject({
      kind: 'selection',
    });
    expect(
      parsePluginMessage({
        source: SOURCE,
        kind: 'exported',
        id: 2,
        name: '',
        bytes: new Uint8Array([1]),
      }),
    ).toMatchObject({ name: 'Layer' });
    expect(
      parsePluginMessage({ source: SOURCE, kind: 'failed', id: 3, message: '' }),
    ).toMatchObject({
      message: 'Figma could not do that.',
    });
    expect(
      parsePluginMessage({
        source: SOURCE,
        kind: 'placed',
        id: 4,
        name: 'p',
        destination: { kind: 'page' },
      }),
    ).toMatchObject({ destination: { kind: 'page', name: null } });
  });

  it('refuses the rest', () => {
    expect(parsePluginMessage({ source: SOURCE, kind: 'selection', selection: {} })).toBeNull();
    expect(
      parsePluginMessage({
        source: SOURCE,
        kind: 'selection',
        selection: { ...selection, destination: { kind: 'board' } },
      }),
    ).toBeNull();
    expect(
      parsePluginMessage({ source: SOURCE, kind: 'exported', id: 2, name: 'x', bytes: 'abc' }),
    ).toBeNull();
    expect(parsePluginMessage({ kind: 'done', id: 1 })).toBeNull();
  });
});

describe('checks', () => {
  it('knows an API key and an API address', () => {
    expect(isApiKey(KEY)).toBe(true);
    expect(isApiKey(`${KEY}x`)).toBe(false);
    expect(isApiKey(`cvs_test_${'a'.repeat(32)}`)).toBe(false);
    expect(isApiBase('https://converter.studio/api')).toBe(true);
    expect(isApiBase('http://localhost:4391/api')).toBe(true);
    expect(isApiBase('https://converter.studio/api?x=1')).toBe(false);
    expect(isApiBase('file:///etc/passwd')).toBe(false);
  });

  it('cleans names', () => {
    expect(cleanName('  \tHero\n ')).toBe('Hero');
    expect(cleanName('   ', 'Frame')).toBe('Frame');
    expect(cleanName('x'.repeat(300))).toHaveLength(200);
  });
});
