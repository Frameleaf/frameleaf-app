import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  goto: vi.fn(),
  init: vi.fn(),
}));

vi.mock('$app/navigation', () => ({ goto: mocks.goto }));
vi.mock('$lib/utils/server', () => ({ init: mocks.init }));
vi.mock('$lib/managers/language-manager.svelte', () => ({ languageManager: { init: vi.fn() } }));
vi.mock('$lib/managers/server-config-manager.svelte', () => ({
  serverConfigManager: { value: { maintenanceMode: false } },
}));
vi.mock('@frameleaf/ui', () => ({ commandPaletteManager: { enable: vi.fn() } }));

const runLoad = async (path: string, fetchFn: typeof fetch) => {
  const { load } = await import('./+layout');
  return (load as unknown as (event: { fetch: typeof fetch; url: URL }) => Promise<unknown>)({
    fetch: fetchFn,
    url: new URL(path, 'http://localhost'),
  });
};

describe('canonical app startup', { timeout: 30_000 }, () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.goto.mockReset();
    mocks.init.mockReset();
  });

  it.each(['/photos?at=1', '/albums', '/auth/login'])(
    'loads %s without an automatic storage upgrade or upgrade redirect',
    async (path) => {
      const fetchFn = vi.fn<typeof fetch>();
      await runLoad(path, fetchFn);
      expect(mocks.init).toHaveBeenCalledWith(fetchFn);
      expect(fetchFn).not.toHaveBeenCalled();
      expect(mocks.goto).not.toHaveBeenCalled();
    },
  );

  it('preserves normal startup errors without starting media work', async () => {
    const error = new Error('server unavailable');
    mocks.init.mockRejectedValueOnce(error);
    const fetchFn = vi.fn<typeof fetch>();
    expect(await runLoad('/photos', fetchFn)).toMatchObject({ error });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(mocks.goto).not.toHaveBeenCalled();
  });
});
