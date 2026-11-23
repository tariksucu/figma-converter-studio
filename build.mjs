// Builds the plugin into dist/: manifest.json, code.js and ui.html, the folder Figma's desktop
// app imports (Plugins → Development → Import plugin from manifest…) and publishes.
//
//   node build.mjs                          for converter.studio (API: https://converter.studio/api)
//   node build.mjs --api <url> [--out dir]  a development build against another API (a local
//                                           one): its origin is added to the manifest's
//                                           `devAllowedDomains`, which Figma honours only for
//                                           a plugin in development
//
// Figma shows ui.html as one document: the panel's script and styles are inlined into it.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import * as esbuild from 'esbuild';

const root = fileURLToPath(new URL('.', import.meta.url));
export const PRODUCTION_API = 'https://converter.studio/api';
/** What the release manifest may reach: Converter Studio's API, nothing else. */
const ALLOWED = ['https://converter.studio/api/'];

/** @type {import('esbuild').BuildOptions} */
const common = {
  absWorkingDir: root,
  bundle: true,
  format: 'iife',
  // Figma's sandbox takes ES2020 (optional chaining, nullish coalescing); the panel is Chromium.
  target: ['es2020'],
  // Readable for anyone who looks (Figma's reviewers too): bundled, not minified, no source map.
  minify: false,
  legalComments: 'inline',
  logLevel: 'warning',
  write: false,
};

const text = (result) => result.outputFiles[0].text;

/** Builds into `out` (default dist/) against `api` (default production's). */
export async function build({ api = PRODUCTION_API, out = 'dist' } = {}) {
  const apiBase = api.replace(/\/$/, '');
  const production = apiBase === PRODUCTION_API;
  const dist = resolve(root, out);
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });

  const code = text(
    await esbuild.build({
      ...common,
      entryPoints: ['src/code/index.ts'],
      outfile: 'code.js',
      platform: 'neutral',
    }),
  );
  const ui = text(
    await esbuild.build({
      ...common,
      entryPoints: ['src/ui/main.ts'],
      outfile: 'ui.js',
      platform: 'browser',
      define: { __API_BASE__: JSON.stringify(apiBase) },
    }),
  );
  if (/<\/script/i.test(ui)) throw new Error('ui.js holds "</script": it cannot be inlined');
  const template = await readFile(join(root, 'public/ui.html'), 'utf8');
  const styles = await readFile(join(root, 'public/styles.css'), 'utf8');
  // Functions as replacements: `$` in the code is not a pattern.
  const html = template.replace('/*__STYLES__*/', () => styles).replace('/*__SCRIPT__*/', () => ui);

  const manifest = JSON.parse(await readFile(join(root, 'public/manifest.json'), 'utf8'));
  checkManifest(manifest);
  if (!production)
    manifest.networkAccess = {
      ...manifest.networkAccess,
      devAllowedDomains: [new URL(apiBase).origin],
    };

  checkBundle(code, html, production);
  await writeFile(join(dist, 'code.js'), code);
  await writeFile(join(dist, 'ui.html'), html);
  await writeFile(join(dist, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { dist, apiBase, manifest };
}

/** The manifest as Figma's documentation describes it, and nothing more than the plugin needs. */
export function checkManifest(manifest) {
  const problems = [];
  if (typeof manifest.name !== 'string' || !manifest.name) problems.push('no name');
  if (typeof manifest.id !== 'string' || !manifest.id) problems.push('no id');
  if (manifest.api !== '1.0.0') problems.push('api must be 1.0.0');
  if (manifest.main !== 'code.js' || manifest.ui !== 'ui.html')
    problems.push('main and ui must be code.js and ui.html (next to the manifest)');
  if (JSON.stringify(manifest.editorType) !== '["figma"]') problems.push('editorType: ["figma"]');
  // Required of every new plugin: pages load on demand.
  if (manifest.documentAccess !== 'dynamic-page') problems.push('documentAccess: dynamic-page');
  const network = manifest.networkAccess;
  if (JSON.stringify(network?.allowedDomains) !== JSON.stringify(ALLOWED))
    problems.push(`networkAccess.allowedDomains must be ${ALLOWED.join(', ')}`);
  if (typeof network?.reasoning !== 'string' || network.reasoning.length < 40)
    problems.push('networkAccess.reasoning: say why the plugin goes online');
  if ('devAllowedDomains' in (network ?? {}))
    problems.push('no devAllowedDomains in the release manifest (the build adds them)');
  for (const field of [
    'permissions',
    'capabilities',
    'enableProposedApi',
    'enablePrivatePluginApi',
  ])
    if (field in manifest) problems.push(`no ${field}: the plugin does not need it`);
  if (problems.length) throw new Error(`manifest.json: ${problems.join('; ')}`);
}

/** No network or DOM in code.js; no local address, source map, code from strings or key. */
export function checkBundle(code, html, production) {
  const problems = [];
  for (const [name, source] of [
    ['code.js', code],
    ['ui.html', html],
  ]) {
    for (const [pattern, what] of [
      [/sourceMappingURL/, 'a source map reference'],
      [/\beval\s*\(|new Function\s*\(/, 'code built from strings'],
      [/cvs_live_[A-Za-z0-9]{32}/, 'an API key'],
      ...(production ? [[/localhost|127\.0\.0\.1|\[::1\]/, 'a local address']] : []),
    ])
      if (pattern.test(source)) problems.push(`${name} has ${what}`);
  }
  // Figma's sandbox has none of these: code.js would fail when Figma runs it. It never goes
  // online either: the panel does, and only for the cloud.
  for (const name of ['window', 'document', 'localStorage', 'XMLHttpRequest', 'fetch'])
    if (new RegExp(`\\b${name}\\b`).test(code)) problems.push(`code.js uses ${name}`);
  if (production && !html.includes(PRODUCTION_API))
    problems.push('ui.html lacks the production API');
  if (problems.length) throw new Error(problems.join('; '));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values: args } = parseArgs({
    options: { api: { type: 'string' }, out: { type: 'string' } },
  });
  const { dist, apiBase } = await build({ api: args.api, out: args.out });
  console.log(`Built ${dist} (API: ${apiBase})`);
}
