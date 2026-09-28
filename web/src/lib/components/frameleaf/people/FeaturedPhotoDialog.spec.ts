import { AssetTypeEnum, AssetVisibility, type AssetFaceResponseDto, type SearchResponseDto } from '@immich/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { assetFactory } from '@test-data/factories/asset-factory';
import { personFactory } from '@test-data/factories/person-factory';
import FeaturedPhotoDialog from './FeaturedPhotoDialog.svelte';

const page = (items: ReturnType<typeof assetFactory.build>[], nextCursor: string | null = null) =>
  ({
    albums: { count: 0, facets: [], items: [], total: 0 },
    assets: { count: items.length, facets: [], items, nextCursor, nextPage: null, total: items.length },
  }) as unknown as SearchResponseDto;

const photo = (overrides: Partial<ReturnType<typeof assetFactory.build>>) =>
  assetFactory.build({ type: AssetTypeEnum.Image, ...overrides });

const face = (personId: string | null): AssetFaceResponseDto =>
  ({
    id: `face-${personId}`,
    boundingBoxX1: 100,
    boundingBoxY1: 50,
    boundingBoxX2: 300,
    boundingBoxY2: 250,
    imageWidth: 1000,
    imageHeight: 500,
    person: personId ? personFactory.build({ id: personId }) : null,
  }) as AssetFaceResponseDto;

describe('FeaturedPhotoDialog (PD-6)', () => {
  const ada = personFactory.build({ id: 'ada', name: 'Ada' });

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
    vi.resetAllMocks();
  });

  it('offers Timeline and Archive photos of the person, never trashed ones', async () => {
    const timeline = photo({ id: 'timeline', originalFileName: 'timeline.jpg' });
    const archived = photo({
      id: 'archived',
      originalFileName: 'archived.jpg',
      visibility: AssetVisibility.Archive,
    });
    sdkMock.searchAssets.mockResolvedValue(page([timeline, archived]));
    sdkMock.getFaces.mockResolvedValue([]);

    render(FeaturedPhotoDialog, { person: ada, open: true });

    expect(await screen.findByRole('radio', { name: 'archived.jpg' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'timeline.jpg' })).toBeTruthy();
    expect(sdkMock.searchAssets).toHaveBeenCalledWith({
      metadataSearchDto: {
        filter: {
          personIds: { any: ['ada'] },
          visibility: { in: [AssetVisibility.Timeline, AssetVisibility.Archive] },
          trashedAt: { eq: null },
        },
        size: 60,
        cursor: undefined,
      },
    });
  });

  it('never lists a Locked or trashed photo even if one comes back', async () => {
    sdkMock.searchAssets.mockResolvedValue(
      page([
        photo({ id: 'locked', originalFileName: 'locked.jpg', visibility: AssetVisibility.Locked }),
        photo({ id: 'trashed', originalFileName: 'trashed.jpg', isTrashed: true }),
        photo({ id: 'kept', originalFileName: 'kept.jpg' }),
      ]),
    );
    sdkMock.getFaces.mockResolvedValue([]);

    render(FeaturedPhotoDialog, { person: ada, open: true });

    await screen.findByRole('radio', { name: 'kept.jpg' });
    expect(screen.queryByRole('radio', { name: 'locked.jpg' })).toBeNull();
    expect(screen.queryByRole('radio', { name: 'trashed.jpg' })).toBeNull();
    await waitFor(() => expect(sdkMock.getFaces).toHaveBeenCalledTimes(1));
    expect(sdkMock.getFaces).toHaveBeenCalledWith({ id: 'kept' });
  });

  it("crops a tile to the person's face when the photo has one, and shows the whole photo otherwise", async () => {
    sdkMock.searchAssets.mockResolvedValue(
      page([
        photo({ id: 'with-face', originalFileName: 'with-face.jpg' }),
        photo({ id: 'someone-else', originalFileName: 'someone-else.jpg' }),
        assetFactory.build({ id: 'clip', originalFileName: 'clip.mp4', type: AssetTypeEnum.Video }),
      ]),
    );
    sdkMock.getFaces.mockImplementation(({ id }) =>
      Promise.resolve(id === 'with-face' ? [face('other'), face('ada')] : [face('other')]),
    );

    render(FeaturedPhotoDialog, { person: ada, open: true });

    const withFace = await screen.findByRole('radio', { name: 'with-face.jpg' });
    await waitFor(() => expect(withFace.querySelector(':scope .face-crop')).not.toBeNull());
    const crop = withFace.querySelector(':scope .face-crop img') as HTMLImageElement;
    // box 0.1..0.3 × 0.1..0.5 of the image: scaled 5× and centred on (20%, 30%)
    expect(crop.style.width).toBe('500%');
    expect(crop.style.transform).toMatch(/^translate\(-20%, -30(\.0+\d*)?%\)$/);
    expect(screen.getByRole('radio', { name: 'someone-else.jpg' }).querySelector(':scope .face-crop')).toBeNull();
    // a video has no face box to read
    expect(sdkMock.getFaces).not.toHaveBeenCalledWith({ id: 'clip' });
  });

  it('pages on with the cursor', async () => {
    sdkMock.searchAssets
      .mockResolvedValueOnce(page([photo({ id: 'first', originalFileName: 'first.jpg' })], 'next'))
      .mockResolvedValueOnce(page([photo({ id: 'second', originalFileName: 'second.jpg' })]));
    sdkMock.getFaces.mockResolvedValue([]);

    render(FeaturedPhotoDialog, { person: ada, open: true });
    await fireEvent.click(await screen.findByRole('button', { name: 'Show more' }));

    expect(await screen.findByRole('radio', { name: 'second.jpg' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'first.jpg' })).toBeTruthy();
    expect(sdkMock.searchAssets.mock.calls[1][0].metadataSearchDto.cursor).toBe('next');
  });

  it('sets the featured photo and announces the updated person', async () => {
    const updated = { ...ada, updatedAt: '2026-09-25T00:00:00.000Z' };
    sdkMock.searchAssets.mockResolvedValue(
      page([photo({ id: 'archived', originalFileName: 'a.jpg', visibility: AssetVisibility.Archive })]),
    );
    sdkMock.getFaces.mockResolvedValue([]);
    sdkMock.updatePerson.mockResolvedValue(updated);
    const onSelected = vi.fn();
    const announced = vi.fn();
    const stop = eventManager.on({ PersonUpdate: announced });

    render(FeaturedPhotoDialog, { person: ada, open: true, onSelected });
    await fireEvent.click(await screen.findByRole('radio', { name: 'a.jpg' }));

    await waitFor(() => expect(onSelected).toHaveBeenCalledWith(updated));
    expect(sdkMock.updatePerson).toHaveBeenCalledWith({
      id: 'ada',
      personUpdateDto: { featureFaceAssetId: 'archived' },
    });
    expect(announced).toHaveBeenCalledWith(updated);
    stop();
  });

  // FL-37: the person's current featured photo (`featuredAssetId`, owner-only) is marked, as in
  // People.jsx:603-628: checked, with the accent border and check, named as the current one
  it('marks the current featured photo', async () => {
    sdkMock.searchAssets.mockResolvedValue(
      page([
        photo({ id: 'other', originalFileName: 'other.jpg' }),
        photo({ id: 'featured', originalFileName: 'featured.jpg' }),
      ]),
    );
    sdkMock.getFaces.mockResolvedValue([]);

    render(FeaturedPhotoDialog, { person: { ...ada, featuredAssetId: 'featured' }, open: true });

    const current = await screen.findByRole('radio', { name: 'featured.jpg, current featured photo' });
    expect(current.getAttribute('aria-checked')).toBe('true');
    expect(current.classList.contains('current')).toBe(true);
    expect(current.querySelector(':scope .check')).not.toBeNull();
    const other = screen.getByRole('radio', { name: 'other.jpg' });
    expect(other.getAttribute('aria-checked')).toBe('false');
    expect(other.querySelector(':scope .check')).toBeNull();
  });

  it('marks nothing when the server names no featured photo', async () => {
    sdkMock.searchAssets.mockResolvedValue(page([photo({ id: 'only', originalFileName: 'only.jpg' })]));
    sdkMock.getFaces.mockResolvedValue([]);

    render(FeaturedPhotoDialog, { person: { ...ada, featuredAssetId: null }, open: true });

    const tile = await screen.findByRole('radio', { name: 'only.jpg' });
    expect(tile.getAttribute('aria-checked')).toBe('false');
    expect(screen.queryByRole('radio', { checked: true })).toBeNull();
  });

  it('moves the mark to the photo just chosen', async () => {
    sdkMock.searchAssets.mockResolvedValue(
      page([photo({ id: 'old', originalFileName: 'old.jpg' }), photo({ id: 'new', originalFileName: 'new.jpg' })]),
    );
    sdkMock.getFaces.mockResolvedValue([]);
    let resolve: (value: never) => void = () => {};
    sdkMock.updatePerson.mockReturnValue(new Promise((done) => (resolve = done)) as never);

    render(FeaturedPhotoDialog, { person: { ...ada, featuredAssetId: 'old' }, open: true });
    await fireEvent.click(await screen.findByRole('radio', { name: 'new.jpg' }));

    expect(screen.getByRole('radio', { name: 'new.jpg, current featured photo' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(screen.getByRole('radio', { name: 'old.jpg' }).getAttribute('aria-checked')).toBe('false');
    resolve({ ...ada, featuredAssetId: 'new' } as never);
  });
});
