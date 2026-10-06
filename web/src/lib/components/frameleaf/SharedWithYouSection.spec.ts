import { NotificationType } from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { goto } from '$app/navigation';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
import { assetFactory } from '@test-data/factories/asset-factory';
import en from '../../../../../i18n/en.json';
import SharedWithYouSection from './SharedWithYouSection.svelte';

const hiddenHandlers = vi.hoisted(() => new Set<(assetId: string) => void>());
const notificationHandlers = vi.hoisted(() => new Set<(notification: { type: string }) => void>());
vi.mock('$lib/stores/websocket', () => ({
  websocketEvents: {
    on: (event: string, handler: never) => {
      if (event === 'on_asset_hidden') {
        hiddenHandlers.add(handler);
      } else if (event === 'on_notification') {
        notificationHandlers.add(handler);
      }
      return () => {
        hiddenHandlers.delete(handler);
        notificationHandlers.delete(handler);
      };
    },
  },
}));

const app = vi.hoisted(() => ({ page: { url: new URL('http://localhost/sharing'), params: {}, route: { id: null } } }));
vi.mock('$app/state', () => ({ page: app.page }));
vi.mock('$app/navigation', () => ({
  goto: vi.fn(() => Promise.resolve()),
  afterNavigate: vi.fn(),
  invalidate: vi.fn(),
}));

/** FL-83 (AL-30b): Sharing › Shared with you, the recipient's side of "Share with people in this library". */
describe('SharedWithYouSection', () => {
  const taylor = { id: 'taylor', name: 'Taylor', email: 'taylor@example.com' } as never;
  const sam = { id: 'sam', name: 'Sam', email: 'sam@example.com' } as never;
  const beach = assetFactory.build({ id: 'beach', originalFileName: 'beach.jpg' });
  const dinner = assetFactory.build({ id: 'dinner', originalFileName: 'dinner.jpg' });
  const hike = assetFactory.build({ id: 'hike', originalFileName: 'hike.jpg' });

  beforeEach(() => {
    vi.clearAllMocks();
    addMessages('dev', en);
    app.page.url = new URL('http://localhost/sharing');
    sdkMock.getAssetThumbnailPath?.mockImplementation?.((id: string) => `/assets/${id}/thumbnail`);
  });

  it('shows the items shared with you, grouped by who shared them', async () => {
    sdkMock.getReceivedItemShares.mockResolvedValue({
      link: null,
      items: [
        { id: '1', sharedAt: '', owner: taylor, asset: beach },
        { id: '2', sharedAt: '', owner: sam, asset: hike },
        { id: '3', sharedAt: '', owner: taylor, asset: dinner },
      ],
    });
    render(SharedWithYouSection);

    const fromTaylor = await screen.findByRole('group', { name: 'From Taylor' });
    expect(
      within(fromTaylor)
        .getAllByRole('button')
        .map((tile) => tile.getAttribute('aria-label')),
    ).toEqual(['beach.jpg', 'dinner.jpg']);
    expect(within(fromTaylor).getByText('2 items')).toBeInTheDocument();
    const fromSam = screen.getByRole('group', { name: 'From Sam' });
    expect(within(fromSam).getByRole('button', { name: 'hike.jpg' })).toBeInTheDocument();
  });

  it('removes a locked or revoked item and closes its already-open viewer', async () => {
    app.page.url = new URL('http://localhost/sharing?assetId=beach');
    sdkMock.getReceivedItemShares.mockResolvedValue({
      link: null,
      items: [{ id: '1', sharedAt: '', owner: taylor, asset: beach }],
    });
    const close = vi.spyOn(assetViewerManager, 'showAssetViewer');
    render(SharedWithYouSection);
    expect(await screen.findByRole('button', { name: 'beach.jpg' })).toBeInTheDocument();

    for (const handler of hiddenHandlers) {
      handler('beach');
    }

    await waitFor(() => expect(screen.queryByRole('button', { name: 'beach.jpg' })).toBeNull());
    expect(close).toHaveBeenCalledWith(false);
    expect(goto).toHaveBeenCalledWith('/sharing', { noScroll: true, keepFocus: true });
  });

  it('says so when nothing was shared with you', async () => {
    sdkMock.getReceivedItemShares.mockResolvedValue({ link: null, items: [] });
    render(SharedWithYouSection);
    expect(await screen.findByText(en.frameleaf_sharing.shared_with_you_empty)).toBeInTheDocument();
  });

  it('shows a retry instead of an empty list when received shares fail to load', async () => {
    let finishRetry!: (response: Awaited<ReturnType<typeof sdkMock.getReceivedItemShares>>) => void;
    sdkMock.getReceivedItemShares
      .mockRejectedValueOnce(new Error('Unavailable'))
      .mockImplementationOnce(() => new Promise((resolve) => (finishRetry = resolve)));
    render(SharedWithYouSection);

    expect(await screen.findByRole('alert')).toHaveTextContent(en.frameleaf_sharing.shared_with_you_load_failed);
    expect(screen.queryByText(en.frameleaf_sharing.shared_with_you_empty)).toBeNull();
    const retry = screen.getByRole('button', { name: en.frameleaf_error_retry });
    await fireEvent.click(retry);
    expect(retry).toBeDisabled();
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText(en.frameleaf_sharing.shared_with_you_empty)).toBeNull();

    finishRetry({ link: null, items: [{ id: '1', sharedAt: '', owner: taylor, asset: beach }] });

    expect(await screen.findByRole('button', { name: 'beach.jpg' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(sdkMock.getReceivedItemShares).toHaveBeenCalledTimes(2);
  });

  it('loads a new item share while the Sharing page remains open', async () => {
    sdkMock.getReceivedItemShares.mockResolvedValueOnce({ link: null, items: [] }).mockResolvedValue({
      link: null,
      items: [{ id: '1', sharedAt: '', owner: taylor, asset: beach }],
    });
    render(SharedWithYouSection);
    expect(await screen.findByText(en.frameleaf_sharing.shared_with_you_empty)).toBeInTheDocument();

    for (const handler of notificationHandlers) {
      handler({ type: NotificationType.ItemShare });
    }

    expect(await screen.findByRole('button', { name: 'beach.jpg' })).toBeInTheDocument();
    expect(sdkMock.getReceivedItemShares).toHaveBeenCalledTimes(2);
  });

  it('keeps received items visible when a notification refresh fails', async () => {
    sdkMock.getReceivedItemShares
      .mockResolvedValueOnce({ link: null, items: [{ id: '1', sharedAt: '', owner: taylor, asset: beach }] })
      .mockRejectedValueOnce(new Error('Unavailable'));
    render(SharedWithYouSection);
    expect(await screen.findByRole('button', { name: 'beach.jpg' })).toBeInTheDocument();

    for (const handler of notificationHandlers) {
      handler({ type: NotificationType.ItemShare });
    }

    expect(await screen.findByRole('alert')).toHaveTextContent(en.frameleaf_sharing.shared_with_you_load_failed);
    expect(screen.getByRole('button', { name: 'beach.jpg' })).toBeInTheDocument();
    expect(screen.queryByText(en.frameleaf_sharing.shared_with_you_empty)).toBeNull();
  });

  it('does not restore a hidden item from an in-flight notification refresh', async () => {
    app.page.url = new URL('http://localhost/sharing?assetId=beach');
    let finishRefresh!: (response: Awaited<ReturnType<typeof sdkMock.getReceivedItemShares>>) => void;
    sdkMock.getReceivedItemShares
      .mockResolvedValueOnce({ link: null, items: [{ id: '1', sharedAt: '', owner: taylor, asset: beach }] })
      .mockImplementationOnce(() => new Promise((resolve) => (finishRefresh = resolve)));
    const close = vi.spyOn(assetViewerManager, 'showAssetViewer');
    render(SharedWithYouSection);
    expect(await screen.findByRole('button', { name: 'beach.jpg' })).toBeInTheDocument();

    for (const handler of notificationHandlers) {
      handler({ type: NotificationType.ItemShare });
    }
    expect(sdkMock.getReceivedItemShares).toHaveBeenCalledTimes(2);
    for (const handler of hiddenHandlers) {
      handler('beach');
    }
    await waitFor(() => expect(screen.queryByRole('button', { name: 'beach.jpg' })).toBeNull());
    expect(close).toHaveBeenCalledWith(false);
    expect(goto).toHaveBeenCalledWith('/sharing', { noScroll: true, keepFocus: true });

    finishRefresh({
      link: null,
      items: [
        { id: '1', sharedAt: '', owner: taylor, asset: beach },
        { id: '2', sharedAt: '', owner: sam, asset: dinner },
      ],
    });
    expect(await screen.findByRole('button', { name: 'dinner.jpg' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'beach.jpg' })).toBeNull();
  });

  it('opens the item named in the address in the viewer, only when it was shared with you', async () => {
    app.page.url = new URL('http://localhost/sharing?assetId=beach');
    sdkMock.getReceivedItemShares.mockResolvedValue({
      link: null,
      items: [{ id: '1', sharedAt: '', owner: taylor, asset: beach }],
    });
    const setAsset = vi.spyOn(assetViewerManager, 'setAsset');
    render(SharedWithYouSection);

    await waitFor(() => expect(setAsset).toHaveBeenCalledWith(beach));
  });
});
