import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import en from '../../../../../i18n/en.json';
import SharingSettings from './SharingSettings.svelte';

vi.mock('$lib/managers/auth-manager.svelte', () => ({ authManager: { user: { id: 'me' } } }));

const user = (id: string, name: string) =>
  ({
    id,
    name,
    email: `${id}@example.test`,
    avatarColor: 'primary',
    profileImagePath: '',
    profileChangedAt: '',
  }) as never;

describe('SharingSettings — People & sharing (CC-52/53/54)', () => {
  beforeAll(() => {
    addMessages('dev', en);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    HTMLDialogElement.prototype.showModal ??= vi.fn(function (this: HTMLDialogElement) {
      this.open = true;
    });
    HTMLDialogElement.prototype.close ??= vi.fn(function (this: HTMLDialogElement) {
      this.open = false;
    });
    sdkMock.getMyUser.mockResolvedValue({ clusterGroupId: 'group-1' } as never);
    sdkMock.getClusterGroupUsers.mockResolvedValue([user('me', 'Taylor')]);
    sdkMock.getClusterGroupRequestsForGroup.mockResolvedValue([]);
    sdkMock.getClusterGroupRequests.mockResolvedValue([]);
    sdkMock.searchUsers.mockResolvedValue([user('me', 'Taylor'), user('sam', 'Sam')]);
    sdkMock.getPartners.mockResolvedValue([]);
    sdkMock.createPartner.mockResolvedValue({} as never);
  });

  it('shows the prototype sections, empty states and a disabled Leave for a group of one', async () => {
    render(SharingSettings);

    expect(await screen.findByRole('heading', { name: 'Recognition groups' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Partner libraries' })).toBeInTheDocument();
    expect(await screen.findByText('No partner libraries connected.')).toBeInTheDocument();
    expect(screen.getByText('No pending invitations.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Leave group' })).toBeDisabled();
  });

  it('adds a partner through the titled review dialog', async () => {
    render(SharingSettings);

    const add = await screen.findByRole('button', { name: 'Add partner' });
    await waitFor(() => expect(add).toBeEnabled());
    await fireEvent.click(add);

    expect(screen.getByRole('heading', { name: 'Review partner access' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Account' })).toHaveValue('sam');
    await fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() =>
      expect(sdkMock.createPartner).toHaveBeenCalledWith({ partnerCreateDto: { sharedWithId: 'sam' } }),
    );
  });
});
