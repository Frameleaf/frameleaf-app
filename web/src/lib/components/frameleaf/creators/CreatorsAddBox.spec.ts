import {
  MediaInspectionKind,
  MediaQuality,
  MediaReachMode,
  type AlbumResponseDto,
  type MediaSubscriptionResponseDto,
} from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import en from '$i18n/en.json';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { creatorsStore } from '$lib/frameleaf/creators-store.svelte';
import CreatorsAddBox from './CreatorsAddBox.svelte';
import { creatorFixture, inspectionFixture } from './creators.fixture';

const channel = 'https://www.youtube.com/@maraellis';
const video = 'https://www.youtube.com/watch?v=loft3';
const subscription = { id: 'subscription-1', creator: 'Mara Ellis', mediaCreatorId: 'creator-1' };

const mount = (address: string) => {
  const onDone = vi.fn();
  render(CreatorsAddBox, { address, delay: 0, onDone });
  return onDone;
};

beforeEach(() => {
  addMessages('dev', en);
  creatorsStore.reset();
  sdkMock.previewMediaSubscription.mockResolvedValue(inspectionFixture());
  sdkMock.inspectMedia.mockResolvedValue(inspectionFixture({ kind: MediaInspectionKind.Item }));
  sdkMock.createMediaSubscription.mockResolvedValue(subscription as MediaSubscriptionResponseDto);
  sdkMock.createMediaImport.mockResolvedValue(inspectionFixture({ id: 'download-1', mediaCreatorId: 'creator-1' }));
});

describe('CreatorsAddBox', () => {
  it('follows a whole channel, and only once how far back is chosen', async () => {
    const onDone = mount(channel);
    expect(screen.getByText('A whole channel: you’ll follow it')).toBeInTheDocument();
    await waitFor(() =>
      expect(sdkMock.previewMediaSubscription).toHaveBeenCalledWith(
        { mediaInspectDto: { urls: [channel], connectionId: undefined } },
        expect.anything(),
      ),
    );
    expect(sdkMock.inspectMedia).not.toHaveBeenCalled();
    await screen.findByText('Mara Ellis');

    // Nothing is chosen for "How far back", so there is nothing to follow with yet.
    const follow = screen.getByRole('button', { name: 'Follow and download' });
    for (const radio of ['Their latest 20, then everything new', 'Everything they’ve posted', 'Since a date']) {
      expect(screen.getByRole('radio', { name: radio })).not.toBeChecked();
    }
    expect(follow).toBeDisabled();
    expect(screen.getByText(/Choose how far back to go before following\./)).toBeInTheDocument();

    await fireEvent.click(screen.getByRole('radio', { name: 'Their latest 20, then everything new' }));
    expect(follow).toBeEnabled();
    await fireEvent.click(follow);

    await waitFor(() =>
      expect(onDone).toHaveBeenCalledWith(expect.stringContaining('Following Mara Ellis.'), 'creator-1'),
    );
    expect(sdkMock.createMediaSubscription).toHaveBeenCalledWith({
      mediaSubscriptionCreateDto: {
        inspectionId: 'inspection-1',
        history: { mode: MediaReachMode.Recent, count: 20 },
        intervalMinutes: 60,
        parentId: undefined,
        quality: MediaQuality.Best,
        saves: { videos: true, shorts: true, live: false },
        idempotencyKey: expect.any(String),
      },
    });
  });

  it('sends the same receipt key when following is tried again', async () => {
    sdkMock.createMediaSubscription.mockRejectedValueOnce(new Error('offline'));
    const onDone = mount(channel);
    await screen.findByText('Mara Ellis');
    await fireEvent.click(screen.getByRole('radio', { name: 'Only new posts from now on' }));
    const follow = screen.getByRole('button', { name: 'Follow and download' });
    await fireEvent.click(follow);
    await screen.findByText('Your Library couldn’t follow this. Try again.');
    await fireEvent.click(follow);
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const keys = sdkMock.createMediaSubscription.mock.calls.map(
      ([{ mediaSubscriptionCreateDto }]) => mediaSubscriptionCreateDto.idempotencyKey,
    );
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  it('downloads one video under its creator, without following them', async () => {
    const onDone = mount(video);
    expect(screen.getByText('One video: just this is saved')).toBeInTheDocument();
    await waitFor(() =>
      expect(sdkMock.inspectMedia).toHaveBeenCalledWith(
        { mediaInspectDto: { urls: [video], connectionId: undefined } },
        expect.anything(),
      ),
    );
    expect(sdkMock.previewMediaSubscription).not.toHaveBeenCalled();
    await screen.findByText('Raising the frame');
    expect(screen.getByRole('switch', { name: /Follow Mara Ellis too/ })).not.toBeChecked();

    await fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('Downloading. Mara Ellis is under Creators.', 'creator-1'));
    const [{ mediaImportCreateDto }] = sdkMock.createMediaImport.mock.calls[0];
    expect(mediaImportCreateDto).toEqual({
      inspectionId: 'inspection-1',
      itemIds: ['item-1'],
      quality: MediaQuality.Best,
      idempotencyKey: expect.any(String),
    });
    // No collection is named: the Library files it under the creator.
    expect(mediaImportCreateDto).not.toHaveProperty('albumId');
    expect(sdkMock.createMediaSubscription).not.toHaveBeenCalled();
  });

  it('asks how far back before a download that also follows', async () => {
    sdkMock.getMediaCreator.mockResolvedValue(creatorFixture({ following: false, subscription: null, url: channel }));
    const onDone = mount(video);
    await screen.findByText('Raising the frame');
    const download = screen.getByRole('button', { name: 'Download' });
    await fireEvent.click(screen.getByRole('switch', { name: /Follow Mara Ellis too/ }));
    expect(download).toBeDisabled();

    await fireEvent.click(screen.getByRole('radio', { name: 'Everything they’ve posted' }));
    expect(download).toBeEnabled();
    await fireEvent.click(download);

    await waitFor(() =>
      expect(onDone).toHaveBeenCalledWith(expect.stringContaining('Following Mara Ellis.'), 'creator-1'),
    );
    expect(sdkMock.createMediaImport).toHaveBeenCalledTimes(1);
    expect(sdkMock.previewMediaSubscription).toHaveBeenCalledWith(
      { mediaInspectDto: { urls: [channel], connectionId: undefined } },
      expect.anything(),
    );
    expect(sdkMock.createMediaSubscription.mock.calls[0][0].mediaSubscriptionCreateDto.history).toEqual({
      mode: MediaReachMode.All,
    });
  });

  it('says so when the text is not an address it can save from', () => {
    mount('not an address');
    expect(screen.getByRole('status')).toHaveTextContent('That doesn’t look like a page your Library can save from.');
    expect(screen.queryByRole('button', { name: 'Download' })).not.toBeInTheDocument();
  });

  it('asks for a collection when the Library found no creator, and sends it', async () => {
    sdkMock.inspectMedia.mockResolvedValue(
      inspectionFixture({ kind: MediaInspectionKind.Item, creator: null, creatorId: null }),
    );
    creatorsStore.albums = [
      { id: 'album-1', albumName: 'Saved', albumUsers: [{ user: { id: '' } }] },
    ] as unknown as AlbumResponseDto[];
    mount(video);
    await screen.findByText('Raising the frame');
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    const download = screen.getByRole('button', { name: 'Download' });
    expect(download).toBeDisabled();

    await fireEvent.change(screen.getByRole('combobox', { name: /Save into/ }), { target: { value: 'album-1' } });
    expect(download).toBeEnabled();
    await fireEvent.click(download);
    await waitFor(() => expect(sdkMock.createMediaImport).toHaveBeenCalled());
    expect(sdkMock.createMediaImport.mock.calls[0][0].mediaImportCreateDto).toMatchObject({ albumId: 'album-1' });
  });
});
