import { getAuthStatus, type AuthStatusResponseDto } from '@frameleaf/sdk';
import { redirect } from '@sveltejs/kit';
import type { MessageFormatter } from 'svelte-i18n';
import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import { load } from './+page';

vi.mock('@frameleaf/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@frameleaf/sdk')>();

  return {
    ...actual,
    getAuthStatus: vi.fn(),
  };
});

vi.mock('@sveltejs/kit', () => ({
  redirect: vi.fn((status: number, location: string) => {
    throw { status, location };
  }),
}));

vi.mock('$lib/utils/auth', () => ({
  authenticate: vi.fn(),
}));

vi.mock('$lib/utils/i18n', () => ({
  getFormatter: vi.fn(),
}));

describe('Locked page load (FL-34)', () => {
  const authStatus = (overrides: Partial<AuthStatusResponseDto> = {}): AuthStatusResponseDto => ({
    isElevated: true,
    password: false,
    pinCode: true,
    ...overrides,
  });

  const formatMessage: MessageFormatter = (key) => (typeof key === 'string' ? key : key.id);

  const loadPage = (search = '') =>
    load({ url: new URL(`http://localhost/locked${search}`), depends: vi.fn() } as unknown as Parameters<
      typeof load
    >[0]);

  beforeEach(() => {
    vi.mocked(redirect).mockClear();
    vi.mocked(authenticate).mockResolvedValue(undefined);
    vi.mocked(getAuthStatus).mockResolvedValue(authStatus());
    vi.mocked(getFormatter).mockResolvedValue(formatMessage);
  });

  it('opens inside the app while locked, and asks for the PIN there (LIB-P2)', async () => {
    vi.mocked(getAuthStatus).mockResolvedValue(authStatus({ isElevated: false }));

    await expect(loadPage('?reason=detected')).resolves.toEqual({
      unlocked: false,
      meta: { title: 'frameleaf_locked' },
    });
    expect(redirect).not.toHaveBeenCalled();
  });

  it('stays locked for an account without a PIN, whose dialog offers PIN settings', async () => {
    vi.mocked(getAuthStatus).mockResolvedValue(authStatus({ pinCode: false }));

    await expect(loadPage()).resolves.toMatchObject({ unlocked: false });
  });

  it('names the view Locked, never the old Locked folder', async () => {
    await expect(loadPage()).resolves.toEqual({ unlocked: true, meta: { title: 'frameleaf_locked' } });
  });
});
