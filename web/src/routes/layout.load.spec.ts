import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  goto: vi.fn(),
  init: vi.fn(),
}));

vi.mock('$app/navigation', () => ({ goto: mocks.goto }));
vi.mock('$lib/utils/server', () => ({ init: mocks.init }));
vi.mock('$lib/utils', () => ({ initLanguage: vi.fn() }));
vi.mock('$lib/managers/language-manager.svelte', () => ({ languageManager: { init: vi.fn() } }));
vi.mock('$lib/managers/server-config-manager.svelte', () => ({
  serverConfigManager: { value: { maintenanceMode: false } },
}));
vi.mock('@immich/ui', () => ({ commandPaletteManager: { enable: vi.fn() } }));

const migration = (showInGettingReady: boolean) => Response.json({ stage: 'linking', showInGettingReady });

const runLoad = async (path: string, fetchFn: typeof fetch) => {
  const { load } = await import('./+layout');
  return (load as unknown as (event: { fetch: typeof fetch; url: URL }) => Promise<unknown>)({
    fetch: fetchFn,
    url: new URL(path, 'http://localhost'),
  });
};

describe('app start-up while the storage migration runs (FL-326)', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.goto.mockReset();
    mocks.init.mockReset();
  });

  it('returns to Getting Ready while it waits for the migration', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(migration(true));
    await runLoad('/photos?at=1', fetchFn);
    expect(fetchFn).toHaveBeenCalledWith('/api/server/storage-migration', expect.anything());
    expect(mocks.goto).toHaveBeenCalledWith('/getting-ready?continue=%2Fphotos%3Fat%3D1');
    expect(mocks.init).not.toHaveBeenCalled();
  });

  it('starts normally once it is done or runs in the background', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(migration(false));
    await runLoad('/photos', fetchFn);
    expect(mocks.goto).not.toHaveBeenCalled();
    expect(mocks.init).toHaveBeenCalled();
  });

  it('keeps sign-in reachable, so an administrator can send it to the background', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(migration(true));
    await runLoad('/auth/login', fetchFn);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(mocks.goto).not.toHaveBeenCalled();
  });

  it('asks only once per app load', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(migration(false));
    await runLoad('/photos', fetchFn);
    await runLoad('/albums', fetchFn);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
