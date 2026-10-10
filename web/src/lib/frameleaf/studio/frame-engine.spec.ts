import { afterEach, describe, expect, it, vi } from 'vitest';
import { Blob as NodeBlob } from 'node:buffer';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { websocketEvents, websocketStore } from '$lib/stores/websocket';
import { clearStudioEngine, loadStudioEngine, pinnedFreecutRevision, registerStudioEngine } from './engine-loader';
import { createFrameStudioEngine, resolveStudioFrameManifest, toFrameData } from './frame-engine';
import { STUDIO_FRAME_PROTOCOL_VERSION, type StudioFrameManifest } from './frame-protocol';
import { generatedMediaAlias } from './generated-media';
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
  reportTransport: vi.fn(),
  reportLocalPreviewSupport: vi.fn(),
  requestExport: vi.fn(),
});

/**
 * A frame that announces itself like the built editor and answers from `respond`. The host's end of
 * the channel arrives through `contentWindow.postMessage`, as it does in a browser.
 */
const fakeFrame = (
  options: {
    kind?: 'editor' | 'commands';
    revision?: string;
    respond?: (port: MessagePort, message: { type: string }) => void;
  } = {},
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
            kind: options.kind ?? 'editor',
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
      args: [{ id: 'g', edited: true }, ['editor.save'], 3, 1],
    });
    port.postMessage({ type: 'dirty', dirty: true });
    port.postMessage({ type: 'request-export', kind: 'video' });
    port.postMessage({ type: 'navigate', target: { kind: 'library' } });
    port.postMessage({ type: 'playhead', time: { num: 5, den: 2 } });
    port.postMessage({ type: 'playhead', time: { num: 1.5, den: 2 } });
    port.postMessage({ type: 'transport', playing: true, time: { num: 3, den: 1 }, seek: false });
    port.postMessage({ type: 'transport', playing: 'yes', time: { num: 4, den: 1 }, seek: 1 });
    port.postMessage({ type: 'transport', playing: true, time: { num: -1, den: 1 }, seek: false });
    await tick();

    // The revision and the host graph version the editor's graph came from travel with the draft.
    expect(host.stageDraft).toHaveBeenCalledWith({ id: 'g', edited: true }, ['editor.save'], 3, 1);
    expect(results).toContainEqual({ type: 'service-result', callId: 7, ok: true, value: { status: 'staged' } });

    // Protocol 3 (FL-174): a draft without both as whole counts is refused, never passed on, so the
    // host can never take it for its own graph.
    for (const [callId, base, version] of [
      [8, undefined, undefined],
      [9, 3, undefined],
      [10, -1, 2],
      [11, 'x', 2],
      [12, 3, -1],
      [13, 3, 1.5],
    ] as const) {
      port.postMessage({
        type: 'service',
        callId,
        name: 'stageDraft',
        args: [{ id: 'v' }, ['editor.save'], base, version],
      });
    }
    await tick();
    expect(host.stageDraft).toHaveBeenCalledTimes(1);
    for (const callId of [8, 9, 10, 11, 12, 13]) {
      expect(results).toContainEqual({
        type: 'service-result',
        callId,
        ok: true,
        value: { status: 'rejected', reason: 'invalid' },
      });
    }
    expect(host.setDirty).toHaveBeenCalledWith(true);
    // The editor's Export opens the host's export dialog; nothing renders inside the editor.
    expect(host.requestExport).toHaveBeenCalledWith('video');
    expect(host.navigate).toHaveBeenCalledWith({ kind: 'library' });
    // Only an exact rational crosses into the host.
    expect(host.reportPlayhead).toHaveBeenCalledTimes(1);
    expect(host.reportPlayhead).toHaveBeenCalledWith({ num: 5, den: 2 });
    // FL-96: the editor's transport drives the streamed playback; only booleans and exact times cross.
    expect(host.reportTransport).toHaveBeenCalledTimes(2);
    expect(host.reportTransport).toHaveBeenNthCalledWith(1, { playing: true, time: { num: 3, den: 1 }, seek: false });
    expect(host.reportTransport).toHaveBeenNthCalledWith(2, { playing: false, time: { num: 4, den: 1 }, seek: false });
    // What the editor measured at mount reaches the host, so it can open the server preview itself.
    expect(host.reportLocalPreviewSupport).toHaveBeenCalledWith({ webCodecs: true, webGpu: false });
    await instance.dispose();
  });

  it('passes a well-formed project import to the host and refuses anything else (FL-103 / FL-105)', async () => {
    const frame = fakeFrame();
    const kept = {
      id: '4b0f4b2e-5d3a-4c55-9e0e-6b9f4c7d8e01',
      kind: 'audio',
      name: 'take.webm',
      mimeType: 'audio/webm',
      sizeBytes: 3,
      url: '/api/studio/projects/p/imports/4b0f4b2e-5d3a-4c55-9e0e-6b9f4c7d8e01/file',
    } as const;
    const host = { ...services(), uploadProjectImport: vi.fn().mockResolvedValue(kept) };
    const instance = await createFrameStudioEngine({ manifest, createFrame: frame.createFrame }).mount(
      newStage(),
      context(),
      host,
    );
    const port = frame.port()!;
    const results: Array<{ callId?: number; ok?: boolean; value?: unknown; error?: string }> = [];
    port.addEventListener('message', (event: MessageEvent) => {
      results.push(event.data);
    });
    // Node's own Blob, which its MessagePort can clone; jsdom's cannot cross a port in tests.
    const file = new NodeBlob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' }) as unknown as Blob;
    const good = { id: kept.id, fileName: 'take.webm', file };
    const calls: Array<[number, unknown]> = [
      [21, good],
      [22, { ...good, id: '../../etc' }],
      [23, { ...good, file: 'not bytes' }],
      [24, { ...good, fileName: '' }],
      [25, { ...good, file: new NodeBlob([]) }],
      [26, null],
    ];
    for (const [callId, upload] of calls) {
      port.postMessage({ type: 'service', callId, name: 'uploadProjectImport', args: [upload] });
    }
    await tick();
    await tick();

    expect(host.uploadProjectImport).toHaveBeenCalledTimes(1);
    expect(host.uploadProjectImport.mock.calls[0][0]).toMatchObject({ id: kept.id, fileName: 'take.webm' });
    expect(results).toContainEqual({ type: 'service-result', callId: 21, ok: true, value: kept });
    for (const callId of [22, 23, 24, 25, 26]) {
      expect(results).toContainEqual(
        expect.objectContaining({ type: 'service-result', callId, ok: false, error: 'Invalid project import' }),
      );
    }
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

it.each(['source', 'project'] as const)(
  'preserves the normalized pending draft before %s revocation removes the frame',
  async (kind) => {
    const listen = vi.spyOn(websocketEvents, 'on');
    websocketStore.connected.set(true);
    const operationId = '0195e2a0-0000-7000-8000-000000000012';
    const generatedId = `reverse-${operationId}`;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          operationId,
          projectId: 'p',
          generatedId,
          frames: 300,
          frameRate: { num: 30, den: 1 },
          width: 32,
          height: 32,
          browserPreview: {
            generatedId: `reverse-preview-${operationId}`,
            checksum: 'ab'.repeat(32),
            contentType: 'video/mp4',
            profile: 'h264-main-3.2-aac-lc-v1',
            delivery: 'authenticated',
          },
        }),
      ),
    );
    const host = services();
    const draft = { timeline: { items: [{ id: 'clip', generatedId, from: 42 }] } };
    const frame = fakeFrame({
      respond: (port, message) => {
        switch (message.type) {
          case 'mount': {
            expect(message).toMatchObject({
              context: { generatedMedia: [{ generatedId, id: generatedMediaAlias(generatedId) }] },
            });
            port.postMessage({ type: 'mounted' });

            break;
          }
          case 'revoke-generated': {
            port.postMessage({
              type: 'service',
              callId: 99,
              name: 'stageDraft',
              args: [
                {
                  timeline: {
                    items: [
                      {
                        ...draft.timeline.items[0],
                        mediaId: generatedMediaAlias(generatedId),
                        src: '/private-preview',
                      },
                    ],
                  },
                },
                ['editor.save'],
                2,
                0,
              ],
            });

            break;
          }
          case 'service-result': {
            expect(host.stageDraft).toHaveBeenCalledWith(draft, ['editor.save'], 2, 0);
            port.postMessage({ type: 'disposed' });

            break;
          }
          // No default
        }
      },
    });
    const initial = context();
    initial.project.graph = draft;
    try {
      const instance = await createFrameStudioEngine({ manifest, createFrame: frame.createFrame }).mount(
        newStage(),
        initial,
        host,
      );
      if (kind === 'source') {
        eventManager.emit('AssetsDelete', ['source']);
      } else {
        const invalidate = listen.mock.calls.find(([event]) => event === 'StudioProjectInvalidatedV1')![1] as (data: {
          projectId: string | null;
        }) => void;
        invalidate({ projectId: 'p' });
      }
      await vi.waitFor(() => expect(host.reportFatal).toHaveBeenCalledOnce());
      expect(frame.frames[0].isConnected).toBe(false);
      await instance.dispose();
    } finally {
      listen.mockRestore();
      vi.unstubAllGlobals();
    }
  },
);

it.each(['disconnect', 'project'] as const)('rejects an in-flight command on %s revocation', async (kind) => {
  const listen = vi.spyOn(websocketEvents, 'on');
  websocketStore.connected.set(true);
  const operationId = '0195e2a0-0000-7000-8000-000000000012';
  const generatedId = `reverse-${operationId}`;
  const request = vi.fn(async () =>
    Response.json({
      operationId,
      projectId: 'p',
      generatedId,
      frames: 300,
      frameRate: { num: 30, den: 1 },
      width: 32,
      height: 32,
      browserPreview: {
        generatedId: `reverse-preview-${operationId}`,
        checksum: 'ab'.repeat(32),
        contentType: 'video/mp4',
        profile: 'h264-main-3.2-aac-lc-v1',
        delivery: 'authenticated',
      },
    }),
  );
  vi.stubGlobal('fetch', request);
  const received: unknown[] = [];
  const frame = fakeFrame({
    kind: 'commands',
    respond: (_port, message) => {
      received.push(message);
    },
  });
  try {
    const engine = await createFrameStudioEngine({ manifest, createFrame: frame.createFrame }).createCommandEngine!();
    const graph = { timeline: { items: [{ id: 'clip', generatedId }] } };
    const result = engine.apply(graph, [], [], 'p');
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(request).toHaveBeenCalledOnce();
    expect(received[0]).toMatchObject({
      type: 'apply',
      graph,
      generatedMedia: [{ generatedId, id: generatedMediaAlias(generatedId) }],
    });
    if (kind === 'disconnect') {
      websocketStore.connected.set(false);
    } else {
      const invalidate = listen.mock.calls.find(([event]) => event === 'StudioProjectInvalidatedV1')![1] as (data: {
        projectId: string | null;
      }) => void;
      invalidate({ projectId: null });
    }
    await expect(result).resolves.toMatchObject({ status: 'rejected', detail: 'The command engine was released' });
    expect(frame.frames[0].isConnected).toBe(false);
    engine.dispose();
  } finally {
    listen.mockRestore();
    vi.unstubAllGlobals();
  }
});
