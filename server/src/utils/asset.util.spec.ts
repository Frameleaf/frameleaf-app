import type { AccessRepository } from 'src/repositories/access.repository.js';
import type { IBulkAsset } from 'src/types.js';
import { BulkIdErrorReason } from 'src/dtos/asset-ids.response.dto.js';
import { Permission } from 'src/enum.js';
import { checkAccess } from 'src/utils/access.js';
import { addAssets, removeAssets } from 'src/utils/asset.util.js';
import { AuthFactory } from 'test/factories/auth.factory.js';

vi.mock('src/utils/access.js', () => ({ checkAccess: vi.fn() }));

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
