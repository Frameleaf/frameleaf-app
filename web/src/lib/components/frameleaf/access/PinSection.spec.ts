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

  it('says how long an unlock lasts and offers 5 minutes, 15 minutes or an hour', async () => {
    render(PinSection);

    const choice = await screen.findByRole('combobox', { name: /Lock again after/ });
    expect(screen.getByText('After you unlock, Locked photos hide again after an hour.')).toBeInTheDocument();
    expect([...(choice as HTMLSelectElement).options].map((option) => option.text)).toEqual([
      '5 minutes',
      '15 minutes',
      'an hour',
    ]);

    await fireEvent.change(choice, { target: { value: '15' } });
    await waitFor(() =>
      expect(sdkMock.updateMyPreferences).toHaveBeenCalledWith({
        userPreferencesUpdateDto: { lockedPin: { relockMinutes: 15 } },
      }),
    );
    expect(screen.getByText('After you unlock, Locked photos hide again after 15 minutes.')).toBeInTheDocument();
  });

  it('does not offer the choice before a PIN is set', async () => {
    sdkMock.getAuthStatus.mockResolvedValue({ pinCode: false } as never);
    render(PinSection);

    expect(await screen.findByRole('button', { name: 'Create PIN' })).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /Lock again after/ })).toBeNull();
  });
});
