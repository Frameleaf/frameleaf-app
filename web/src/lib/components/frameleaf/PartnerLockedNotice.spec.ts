import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { goto } from '$app/navigation';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import PartnerLockedNotice from './PartnerLockedNotice.svelte';

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));

/** FL-326 (prototype PartnerLockedNotice.jsx): Locked partner items without a PIN get a one-time notice. */
describe('PartnerLockedNotice', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('stays hidden when the server says not to show it', async () => {
    sdkMock.getPartnerLockedNotice.mockResolvedValue({ show: false, flaggedAt: null });
    render(PartnerLockedNotice);
    await waitFor(() => expect(sdkMock.getPartnerLockedNotice).toHaveBeenCalled());
    expect(screen.queryByText(/Locked items from a partner/)).toBeNull();
  });

  it('offers to set a PIN, and dismisses for good', async () => {
    sdkMock.getPartnerLockedNotice.mockResolvedValue({ show: true, flaggedAt: '2026-10-03T00:00:00.000Z' });
    sdkMock.dismissPartnerLockedNotice.mockResolvedValue({ show: false, flaggedAt: '2026-10-03T00:00:00.000Z' });
    render(PartnerLockedNotice);

    expect(await screen.findByText('A partner shared Locked items with you.')).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'Set a PIN' }));
    expect(goto).toHaveBeenCalledWith('/user-settings?isOpen=user-pin-code-settings');

    await fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    await waitFor(() => expect(sdkMock.dismissPartnerLockedNotice).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText('A partner shared Locked items with you.')).toBeNull());
  });
});
