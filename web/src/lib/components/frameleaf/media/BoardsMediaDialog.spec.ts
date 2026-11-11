// @vitest-environment-options {"url":"https://library.example"}
import {
  AlbumUserRole,
  MediaAuthenticationMethod,
  MediaConnectionStatus,
  MediaFeedSupport,
  MediaHistoryMode,
  MediaImportItemState,
  MediaImportState,
  MediaIndividualSupport,
  MediaInspectionKind,
  MediaItemKind,
  MediaProtocolVersion,
  MediaSubscriptionAction,
  MediaSubscriptionState,
  type MediaImportResponseDto,
  type MediaSubscriptionResponseDto,
} from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import en from '$i18n/en.json';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { albumFactory } from '@test-data/factories/album-factory';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';
import BoardsMediaDialog from './BoardsMediaDialog.svelte';

const date = '2026-10-20T10:00:00Z';
const user = userAdminFactory.build();
const album = albumFactory.build({
  albumName: 'Mood board',
  albumUsers: [{ role: AlbumUserRole.Owner, user }],
});
const item: MediaImportResponseDto['items'][number] = {
  id: 'item',
  pageUrl: 'javascript:alert(1)',
  provider: 'fixture',
  creator: 'Creator',
  creatorId: 'creator',
  postId: 'post',
  attachmentId: 'attachment',
  title: '<img onerror="window.evil()">',
  description: '',
  publishedAt: null,
  kind: MediaItemKind.Video,
  state: MediaImportItemState.Discovered,
  assetId: null,
  error: null,
  bytes: 0,
};
const inspection: MediaImportResponseDto = {
  id: 'inspection',
  albumId: null,
  connectionId: null,
  createdAt: date,
  updatedAt: date,
  creator: 'Creator',
  creatorId: 'creator',
  provider: 'fixture',
  kind: MediaInspectionKind.Feed,
  state: MediaImportState.Ready,
  complete: false,
  limitation: 'Limited preview.',
  items: [item],
  discovered: 1,
  saved: 0,
  skipped: 0,
  failed: 0,
  error: null,
  subscriptionId: null,
};
const download = {
  ...inspection,
  id: 'job',
  albumId: album.id,
  state: MediaImportState.Downloading,
};
const subscription: MediaSubscriptionResponseDto = {
  id: 'subscription',
  provider: 'fixture',
  creatorId: 'creator',
  creator: 'Creator',
  url: 'https://fixture.example/creator',
  albumId: album.id,
  connectionId: null,
  history: { mode: MediaHistoryMode.New },
  intervalMinutes: 60,
  status: MediaSubscriptionState.Active,
  lastSuccessAt: null,
  nextCheckAt: date,
  historyComplete: false,
  limitation: null,
  error: null,
  discovered: 1,
  saved: 0,
  skipped: 0,
  failed: 0,
};
const connection = {
  id: 'connection',
  provider: 'bluesky',
  label: 'Blue account',
  domains: ['bsky.app', 'bsky.social'],
  status: MediaConnectionStatus.Connected,
  revision: 1,
  updatedAt: date,
};

beforeEach(() => {
  vi.resetAllMocks();
  addMessages('dev', en);
  authManager.setUser(user);
  authManager.setPreferences(preferencesFactory.build());
  sdkMock.getMediaCapabilities.mockResolvedValue({
    version: MediaProtocolVersion.$1,
    available: true,
    reason: null,
    ytDlpVersion: null,
    galleryDlVersion: null,
    individualMedia: MediaIndividualSupport.InstalledExtractors,
    creatorFeeds: MediaFeedSupport.PerUrl,
    authentication: [
      MediaAuthenticationMethod.Cookies,
      MediaAuthenticationMethod.Credentials,
      MediaAuthenticationMethod.Token,
    ],
    qualifiedProviders: [],
  });
  sdkMock.getCaptureCatalog.mockResolvedValue({ albums: [album], tags: [] });
  sdkMock.getAllAlbums.mockResolvedValue([album]);
  sdkMock.getMediaConnections.mockResolvedValue({ connections: [] });
  sdkMock.getMediaSubscriptions.mockResolvedValue({ subscriptions: [] });
  sdkMock.getAlbumInfo.mockResolvedValue(album);
});

afterEach(() => authManager.reset());

it('inspects several URLs, waits for the feed preview and requires explicit attachments', async () => {
  sdkMock.inspectMedia.mockResolvedValue({ ...inspection, state: MediaImportState.Inspecting, items: [] });
  sdkMock.getMediaImport.mockResolvedValue(inspection);
  sdkMock.createMediaImport.mockResolvedValue(download);
  const { container } = render(BoardsMediaDialog, { sheet: 'download', albumId: album.id, onClosed: vi.fn() });
  const urls = await screen.findByRole('textbox', { name: 'Media URLs' });
  const inspect = screen.getByRole('button', { name: 'Inspect addresses' });
  await fireEvent.input(urls, { target: { value: 'https://fixture.example/a\njavascript:alert(1)' } });
  expect(inspect).toBeDisabled();
  await fireEvent.input(urls, { target: { value: 'https://fixture.example/a\n\nhttps://fixture.example/b' } });
  await fireEvent.click(inspect);
  expect(sdkMock.inspectMedia).toHaveBeenCalledWith(
    { mediaInspectDto: { urls: ['https://fixture.example/a', 'https://fixture.example/b'], connectionId: undefined } },
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(await screen.findByText('Inspecting')).toBeInTheDocument();
  expect(await screen.findByText('Limited preview.')).toBeInTheDocument();
  const start = await screen.findByRole('button', { name: 'Start download' });
  expect(start).toBeDisabled();
  expect(container.querySelector('img')).toBeNull();
  expect(screen.queryByRole('link', { name: 'Open source page' })).not.toBeInTheDocument();
  await fireEvent.click(screen.getByRole('checkbox', { name: /onerror/ }));
  await fireEvent.click(start);
  expect(sdkMock.createMediaImport).toHaveBeenCalledWith({
    mediaImportCreateDto: {
      inspectionId: inspection.id,
      albumId: album.id,
      itemIds: [item.id],
      tagIds: [],
      overrideSuppression: false,
      idempotencyKey: expect.any(String),
    },
  });
  expect(await screen.findByText('Downloading')).toBeInTheDocument();
});

it('reuses the download receipt after a lost response and only overrides removal on request', async () => {
  sdkMock.inspectMedia.mockResolvedValue(inspection);
  sdkMock.createMediaImport.mockRejectedValueOnce(new Error('connection lost')).mockResolvedValueOnce(download);
  render(BoardsMediaDialog, { sheet: 'download', albumId: album.id, onClosed: vi.fn() });
  await fireEvent.input(await screen.findByRole('textbox', { name: 'Media URLs' }), {
    target: { value: 'https://fixture.example/post' },
  });
  await fireEvent.click(screen.getByRole('button', { name: 'Inspect addresses' }));
  await fireEvent.click(await screen.findByRole('checkbox', { name: /onerror/ }));
  await fireEvent.click(screen.getByRole('checkbox', { name: 'Re-import previously removed media' }));
  const start = screen.getByRole('button', { name: 'Start download' });
  await fireEvent.click(start);
  expect(await screen.findByRole('alert')).toHaveTextContent('could not confirm');
  await fireEvent.click(start);
  const [first, second] = sdkMock.createMediaImport.mock.calls;
  expect(first[0].mediaImportCreateDto.overrideSuppression).toBe(true);
  expect(first[0].mediaImportCreateDto.idempotencyKey).toMatch(/^[\da-f-]{36}$/);
  expect(second[0]).toEqual(first[0]);
});

it('reopens durable downloads, cancels unfinished work, retries and links to the saved result', async () => {
  sdkMock.getMediaImports.mockResolvedValue({ imports: [download] });
  sdkMock.cancelMediaImport.mockResolvedValue({ ...download, state: MediaImportState.Cancelled });
  sdkMock.retryMediaImport.mockRejectedValueOnce(new Error('connection lost')).mockResolvedValueOnce({
    ...download,
    state: MediaImportState.Saved,
    items: [{ ...item, state: MediaImportItemState.Saved, assetId: 'saved-asset' }],
    saved: 1,
  });
  render(BoardsMediaDialog, { sheet: 'download', onClosed: vi.fn() });
  await fireEvent.click(await screen.findByRole('button', { name: 'Download history' }));
  await fireEvent.click(await screen.findByRole('button', { name: /View progress for/ }));
  await fireEvent.click(screen.getByRole('button', { name: 'Cancel unfinished work' }));
  expect(sdkMock.cancelMediaImport).toHaveBeenCalledWith({ id: download.id });
  const retry = await screen.findByRole('button', { name: 'Retry unfinished items' });
  await fireEvent.click(retry);
  expect(await screen.findByRole('alert')).toBeInTheDocument();
  await fireEvent.click(retry);
  expect(sdkMock.retryMediaImport.mock.calls[1][0]).toEqual(sdkMock.retryMediaImport.mock.calls[0][0]);
  expect(await screen.findByRole('link', { name: item.title })).toHaveAttribute(
    'href',
    `/albums/${album.id}/photos/saved-asset`,
  );
});

it('requires an explicit subscription history choice and defaults to a top-level hourly collection', async () => {
  sdkMock.previewMediaSubscription.mockResolvedValue(inspection);
  sdkMock.createMediaSubscription.mockResolvedValue(subscription);
  sdkMock.getMediaSubscriptions
    .mockResolvedValueOnce({ subscriptions: [] })
    .mockResolvedValueOnce({ subscriptions: [subscription] });
  render(BoardsMediaDialog, { sheet: 'subscriptions', albumId: album.id, onClosed: vi.fn() });
  await fireEvent.click(await screen.findByRole('button', { name: 'New subscription' }));
  await fireEvent.input(await screen.findByRole('textbox', { name: 'Creator URL' }), {
    target: { value: 'https://fixture.example/creator' },
  });
  await fireEvent.click(screen.getByRole('button', { name: 'Preview creator' }));
  const subscribe = await screen.findByRole('button', { name: 'Subscribe' });
  expect(subscribe).toBeDisabled();
  const historyChoices = within(screen.getByRole('group', { name: 'History to save' })).getAllByRole('radio');
  expect(historyChoices.every((element) => !(element as HTMLInputElement).checked)).toBe(true);
  await fireEvent.click(screen.getByRole('radio', { name: 'Since a date' }));
  expect(subscribe).toBeDisabled();
  await fireEvent.click(screen.getByRole('radio', { name: 'New posts only' }));
  await fireEvent.click(subscribe);
  expect(sdkMock.createMediaSubscription).toHaveBeenCalledWith({
    mediaSubscriptionCreateDto: {
      inspectionId: inspection.id,
      intervalMinutes: 60,
      parentId: undefined,
      history: { mode: MediaHistoryMode.New },
      idempotencyKey: expect.any(String),
    },
  });
});

it('uses the server to check, pause, resume and unsubscribe while retaining the collection link', async () => {
  sdkMock.getMediaSubscriptions.mockResolvedValue({ subscriptions: [subscription] });
  sdkMock.updateMediaSubscription
    .mockResolvedValueOnce(subscription)
    .mockResolvedValueOnce({ ...subscription, status: MediaSubscriptionState.Paused })
    .mockResolvedValueOnce(subscription)
    .mockResolvedValueOnce({ ...subscription, status: MediaSubscriptionState.Unsubscribed });
  render(BoardsMediaDialog, { sheet: 'subscriptions', onClosed: vi.fn() });
  await fireEvent.click(await screen.findByRole('button', { name: 'Manage Creator' }));
  await fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Pause' })).toBeEnabled());
  await fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
  await fireEvent.click(await screen.findByRole('button', { name: 'Resume' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Unsubscribe' })).toBeEnabled());
  await fireEvent.click(screen.getByRole('button', { name: 'Unsubscribe' }));
  expect(screen.getByText(/keeps your collection and saved media/)).toBeInTheDocument();
  await fireEvent.click(screen.getByRole('button', { name: 'Unsubscribe' }));
  expect(await screen.findByText('Unsubscribed')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Open collection' })).toBeInTheDocument();
  expect(sdkMock.updateMediaSubscription.mock.calls.map(([input]) => input.mediaSubscriptionUpdateDto.action)).toEqual([
    MediaSubscriptionAction.Check,
    MediaSubscriptionAction.Pause,
    MediaSubscriptionAction.Resume,
    MediaSubscriptionAction.Unsubscribe,
  ]);
});

it('clears credentials after a failed request and after closing, without browser storage', async () => {
  const local = vi.spyOn(localStorage, 'setItem');
  const session = vi.spyOn(sessionStorage, 'setItem');
  sdkMock.createMediaConnection.mockRejectedValueOnce(new Error('connection failed')).mockResolvedValueOnce(connection);
  const onClosed = vi.fn();
  const { container } = render(BoardsMediaDialog, { sheet: 'connections', onClosed });
  await fireEvent.click(await screen.findByRole('button', { name: 'Connect a site' }));
  const password = screen.getByLabelText('Bluesky app password');
  const form = password.closest('form')!;
  const enter = async (secret: string) => {
    await fireEvent.input(screen.getByLabelText('Connection name'), { target: { value: connection.label } });
    await fireEvent.input(screen.getByLabelText('Bluesky handle or email'), {
      target: { value: 'fixture.bsky.social' },
    });
    await fireEvent.input(password, { target: { value: secret } });
  };
  await enter('fixture-app-password');
  await fireEvent.click(within(form).getByRole('button', { name: 'Connect a site' }));
  expect(sdkMock.createMediaConnection).toHaveBeenCalledWith({
    mediaConnectionCreateDto: {
      provider: 'bluesky',
      label: connection.label,
      session: { domains: connection.domains, username: 'fixture.bsky.social', password: 'fixture-app-password' },
    },
  });
  expect(await screen.findByRole('alert')).toBeInTheDocument();
  expect(password).toHaveValue('');
  await enter('other-fixture-password');
  const buttons = screen.getAllByRole('button', { name: 'Close' });
  await fireEvent.click(buttons.at(-1)!);
  expect(onClosed).toHaveBeenCalledOnce();
  expect(container.querySelector('input[type="password"]')).toBeNull();
  expect(local).not.toHaveBeenCalled();
  expect(session).not.toHaveBeenCalled();
  local.mockRestore();
  session.mockRestore();
});
