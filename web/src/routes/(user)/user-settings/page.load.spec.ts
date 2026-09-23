import { getApiKeys, getSessions } from '@immich/sdk';
import { load } from './+page';
vi.mock('@immich/sdk', () => ({ getApiKeys: vi.fn().mockResolvedValue([]), getSessions: vi.fn().mockResolvedValue([]) }));
vi.mock('$lib/utils/auth', () => ({ authenticate: vi.fn() }));
vi.mock('$lib/utils/i18n', () => ({ getFormatter: vi.fn().mockResolvedValue((key: string) => key) }));

describe('user settings utilities access', () => {
  beforeEach(() => vi.clearAllMocks());
  it.each(['?area=utilities', '?area=utilities&section=duplicates', '?screen=care'])('opens %s without account credentials or admin configuration reads', async (query) => {
    const result = await load({ url: new URL(`https://example.test/user-settings${query}`) } as never);
    expect(result).toMatchObject({ commandCenter: true });
    expect(getApiKeys).not.toHaveBeenCalled();
    expect(getSessions).not.toHaveBeenCalled();
  });
  it('preserves the existing personal account settings loader', async () => {
    await load({ url: new URL('https://example.test/user-settings?isOpen=preservation') } as never);
    expect(getApiKeys).toHaveBeenCalledTimes(1);
    expect(getSessions).toHaveBeenCalledTimes(1);
  });
});
