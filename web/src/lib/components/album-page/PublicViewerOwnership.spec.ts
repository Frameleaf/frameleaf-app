import { SharedLinkType } from '@frameleaf/sdk';
import { toastManager } from '@frameleaf/ui';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { librarySession } from '$lib/frameleaf/library-session.svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { openFileUploadDialog } from '$lib/utils/file-uploader';
import { handleError } from '$lib/utils/handle-error';
import { publicViewState } from '@test-data/components/public-view-state';
import { deferredPromise } from '@test-data/deferred';
import { albumFactory } from '@test-data/factories/album-factory';
import { sharedLinkFactory } from '@test-data/factories/shared-link-factory';
import IndividualSharedViewer from '../share-page/IndividualSharedViewer.svelte';
import AlbumViewer from './AlbumViewer.svelte';

vi.mock('$lib/components/frameleaf/PublicViewerShell.svelte', async () => ({
  default: (await import('@test-data/components/PublicViewerFixture.svelte')).default,
}));
vi.mock('$lib/components/frameleaf/LibraryView.svelte', async () => ({
  default: (await import('@test-data/components/PublicViewerFixture.svelte')).default,
}));
vi.mock('$lib/components/frameleaf/ResultsView.svelte', async () => ({
  default: (await import('@test-data/components/MockText.svelte')).default,
}));
vi.mock('$lib/components/frameleaf/ResultsAssetViewer.svelte', async () => ({
  default: (await import('@test-data/components/MockText.svelte')).default,
}));
vi.mock('$lib/utils/file-uploader', async (original) => ({
  ...(await original<typeof import('$lib/utils/file-uploader')>()),
  openFileUploadDialog: vi.fn(),
}));

vi.mock('$lib/utils/handle-error', async (original) => ({
  ...(await original<typeof import('$lib/utils/handle-error')>()),
  handleError: vi.fn(),
}));

const albumLink = () =>
  sharedLinkFactory.build({ type: SharedLinkType.Album, album: albumFactory.build(), allowUpload: true });
const individualLink = () => sharedLinkFactory.build({ type: SharedLinkType.Individual, allowUpload: true });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
beforeEach(() => {
  vi.resetAllMocks();
  authManager.reset();
  librarySession.clearSelection();
  publicViewState.timeline = undefined;
});
afterEach(() => vi.restoreAllMocks());

it('follows replacement album metadata and timeline options', async () => {
  const first = albumLink();
  const second = albumLink();
  const view = render(AlbumViewer, { sharedLink: first });
  expect(screen.getByTestId('album-id')).toHaveTextContent(first.album!.id);
  await view.rerender({ sharedLink: second });
  expect(screen.getByTestId('album-id')).toHaveTextContent(second.album!.id);
  expect(screen.getByTestId('public-title')).toHaveTextContent(second.album!.albumName);
});

it.each(['current', 'replace', 'close', 'session'])(
  'keeps album select-all with its original viewer: %s',
  async (change) => {
    const pending = deferredPromise<void>();
    const load = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(undefined);
    publicViewState.timeline = {
      months: [
        { yearMonth: '2025-01', isLoaded: false, timelineDays: [{ viewerAssets: [{ id: 'original' }] }] },
        { yearMonth: '2025-02', isLoaded: false, timelineDays: [] },
      ],
      loadTimelineMonth: load,
    };
    const select = vi.spyOn(librarySession, 'selectAll');
    const view = render(AlbumViewer, { sharedLink: albumLink() });
    await fireEvent.click(screen.getByRole('button', { name: 'Select all' }));
    await waitFor(() => expect(load).toHaveBeenCalledWith('2025-01'));
    switch (change) {
      case 'replace': {
        await view.rerender({ sharedLink: albumLink() });
        break;
      }
      case 'close': {
        view.unmount();
        break;
      }
      case 'session': {
        authManager.reset();
        break;
      }
      // No default
    }
    pending.resolve();
    await settle();
    expect(select).toHaveBeenCalledTimes(change === 'current' ? 1 : 0);
    expect(load).toHaveBeenCalledTimes(change === 'current' ? 2 : 1);
    if (change === 'current') {
      expect(select).toHaveBeenCalledWith(['original']);
    }
  },
);

it.each(['current', 'replace', 'close', 'session'])(
  'keeps album upload announcements with their viewer: %s',
  async (change) => {
    const pending = deferredPromise<string[]>();
    vi.mocked(openFileUploadDialog).mockReturnValueOnce(pending.promise);
    const toast = vi.spyOn(toastManager, 'success').mockImplementation(() => 'toast');
    const sharedLink = albumLink();
    const view = render(AlbumViewer, { sharedLink });
    await fireEvent.click(screen.getByRole('button', { name: 'Upload' }));
    expect(openFileUploadDialog).toHaveBeenCalledWith({ albumId: sharedLink.album!.id });
    switch (change) {
      case 'replace': {
        await view.rerender({ sharedLink: albumLink() });
        break;
      }
      case 'close': {
        view.unmount();
        break;
      }
      case 'session': {
        authManager.reset();
        break;
      }
      // No default
    }
    pending.resolve(['uploaded']);
    await settle();
    expect(toast).toHaveBeenCalledTimes(change === 'current' ? 1 : 0);
  },
);

it.each(['current', 'replace', 'close', 'session', 'credentials'])(
  'keeps individual upload readback with its original link: %s',
  async (change) => {
    const pending = deferredPromise<string[]>();
    vi.mocked(openFileUploadDialog).mockReturnValueOnce(pending.promise);
    const params = vi.spyOn(authManager, 'params', 'get').mockReturnValue({ key: 'original', slug: undefined });
    sdkMock.getMySharedLink.mockResolvedValue(individualLink());
    const toast = vi.spyOn(toastManager, 'success').mockImplementation(() => 'toast');
    const view = render(IndividualSharedViewer, { sharedLink: individualLink(), isOwned: false });
    await fireEvent.click(screen.getByRole('button', { name: 'Upload' }));
    switch (change) {
      case 'replace': {
        await view.rerender({ sharedLink: individualLink() });
        break;
      }
      case 'close': {
        view.unmount();
        break;
      }
      case 'session': {
        authManager.reset();
        break;
      }
      // No default
    }
    if (change === 'credentials') {
      params.mockReturnValue({ key: 'replacement', slug: undefined });
    }
    pending.resolve(['uploaded']);
    await settle();
    expect(sdkMock.getMySharedLink).toHaveBeenCalledTimes(change === 'current' ? 1 : 0);
    if (change === 'current') {
      expect(sdkMock.getMySharedLink).toHaveBeenCalledWith({ key: 'original', slug: undefined });
    }
    expect(toast).toHaveBeenCalledTimes(change === 'current' ? 1 : 0);
  },
);

it.each(['current', 'replace', 'close', 'session'])(
  'keeps individual readback completion with its original link: %s',
  async (change) => {
    const link = individualLink();
    const pending = deferredPromise<typeof link>();
    vi.mocked(openFileUploadDialog).mockResolvedValueOnce(['uploaded']);
    sdkMock.getMySharedLink.mockReturnValueOnce(pending.promise);
    const toast = vi.spyOn(toastManager, 'success').mockImplementation(() => 'toast');
    const view = render(IndividualSharedViewer, { sharedLink: link, isOwned: false });
    await fireEvent.click(screen.getByRole('button', { name: 'Upload' }));
    await waitFor(() => expect(sdkMock.getMySharedLink).toHaveBeenCalled());
    switch (change) {
      case 'replace': {
        await view.rerender({ sharedLink: individualLink() });
        break;
      }
      case 'close': {
        view.unmount();
        break;
      }
      case 'session': {
        authManager.reset();
        break;
      }
      // No default
    }
    pending.resolve({ ...link, description: 'Updated' });
    await settle();
    expect(toast).toHaveBeenCalledTimes(change === 'current' ? 1 : 0);
    if (change === 'current') {
      expect(screen.getByTestId('public-title')).toHaveTextContent('Updated');
    }
  },
);

it.each(['album', 'individual'])('suppresses %s upload errors after the viewer closes', async (kind) => {
  const pending = deferredPromise<string[]>();
  vi.mocked(openFileUploadDialog).mockReturnValueOnce(pending.promise);
  const view =
    kind === 'album'
      ? render(AlbumViewer, { sharedLink: albumLink() })
      : render(IndividualSharedViewer, { sharedLink: individualLink(), isOwned: false });
  await fireEvent.click(screen.getByRole('button', { name: 'Upload' }));
  view.unmount();
  pending.reject(new Error('Upload failed'));
  await settle();
  expect(handleError).not.toHaveBeenCalled();
});

it('suppresses a month-load failure after the album viewer closes', async () => {
  const pending = deferredPromise<void>();
  const load = vi.fn().mockReturnValueOnce(pending.promise);
  publicViewState.timeline = { months: [{ yearMonth: '2025-01', isLoaded: false }], loadTimelineMonth: load };
  const view = render(AlbumViewer, { sharedLink: albumLink() });
  await fireEvent.click(screen.getByRole('button', { name: 'Select all' }));
  await waitFor(() => expect(load).toHaveBeenCalled());
  view.unmount();
  pending.reject(new Error('Month load failed'));
  await settle();
  expect(handleError).not.toHaveBeenCalled();
});
