import { wakeDelivery, stopDelivery } from './delivery';
import { listCaptures } from './queue';
vi.mock('./delivery', () => ({
  wakeDelivery: vi.fn().mockResolvedValue(undefined),
  stopDelivery: vi.fn(),
  deliveryError: vi.fn().mockReturnValue(null),
}));
vi.mock('./queue', async (original) => ({
  ...(await original<typeof import('./queue')>()),
  listCaptures: vi.fn().mockResolvedValue([]),
  retryCapture: vi.fn(),
  cancelQueuedCapture: vi.fn(),
}));
import { discoverActivePage } from './discovery';
import { clearPreview } from './preview';
vi.mock('./discovery', async (original) => ({
  ...(await original<typeof import('./discovery')>()),
  discoverActivePage: vi.fn(),
}));
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { connectServer, getCatalog } from './api';
vi.mock('./api', async (original) => ({
  ...(await original<typeof import('./api')>()),
  connectServer: vi.fn(),
  getCatalog: vi.fn(),
}));
const binding = {
  serverId: 'server-a',
  userId: '11111111-1111-4111-8111-111111111111',
  origin: 'https://photos.example',
  credentialId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
};
const sender = {
  id: 'frameleaf',
  url: 'chrome-extension://frameleaf/options.html',
};
let values: Record<string, unknown>;
let contains: ReturnType<typeof vi.fn>;
beforeEach(() => {
  clearPreview();
  vi.resetModules();
  vi.clearAllMocks();
  values = {};
  contains = vi.fn().mockResolvedValue(true);
  vi.mocked(listCaptures).mockResolvedValue([]);
  const event = () => ({ addListener: vi.fn() });
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'frameleaf',
      getURL: (path: string) => `chrome-extension://frameleaf/${path}`,
      onMessage: event(),
      onInstalled: event(),
      onStartup: event(),
    },
    storage: {
      local: {
        setAccessLevel: vi.fn().mockResolvedValue(undefined),
        get: vi.fn(async (key: string) => ({
          [key]: structuredClone(values[key]),
        })),
        set: vi.fn(async (input: Record<string, unknown>) => {
          Object.assign(values, structuredClone(input));
        }),
        remove: vi.fn(async (key: string) => {
          delete values[key];
        }),
      },
    },
    permissions: { contains, onRemoved: event() },
    tabs: { create: vi.fn().mockResolvedValue({ id: 10 }) },
    alarms: { create: vi.fn().mockResolvedValue(undefined), onAlarm: event() },
  });
  vi.mocked(discoverActivePage).mockResolvedValue({
    tabId: 42,
    documentId: 'doc',
    pageUrl: 'https://example.com/',
    title: 'Inspiration',
    candidates: [],
  });
  vi.mocked(connectServer).mockResolvedValue(binding);
  vi.mocked(getCatalog).mockResolvedValue({ albums: [], tags: [] });
});

describe('trusted extension operations', () => {
  it.each([
    { id: 'frameleaf', url: 'https://page.example/options.html' },
    { id: 'elsewhere', url: sender.url },
    { id: 'frameleaf', url: 'chrome-extension://frameleaf/content.html' },
    { id: 'frameleaf' },
  ])(
    'rejects a forged sender without reading credentials or performing a request',
    async (untrusted) => {
      const { handleMessage } = await import('./background');
      const result = await handleMessage(
        { type: 'connect', address: binding.origin, token: 'private-key' },
        untrusted,
      );
      expect(result.ok).toBe(false);
      expect(chrome.storage.local.get).not.toHaveBeenCalled();
      expect(connectServer).not.toHaveBeenCalled();
    },
  );
  it('accepts discovery only from the popup and keeps preview access separate from settings writes', async () => {
    const { handleMessage } = await import('./background');
    await handleMessage(
      { type: 'connect', address: binding.origin, token: 'private-key' },
      sender,
    );
    expect((await handleMessage({ type: 'discover' }, sender)).ok).toBe(false);
    expect((await handleMessage({ type: 'bookmark' }, sender)).ok).toBe(false);
    expect(discoverActivePage).not.toHaveBeenCalled();
    const captureSender = {
      ...sender,
      url: 'chrome-extension://frameleaf/capture.html',
    };
    expect(
      (await handleMessage({ type: 'disconnect' }, captureSender)).ok,
    ).toBe(false);
    expect(
      (
        await handleMessage(
          { type: 'connect', address: binding.origin, token: 'replacement' },
          captureSender,
        )
      ).ok,
    ).toBe(false);
    await handleMessage(
      { type: 'discover' },
      { ...sender, url: 'chrome-extension://frameleaf/popup.html' },
    );
    expect(discoverActivePage).toHaveBeenCalledOnce();
    const url = vi.mocked(chrome.tabs.create).mock.calls[0][0].url!;
    const id = new URL(url).searchParams.get('id')!;
    const preview = await handleMessage({ type: 'preview', id }, captureSender);
    expect(preview).toMatchObject({
      ok: true,
      preview: { id, discovery: { documentId: 'doc' } },
    });
    expect(JSON.stringify(preview)).not.toContain('private-key');
    expect(
      (
        await handleMessage(
          { type: 'preview', id },
          { ...sender, url: 'https://page.example/capture.html' },
        )
      ).ok,
    ).toBe(false);
    expect((await handleMessage({ type: 'bookmark' }, captureSender)).ok).toBe(
      false,
    );
    await handleMessage(
      { type: 'bookmark' },
      { ...sender, url: 'chrome-extension://frameleaf/popup.html' },
    );
    expect(discoverActivePage).toHaveBeenLastCalledWith('bookmark');
    await handleMessage({ type: 'disconnect' }, sender);
    expect(
      (await handleMessage({ type: 'preview', id }, captureSender)).ok,
    ).toBe(false);
  });
  it('wakes delivery asynchronously after connecting, registers its alarm and projects queue data only to trusted connected pages', async () => {
    const { handleMessage } = await import('./background');
    await handleMessage(
      { type: 'connect', address: binding.origin, token: 'private-key' },
      sender,
    );
    expect(wakeDelivery).toHaveBeenCalled();
    expect(chrome.alarms.onAlarm.addListener).toHaveBeenCalled();
    vi.mocked(listCaptures).mockResolvedValue([
      {
        id: '33333333-3333-4333-8333-333333333333',
        state: 'queued',
        attempts: 0,
        offset: 0,
        file: { filename: 'reference.png', size: 3 },
        source: { title: 'private-source' },
        note: 'private-note',
      },
    ] as import('./queue').CaptureTask[]);
    const captureSender = {
      ...sender,
      url: 'chrome-extension://frameleaf/capture.html',
    };
    const view = await handleMessage({ type: 'queue' }, captureSender);
    expect(view).toMatchObject({
      ok: true,
      queue: {
        unfinished: 1,
        items: [{ label: 'reference.png', state: 'queued', canCancel: true }],
      },
    });
    expect(JSON.stringify(view)).not.toContain('private-note');
    expect(JSON.stringify(view)).not.toContain('private-source');
    expect(JSON.stringify(view)).not.toContain('private-key');
    const calls = vi.mocked(listCaptures).mock.calls.length;
    expect(
      (
        await handleMessage(
          { type: 'wake-queue' },
          { ...sender, url: 'https://page.example/' },
        )
      ).ok,
    ).toBe(false);
    expect(vi.mocked(listCaptures).mock.calls.length).toBe(calls);
    await handleMessage({ type: 'disconnect' }, sender);
    expect(stopDelivery).toHaveBeenCalled();
    expect(await handleMessage({ type: 'queue' }, captureSender)).toMatchObject(
      { ok: true, queue: { unfinished: 0, items: [] } },
    );
  });
  it('a late delivery authorization failure cannot overwrite a newer connection', async () => {
    const { handleMessage } = await import('./background');
    await handleMessage(
      { type: 'connect', address: binding.origin, token: 'old-key' },
      sender,
    );
    const pause = vi.mocked(wakeDelivery).mock.calls.at(-1)![0];
    const replacement = {
      ...binding,
      credentialId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    };
    const gate = Promise.withResolvers<typeof binding>();
    vi.mocked(connectServer).mockReturnValueOnce(gate.promise);
    const reconnect = handleMessage(
      { type: 'connect', address: binding.origin, token: 'new-key' },
      sender,
    );
    const { CaptureFailure } = await import('./api');
    const late = pause(binding, new CaptureFailure('authorization'));
    gate.resolve(replacement);
    await reconnect;
    await late;
    expect(await handleMessage({ type: 'status' }, sender)).toMatchObject({
      ok: true,
      connection: { status: 'connected', binding: replacement },
    });
    expect(JSON.stringify(values)).toContain('new-key');
  });
  it('requires a host grant and never returns a key to the UI', async () => {
    const { handleMessage } = await import('./background');
    const reply = await handleMessage(
      { type: 'connect', address: binding.origin, token: 'private-key' },
      sender,
    );
    expect(reply.ok).toBe(true);
    expect(JSON.stringify(reply)).not.toContain('private-key');
    contains.mockResolvedValue(false);
    const denied = await handleMessage({ type: 'refresh' }, sender);
    expect(denied).toMatchObject({
      ok: false,
      connection: { status: 'needs-attention', catalog: null },
    });
    expect(JSON.stringify(values)).not.toContain('private-key');
  });
  it('serializes writes across extension pages so disconnect cannot be overwritten by a late connect', async () => {
    const gate = Promise.withResolvers<typeof binding>();
    vi.mocked(connectServer).mockReturnValue(gate.promise);
    const { handleMessage } = await import('./background');
    const connecting = handleMessage(
      { type: 'connect', address: binding.origin, token: 'private-key' },
      sender,
    );
    const disconnecting = handleMessage({ type: 'disconnect' }, sender);
    gate.resolve(binding);
    await connecting;
    await disconnecting;
    expect(await handleMessage({ type: 'status' }, sender)).toMatchObject({
      ok: true,
      connection: null,
    });
  });
});
