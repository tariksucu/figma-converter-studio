import { ConverterApi } from './api';
import { createBridge } from './bridge';
import { browserDeflate } from './encode/tiff';
import { startPanel } from './panel';
import { browserRaster } from './raster';
import { saveFile } from './save';

/**
 * The panel's entry point, inlined into ui.html by the build (Figma shows ui.html as one
 * document). `__API_BASE__` is set by the build: https://converter.studio/api in the release.
 */
declare const __API_BASE__: string;

const app = document.getElementById('app');
if (app) {
  void startPanel(app, {
    bridge: createBridge(window),
    raster: browserRaster(),
    deflate: browserDeflate(),
    api: (base, key) => new ConverterApi(base, key),
    defaultBase: __API_BASE__,
    save: (blob, name) => saveFile(document, blob, name),
  });
}
