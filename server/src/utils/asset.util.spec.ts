import type { AccessRepository } from 'src/repositories/access.repository.js';
import type { IBulkAsset } from 'src/types.js';
import { BulkIdErrorReason } from 'src/dtos/asset-ids.response.dto.js';
import { AssetFileType, Permission } from 'src/enum.js';
import { checkAccess } from 'src/utils/access.js';
import { addAssets, getAssetFiles, removeAssets } from 'src/utils/asset.util.js';
import { AssetFileFactory } from 'test/factories/asset-file.factory.js';
import { AuthFactory } from 'test/factories/auth.factory.js';

vi.mock('src/utils/access.js', () => ({ checkAccess: vi.fn() }));

describe('getAssetFiles', () => {
  const variants = [
    ['fullsizeFile', AssetFileType.FullSize, false],
    ['previewFile', AssetFileType.Preview, false],
    ['thumbnailFile', AssetFileType.Thumbnail, false],
    ['sidecarFile', AssetFileType.Sidecar, false],
    ['editedFullsizeFile', AssetFileType.FullSize, true],
    ['editedPreviewFile', AssetFileType.Preview, true],
    ['editedThumbnailFile', AssetFileType.Thumbnail, true],
    ['encodedVideoFile', AssetFileType.EncodedVideo, false],
  ] as const;

  it('retains every output key when no file is available', () => {
    const selected = getAssetFiles([]);
    expect(Object.keys(selected)).toEqual(variants.map(([key]) => key));
    expect(Object.values(selected).every((file) => file === undefined)).toBe(true);
  });

  it('returns the first matching objects for each original and edited variant without modifying the input', () => {
    const first = variants.map(([, type, isEdited]) => AssetFileFactory.create({ type, isEdited }));
    const duplicates = variants.map(([, type, isEdited]) => AssetFileFactory.create({ type, isEdited }));
    const files = [...first.toReversed(), ...duplicates];
    const snapshot = [...files];
    const selected = getAssetFiles(files);
    for (const [index, [key]] of variants.entries()) {
      expect(selected[key]).toBe(first[index]);
    }
    expect(files).toEqual(snapshot);
  });

  it('ignores unsupported variants and preserves missing choices', () => {
    const preview = AssetFileFactory.create({ type: AssetFileType.Preview, isEdited: false });
    const selected = getAssetFiles([
      AssetFileFactory.create({ type: AssetFileType.HdrPreview, isEdited: false }),
      AssetFileFactory.create({ type: AssetFileType.Sidecar, isEdited: true }),
      AssetFileFactory.create({ type: AssetFileType.EncodedVideo, isEdited: true }),
      preview,
    ]);
    expect(selected.previewFile).toBe(preview);
    expect(Object.values(selected).filter((file) => file !== undefined)).toEqual([preview]);
  });

  it('stops inspecting the tail only when every choice is already found', () => {
    const files = variants.map(([, type, isEdited]) => AssetFileFactory.create({ type, isEdited }));
    files.length++;
    const selected = getAssetFiles(files);
    expect(Object.values(selected)).toEqual(files.slice(0, 8));
    const incomplete = files.slice(0, 1);
    incomplete.length++;
    expect(() => getAssetFiles(incomplete)).toThrow(TypeError);
  });

  it('does not treat absent or non-boolean edited flags as an original or edited file', () => {
    for (const flag of [undefined, null, 0, 1, 'false', 'true']) {
      const file = AssetFileFactory.create({ type: AssetFileType.FullSize });
      Reflect.set(file, 'isEdited', flag);
      expect(Object.values(getAssetFiles([file])).every((selected) => selected === undefined)).toBe(true);
    }
  });
});

describe('bulk asset membership', () => {
  const parentId = 'parent';
  const access = {} as AccessRepository;
  let auth: ReturnType<typeof AuthFactory.create>;
  let bulk: {
    getAssetIds: ReturnType<typeof vi.fn<IBulkAsset['getAssetIds']>>;
    addAssetIds: ReturnType<typeof vi.fn<IBulkAsset['addAssetIds']>>;
    removeAssetIds: ReturnType<typeof vi.fn<IBulkAsset['removeAssetIds']>>;
  };

  beforeEach(() => {
    vi.resetAllMocks();
    auth = AuthFactory.create();
    bulk = { getAssetIds: vi.fn(), addAssetIds: vi.fn(), removeAssetIds: vi.fn() };
  });

  it('adds permitted IDs once in request order and retains each duplicate or denied result', async () => {
    const ids = ['existing', 'new-b', 'denied', 'new-a', 'new-b'];
    bulk.getAssetIds.mockResolvedValue(new Set(['existing']));
    vi.mocked(checkAccess).mockResolvedValue(new Set(['new-a', 'new-b']));

    await expect(
      addAssets(auth, { access, bulk }, { parentId, assetIds: ids, permission: Permission.AssetShare }),
    ).resolves.toEqual([
      { id: 'existing', success: false, error: BulkIdErrorReason.DUPLICATE },
      { id: 'new-b', success: true },
      { id: 'denied', success: false, error: BulkIdErrorReason.NO_PERMISSION },
      { id: 'new-a', success: true },
      { id: 'new-b', success: false, error: BulkIdErrorReason.DUPLICATE },
    ]);
    expect(checkAccess).toHaveBeenCalledExactlyOnceWith(access, {
      auth,
      permission: Permission.AssetShare,
      ids: ['new-b', 'denied', 'new-a', 'new-b'],
    });
    expect(bulk.addAssetIds).toHaveBeenCalledExactlyOnceWith(parentId, ['new-b', 'new-a']);
    expect(ids).toEqual(['existing', 'new-b', 'denied', 'new-a', 'new-b']);
  });

  it.each([{ assetIds: [] }, { assetIds: ['existing'] }, { assetIds: ['denied'] }])(
    'skips writes when no additions succeed: %j',
    async ({ assetIds }) => {
      bulk.getAssetIds.mockResolvedValue(new Set(['existing']));
      vi.mocked(checkAccess).mockResolvedValue(new Set());
      await addAssets(auth, { access, bulk }, { parentId, assetIds, permission: Permission.AssetShare });
      expect(bulk.addAssetIds).not.toHaveBeenCalled();
    },
  );

  it('removes permitted IDs once and preserves missing, denied and repeated results', async () => {
    bulk.getAssetIds.mockResolvedValue(new Set(['remove-b', 'denied', 'remove-a']));
    vi.mocked(checkAccess)
      .mockResolvedValueOnce(new Set())
      .mockResolvedValueOnce(new Set(['remove-a', 'remove-b']));

    await expect(
      removeAssets(
        auth,
        { access, bulk },
        {
          parentId,
          assetIds: ['remove-b', 'missing', 'denied', 'remove-a', 'remove-b'],
          canAlwaysRemove: Permission.AlbumAssetDelete,
        },
      ),
    ).resolves.toEqual([
      { id: 'remove-b', success: true },
      { id: 'missing', success: false, error: BulkIdErrorReason.NOT_FOUND },
      { id: 'denied', success: false, error: BulkIdErrorReason.NO_PERMISSION },
      { id: 'remove-a', success: true },
      { id: 'remove-b', success: false, error: BulkIdErrorReason.NOT_FOUND },
    ]);
    expect(bulk.removeAssetIds).toHaveBeenCalledExactlyOnceWith(parentId, ['remove-b', 'remove-a']);
    expect(checkAccess).toHaveBeenNthCalledWith(2, access, {
      auth,
      permission: Permission.AssetShare,
      ids: new Set(['denied']),
    });
  });

  it('retains the hidden-content filter even when the caller can otherwise remove any asset', async () => {
    auth.hideNsfwAssets = true;
    bulk.getAssetIds.mockResolvedValue(new Set(['hidden', 'visible']));
    vi.mocked(checkAccess)
      .mockResolvedValueOnce(new Set([parentId]))
      .mockResolvedValueOnce(new Set(['visible']));

    await expect(
      removeAssets(
        auth,
        { access, bulk },
        {
          parentId,
          assetIds: ['hidden', 'visible'],
          canAlwaysRemove: Permission.AlbumAssetDelete,
        },
      ),
    ).resolves.toEqual([
      { id: 'hidden', success: false, error: BulkIdErrorReason.NO_PERMISSION },
      { id: 'visible', success: true },
    ]);
    expect(checkAccess).toHaveBeenNthCalledWith(2, access, {
      auth,
      permission: Permission.AssetRead,
      ids: new Set(['hidden']),
    });
    expect(bulk.removeAssetIds).toHaveBeenCalledExactlyOnceWith(parentId, ['visible']);
  });

  it('still checks membership when a parent grant allows removing any asset', async () => {
    bulk.getAssetIds.mockResolvedValue(new Set(['member']));
    vi.mocked(checkAccess).mockResolvedValueOnce(new Set([parentId]));
    await expect(
      removeAssets(
        auth,
        { access, bulk },
        {
          parentId,
          assetIds: ['missing', 'member', 'member'],
          canAlwaysRemove: Permission.AlbumAssetDelete,
        },
      ),
    ).resolves.toEqual([
      { id: 'missing', success: false, error: BulkIdErrorReason.NOT_FOUND },
      { id: 'member', success: true },
      { id: 'member', success: false, error: BulkIdErrorReason.NOT_FOUND },
    ]);
    expect(checkAccess).toHaveBeenCalledOnce();
    expect(bulk.removeAssetIds).toHaveBeenCalledExactlyOnceWith(parentId, ['member']);
  });

  it.each([{ assetIds: [] }, { assetIds: ['missing'] }, { assetIds: ['denied'] }])(
    'skips writes when no removals succeed: %j',
    async ({ assetIds }) => {
      bulk.getAssetIds.mockResolvedValue(new Set(['denied']));
      vi.mocked(checkAccess).mockResolvedValue(new Set());
      await removeAssets(
        auth,
        { access, bulk },
        {
          parentId,
          assetIds,
          canAlwaysRemove: Permission.AlbumAssetDelete,
        },
      );
      expect(bulk.removeAssetIds).not.toHaveBeenCalled();
    },
  );

  it.each(['add', 'remove'] as const)('propagates a rejected %s write', async (operation) => {
    const failure = new Error('write failed');
    bulk.getAssetIds.mockResolvedValue(new Set(operation === 'add' ? [] : ['asset']));
    vi.mocked(checkAccess).mockResolvedValue(new Set(['asset']));
    const write = operation === 'add' ? bulk.addAssetIds : bulk.removeAssetIds;
    write.mockRejectedValue(failure);
    const result =
      operation === 'add'
        ? addAssets(auth, { access, bulk }, { parentId, assetIds: ['asset'], permission: Permission.AssetShare })
        : removeAssets(
            auth,
            { access, bulk },
            {
              parentId,
              assetIds: ['asset'],
              canAlwaysRemove: Permission.AlbumAssetDelete,
            },
          );
    await expect(result).rejects.toBe(failure);
  });
});
