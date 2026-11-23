import { describe, expect, it, vi } from 'vitest';
import { PluginError, createBridge, type BridgeWindow } from '../src/ui/bridge';
import { SOURCE } from '../src/shared/messages';

/** The panel's window: what it posts to Figma, and a way to deliver Figma's messages. */
function panelWindow() {
  const posted: Array<{ message: unknown; target: string }> = [];
  let listener: ((event: MessageEvent) => void) | undefined;
  const win: BridgeWindow = {
    parent: { postMessage: (message, target) => posted.push({ message, target }) },
    addEventListener: (_type, handler) => {
      listener = handler;
    },
  };
  const deliver = (data: unknown) => listener?.({ data } as MessageEvent);
  return { win, posted, deliver };
}

const selection = { layers: [], count: 0, destination: { kind: 'page', name: null } };

describe("the panel's line to Figma", () => {
  it("sends { pluginMessage } to '*' and resolves with the matching answer", async () => {
    const { win, posted, deliver } = panelWindow();
    const bridge = createBridge(win);
    const answer = bridge.ask({ kind: 'hello' });
    expect(posted).toEqual([
      { message: { pluginMessage: { kind: 'hello', source: SOURCE, id: 1 } }, target: '*' },
    ]);
    deliver({ pluginMessage: { source: SOURCE, kind: 'done', id: 99 } });
    deliver({ pluginMessage: { source: SOURCE, kind: 'context', id: 1, selection, settings: {} } });
    await expect(answer).resolves.toMatchObject({ kind: 'context', settings: { apiKey: null } });
  });

  it("turns `failed` into Figma's reason", async () => {
    const { win, deliver } = panelWindow();
    const bridge = createBridge(win);
    const answer = bridge.ask({ kind: 'notify', message: 'x' });
    deliver({
      pluginMessage: { source: SOURCE, kind: 'failed', id: 1, message: 'Image is too large' },
    });
    await expect(answer).rejects.toEqual(new PluginError('Image is too large'));
  });

  it("ignores what is not Figma's message for us, and passes selection notices on", () => {
    const { win, deliver } = panelWindow();
    const bridge = createBridge(win);
    const notices = vi.fn();
    bridge.onNotice(notices);
    deliver('hello');
    deliver({ pluginMessage: { source: 'other', kind: 'selection', selection } });
    deliver({ source: SOURCE, kind: 'selection', selection });
    deliver({ pluginMessage: { source: SOURCE, kind: 'selection', selection } });
    expect(notices).toHaveBeenCalledTimes(1);
  });

  it('gives up when Figma does not answer', async () => {
    vi.useFakeTimers();
    const bridge = createBridge(panelWindow().win);
    const answer = bridge.ask({ kind: 'hello' }, 1000);
    vi.advanceTimersByTime(1001);
    await expect(answer).rejects.toThrow('Figma did not answer');
    vi.useRealTimers();
  });
});
