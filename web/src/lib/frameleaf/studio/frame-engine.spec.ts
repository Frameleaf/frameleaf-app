import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearStudioEngine, loadStudioEngine, pinnedFreecutRevision, registerStudioEngine } from './engine-loader';
import { createFrameStudioEngine, resolveStudioFrameManifest, toFrameData } from './frame-engine';
import { STUDIO_FRAME_PROTOCOL_VERSION, type StudioFrameManifest } from './frame-protocol';
import { emptyStudioCapabilities, type StudioHostContext, type StudioHostServices } from './host-contract';
import { idleStudioPreviewView } from './preview';

/**
 * FL-88: the host half of the Freecut editor frame. The editor document itself is built by
 * `studio/adapters/web`; here a stand-in speaks the same protocol from the frame's side.
 */

const manifest: StudioFrameManifest = {
  protocolVersion: STUDIO_FRAME_PROTOCOL_VERSION,
  engineRevision: pinnedFreecutRevision,
  sourceSha256: 'a'.repeat(64),
  features: ['command.addItem'],
  editor: 'editor.html',
  commands: 'commands.html',
};

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'content-type': 'application/json' } });

const context = (): StudioHostContext => ({
  project: { id: 'p', name: 'Surf', revision: 2, graph: { id: 'g' }, hasLease: true },
  assets: [],
  handoffAssetIds: [],
  auth: { userId: 'u', name: 'Ada', avatarUrl: null, locale: 'en' },
  theme: { theme: 'dark', tokens: {} },
  capabilities: emptyStudioCapabilities(),
  preview: idleStudioPreviewView(),
  online: true,
});

const services = (): StudioHostServices => ({
  submitCommands: vi.fn(async () => []),
  stageDraft: vi.fn(async () => ({ status: 'staged' as const })),
  reloadProject: vi.fn(),
  resolveAsset: vi.fn(),
  notify: vi.fn(),
  navigate: vi.fn(),
  setDirty: vi.fn(),
  reportFatal: vi.fn(),
  reportPlayhead: vi.fn(),
  requestExport: vi.fn(),
});

/**
 * A frame that announces itself like the built editor and answers from `respond`. The host's end of
 * the channel arrives through `contentWindow.postMessage`, as it does in a browser.
 */
const fakeFrame = (
  options: { revision?: string; respond?: (port: MessagePort, message: { type: string }) => void } = {},
) => {
  const frames: HTMLIFrameElement[] = [];
  let framePort: MessagePort | null = null;
  const createFrame = (parent: HTMLElement) => {
    const frame = document.createElement('iframe');
    parent.append(frame);
    frames.push(frame);
    const view = frame.contentWindow!;
    vi.spyOn(view, 'postMessage').mockImplementation(((_data: unknown, _origin: string, transfer?: Transferable[]) => {
      framePort = transfer?.[0] as MessagePort;
      framePort.addEventListener('message', (event: MessageEvent) =>
        (options.respond ?? defaultRespond)(framePort!, event.data),
      );
      framePort.start();
    }) as typeof view.postMessage);
    queueMicrotask(() =>
      dispatchEvent(
        new MessageEvent('message', {
          source: view,
          origin: location.origin,
          data: {
            source: 'frameleaf-studio-frame',
            kind: 'editor',
            protocolVersion: STUDIO_FRAME_PROTOCOL_VERSION,
            engineRevision: options.revision ?? pinnedFreecutRevision,
          },
        }),
      ),
    );
    return frame;
  };
  return { createFrame, frames, port: () => framePort };
};

const defaultRespond = (port: MessagePort, message: { type: string }) => {
  if (message.type === 'mount') {
    port.postMessage({ type: 'mounted', support: { webCodecs: true, webGpu: false } });
  } else if (message.type === 'dispose') {
    port.postMessage({ type: 'disposed' });
  }
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

/** The stage element, in the document as the host's is, so the frame has a window. */
const newStage = () => {
  const stage = document.createElement('div');
  document.body.append(stage);
  return stage;
};

afterEach(() => {
  clearStudioEngine();
  document.body.replaceChildren();
});

describe('studio engine manifest', () => {
  it('reports a missing build as not built, so the route shows the unavailable state', async () => {
    registerStudioEngine(async () =>
      createFrameStudioEngine({
        manifest: await resolveStudioFrameManifest(async () => new Response('', { status: 404 })),
      }),
    );
    await expect(loadStudioEngine()).resolves.toMatchObject({ status: 'absent', reason: 'not-built' });
  });

  it('treats the app shell answering for the manifest as not built', async () => {
    await expect(
      resolveStudioFrameManifest(async () => new Response('<!doctype html>', { status: 200 })),
    ).rejects.toMatchObject({ name: 'StudioEngineNotBuiltError' });
  });

  it('refuses another protocol and lets the loader refuse another engine revision', async () => {
    await expect(resolveStudioFrameManifest(async () => json({ ...manifest, protocolVersion: 99 }))).rejects.toThrow(
      /protocol 99/,
    );
    registerStudioEngine(async () =>
      createFrameStudioEngine({
        manifest: await resolveStudioFrameManifest(async () => json({ ...manifest, engineRevision: 'f'.repeat(40) })),
      }),
    );
    await expect(loadStudioEngine()).resolves.toMatchObject({ status: 'absent', reason: 'revision-mismatch' });
  });
});

describe('studio editor frame (FL-88)', () => {
  it('mounts the editor in a frame inside the stage and passes data, never functions', async () => {
    const received: unknown[] = [];
    const frame = fakeFrame({
      respond: (port, message) => {
        received.push(message);
        defaultRespond(port, message);
      },
    });
    const stage = newStage();
    const engine = createFrameStudioEngine({ manifest, createFrame: frame.createFrame });
    const instance = await engine.mount(stage, context(), services());

    expect(stage.querySelector('iframe')).not.toBeNull();
    expect(received[0]).toMatchObject({ type: 'mount', protocolVersion: STUDIO_FRAME_PROTOCOL_VERSION });
    expect(JSON.stringify(received[0])).not.toMatch(/"(accessToken|token|apiBase\w*|baseUrl|sdk)":/i);

    instance.update({ ...context(), online: false });
    await tick();
    expect(received[1]).toMatchObject({ type: 'update', context: { online: false } });

    await instance.dispose();
    await instance.dispose();
    expect(stage.querySelector('iframe')).toBeNull();
    expect(received.filter((message) => (message as { type: string }).type === 'dispose')).toHaveLength(1);
  });

  it('answers the frame’s service calls with the host services', async () => {
    const frame = fakeFrame();
    const host = services();
    const instance = await createFrameStudioEngine({ manifest, createFrame: frame.createFrame }).mount(
      newStage(),
      context(),
      host,
    );
    const port = frame.port()!;
    const results: unknown[] = [];
    port.addEventListener('message', (event: MessageEvent) => {
      results.push(event.data);
    });

    port.postMessage({
      type: 'service',
      callId: 7,
      name: 'stageDraft',
      args: [{ id: 'g', edited: true }, ['editor.save']],
    });
    port.postMessage({ type: 'dirty', dirty: true });
    port.postMessage({ type: 'request-export', kind: 'video' });
    port.postMessage({ type: 'navigate', target: { kind: 'library' } });
    port.postMessage({ type: 'playhead', time: { num: 5, den: 2 } });
    port.postMessage({ type: 'playhead', time: { num: 1.5, den: 2 } });
    await tick();

    expect(host.stageDraft).toHaveBeenCalledWith({ id: 'g', edited: true }, ['editor.save']);

    // The revision the editor's graph came from travels with the draft; anything else is dropped.
    for (const [callId, base] of [
      [8, 3],
      [9, -1],
      [10, 'x'],
    ] as const) {
      port.postMessage({ type: 'service', callId, name: 'stageDraft', args: [{ id: 'g' }, ['editor.save'], base] });
    }
    await tick();
    expect(host.stageDraft).toHaveBeenCalledWith({ id: 'g' }, ['editor.save'], 3);
    expect(host.stageDraft).toHaveBeenLastCalledWith({ id: 'g' }, ['editor.save']);

    // FL-174: the host graph version the editor loaded travels too, in its own position.
    for (const [callId, base, version] of [
      [11, 3, 2],
      [12, 'x', 2],
      [13, 3, -1],
    ] as const) {
      port.postMessage({
        type: 'service',
        callId,
        name: 'stageDraft',
        args: [{ id: 'v' }, ['editor.save'], base, version],
      });
    }
    await tick();
    expect(host.stageDraft).toHaveBeenCalledWith({ id: 'v' }, ['editor.save'], 3, 2);
    expect(host.stageDraft).toHaveBeenCalledWith({ id: 'v' }, ['editor.save'], undefined, 2);
    expect(host.stageDraft).toHaveBeenLastCalledWith({ id: 'v' }, ['editor.save'], 3);
    expect(results).toContainEqual({ type: 'service-result', callId: 7, ok: true, value: { status: 'staged' } });
    expect(host.setDirty).toHaveBeenCalledWith(true);
    // The editor's Export opens the host's export dialog; nothing renders inside the editor.
    expect(host.requestExport).toHaveBeenCalledWith('video');
    expect(host.navigate).toHaveBeenCalledWith({ kind: 'library' });
    // Only an exact rational crosses into the host.
    expect(host.reportPlayhead).toHaveBeenCalledTimes(1);
    expect(host.reportPlayhead).toHaveBeenCalledWith({ num: 5, den: 2 });
    await instance.dispose();
  });

  it('ignores malformed or hostile messages from the frame', async () => {
    const frame = fakeFrame();
    const host = services();
    const instance = await createFrameStudioEngine({ manifest, createFrame: frame.createFrame }).mount(
      newStage(),
      context(),
      host,
    );
    const port = frame.port()!;
    const results: unknown[] = [];
    port.addEventListener('message', (event: MessageEvent) => {
      results.push(event.data);
    });

    port.postMessage({ type: 'service', callId: 1, name: 'constructor', args: [] });
    port.postMessage({ type: 'service', callId: 2, name: '__proto__', args: [] });
    port.postMessage({ type: 'service', callId: 'x', name: 'reloadProject', args: [] });
    port.postMessage({ type: 'navigate', target: { kind: 'asset', assetId: '../admin' } });
    port.postMessage({ type: 'navigate', target: { kind: 'elsewhere' } });
    port.postMessage({ type: 'navigate', target: 'library' });
    port.postMessage({ type: 'notify', message: { html: '<b>x</b>' } });
    port.postMessage({ type: 'fatal', error: { stack: 'x' } });
    port.postMessage({ type: 'navigate', target: { kind: 'asset', assetId: 'asset-1', extra: true } });
    await tick();

    expect(results).toEqual([
      { type: 'service-result', callId: 1, ok: false, error: 'Unknown service constructor' },
      { type: 'service-result', callId: 2, ok: false, error: 'Unknown service __proto__' },
    ]);
    expect(host.reloadProject).not.toHaveBeenCalled();
    expect(host.notify).not.toHaveBeenCalled();
    expect(host.navigate).toHaveBeenCalledTimes(1);
    expect(host.navigate).toHaveBeenCalledWith({ kind: 'asset', assetId: 'asset-1' });
    expect(host.reportFatal).toHaveBeenCalledWith(new Error('Studio failed'));
    await instance.dispose();
  });

  it('refuses a frame built for another engine and leaves nothing behind', async () => {
    const frame = fakeFrame({ revision: 'b'.repeat(40) });
    const stage = newStage();
    await expect(
      createFrameStudioEngine({ manifest, createFrame: frame.createFrame }).mount(stage, context(), services()),
    ).rejects.toThrow(/another engine/);
    expect(stage.querySelector('iframe')).toBeNull();
  });

  it('reports a failed mount and removes the frame', async () => {
    const frame = fakeFrame({
      respond: (port, message) => {
        if (message.type === 'mount') {
          port.postMessage({ type: 'mount-failed', error: 'The stored project could not be read by the editor' });
        }
      },
    });
    const stage = newStage();
    await expect(
      createFrameStudioEngine({ manifest, createFrame: frame.createFrame }).mount(stage, context(), services()),
    ).rejects.toThrow(/could not be read/);
    expect(stage.querySelector('iframe')).toBeNull();
  });

  it('snapshots host state before posting it', () => {
    const live = { nested: { value: 1 }, missing: undefined };
    const copy = toFrameData(live);
    expect(copy).toEqual({ nested: { value: 1 } });
    expect(copy.nested).not.toBe(live.nested);
  });
});
