import { startPlugin } from './plugin';

// code.js: Figma runs it in its sandbox, where `figma` is the plugin API and `__html__` is the
// panel (ui.html, named in manifest.json). plugin.ts takes the API as an argument, typed with
// the module edition of Figma's typings (so the tests can stand in for it); the global edition
// describes the same object, but TypeScript cannot match the two copies' recursive types.
startPlugin(figma as unknown as Parameters<typeof startPlugin>[0], __html__);
