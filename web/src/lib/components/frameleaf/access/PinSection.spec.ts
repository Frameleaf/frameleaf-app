import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import PinSection from '$lib/components/frameleaf/access/PinSection.svelte';
import en from '../../../../../../i18n/en.json';

describe('Locked PIN (FL-517)', () => {
  beforeAll(() => addMessages('dev', en));
  beforeEach(() => {
    sdkMock.getAuthStatus.mockResolvedValue({ pinCode: true } as never);
    sdkMock.getMyPreferences.mockResolvedValue({ lockedPin: { relockMinutes: 60 } } as never);
    sdkMock.updateMyPreferences.mockResolvedValue({} as never);
  });

  it('says how long an unlock lasts and offers 5 minutes, 15 minutes or 1 hour', async () => {
    render(PinSection);

    const choice = await screen.findByRole('group', { name: /Lock again after/ });
    expect(
      screen.getByText(
        'After you unlock, Locked photos hide again after an hour. Shorter is safer on a computer you share.',
      ),
    ).toBeInTheDocument();
    const segments = [...choice.querySelectorAll('button')];
    expect(segments.map((segment) => segment.textContent?.trim())).toEqual(['5 minutes', '15 minutes', '1 hour']);

    await fireEvent.click(screen.getByRole('button', { name: '15 minutes' }));
    await waitFor(() =>
      expect(sdkMock.updateMyPreferences).toHaveBeenCalledWith({
        userPreferencesUpdateDto: { lockedPin: { relockMinutes: 15 } },
      }),
    );
    expect(
      screen.getByText(
        'After you unlock, Locked photos hide again after 15 minutes. Shorter is safer on a computer you share.',
      ),
    ).toBeInTheDocument();
  });

  it('with Locked encryption on, offers no Clear PIN and opens the encryption page (FL-721)', async () => {
    sdkMock.getLockedEncryption.mockResolvedValue({ enabled: true, mode: 'pin' } as never);
    render(PinSection);

    expect(
      await screen.findByText(
        'Frameleaf can’t show it to you. Your Locked files are encrypted with it, so if you forget it, only your recovery key can reset it.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear PIN…' })).toBeNull();
    expect(screen.getByText('On. Your Locked files are encrypted with your PIN.')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Open' })).toHaveLength(2);
  });

  it('keeps Clear PIN disabled while it can’t tell whether Locked encryption is on (FL-721)', async () => {
    sdkMock.getLockedEncryption.mockRejectedValue(new Error('offline'));
    render(PinSection);

    expect(await screen.findByRole('button', { name: 'Clear PIN…' })).toBeDisabled();
  });

  it('does not offer the choice before a PIN is set', async () => {
    sdkMock.getAuthStatus.mockResolvedValue({ pinCode: false } as never);
    render(PinSection);

    expect(await screen.findByRole('button', { name: 'Set a PIN' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: /Lock again after/ })).toBeNull();
  });
});
