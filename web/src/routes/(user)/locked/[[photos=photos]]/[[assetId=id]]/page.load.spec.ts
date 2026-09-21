import { getAuthStatus } from '@immich/sdk';
import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import { load } from './+page';

vi.mock('@immich/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@immich/sdk')>()),
  getAuthStatus: vi.fn(),
}));
vi.mock('$lib/utils/auth', () => ({ authenticate: vi.fn() }));
vi.mock('$lib/utils/i18n', () => ({ getFormatter: vi.fn() }));

beforeEach(() => {
  vi.mocked(authenticate).mockResolvedValue(undefined);
  vi.mocked(getAuthStatus).mockResolvedValue({ isElevated: true, pinCode: true, password: false });
  vi.mocked(getFormatter).mockResolvedValue((key) => (typeof key === 'string' ? key : key.id));
});
const loadPage = (query = '') =>
  load({ url: new URL(`https://example.test/locked${query}`) } as Parameters<typeof load>[0]);

it.each(['', '?view=legacy'])('requires the actual elevated PIN session for %s', async (query) => {
  vi.mocked(getAuthStatus).mockResolvedValue({ isElevated: false, pinCode: true, password: false });
  await expect(loadPage(query)).rejects.toMatchObject({
    status: 307,
    location: `/auth/pin-prompt?continue=${encodeURIComponent(`/locked${query}`)}`,
  });
});
it('defaults to sensitive filtering and retains an explicit legacy view', async () => {
  await expect(loadPage()).resolves.toMatchObject({ legacy: false });
  await expect(loadPage('?view=legacy')).resolves.toMatchObject({ legacy: true });
  await expect(loadPage('?view=unknown')).resolves.toMatchObject({ legacy: false });
});
