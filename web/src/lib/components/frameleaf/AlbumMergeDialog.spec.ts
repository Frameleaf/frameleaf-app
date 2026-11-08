import type { AlbumMergePreviewResponseDto, AlbumResponseDto } from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { albumFactory } from '@test-data/factories/album-factory';
import AlbumMergeDialog from './AlbumMergeDialog.svelte';

const album = (id: string, albumName: string, overrides: Partial<AlbumResponseDto> = {}) =>
  albumFactory.build({ id, albumName, assetCount: 3, albumThumbnailAssetId: null, ...overrides });

const trip = album('trip', 'Friends - Patrick');
const others = [album('beach', 'Beach'), album('same', 'friends  - patrick', { assetCount: 9 }), album('zoo', 'Zoo')];

const preview = (overrides: Partial<AlbumMergePreviewResponseDto> = {}): AlbumMergePreviewResponseDto => ({
  winnerId: 'same',
  total: 11,
  inBoth: 0,
  winnerShared: false,
  loserShared: false,
  ...overrides,
});

const renderDialog = (albums = others, target = trip) => {
  const onMerge = vi.fn();
  render(AlbumMergeDialog, { album: target, albums: [target, ...albums], open: true, onMerge });
  return { onMerge };
};

const rows = () => screen.getAllByRole('listitem').map((row) => within(row).getByRole('button'));
const pick = async (name: RegExp) => {
  await fireEvent.click(screen.getByRole('button', { name }));
  return screen.findByRole('button', { name: 'Merge albums' });
};

describe('AlbumMergeDialog', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.open = true;
    };
    HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
      this.open = false;
    };
  });

  beforeEach(() => {
    vi.clearAllMocks();
    sdkMock.getAlbumMergePreview.mockResolvedValue(preview());
  });

  it('lists same-name albums first and marks them, leaving out the album itself', () => {
    renderDialog();

    expect(screen.getByRole('heading', { name: 'Merge “Friends - Patrick” with' })).toBeInTheDocument();
    const [first, ...rest] = rows();
    expect(first).toHaveTextContent('friends - patrick');
    expect(first).toHaveTextContent('Same name');
    expect(rest.map((row) => row.textContent)).toEqual([
      expect.stringContaining('Beach'),
      expect.stringContaining('Zoo'),
    ]);
    expect(rows()).toHaveLength(3);
  });

  it('narrows the list as the person searches and says when nothing matches', async () => {
    renderDialog();
    const search = screen.getByRole('searchbox', { name: 'Search albums' });

    await fireEvent.input(search, { target: { value: 'zo' } });
    expect(rows()).toHaveLength(1);

    await fireEvent.input(search, { target: { value: 'nothing here' } });
    expect(screen.getByText('No albums match.')).toBeInTheDocument();
  });

  it('caps a very long list and says to search for the rest', () => {
    renderDialog(Array.from({ length: 205 }, (_, index) => album(`a${index}`, `Album ${index}`)));

    expect(rows()).toHaveLength(200);
    expect(screen.getByText('Showing the first 200. Search to find the rest.')).toBeInTheDocument();
  });

  it('shows the album the server chose as the one that stays, with the total', async () => {
    sdkMock.getAlbumMergePreview.mockResolvedValue(preview({ winnerId: 'same', total: 11, inBoth: 1 }));
    renderDialog();

    await pick(/friends\s+- patrick/);

    expect(sdkMock.getAlbumMergePreview).toHaveBeenCalledWith({ id: 'trip', otherId: 'same' });
    expect(screen.getByRole('heading', { name: 'Merge these albums?' })).toBeInTheDocument();
    expect(screen.getByText('Keeps name and icon').closest('.tile')).toHaveTextContent('friends - patrick');
    expect(screen.getByText('Merged in, then removed').closest('.tile')).toHaveTextContent('Friends - Patrick');
    expect(
      screen.getByText(
        '“friends - patrick” will hold 11 photos, counting 1 that are in both albums once. No photos are removed from your library.',
      ),
    ).toBeInTheDocument();
  });

  it('can keep the album the merge started from', async () => {
    sdkMock.getAlbumMergePreview.mockResolvedValue(preview({ winnerId: 'trip', total: 4 }));
    renderDialog();

    await pick(/Beach/);

    expect(screen.getByText('Keeps name and icon').closest('.tile')).toHaveTextContent('Friends - Patrick');
    expect(screen.getByText(/will hold 4 photos\. No photos are removed/)).toBeInTheDocument();
  });

  it('says nothing about sharing when neither album is shared', async () => {
    renderDialog();

    await pick(/Beach/);

    expect(screen.queryByText(/One of these is shared/)).toBeNull();
    expect(screen.queryByText(/lose access/)).toBeNull();
  });

  it("warns that the winner's people will see both albums", async () => {
    sdkMock.getAlbumMergePreview.mockResolvedValue(preview({ winnerShared: true }));
    renderDialog();

    await pick(/friends\s+- patrick/);

    expect(
      screen.getByText(
        'One of these is shared. Everyone in “friends - patrick” will be able to see the photos from both albums.',
      ),
    ).toBeInTheDocument();
  });

  it("warns that the merged-away album's people and public links lose access", async () => {
    sdkMock.getAlbumMergePreview.mockResolvedValue(preview({ loserShared: true }));
    renderDialog();

    await pick(/Beach/);

    expect(screen.getByText(/People “Friends - Patrick” is shared with lose access/)).toHaveTextContent(
      'its public links stop working',
    );
  });

  it('says what else moves and what Undo does and does not bring back', async () => {
    renderDialog();

    await pick(/Beach/);

    expect(screen.getByText(/Comments, likes and links move to/)).toBeInTheDocument();
    const undo = screen.getByText(/^Undo appears once/);
    expect(undo).toHaveTextContent('brings “Friends - Patrick” back, with its people and public links');
    expect(undo).toHaveTextContent('doesn’t reverse what you change after merging');
  });

  it('explains the lock only when just one of the albums is locked', async () => {
    renderDialog([album('same', 'friends - patrick', { isLocked: true })]);
    await pick(/friends - patrick/);
    expect(screen.getByText(/won’t be locked, because only one of these is/)).toHaveTextContent(
      'Photos that are locked stay locked',
    );
  });

  it('does not mention locking when both albums are locked', async () => {
    renderDialog([album('same', 'friends - patrick', { isLocked: true })], { ...trip, isLocked: true });
    await pick(/friends - patrick/);
    expect(screen.queryByText(/won’t be locked/)).toBeNull();
  });

  it('merges with the album the person picked', async () => {
    const { onMerge } = renderDialog();

    const confirm = await pick(/Beach/);
    await fireEvent.click(confirm);

    expect(onMerge).toHaveBeenCalledWith(expect.objectContaining({ id: 'beach' }));
  });

  it('holds the confirm button until the server has said which album stays', async () => {
    let answer: (value: AlbumMergePreviewResponseDto) => void = () => {};
    sdkMock.getAlbumMergePreview.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    renderDialog();

    await fireEvent.click(screen.getByRole('button', { name: /Beach/ }));

    expect(await screen.findByRole('button', { name: 'Merge albums' })).toBeDisabled();
    answer(preview());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Merge albums' })).toBeEnabled());
  });

  it('goes back to the list', async () => {
    renderDialog();
    await pick(/Beach/);

    await fireEvent.click(screen.getByRole('button', { name: 'Back' }));

    expect(screen.getByRole('searchbox', { name: 'Search albums' })).toBeInTheDocument();
  });

  it('returns to the list when the server refuses the pair', async () => {
    sdkMock.getAlbumMergePreview.mockRejectedValue(new Error('refused'));
    renderDialog();

    await fireEvent.click(screen.getByRole('button', { name: /Beach/ }));

    await waitFor(() => expect(screen.getByRole('searchbox', { name: 'Search albums' })).toBeInTheDocument());
  });
});
