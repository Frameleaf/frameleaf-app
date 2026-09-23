import { getAdminConfigWithRevision } from '@immich/sdk';
import { load } from './+page';

vi.mock('@immich/sdk', () => ({
  getAdminConfigWithRevision: vi.fn().mockResolvedValue({ config: {}, revision: 1 }),
  getConfigDefaults: vi.fn().mockResolvedValue({}),
}));
vi.mock('$lib/utils/auth', () => ({ authenticate: vi.fn() }));
vi.mock('$lib/utils/i18n', () => ({ getFormatter: vi.fn().mockResolvedValue((key: string) => key) }));

describe('administrator settings utilities address', () => {
  beforeEach(() => vi.clearAllMocks());
  it('sends an old administrator utilities address to the single utilities host', async () => {
    await expect(
      load({
        url: new URL('https://example.test/admin/system-settings?area=utilities&section=missing-media&status=resolved'),
      } as never),
    ).rejects.toMatchObject({
      status: 307,
      location: '/user-settings?area=utilities&section=missing-media&status=resolved',
    });
    expect(getAdminConfigWithRevision).not.toHaveBeenCalled();
  });
  it('drops an unknown utility section instead of carrying it across', async () => {
    await expect(
      load({ url: new URL('https://example.test/admin/system-settings?area=utilities&section=nope') } as never),
    ).rejects.toMatchObject({ location: '/user-settings?area=utilities' });
  });
  it('loads the settings draft for every other area', async () => {
    await load({ url: new URL('https://example.test/admin/system-settings?area=storage') } as never);
    expect(getAdminConfigWithRevision).toHaveBeenCalledTimes(1);
  });
});
