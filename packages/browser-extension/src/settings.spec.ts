import { beforeEach, describe, expect, it, vi } from 'vitest';

const binding = {
  serverId: 'server-a',
  userId: '11111111-1111-4111-8111-111111111111',
  origin: 'https://photos.example',
  credentialId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
};
let values: Record<string, unknown>;
let local: {
  setAccessLevel: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
};
beforeEach(() => {
  vi.resetModules();
  values = {};
  local = {
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
  };
  vi.stubGlobal('chrome', { storage: { local } });
});

describe('trusted connection storage', () => {
  it('restricts access before writing a key and returns no key to UI callers', async () => {
    const gate = Promise.withResolvers<void>();
    local.setAccessLevel.mockReturnValue(gate.promise);
    const settings = await import('./settings');
    const pending = settings.saveConnection(binding, 'private-key');
    expect(local.setAccessLevel).toHaveBeenCalledWith({
      accessLevel: 'TRUSTED_CONTEXTS',
    });
    expect(local.set).not.toHaveBeenCalled();
    gate.resolve();
    await pending;
    expect(JSON.stringify(await settings.connectionStatus())).not.toContain(
      'private-key',
    );
    expect(await settings.credentialFor(binding)).toBe('private-key');
  });
  it('does not hand a credential to a stale or different server/account binding', async () => {
    const settings = await import('./settings');
    await settings.saveConnection(binding, 'private-key');
    for (const change of [
      { serverId: 'other' },
      { userId: 'other' },
      { origin: 'https://other.example' },
      { credentialId: 'other' },
    ]) {
      await expect(
        settings.credentialFor({ ...binding, ...change }),
      ).rejects.toThrow();
    }
  });
  it('clears private cached catalog and the key on revocation, while keeping the destination identity', async () => {
    const settings = await import('./settings');
    await settings.saveConnection(binding, 'private-key');
    await settings.saveCatalog(binding, { albums: [], tags: [] });
    await settings.pauseConnection(binding);
    expect(await settings.connectionStatus()).toEqual({
      binding,
      status: 'needs-attention',
      catalog: null,
    });
    expect(JSON.stringify(values)).not.toContain('private-key');
    await expect(settings.credentialFor(binding)).rejects.toThrow();
  });
  it('does not let a late old read replace or pause a new connection', async () => {
    const settings = await import('./settings');
    await settings.saveConnection(binding, 'old-key');
    const next = {
      ...binding,
      credentialId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    };
    await settings.saveConnection(next, 'new-key');
    await settings.saveCatalog(binding, { albums: [], tags: [] });
    await settings.pauseConnection(binding);
    expect(await settings.connectionStatus()).toEqual({
      binding: next,
      status: 'connected',
      catalog: null,
    });
    expect(await settings.credentialFor(next)).toBe('new-key');
  });
  it('reports malformed stored state without exposing it as a connection', async () => {
    const settings = await import('./settings');
    values.frameleafConnectionV1 = {
      version: 1,
      binding: {},
      status: 'connected',
      token: 'private-key',
      catalog: null,
    };
    await expect(settings.connectionStatus()).rejects.toThrow('Connect again');
    expect(local.set).not.toHaveBeenCalled();
  });
  it('disconnect removes local credentials and catalog together', async () => {
    const settings = await import('./settings');
    await settings.saveConnection(binding, 'private-key');
    await settings.disconnect();
    expect(await settings.connectionStatus()).toBeNull();
    expect(values).toEqual({});
  });
});
