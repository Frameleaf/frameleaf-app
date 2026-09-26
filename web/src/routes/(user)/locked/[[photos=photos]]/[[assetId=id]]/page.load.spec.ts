import { getAuthStatus, type AuthStatusResponseDto } from '@immich/sdk';
import { redirect } from '@sveltejs/kit';
import type { MessageFormatter } from 'svelte-i18n';
import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import { load } from './+page';

vi.mock('@immich/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@immich/sdk')>();

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
    load({ url: new URL(`http://localhost/locked${search}`) } as Parameters<typeof load>[0]);

  beforeEach(() => {
    vi.mocked(authenticate).mockResolvedValue(undefined);
    vi.mocked(getAuthStatus).mockResolvedValue(authStatus());
    vi.mocked(getFormatter).mockResolvedValue(formatMessage);
  });

  it('asks for the PIN first and comes back to the same filter', async () => {
    vi.mocked(getAuthStatus).mockResolvedValue(authStatus({ isElevated: false }));

    await expect(loadPage('?reason=detected')).rejects.toMatchObject({
      status: 307,
      location: '/auth/pin-prompt?continue=%2Flocked%3Freason%3Ddetected',
    });
    expect(redirect).toHaveBeenCalledWith(307, '/auth/pin-prompt?continue=%2Flocked%3Freason%3Ddetected');
  });

  it('asks for a PIN to be set up when the account has none', async () => {
    vi.mocked(getAuthStatus).mockResolvedValue(authStatus({ pinCode: false }));

    await expect(loadPage()).rejects.toMatchObject({ status: 307 });
  });

  it('names the view Locked, never the old Locked folder', async () => {
    await expect(loadPage()).resolves.toEqual({ meta: { title: 'frameleaf_locked' } });
  });
});
