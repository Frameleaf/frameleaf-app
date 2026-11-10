import { render, screen, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { addMessages } from 'svelte-i18n';
import en from '../../../../../../i18n/en.json';
import PasskeysSection from './PasskeysSection.svelte';

const sdk = vi.hoisted(() => ({ getPasskeys: vi.fn() }));
const here = vi.hoisted(() => ({
  value: { ok: true } as { ok: true } | { ok: false; reason: 'http' | 'unsupported' },
}));
const modal = vi.hoisted(() => ({ show: vi.fn() }));
vi.mock('@frameleaf/sdk', async (original) => ({ ...(await original<typeof import('@frameleaf/sdk')>()), ...sdk }));
vi.mock('@frameleaf/ui', async (original) => ({
  ...(await original<typeof import('@frameleaf/ui')>()),
  modalManager: modal,
}));
vi.mock('$lib/frameleaf/passkeys', async (original) => ({
  ...(await original<typeof import('$lib/frameleaf/passkeys')>()),
  passkeysInThisBrowser: () => here.value,
}));

const passkey = (id: string, name: string, extra = {}) => ({
  id,
  name,
  provider: 'iCloud Keychain',
  backedUp: true,
  rpId: 'photos.example.com',
  createdAt: '2026-11-03T08:00:00.000Z',
  lastUsedAt: '2026-11-09T08:12:00.000Z',
  ...extra,
});

describe('Passkeys page (FL-859)', () => {
  beforeAll(() => addMessages('dev', en));
  beforeEach(() => {
    here.value = { ok: true };
    sdk.getPasskeys.mockResolvedValue([
      passkey('a', 'Taylor’s iPhone'),
      passkey('b', 'Security key', { provider: null, backedUp: false, lastUsedAt: null }),
    ]);
  });

  it('lists the passkeys, where each is saved and whether it was used', async () => {
    render(PasskeysSection);
    expect(await screen.findByRole('heading', { name: 'You can sign in with 2 passkeys' })).toBeInTheDocument();
    expect(screen.getByText('Taylor’s iPhone')).toBeInTheDocument();
    expect(screen.getByText('iCloud Keychain, on all your devices')).toBeInTheDocument();
    expect(screen.getByText('On one device, or a key you plug in or tap')).toBeInTheDocument();
    expect(screen.getByText('Not used yet')).toBeInTheDocument();
    expect(screen.getByText(/These were made at photos\.example\.com/)).toBeInTheDocument();
  });

  it('explains passkeys when there are none yet', async () => {
    sdk.getPasskeys.mockResolvedValue([]);
    render(PasskeysSection);
    expect(await screen.findByRole('heading', { name: 'You don’t have a passkey yet' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'How it works' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Add a passkey/ })).toBeEnabled();
  });

  it('says to open the secure address on plain http, and offers no Add', async () => {
    here.value = { ok: false, reason: 'http' };
    render(PasskeysSection);
    expect(
      await screen.findByRole('heading', { name: 'Open Frameleaf at its secure address to add a passkey' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add a passkey/ })).not.toBeInTheDocument();
    // the passkeys can still be renamed and removed
    expect(screen.getByRole('button', { name: 'Remove Taylor’s iPhone' })).toBeInTheDocument();
  });

  it('says when the list could not be loaded, and tries again', async () => {
    sdk.getPasskeys.mockRejectedValueOnce(new Error('offline'));
    render(PasskeysSection);
    expect(await screen.findByRole('heading', { name: 'Your passkeys couldn’t be loaded' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Taylor’s iPhone')).toBeInTheDocument();
  });

  it('removes a passkey after the confirmation and says so', async () => {
    modal.show.mockResolvedValue(true);
    render(PasskeysSection);
    await userEvent.click(await screen.findByRole('button', { name: 'Remove Security key' }));
    expect(modal.show).toHaveBeenCalledWith(expect.anything(), {
      passkey: expect.objectContaining({ id: 'b' }),
      last: false,
    });
    const status = await screen.findByText('“Security key” is removed. It no longer signs you in.');
    expect(within(status.closest('[role="status"]')!).getByText(/is removed/)).toBeInTheDocument();
    expect(screen.queryByText('Security key')).not.toBeInTheDocument();
  });
});
