import { getAdminConfigWithRevision, getApiKeys, getConfigDefaults, getSessions } from '@immich/sdk';
import { load } from './+page';

const auth = vi.hoisted(() => ({ user: { isAdmin: false } }));
vi.mock('@immich/sdk', () => ({
  getApiKeys: vi.fn().mockResolvedValue([]),
  getSessions: vi.fn().mockResolvedValue([]),
  getAdminConfigWithRevision: vi.fn().mockResolvedValue({ config: {}, revision: 1 }),
  getConfigDefaults: vi.fn().mockResolvedValue({}),
}));
vi.mock('$lib/utils/auth', () => ({ authenticate: vi.fn() }));
vi.mock('$lib/utils/i18n', () => ({ getFormatter: vi.fn().mockResolvedValue((key: string) => key) }));
vi.mock('$lib/managers/auth-manager.svelte', () => ({ authManager: auth }));
vi.mock('$lib/managers/system-config-manager.svelte', () => ({ systemConfigManager: { init: vi.fn() } }));

const open = (query: string) => load({ url: new URL(`https://example.test/user-settings${query}`) } as never);

describe('the Command Center page (FL-71)', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(['', '?area=utilities', '?area=utilities&section=duplicates', '?area=preferences&section=api-keys'])(
    'opens %s for an account without administration and never reads server settings',
    async (query) => {
      auth.user.isAdmin = false;
      await expect(open(query)).resolves.toMatchObject({ screen: 'settings', system: null });
      expect(getAdminConfigWithRevision).not.toHaveBeenCalled();
      expect(getConfigDefaults).not.toHaveBeenCalled();
      // Keys and devices load with their own sections, not with every Command Center page.
      expect(getApiKeys).not.toHaveBeenCalled();
      expect(getSessions).not.toHaveBeenCalled();
    },
  );

  it('loads the server settings with their revision for an administrator', async () => {
    auth.user.isAdmin = true;
    await expect(open('?area=storage')).resolves.toMatchObject({
      screen: 'settings',
      system: { current: { config: {}, revision: 1 }, defaultConfig: {} },
    });
    expect(getAdminConfigWithRevision).toHaveBeenCalledTimes(1);
  });

  it('sends the old Library Care screen to the Library care area', async () => {
    auth.user.isAdmin = true;
    await expect(open('?screen=care')).rejects.toMatchObject({ status: 307, location: '/user-settings?area=care' });
    expect(getAdminConfigWithRevision).not.toHaveBeenCalled();
  });
});
