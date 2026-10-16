import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { tick } from 'svelte';
import { addMessages } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { confirmFrameleaf } from '$lib/frameleaf/confirm';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { handleError } from '$lib/utils/handle-error';
import { deferredPromise } from '@test-data/deferred';
import en from '../../../../../i18n/en.json';
import SharingSettings from './SharingSettings.svelte';

vi.mock('$lib/frameleaf/confirm', () => ({ confirmFrameleaf: vi.fn() }));
vi.mock('$lib/utils/handle-error', async (original) => ({ ...(await original<object>()), handleError: vi.fn() }));

const server = vi.hoisted(() => ({ publicUsers: true, isAdmin: false, session: 0, userId: 'me' }));
vi.mock('$lib/managers/auth-manager.svelte', () => ({
  authManager: {
    captureSession: () => {
      const session = server.session;
      return () => session === server.session;
    },
    user: {
      get id() {
        return server.userId;
      },
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

// ACCOUNT-P2: the page's two account switches go through the account's own preferences draft.
const sharingPrefs = vi.hoisted(() => ({
  draft: { 'people.suggestInSpaces': false },
  baseline: { 'people.suggestInSpaces': false },
  dirty: false,
  stale: false,
  loading: false,
  saving: false,
  error: null,
  notice: null,
  set: vi.fn(),
  follow: vi.fn(),
  cancel: vi.fn(),
  save: vi.fn(),
  loadLatest: vi.fn(),
}));
vi.mock('$app/navigation', () => ({ invalidateAll: vi.fn(), beforeNavigate: vi.fn(), goto: vi.fn() }));
vi.mock('$lib/frameleaf/own-preferences-draft', () => ({ createOwnPreferencesDraft: () => sharingPrefs }));

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
    server.session++;
    server.userId = 'me';
    vi.mocked(confirmFrameleaf).mockReset().mockResolvedValue(true);
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
    // The one account switch is the Spaces suggestion; partners have no timeline switch (FL-326).
    expect(screen.queryByRole('button', { name: 'Leave' })).toBeNull();
    expect(screen.getAllByRole('switch').map((item) => item.getAttribute('aria-label'))).toEqual([
      'Suggest matching people in shared Spaces',
    ]);
    expect(screen.queryByText(/arrives in your library as your own copies/)).toBeNull();
  });

  it('ACCOUNT-P2: says where a partner’s photos go once one shares, and saves the Spaces suggestion', async () => {
    sdkMock.getPartners.mockImplementation(({ direction }) =>
      Promise.resolve(direction === 'shared-with' ? [user('sam', 'Sam')] : []),
    );
    render(SharingSettings);

    expect(await screen.findByText(/arrives in your library as your own copies, places included/)).toBeVisible();
    expect(screen.queryByRole('switch', { name: /timeline/ })).toBeNull();

    const suggest = screen.getByRole('switch', { name: 'Suggest matching people in shared Spaces' });
    expect(suggest).not.toBeChecked();
    await fireEvent.click(suggest);
    expect(sharingPrefs.set).toHaveBeenCalledWith('people.suggestInSpaces', true);
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
  it.each(['leave', 'stop'] as const)(
    'does not complete a retired %s confirmation in another session',
    async (kind) => {
      const pending = deferredPromise<boolean>();
      vi.mocked(confirmFrameleaf).mockReturnValue(pending.promise);
      sdkMock.getClusterGroupUsers.mockResolvedValue([user('me', 'Taylor'), user('sam', 'Sam')]);
      sdkMock.getPartners.mockImplementation(({ direction }) =>
        Promise.resolve(direction === 'shared-by' ? [user('sam', 'Sam')] : []),
      );
      render(SharingSettings);
      const button = await screen.findByRole('button', {
        name: kind === 'leave' ? 'Leave' : 'Stop sharing your library with Sam',
      });
      await fireEvent.click(button);
      server.session++;
      server.userId = 'replacement';
      pending.resolve(true);
      await pending.promise;
      await tick();
      expect(sdkMock.leaveClusterGroup).not.toHaveBeenCalled();
      expect(sdkMock.removePartner).not.toHaveBeenCalled();
    },
  );

  it.each(['leave', 'stop'] as const)('does not complete a %s confirmation after the settings close', async (kind) => {
    const pending = deferredPromise<boolean>();
    vi.mocked(confirmFrameleaf).mockReturnValue(pending.promise);
    sdkMock.getClusterGroupUsers.mockResolvedValue([user('me', 'Taylor'), user('sam', 'Sam')]);
    sdkMock.getPartners.mockImplementation(({ direction }) =>
      Promise.resolve(direction === 'shared-by' ? [user('sam', 'Sam')] : []),
    );
    const view = render(SharingSettings);
    await fireEvent.click(
      await screen.findByRole('button', { name: kind === 'leave' ? 'Leave' : 'Stop sharing your library with Sam' }),
    );
    view.unmount();
    pending.resolve(true);
    await pending.promise;
    await tick();
    expect(sdkMock.leaveClusterGroup).not.toHaveBeenCalled();
    expect(sdkMock.removePartner).not.toHaveBeenCalled();
  });

  it('does not read group details after its account read is retired', async () => {
    const pending = deferredPromise<Awaited<ReturnType<typeof sdkMock.getMyUser>>>();
    sdkMock.getMyUser.mockReturnValue(pending.promise);
    render(SharingSettings);
    server.session++;
    pending.resolve({ clusterGroupId: 'obsolete-group' } as Awaited<ReturnType<typeof sdkMock.getMyUser>>);
    await pending.promise;
    await tick();
    expect(sdkMock.getClusterGroupUsers).not.toHaveBeenCalled();
    expect(sdkMock.getClusterGroupRequestsForGroup).not.toHaveBeenCalled();
  });

  it('does not refresh partner data after a save completes in a replacement session', async () => {
    const pending = deferredPromise<Awaited<ReturnType<typeof sdkMock.createPartner>>>();
    sdkMock.createPartner.mockReturnValue(pending.promise);
    render(SharingSettings);
    const add = await screen.findByRole('button', { name: 'Add a partner' });
    await waitFor(() => expect(add).toBeEnabled());
    await fireEvent.click(add);
    sdkMock.getPartners.mockClear();
    await fireEvent.click(screen.getByRole('button', { name: 'Share my library with Sam' }));
    server.session++;
    pending.resolve({} as Awaited<ReturnType<typeof sdkMock.createPartner>>);
    await pending.promise;
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sdkMock.getPartners).not.toHaveBeenCalled();
  });

  it('keeps a replacement dialog open when an earlier save finishes', async () => {
    const pending = deferredPromise<Awaited<ReturnType<typeof sdkMock.createPartner>>>();
    sdkMock.createPartner.mockReturnValue(pending.promise);
    render(SharingSettings);
    const add = await screen.findByRole('button', { name: 'Add a partner' });
    await waitFor(() => expect(add).toBeEnabled());
    await fireEvent.click(add);
    await fireEvent.click(screen.getByRole('button', { name: 'Share my library with Sam' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Invite someone' }));
    const replacement = screen.getByRole('dialog');
    pending.resolve({} as Awaited<ReturnType<typeof sdkMock.createPartner>>);
    await pending.promise;
    await waitFor(() => expect(sdkMock.getPartners).toHaveBeenCalledTimes(4));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(replacement).toBeVisible();
    expect(screen.getByRole('dialog')).toBe(replacement);
  });

  it('announces a committed partner revocation after ordinary navigation using the original account', async () => {
    const pending = deferredPromise<Awaited<ReturnType<typeof sdkMock.removePartner>>>();
    sdkMock.removePartner.mockReturnValue(pending.promise);
    sdkMock.getPartners.mockImplementation(({ direction }) =>
      Promise.resolve(direction === 'shared-by' ? [user('sam', 'Sam')] : []),
    );
    const emit = vi.spyOn(eventManager, 'emit');
    const view = render(SharingSettings);
    await fireEvent.click(await screen.findByRole('button', { name: 'Stop sharing your library with Sam' }));
    await waitFor(() => expect(sdkMock.removePartner).toHaveBeenCalledWith({ id: 'sam' }));
    view.unmount();
    pending.resolve(undefined as Awaited<ReturnType<typeof sdkMock.removePartner>>);
    await pending.promise;
    await tick();
    await waitFor(() => expect(emit).toHaveBeenCalledWith('PartnerRevoke', { sharedById: 'me', sharedWithId: 'sam' }));
    emit.mockRestore();
  });
  it('keeps the newest partner read when an initial read finishes after a save', async () => {
    const old = deferredPromise<Awaited<ReturnType<typeof sdkMock.getPartners>>>();
    sdkMock.getPartners
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(old.promise)
      .mockResolvedValue([user('sam', 'Sam')]);
    render(SharingSettings);
    const add = await screen.findByRole('button', { name: 'Add a partner' });
    await waitFor(() => expect(add).toBeEnabled());
    await fireEvent.click(add);
    await fireEvent.click(screen.getByRole('button', { name: 'Share my library with Sam' }));
    await screen.findByRole('button', { name: 'Stop sharing your library with Sam' });
    old.resolve([]);
    await old.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByRole('button', { name: 'Stop sharing your library with Sam' })).toBeVisible();
  });

  it('does not report a save failure in a replacement session', async () => {
    const pending = deferredPromise<Awaited<ReturnType<typeof sdkMock.createPartner>>>();
    sdkMock.createPartner.mockReturnValue(pending.promise);
    render(SharingSettings);
    const add = await screen.findByRole('button', { name: 'Add a partner' });
    await waitFor(() => expect(add).toBeEnabled());
    await fireEvent.click(add);
    await fireEvent.click(screen.getByRole('button', { name: 'Share my library with Sam' }));
    server.session++;
    pending.reject(new Error('Offline'));
    await pending.promise.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(handleError).not.toHaveBeenCalled();
  });
});
