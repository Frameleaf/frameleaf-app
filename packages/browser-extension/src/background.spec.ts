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
    await handleMessage({ type: 'disconnect' }, sender);
    expect(
      (await handleMessage({ type: 'preview', id }, captureSender)).ok,
    ).toBe(false);
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
