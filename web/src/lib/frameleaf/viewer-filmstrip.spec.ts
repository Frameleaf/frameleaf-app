import { AssetTypeEnum, AssetVisibility } from '@immich/sdk';
import { trashFilmstripAsset } from '$lib/frameleaf/trash';
import { filmstripPlaceholder } from '$lib/frameleaf/viewer-filmstrip';

describe('filmstrip placeholders (V-17)', () => {
  it('draws an id-only item as a still that is not Locked or trashed', () => {
    const asset = filmstripPlaceholder({ id: 'a', ownerId: 'me' });
    expect(asset).toMatchObject({ id: 'a', ownerId: 'me', isImage: true, isVideo: false, isTrashed: false });
    expect(asset.visibility).toBe(AssetVisibility.Timeline);
  });

  it('keeps a trash row trashed, its kind and its Locked state', () => {
    const asset = trashFilmstripAsset(
      {
        id: 'b',
        type: AssetTypeEnum.Video,
        isLocked: true,
        isOffline: false,
        originalFileName: 'clip.mov',
        fileSizeInByte: 12,
        trashedAt: '2026-09-01T10:00:00.000Z',
      },
      'me',
    );
    expect(asset).toMatchObject({ id: 'b', isVideo: true, isTrashed: true, originalFileName: 'clip.mov' });
    expect(asset.visibility).toBe(AssetVisibility.Locked);
    expect(asset.localDateTime.year).toBe(2026);
  });
});
