import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import AdminCastPermission from '$lib/components/frameleaf/AdminCastPermission.svelte';
import { handleError } from '$lib/utils/handle-error';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';
import en from '../../../../../i18n/en.json';

vi.mock('$lib/utils/handle-error', () => ({ handleError: vi.fn() }));

const user = userAdminFactory.build({ name: 'Grace Hopper', deletedAt: null });

const castSwitch = () => screen.getByRole('switch', { name: en.frameleaf_users_cast_allow });

beforeEach(() => {
  vi.clearAllMocks();
  addMessages('dev', en);
});

describe('AdminCastPermission (FL-77)', () => {
  it('shows casting as allowed until an administrator turns it off', () => {
    render(AdminCastPermission, { user, preferences: preferencesFactory.build() });

    expect(castSwitch().getAttribute('aria-checked')).toBe('true');
  });

  it('shows casting as turned off when the administrator flag is set', () => {
    render(AdminCastPermission, {
      user,
      preferences: preferencesFactory.build({ cast: { adminDisabled: true, gCastEnabled: false } }),
    });

    expect(castSwitch().getAttribute('aria-checked')).toBe('false');
  });

  it('turns casting off through the admin preferences endpoint', async () => {
    sdkMock.updateUserPreferencesAdmin.mockResolvedValue(
      preferencesFactory.build({ cast: { adminDisabled: true, gCastEnabled: false } }),
    );
    render(AdminCastPermission, { user, preferences: preferencesFactory.build() });

    await fireEvent.click(castSwitch());

    expect(sdkMock.updateUserPreferencesAdmin).toHaveBeenCalledWith({
      id: user.id,
      userPreferencesUpdateDto: { cast: { adminDisabled: true } },
    });
    await waitFor(() => expect(castSwitch().getAttribute('aria-checked')).toBe('false'));
  });

  it('allows casting again without touching the account choice', async () => {
    sdkMock.updateUserPreferencesAdmin.mockResolvedValue(
      preferencesFactory.build({ cast: { adminDisabled: false, gCastEnabled: true } }),
    );
    render(AdminCastPermission, {
      user,
      preferences: preferencesFactory.build({ cast: { adminDisabled: true, gCastEnabled: false } }),
    });

    await fireEvent.click(castSwitch());

    expect(sdkMock.updateUserPreferencesAdmin).toHaveBeenCalledWith({
      id: user.id,
      userPreferencesUpdateDto: { cast: { adminDisabled: false } },
    });
  });

  it('puts the switch back when the save fails', async () => {
    sdkMock.updateUserPreferencesAdmin.mockRejectedValue(new Error('offline'));
    render(AdminCastPermission, { user, preferences: preferencesFactory.build() });

    await fireEvent.click(castSwitch());

    await waitFor(() => expect(handleError).toHaveBeenCalled());
    expect(castSwitch().getAttribute('aria-checked')).toBe('true');
  });

  it('cannot be changed while the account is deleted', () => {
    render(AdminCastPermission, {
      user: userAdminFactory.build({ deletedAt: new Date().toISOString() }),
      preferences: preferencesFactory.build(),
    });

    expect(castSwitch().hasAttribute('disabled')).toBe(true);
  });
});
