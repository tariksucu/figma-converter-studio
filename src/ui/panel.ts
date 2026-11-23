import { ApiError, type Account, type ConverterApi } from './api';
import { PluginError, type Bridge } from './bridge';
import { AUTO_CONFIRM_CREDITS, type Step } from './convert';
import { uniqueNames, zipStore } from './encode/zip';
import type { Deflate } from './encode/tiff';
import { LocalError, NO_KEY_MESSAGE, exportLayer, type Output } from './exporter';
import { externalLink, h, select, show } from './dom';
import { placeInCloud, placeLocal, planPlace, type PlacePlan } from './placer';
import type { Raster } from './raster';
import {
  COMPRESSIONS,
  CLOUD_PLACE,
  Catalog,
  DEFAULT_EXPORT,
  DEFAULT_PLACE,
  EXPORT_TARGETS,
  ICON_SIZES,
  LONG_SIDES,
  MAX_KB,
  MIN_KB,
  QUALITIES,
  SCALES,
  acceptList,
  canMakeInCloud,
  exportFields,
  formatBytes,
  routeOf,
  type Capabilities,
  type Compression,
  type DrawingAs,
  type ExportSettings,
  type ExportTarget,
  type IconSize,
  type LongSide,
  type PlaceSettings,
  type Quality,
  type Route,
} from './targets';
import {
  MAX_LAYERS,
  isApiBase,
  isApiKey,
  type LayerInfo,
  type SelectionState,
  type Settings,
} from '../shared/messages';

/**
 * The plugin's panel. **Export**: the selected layers to WebP, TIFF or ICO on this computer, or
 * to AVIF or a smaller PDF in Converter Studio's cloud. **Place a file**: pictures Figma cannot
 * open, read on this computer when the browser can, otherwise converted in the cloud.
 * **Settings**: the Converter Studio API key (needed only for the cloud) and, under Advanced,
 * the API's address.
 */

export const SITE = 'https://converter.studio';
export const LINKS = {
  site: SITE,
  apiKeys: `${SITE}/account#api-keys`,
  pricing: `${SITE}/pricing`,
  privacy: `${SITE}/privacy`,
  help: 'https://github.com/tariksucu/figma-converter-studio#readme',
};

export interface PanelDeps {
  readonly bridge: Bridge;
  readonly raster: Raster;
  readonly deflate: Deflate | null;
  /** The API at `base` with an account's key ('' for what needs none: the formats). */
  readonly api: (base: string, key: string) => ConverterApi;
  /** The API's address unless the user set another (https://converter.studio/api). */
  readonly defaultBase: string;
  /** Saves a file; called inside the user's click. */
  readonly save: (blob: Blob, name: string) => void;
}

type Tab = 'export' | 'place' | 'settings';

interface Row {
  readonly layer: LayerInfo;
  state: 'waiting' | 'working' | 'done' | 'failed';
  note: string;
  output?: Output;
  /** Failed on this computer, and the cloud can make it. */
  cloudable?: boolean;
}

interface Picked {
  readonly file: File;
  readonly plan: PlacePlan;
}

type Status = { readonly kind: 'info' | 'error' | 'done'; readonly text: string } | null;

interface State {
  tab: Tab;
  selection: SelectionState;
  settings: Settings;
  account: Account | null;
  catalog: Catalog;
  caps: Capabilities;
  target: ExportTarget;
  exportSettings: ExportSettings;
  rows: Row[];
  saveable: { readonly name: string; readonly blob: Blob } | null;
  exportStatus: Status;
  picked: Picked | null;
  placeSettings: PlaceSettings;
  placeStatus: Status;
  settingsStatus: Status;
  busy: AbortController | null;
}

const EMPTY_SELECTION: SelectionState = {
  layers: [],
  count: 0,
  destination: { kind: 'page', name: null },
};

const QUALITY_LABELS: Readonly<Record<Quality, string>> = {
  high: 'High quality',
  balanced: 'Balanced',
  small: 'Smallest file',
};
const ICON_LABELS: Readonly<Record<IconSize, string>> = {
  favicon: 'Favicon (16, 32 and 48 px)',
  '256': '256 px',
  '128': '128 px',
  '64': '64 px',
  '48': '48 px',
  '32': '32 px',
  '16': '16 px',
};
const COMPRESSION_LABELS: Readonly<Record<Compression, string>> = {
  balanced: 'Balanced',
  strong: 'Strong (smallest)',
  light: 'Light (best quality)',
};
const SIZE_LABELS: Readonly<Record<LongSide, string>> = {
  '2560': 'Up to 2560 px',
  '1920': 'Up to 1920 px',
  '1280': 'Up to 1280 px',
  max: "Up to 4096 px (Figma's largest)",
};
const DRAWING_LABELS: Readonly<Record<DrawingAs, string>> = {
  svg: 'Editable vector layers (SVG)',
  png: 'A picture (PNG)',
};

const CLOUD_BADGE = 'Converter Studio cloud · uses credits';
const LOCAL_BADGE = 'In Figma';

export async function startPanel(container: HTMLElement, deps: PanelDeps): Promise<void> {
  const { bridge, raster } = deps;
  const state: State = {
    tab: 'export',
    selection: EMPTY_SELECTION,
    settings: { apiKey: null, apiBase: null },
    account: null,
    catalog: new Catalog(null),
    caps: { encodes: new Set() },
    target: EXPORT_TARGETS[0]!,
    exportSettings: DEFAULT_EXPORT,
    rows: [],
    saveable: null,
    exportStatus: null,
    picked: null,
    placeSettings: DEFAULT_PLACE,
    placeStatus: null,
    settingsStatus: null,
    busy: null,
  };

  const header = h('header', { class: 'bar' });
  const tabs = h('nav', { class: 'tabs', role: 'tablist' });
  const body = h('main', { class: 'body' });
  const dialog = h('div', { class: 'dialog', hidden: true, role: 'dialog', 'aria-modal': 'true' });
  const footer = h(
    'footer',
    { class: 'foot' },
    externalLink(LINKS.help, 'Help'),
    externalLink(LINKS.pricing, 'Plans and credits'),
    externalLink(LINKS.privacy, 'Privacy'),
  );
  container.replaceChildren(header, tabs, body, footer, dialog);

  const base = () => state.settings.apiBase ?? deps.defaultBase;
  const cloudApi = () => (state.settings.apiKey ? deps.api(base(), state.settings.apiKey) : null);

  bridge.onNotice((notice) => {
    state.selection = notice.selection;
    // While something runs, the panel keeps showing it; the new selection shows after.
    if (!state.busy) render();
  });

  // ── Header and tabs ───────────────────────────────────────────────────────────────────

  function renderHeader() {
    const brand = h(
      'a',
      { class: 'brand', href: LINKS.site, target: '_blank', rel: 'noopener noreferrer' },
      h('span', { class: 'mark', 'aria-hidden': 'true' }),
      h('span', { class: 'brand-name', text: 'Converter Studio' }),
    );
    const account = state.account
      ? `${state.account.credits} credit${state.account.credits === 1 ? '' : 's'}`
      : state.settings.apiKey
        ? 'Cloud: key saved'
        : 'Cloud: not connected';
    show(header, brand, h('span', { class: 'credits', text: account }));
  }

  function renderTabs() {
    const items: ReadonlyArray<readonly [Tab, string]> = [
      ['export', 'Export'],
      ['place', 'Place a file'],
      ['settings', 'Settings'],
    ];
    show(
      tabs,
      ...items.map(([tab, label]) => {
        const button = h('button', {
          type: 'button',
          role: 'tab',
          class: 'tab',
          id: `tab-${tab}`,
          'aria-selected': state.tab === tab ? 'true' : 'false',
          text: label,
        });
        button.addEventListener('click', () => {
          state.tab = tab;
          render();
        });
        return button;
      }),
    );
  }

  function render() {
    renderHeader();
    renderTabs();
    if (state.tab === 'export') renderExport();
    else if (state.tab === 'place') renderPlace();
    else renderSettings();
  }

  // ── Shared bits ───────────────────────────────────────────────────────────────────────

  function badge(route: Route) {
    return h('span', {
      class: `badge badge-${route}`,
      text: route === 'local' ? LOCAL_BADGE : CLOUD_BADGE,
    });
  }

  function statusLine(status: Status) {
    if (!status) return null;
    return h('p', {
      class: `status status-${status.kind}`,
      role: status.kind === 'error' ? 'alert' : 'status',
      text: status.text,
    });
  }

  function goToSettings() {
    const button = h('button', { type: 'button', class: 'link-button', text: 'Open Settings' });
    button.addEventListener('click', () => {
      state.tab = 'settings';
      render();
    });
    return button;
  }

  function cloudNote(what: string) {
    return h(
      'div',
      { class: 'note note-cloud' },
      h('p', {
        text: `${what} is uploaded to converter.studio and converted there with your Converter Studio credits (most conversions cost 1). Files are deleted after 6 hours.`,
      }),
      state.settings.apiKey
        ? null
        : h('p', { class: 'warn' }, 'The cloud needs a Converter Studio API key. ', goToSettings()),
    );
  }

  function stepText(step: Step): string {
    if (step.step === 'uploading')
      return step.total > 0
        ? `Uploading… ${Math.floor((step.sent / step.total) * 100)}%`
        : 'Uploading…';
    if (step.step === 'downloading') return 'Fetching the result…';
    if (step.status === 'quoted') return 'Waiting for your go-ahead…';
    if (step.status === 'queued' || step.status === 'measuring') return 'Waiting in line…';
    return step.progress !== null
      ? `Converting… ${Math.round(step.progress * 100)}%`
      : 'Converting…';
  }

  /** Asks before a conversion that costs more than `AUTO_CONFIRM_CREDITS`. */
  function confirmPrice(credits: number): Promise<boolean> {
    return new Promise((resolve) => {
      const yes = h('button', { type: 'button', class: 'button primary', text: 'Convert' });
      const no = h('button', { type: 'button', class: 'button', text: 'Cancel' });
      const close = (answer: boolean) => {
        dialog.hidden = true;
        dialog.replaceChildren();
        resolve(answer);
      };
      yes.addEventListener('click', () => close(true));
      no.addEventListener('click', () => close(false));
      show(
        dialog,
        h(
          'div',
          { class: 'dialog-box' },
          h('p', {
            text: `This conversion costs ${credits} credits (more than ${AUTO_CONFIRM_CREDITS}). Convert it?`,
          }),
          h('div', { class: 'actions' }, yes, no),
        ),
      );
      dialog.hidden = false;
      yes.focus();
    });
  }

  function message(error: unknown): string {
    if (error instanceof ApiError || error instanceof PluginError || error instanceof LocalError)
      return error.message;
    if (error instanceof DOMException && error.name === 'AbortError') return 'Canceled.';
    if (error instanceof Error && error.message) return error.message;
    return 'Something went wrong. Try again.';
  }

  // ── Export ────────────────────────────────────────────────────────────────────────────

  function renderExport() {
    const { selection, target } = state;
    const route = routeOf(target, state.caps, state.catalog);
    const names = selection.layers.slice(0, 3).map((layer) => `“${layer.name}”`);
    const more = selection.count - names.length;
    const summary =
      selection.count === 0
        ? h('p', { class: 'muted', text: 'Select one or more layers to export.' })
        : h('p', {
            class: 'selection',
            text: `${selection.count} layer${selection.count === 1 ? '' : 's'}: ${names.join(', ')}${more > 0 ? ` and ${more} more` : ''}`,
          });

    const options = h('div', { class: 'options', role: 'radiogroup', 'aria-label': 'Format' });
    for (const candidate of EXPORT_TARGETS) {
      const where = routeOf(candidate, state.caps, state.catalog);
      const input = h('input', {
        type: 'radio',
        name: 'target',
        value: candidate.id,
        id: `target-${candidate.id}`,
        disabled: where === null || Boolean(state.busy),
      });
      input.checked = candidate.id === target.id;
      input.addEventListener('change', () => {
        state.target = candidate;
        state.rows = [];
        state.saveable = null;
        state.exportStatus = null;
        render();
      });
      options.appendChild(
        h(
          'label',
          { class: 'option', for: `target-${candidate.id}` },
          input,
          h(
            'span',
            { class: 'option-text' },
            h(
              'span',
              { class: 'option-title' },
              h('span', { text: candidate.label }),
              where
                ? badge(where)
                : h('span', {
                    class: 'badge badge-off',
                    text: state.catalog.online
                      ? 'Not available'
                      : 'Needs a connection to converter.studio',
                  }),
            ),
            h('span', { class: 'hint', text: candidate.hint }),
          ),
        ),
      );
    }

    const fields = exportFields(target);
    const settings = state.exportSettings;
    const update = (change: Partial<ExportSettings>) => {
      state.exportSettings = { ...state.exportSettings, ...change };
    };
    const settingsBox = h('div', { class: 'fields' });
    if (fields.scale)
      settingsBox.appendChild(
        select(
          'scale',
          'Scale',
          SCALES.map((s) => [String(s), `${s}×`] as const),
          String(settings.scale),
          (value) => update({ scale: Number(value) }),
        ),
      );
    if (fields.quality)
      settingsBox.appendChild(
        select(
          'quality',
          'Quality',
          QUALITIES.map((q) => [q, QUALITY_LABELS[q]] as const),
          settings.quality,
          (value) => update({ quality: value }),
        ),
      );
    if (fields.maxKb) {
      const input = h('input', {
        id: 'max-kb',
        class: 'input',
        type: 'number',
        inputmode: 'numeric',
        min: MIN_KB,
        max: MAX_KB,
        step: 1,
        placeholder: 'No limit',
        value: settings.maxKb ?? '',
      });
      input.addEventListener('change', () => {
        const value = input.value.trim() === '' ? null : Number(input.value);
        update({ maxKb: value !== null && Number.isFinite(value) && value > 0 ? value : null });
      });
      settingsBox.appendChild(
        h(
          'div',
          { class: 'field' },
          h('label', { for: 'max-kb', class: 'label', text: 'At most (KB)' }),
          input,
        ),
      );
    }
    if (fields.iconSize)
      settingsBox.appendChild(
        select(
          'icon-size',
          'Sizes',
          ICON_SIZES.map((s) => [s, ICON_LABELS[s]] as const),
          settings.iconSize,
          (value) => update({ iconSize: value }),
        ),
      );
    if (fields.compression)
      settingsBox.appendChild(
        select(
          'compression',
          'Compression',
          COMPRESSIONS.map((c) => [c, COMPRESSION_LABELS[c]] as const),
          settings.compression,
          (value) => update({ compression: value }),
        ),
      );

    const where =
      route === 'local'
        ? h('p', { class: 'note note-local', text: 'Made on this computer: nothing is uploaded.' })
        : route === 'cloud'
          ? cloudNote(
              target.cloud.figma === 'PDF'
                ? "Figma's PDF of each layer"
                : "Figma's PNG of each layer",
            )
          : null;

    const actions = h('div', { class: 'actions' });
    if (state.busy) {
      const cancel = h('button', { type: 'button', class: 'button', text: 'Cancel' });
      cancel.addEventListener('click', () => state.busy?.abort());
      actions.appendChild(cancel);
    } else {
      const count = Math.min(selection.count, MAX_LAYERS);
      const layers = count === 1 ? '1 layer' : `${count} layers`;
      const go = h('button', {
        type: 'button',
        id: 'export',
        class: 'button primary',
        disabled: count === 0 || route === null || (route === 'cloud' && !state.settings.apiKey),
        text: route === 'cloud' ? `Convert ${layers} in the cloud` : `Export ${layers}`,
      });
      go.addEventListener('click', () => {
        if (route) void runExport(selection.layers.slice(0, MAX_LAYERS), route);
      });
      actions.appendChild(go);
    }

    const rows = state.rows.length
      ? h(
          'ul',
          { class: 'rows' },
          ...state.rows.map((row) =>
            h(
              'li',
              { class: `row row-${row.state}` },
              h('span', { class: 'row-name', text: row.layer.name }),
              h('span', { class: 'row-note', text: row.note }),
            ),
          ),
        )
      : null;

    const after = h('div', { class: 'actions' });
    if (!state.busy && state.saveable) {
      const saveable = state.saveable;
      const save = h('button', {
        type: 'button',
        id: 'save',
        class: 'button primary',
        text: `Save ${saveable.name}`,
      });
      save.addEventListener('click', () => deps.save(saveable.blob, saveable.name));
      after.appendChild(save);
    }
    const retry = state.rows.filter((row) => row.state === 'failed' && row.cloudable);
    if (!state.busy && retry.length > 0) {
      const button = h('button', {
        type: 'button',
        id: 'retry-cloud',
        class: 'button',
        disabled: !state.settings.apiKey,
        text: 'Try in the cloud (uses credits)',
      });
      button.addEventListener(
        'click',
        () =>
          void runExport(
            retry.map((row) => row.layer),
            'cloud',
            true,
          ),
      );
      after.appendChild(button);
    }

    show(
      body,
      summary,
      selection.count > MAX_LAYERS
        ? h('p', { class: 'muted', text: `The first ${MAX_LAYERS} are exported.` })
        : null,
      options,
      settingsBox.childElementCount ? settingsBox : null,
      where,
      actions,
      statusLine(state.exportStatus),
      rows,
      after.childElementCount ? after : null,
      retry.length > 0 && !state.settings.apiKey
        ? h(
            'p',
            { class: 'warn' },
            `${NO_KEY_MESSAGE.replace(' in Settings', '')} `,
            goToSettings(),
          )
        : null,
    );
  }

  async function runExport(layers: readonly LayerInfo[], route: Route, retry = false) {
    if (layers.length === 0) return;
    const controller = new AbortController();
    state.busy = controller;
    const target = state.target;
    const settings = state.exportSettings;
    // A cloud retry keeps the layers that already worked and redoes the failed ones.
    const keep = retry
      ? state.rows.filter(
          (row) => row.state === 'done' && !layers.some((layer) => layer.id === row.layer.id),
        )
      : [];
    const rows: Row[] = layers.map((layer) => ({ layer, state: 'waiting', note: 'Waiting' }));
    state.rows = [...keep, ...rows];
    state.saveable = null;
    state.exportStatus = null;
    render();
    const api = route === 'cloud' ? cloudApi() : null;
    for (const row of rows) {
      if (controller.signal.aborted) {
        row.state = 'failed';
        row.note = 'Canceled.';
        continue;
      }
      row.state = 'working';
      row.note = route === 'local' ? 'Exporting…' : 'Starting…';
      render();
      try {
        const output = await exportLayer(row.layer, target, settings, route, {
          bridge,
          raster,
          deflate: deps.deflate,
          api,
          confirmPrice,
          signal: controller.signal,
          onStep: (step) => {
            row.note = stepText(step);
            render();
          },
        });
        row.state = 'done';
        row.output = output;
        row.note = `${formatBytes(output.blob.size)}${output.route === 'cloud' ? ` · ${output.credits} credit${output.credits === 1 ? '' : 's'}` : ''}`;
      } catch (error) {
        row.state = 'failed';
        row.note = message(error);
        row.cloudable = error instanceof LocalError && canMakeInCloud(target, state.catalog);
      }
      render();
    }
    const outputs = state.rows.flatMap((row) => (row.output ? [row.output] : []));
    try {
      state.saveable = await saveableOf(outputs, target);
    } catch (error) {
      state.exportStatus = { kind: 'error', text: message(error) };
    }
    if (route === 'cloud') void refreshAccount();
    state.busy = null;
    render();
  }

  async function saveableOf(outputs: readonly Output[], target: ExportTarget) {
    if (outputs.length === 0) return null;
    if (outputs.length === 1) return { name: outputs[0]!.name, blob: outputs[0]!.blob };
    const names = uniqueNames(outputs.map((output) => output.name));
    const files = await Promise.all(
      outputs.map(async (output, i) => ({
        name: names[i]!,
        bytes: new Uint8Array(await output.blob.arrayBuffer()),
      })),
    );
    return {
      name: `${outputs.length} ${target.label.replace(/ \(.*\)$/, '')} files.zip`,
      blob: new Blob([zipStore(files) as Uint8Array<ArrayBuffer>], { type: 'application/zip' }),
    };
  }

  // ── Place ─────────────────────────────────────────────────────────────────────────────

  function renderPlace() {
    const destination = state.selection.destination;
    const intro = h('p', {
      class: 'muted',
      text: 'Place files Figma cannot open. AVIF, BMP and ICO pictures are read on this computer; camera RAW (DNG, CR2, NEF, ARW), TIFF, Illustrator (AI) and EPS files are converted in the Converter Studio cloud.',
    });
    const where = h('p', {
      class: 'selection',
      text:
        destination.kind === 'frame'
          ? `It goes into the frame “${destination.name ?? 'Frame'}”.`
          : 'It goes onto the page, in the middle of your view.',
    });
    const input = h('input', {
      type: 'file',
      id: 'file',
      class: 'file-input',
      accept: acceptList(state.catalog),
      disabled: Boolean(state.busy),
    });
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (file) void pick(file);
    });
    const chooser = h(
      'label',
      { class: 'button file-button', for: 'file' },
      state.picked ? 'Choose another file…' : 'Choose a file…',
    );

    const picked = state.picked;
    const content: Array<Node | null> = [];
    if (picked) {
      content.push(
        h(
          'p',
          { class: 'picked' },
          h('strong', { text: picked.file.name }),
          ` · ${formatBytes(picked.file.size)}`,
        ),
      );
      const plan = picked.plan;
      if (plan.kind === 'native')
        content.push(
          h('p', {
            class: 'note',
            text: `Figma places .${plan.extension} files itself: drag the file onto the canvas.`,
          }),
        );
      else if (plan.kind === 'unsupported')
        content.push(
          h('p', {
            class: 'status status-error',
            text: state.catalog.online
              ? 'Converter Studio cannot place this file.'
              : 'This app cannot read this file, and converter.studio could not be reached.',
          }),
        );
      else if (plan.kind === 'local') {
        const place = h('button', {
          type: 'button',
          id: 'place',
          class: 'button primary',
          disabled: Boolean(state.busy),
          text: 'Place',
        });
        place.addEventListener('click', () => void runPlace('local'));
        content.push(
          h('p', { class: 'option-title' }, badge('local')),
          h('p', {
            class: 'note note-local',
            text: `Read on this computer (${plan.picture.width} × ${plan.picture.height} px): nothing is uploaded.`,
          }),
          h('div', { class: 'actions' }, place),
        );
      } else {
        const kind = CLOUD_PLACE[plan.format.id];
        const fields = h('div', { class: 'fields' });
        if (kind === 'drawing' && state.catalog.converts(plan.format.id, 'svg'))
          fields.appendChild(
            select(
              'drawing-as',
              'Place as',
              (['svg', 'png'] as const).map((d) => [d, DRAWING_LABELS[d]] as const),
              state.placeSettings.drawingAs,
              (value) => {
                state.placeSettings = { ...state.placeSettings, drawingAs: value };
              },
            ),
          );
        if (kind === 'photo')
          fields.appendChild(
            select(
              'long-side',
              'Size',
              LONG_SIDES.map((s) => [s, SIZE_LABELS[s]] as const),
              state.placeSettings.longSide,
              (value) => {
                state.placeSettings = { ...state.placeSettings, longSide: value };
              },
            ),
          );
        const go = h('button', {
          type: 'button',
          id: 'place',
          class: 'button primary',
          disabled: Boolean(state.busy) || !state.settings.apiKey,
          text: 'Convert in the cloud and place',
        });
        go.addEventListener('click', () => void runPlace('cloud'));
        content.push(
          h('p', { class: 'option-title' }, badge('cloud')),
          fields.childElementCount ? fields : null,
          cloudNote('The file'),
          h('div', { class: 'actions' }, go),
        );
      }
    }
    if (state.busy) {
      const cancel = h('button', { type: 'button', class: 'button', text: 'Cancel' });
      cancel.addEventListener('click', () => state.busy?.abort());
      content.push(h('div', { class: 'actions' }, cancel));
    }
    show(
      body,
      intro,
      where,
      h('div', { class: 'actions' }, chooser, input),
      ...content,
      statusLine(state.placeStatus),
    );
  }

  async function pick(file: File) {
    if (state.picked?.plan.kind === 'local') state.picked.plan.picture.close();
    state.picked = null;
    state.placeStatus = { kind: 'info', text: 'Reading the file…' };
    render();
    const plan = await planPlace(file, state.catalog, raster);
    state.picked = { file, plan };
    state.placeStatus = null;
    render();
  }

  async function runPlace(route: Route) {
    const picked = state.picked;
    if (!picked || state.busy) return;
    const controller = new AbortController();
    state.busy = controller;
    state.placeStatus = { kind: 'info', text: route === 'local' ? 'Placing…' : 'Starting…' };
    render();
    const context = {
      bridge,
      raster,
      api: cloudApi(),
      confirmPrice,
      signal: controller.signal,
      onStep: (step: Step) => {
        state.placeStatus = { kind: 'info', text: stepText(step) };
        render();
      },
    };
    try {
      const plan = picked.plan;
      const placed =
        plan.kind === 'local'
          ? await placeLocal(picked.file, plan.picture, context)
          : plan.kind === 'cloud'
            ? await placeInCloud(
                picked.file,
                plan.format,
                state.placeSettings,
                state.catalog,
                context,
              )
            : null;
      if (placed) {
        const where =
          placed.destination.kind === 'frame'
            ? `into “${placed.destination.name ?? 'the frame'}”`
            : 'on the page';
        state.placeStatus = {
          kind: 'done',
          text: `Placed “${placed.name}” ${where}.${placed.credits ? ` ${placed.credits} credit${placed.credits === 1 ? '' : 's'} used.` : ''}`,
        };
      }
      if (route === 'cloud') void refreshAccount();
    } catch (error) {
      state.placeStatus = { kind: 'error', text: message(error) };
    }
    state.busy = null;
    render();
  }

  // ── Settings ──────────────────────────────────────────────────────────────────────────

  function renderSettings() {
    const parts: Array<Node | null> = [
      h('h2', { class: 'heading', text: 'Converter Studio cloud' }),
    ];
    parts.push(
      h('p', {
        class: 'muted',
        text: 'WebP, TIFF and ICO exports, and AVIF, BMP and ICO pictures you place, are made on this computer and need no account. AVIF and smaller PDF exports, and camera RAW, TIFF, AI and EPS files you place, are converted in the cloud with a Converter Studio API key.',
      }),
    );
    if (state.settings.apiKey) {
      const disconnect = h('button', {
        type: 'button',
        id: 'disconnect',
        class: 'button',
        text: 'Disconnect',
      });
      disconnect.addEventListener('click', () => void saveKey(null));
      const who = state.account
        ? `Connected: ${state.account.email} · ${state.account.credits} credit${state.account.credits === 1 ? '' : 's'}`
        : 'A key is saved.';
      parts.push(
        h('p', { class: 'selection', text: who }),
        h('div', { class: 'actions' }, disconnect),
      );
    } else {
      const input = h('input', {
        id: 'api-key',
        class: 'input',
        type: 'password',
        autocomplete: 'off',
        spellcheck: 'false',
        placeholder: 'cvs_live_…',
      });
      const connect = h('button', {
        type: 'button',
        id: 'connect',
        class: 'button primary',
        text: 'Connect',
      });
      const submit = () => void saveKey(input.value.trim());
      connect.addEventListener('click', submit);
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') submit();
      });
      parts.push(
        h(
          'div',
          { class: 'field' },
          h('label', { for: 'api-key', class: 'label', text: 'API key' }),
          input,
        ),
        h('div', { class: 'actions' }, connect),
        h(
          'p',
          { class: 'muted' },
          'Make a key on your ',
          externalLink(LINKS.apiKeys, 'Converter Studio account page'),
          '. Free accounts get 13 credits a day; most conversions cost 1.',
        ),
      );
    }
    parts.push(statusLine(state.settingsStatus));
    parts.push(
      h('p', {
        class: 'muted small',
        text: 'Figma keeps the key for this plugin on this computer (its client storage): it is not saved in your files and others in them cannot see it. It is sent only to Converter Studio.',
      }),
    );

    const baseInput = h('input', {
      id: 'api-base',
      class: 'input',
      type: 'url',
      spellcheck: 'false',
      value: base(),
    });
    const saveBase = h('button', {
      type: 'button',
      id: 'save-base',
      class: 'button',
      text: 'Save',
    });
    saveBase.addEventListener(
      'click',
      () => void setBase(baseInput.value.trim().replace(/\/$/, '')),
    );
    const reset = h('button', {
      type: 'button',
      id: 'reset-base',
      class: 'link-button',
      text: 'Use converter.studio',
    });
    reset.addEventListener('click', () => void setBase(null));
    parts.push(
      h(
        'details',
        { class: 'advanced' },
        h('summary', { text: 'Advanced' }),
        h(
          'div',
          { class: 'field' },
          h('label', { for: 'api-base', class: 'label', text: 'API address' }),
          baseInput,
        ),
        h('div', { class: 'actions' }, saveBase, reset),
        h('p', {
          class: 'muted small',
          text: "For testing a development build of the plugin against another Converter Studio server. Figma lets the published plugin reach only converter.studio's API.",
        }),
      ),
    );
    show(body, ...parts);
  }

  async function saveKey(key: string | null) {
    if (key !== null && !isApiKey(key)) {
      state.settingsStatus = {
        kind: 'error',
        text: 'That is not a Converter Studio API key. It starts with cvs_live_ and is shown once when you make it.',
      };
      render();
      return;
    }
    state.settingsStatus = key ? { kind: 'info', text: 'Checking the key…' } : null;
    render();
    try {
      if (key) {
        // Checked with Converter Studio before it is kept.
        const account = await deps.api(base(), key).account();
        await bridge.ask({ kind: 'save-key', apiKey: key });
        state.account = account;
        state.settingsStatus = { kind: 'done', text: 'Connected.' };
      } else {
        await bridge.ask({ kind: 'save-key', apiKey: null });
        state.account = null;
        state.settingsStatus = {
          kind: 'info',
          text: 'Disconnected. The key was removed from this computer.',
        };
      }
      state.settings = { ...state.settings, apiKey: key };
    } catch (error) {
      state.settingsStatus = { kind: 'error', text: message(error) };
    }
    render();
  }

  async function setBase(value: string | null) {
    if (value !== null && !isApiBase(value)) {
      state.settingsStatus = {
        kind: 'error',
        text: 'Enter an address like https://converter.studio/api.',
      };
      render();
      return;
    }
    const apiBase = value === deps.defaultBase ? null : value;
    try {
      await bridge.ask({ kind: 'save-base', apiBase });
      state.settings = { ...state.settings, apiBase };
      state.settingsStatus = { kind: 'done', text: `The API address is ${base()}.` };
      await loadCatalog();
      await refreshAccount();
    } catch (error) {
      state.settingsStatus = { kind: 'error', text: message(error) };
    }
    render();
  }

  // ── Start ─────────────────────────────────────────────────────────────────────────────

  async function loadCatalog() {
    try {
      state.catalog = new Catalog(await deps.api(base(), '').formats());
    } catch {
      // Offline, or the API is not reachable: what is made on this computer still works.
      state.catalog = new Catalog(null);
    }
  }

  async function refreshAccount() {
    const api = cloudApi();
    if (!api) {
      state.account = null;
      return;
    }
    try {
      state.account = await api.account();
    } catch (error) {
      state.account = null;
      if (error instanceof ApiError && error.status === 401)
        state.settingsStatus = { kind: 'error', text: message(error) };
    }
    render();
  }

  render();
  const encodes = new Set<string>();
  const [context] = await Promise.all([
    bridge.ask({ kind: 'hello' }),
    ...['image/webp', 'image/avif'].map(async (mime) => {
      if (await raster.canEncode(mime)) encodes.add(mime);
    }),
  ]);
  state.caps = { encodes };
  if (context.kind === 'context') {
    state.selection = context.selection;
    state.settings = context.settings;
  }
  await loadCatalog();
  // The first format this app or the cloud can make.
  state.target =
    EXPORT_TARGETS.find((target) => routeOf(target, state.caps, state.catalog)) ?? state.target;
  render();
  await refreshAccount();
}
