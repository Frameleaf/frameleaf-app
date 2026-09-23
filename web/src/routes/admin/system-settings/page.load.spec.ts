import { getAdminConfigWithRevision } from '@immich/sdk';
import { load } from './+page';

vi.mock('@immich/sdk', () => ({
  getAdminConfigWithRevision: vi.fn().mockResolvedValue({ config: {}, revision: 1 }),
  getConfigDefaults: vi.fn().mockResolvedValue({}),
}));
vi.mock('$lib/utils/auth', () => ({ authenticate: vi.fn() }));
vi.mock('$lib/utils/i18n', () => ({ getFormatter: vi.fn().mockResolvedValue((key: string) => key) }));

const open = (query: string) => load({ url: new URL(`https://example.test/admin/system-settings${query}`) } as never);

describe('the old administrator settings address (FL-71)', () => {
  beforeEach(() => vi.clearAllMocks());
  it('sends an old administrator utilities address to the single utilities host', async () => {
    await expect(open('?area=utilities&section=missing-media&status=resolved')).rejects.toMatchObject({
      status: 307,
      location: '/user-settings?area=utilities&section=missing-media&status=resolved',
    });
    expect(getAdminConfigWithRevision).not.toHaveBeenCalled();
  });
  it('drops an unknown utility section instead of carrying it across', async () => {
    await expect(open('?area=utilities&section=nope')).rejects.toMatchObject({
      location: '/user-settings?area=utilities',
    });
  });
  it.each([
    ['', '/user-settings'],
    ['?area=storage', '/user-settings?area=storage'],
    ['?area=analytics&scope=user%3A1&range=90days', '/user-settings?area=analytics&scope=user%3A1&range=90days'],
    // A bare key named a server section here; the Command Center needs its area to tell it apart.
    ['?isOpen=notifications', '/user-settings?area=notifications&section=notifications&isOpen=notifications'],
    ['?isOpen=oauth', '/user-settings?area=security&section=authentication&isOpen=oauth'],
    [
      '?isOpen=machine-learning&openSetting=workbench',
      '/user-settings?area=intelligence&section=machine-learning&isOpen=machine-learning&openSetting=workbench',
    ],
    ['?area=libraries&selected=library%3A1&edit=1', '/user-settings?area=libraries&selected=library%3A1&edit=1'],
  ])('redirects %s to the Command Center without reading settings', async (query, location) => {
    await expect(open(query)).rejects.toMatchObject({ status: 307, location });
    expect(getAdminConfigWithRevision).not.toHaveBeenCalled();
  });
});
