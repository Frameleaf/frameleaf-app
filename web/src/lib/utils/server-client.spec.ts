const mocks = vi.hoisted(() => ({
  setFetch: vi.fn(),
  language: vi.fn(),
  config: vi.fn(),
  auth: vi.fn(),
  flags: vi.fn(),
  value: { maintenanceMode: false },
}));

vi.mock('@frameleaf/sdk', () => ({ setFetch: mocks.setFetch }));
vi.mock('$lib/utils', () => ({ initLanguage: mocks.language }));
vi.mock('$lib/managers/auth-manager.svelte', () => ({ authManager: { load: mocks.auth } }));
vi.mock('$lib/managers/server-config-manager.svelte', () => ({
  serverConfigManager: { init: mocks.config, value: mocks.value },
}));
vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({ featureFlagsManager: { init: mocks.flags } }));

describe('server client initialization', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    mocks.value.maintenanceMode = false;
    for (const stage of ['language', 'config', 'auth', 'flags'] as const) {
      mocks[stage].mockResolvedValue(undefined);
    }
  });

  it('shares concurrent initialization and keeps the successful result', async () => {
    let ready!: () => void;
    mocks.language.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        ready = resolve;
      }),
    );
    const { init } = await import('$lib/utils/server-client');
    const fetch = vi.fn<typeof globalThis.fetch>();
    const first = init(fetch);
    expect(init(vi.fn())).toBe(first);
    expect(mocks.setFetch).toHaveBeenCalledExactlyOnceWith(fetch);
    expect(mocks.config).not.toHaveBeenCalled();
    ready();
    await first;
    expect(init(vi.fn())).toBe(first);
    for (const stage of ['language', 'config', 'auth', 'flags'] as const) {
      expect(mocks[stage]).toHaveBeenCalledOnce();
    }
    expect(mocks.language.mock.invocationCallOrder[0]).toBeLessThan(mocks.config.mock.invocationCallOrder[0]);
    expect(mocks.config.mock.invocationCallOrder[0]).toBeLessThan(mocks.auth.mock.invocationCallOrder[0]);
    expect(mocks.auth.mock.invocationCallOrder[0]).toBeLessThan(mocks.flags.mock.invocationCallOrder[0]);
  });

  it.each(['language', 'config', 'auth', 'flags'] as const)('allows a fresh attempt after %s fails', async (stage) => {
    const error = new Error(`${stage} unavailable`);
    mocks[stage].mockRejectedValueOnce(error);
    const { init } = await import('$lib/utils/server-client');
    await expect(init(vi.fn())).rejects.toBe(error);
    const replacementFetch = vi.fn<typeof globalThis.fetch>();
    await expect(init(replacementFetch)).resolves.toBeUndefined();
    expect(mocks.setFetch).toHaveBeenLastCalledWith(replacementFetch);
    expect(mocks[stage]).toHaveBeenCalledTimes(2);
  });

  it('retains maintenance startup without requesting feature flags', async () => {
    mocks.value.maintenanceMode = true;
    const { init } = await import('$lib/utils/server-client');
    await init(vi.fn());
    expect(mocks.auth).toHaveBeenCalledOnce();
    expect(mocks.flags).not.toHaveBeenCalled();
  });
});
