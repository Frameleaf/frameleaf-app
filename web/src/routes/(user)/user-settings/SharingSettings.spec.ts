import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import en from '../../../../../i18n/en.json';
import SharingSettings from './SharingSettings.svelte';

const server = vi.hoisted(() => ({ publicUsers: true, isAdmin: false }));
vi.mock('$lib/managers/auth-manager.svelte', () => ({
  authManager: {
    user: {
      id: 'me',
      get isAdmin() {
        return server.isAdmin;
      },
    },
  },
}));
vi.mock('$lib/managers/server-config-manager.svelte', () => ({
  serverConfigManager: {
    get value() {
      return { publicUsers: server.publicUsers };
    },
  },
}));

const user = (id: string, name: string) =>
  ({
    id,
    name,
    email: `${id}@example.test`,
    avatarColor: 'primary',
    profileImagePath: '',
    profileChangedAt: '',
  }) as never;

describe('SharingSettings: People & sharing in plain words (FL-368)', () => {
  beforeAll(() => {
    addMessages('dev', en);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    server.publicUsers = true;
    server.isAdmin = false;
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
    sdkMock.getRecipientGroups.mockResolvedValue([]);
    sdkMock.createPartner.mockResolvedValue({} as never);
    sdkMock.clusterGroupRegeneratePeople.mockResolvedValue(undefined as never);
  });

  it('opens on who you share with, and says so when it is nobody', async () => {
    render(SharingSettings);

    const status = await screen.findByRole('region', { name: 'Who you share with' });
    expect(within(status).getByRole('heading')).toHaveTextContent('You are not sharing your library with anyone');
    expect(screen.getByRole('heading', { name: 'Partner libraries' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Share face recognition with family' })).toBeInTheDocument();
    expect(await screen.findByText(/^Nobody yet\./)).toBeInTheDocument();
    expect(await screen.findByText(/^No groups yet\./, { selector: '.hint' })).toBeInTheDocument();
    // Alone in the group there is nothing to leave, and only an administrator sees the server block.
    expect(screen.queryByRole('button', { name: 'Leave' })).toBeNull();
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('says each way of a partner library in a sentence, with how far the first copy has come (FL-326)', async () => {
    sdkMock.getPartners.mockImplementation(({ direction }) =>
      Promise.resolve(
        direction === 'shared-by'
          ? [{ ...(user('sam', 'Sam') as object), backfill: { state: 'running', total: 3200, done: 1240 } } as never]
          : [],
      ),
    );
    render(SharingSettings);

    expect(await screen.findByText('You share your library with Sam', { selector: 'h2' })).toBeInTheDocument();
    expect(screen.getByText('Sam does not share theirs with you')).toBeInTheDocument();
    const progress = screen.getByRole('progressbar', { name: 'Copying to their library' });
    expect(progress).toHaveAttribute('aria-valuenow', '38');
    expect(screen.getByText('Copying 1,240 of 3,200 items')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop sharing your library with Sam' })).toBeInTheDocument();
  });

  it('adds a partner after saying what they will get', async () => {
    render(SharingSettings);

    const add = await screen.findByRole('button', { name: 'Add a partner' });
    await waitFor(() => expect(add).toBeEnabled());
    await fireEvent.click(add);

    expect(screen.getByRole('heading', { name: 'Share your library with a partner' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Choose someone on this server' })).toHaveValue('sam');
    expect(screen.getByText(/including Locked items, which stay behind their own PIN/, { selector: 'dialog p' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Share my library with Sam' }));

    await waitFor(() =>
      expect(sdkMock.createPartner).toHaveBeenCalledWith({ partnerCreateDto: { sharedWithId: 'sam' } }),
    );
  });

  it('puts an invitation to share face recognition first, with a way to see who sent it', async () => {
    sdkMock.getClusterGroupRequests.mockResolvedValue([
      { id: 'request-1', clusterGroupId: 'group-2', userId: 'me', createdAt: '' },
    ]);
    render(SharingSettings);

    const status = await screen.findByRole('region', { name: 'Who you share with' });
    await within(status).findByText('You are invited to share face recognition');
    sdkMock.getClusterGroupUsers.mockResolvedValue([user('emma', 'Emma')]);
    await fireEvent.click(within(status).getByRole('button', { name: 'See who invited you' }));

    expect(await screen.findByText(/In this group: Emma\./)).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Accept invitation' }));
    await waitFor(() => expect(sdkMock.acceptClusterGroupRequest).toHaveBeenCalledWith({ id: 'request-1' }));
  });

  it('keeps starting face recognition again behind Advanced, says what it erases and needs a tick', async () => {
    sdkMock.getClusterGroupUsers.mockResolvedValue([user('me', 'Taylor'), user('sam', 'Sam')]);
    render(SharingSettings);

    // The consequence is stated where the action sits, with whose names are erased.
    expect(await screen.findByText('Start face recognition again (erases names)')).toBeInTheDocument();
    expect(await screen.findByText(/^Erases every named person for you and Sam\./)).toBeInTheDocument();
    expect(screen.getByText('Advanced').closest('details')).not.toHaveAttribute('open');

    await fireEvent.click(screen.getByRole('button', { name: 'Erase names and start again…' }));
    const confirm = screen.getByRole('button', { name: 'Erase names and start again' });
    expect(confirm).toBeDisabled();
    expect(sdkMock.clusterGroupRegeneratePeople).not.toHaveBeenCalled();

    await fireEvent.click(screen.getByRole('checkbox', { name: /I understand the names cannot be brought back/ }));
    await fireEvent.click(confirm);
    await waitFor(() => expect(sdkMock.clusterGroupRegeneratePeople).toHaveBeenCalledWith({ id: 'group-1' }));
  });

  it('tells a member why there is nobody to choose when people cannot find each other', async () => {
    server.publicUsers = false;
    render(SharingSettings);

    expect(await screen.findByText('You can’t choose people to share with on this server')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add a partner' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Invite someone' })).toBeDisabled();
  });

  it('still offers Add a partner when the recognition group cannot be loaded', async () => {
    sdkMock.getMyUser.mockRejectedValue(new Error('offline'));
    render(SharingSettings);

    const add = await screen.findByRole('button', { name: 'Add a partner' });
    await waitFor(() => expect(add).toBeEnabled());
  });

  it('says when the accounts cannot be loaded and retries', async () => {
    sdkMock.searchUsers.mockRejectedValueOnce(new Error('offline'));
    render(SharingSettings);

    expect(await screen.findByRole('alert')).toHaveTextContent(en.frameleaf_people_sharing.accounts_error);
    await fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add a partner' })).toBeEnabled());
  });
});
