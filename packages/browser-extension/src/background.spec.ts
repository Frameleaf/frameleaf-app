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
  vi.resetModules();
  vi.clearAllMocks();
  values = {};
  contains = vi.fn().mockResolvedValue(true);
  const event = () => ({ addListener: vi.fn() });
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'frameleaf',
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
