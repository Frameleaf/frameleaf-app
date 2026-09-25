import { deleteAssets, restoreAssets } from '@immich/sdk';
import { AssetAction } from '$lib/constants';
import { confirmFrameleaf } from '$lib/frameleaf/confirm';
import { assetFactory } from '@test-data/factories/asset-factory';
import { confirmAndDeletePermanently, restoreFromTrash } from './delete-permanently';

vi.mock('@immich/sdk', async () => {
  const sdk = await vi.importActual<typeof import('@immich/sdk')>('@immich/sdk');
  return { ...sdk, deleteAssets: vi.fn(), restoreAssets: vi.fn() };
});
vi.mock('$lib/frameleaf/confirm', () => ({ confirmFrameleaf: vi.fn() }));

describe('viewer trash actions (V-4)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('asks before deleting permanently and deletes nothing when kept', async () => {
    vi.mocked(confirmFrameleaf).mockResolvedValue(false);
    const asset = assetFactory.build({ isTrashed: true, originalFileName: 'IMG_1.JPG' });
    const onAction = vi.fn();

    expect(await confirmAndDeletePermanently({ asset, preAction: vi.fn(), onAction })).toBe(false);
    expect(confirmFrameleaf).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'frameleaf_viewer_delete_permanently_title',
        confirmText: 'frameleaf_viewer_delete_permanently',
        cancelText: 'frameleaf_viewer_delete_keep',
        danger: true,
      }),
    );
    expect(deleteAssets).not.toHaveBeenCalled();
    expect(onAction).not.toHaveBeenCalled();
  });

  it('deletes the one item with force once confirmed', async () => {
    vi.mocked(confirmFrameleaf).mockResolvedValue(true);
    const asset = assetFactory.build({ isTrashed: true });
    const preAction = vi.fn();
    const onAction = vi.fn();

    expect(await confirmAndDeletePermanently({ asset, preAction, onAction })).toBe(true);
    expect(preAction).toHaveBeenCalledWith(expect.objectContaining({ type: AssetAction.DELETE }));
    expect(deleteAssets).toHaveBeenCalledWith({ assetBulkDeleteDto: { ids: [asset.id], force: true } });
    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ type: AssetAction.DELETE }));
  });

  it('reports a failed delete without claiming it happened', async () => {
    vi.mocked(confirmFrameleaf).mockResolvedValue(true);
    vi.mocked(deleteAssets).mockRejectedValueOnce(new Error('offline'));
    const onAction = vi.fn();

    expect(
      await confirmAndDeletePermanently({
        asset: assetFactory.build({ isTrashed: true }),
        preAction: vi.fn(),
        onAction,
      }),
    ).toBe(false);
    expect(onAction).not.toHaveBeenCalled();
  });

  it('restores through the restore endpoint', async () => {
    const asset = assetFactory.build({ isTrashed: true });
    const onAction = vi.fn();

    expect(await restoreFromTrash({ asset, onAction })).toBe(true);
    expect(restoreAssets).toHaveBeenCalledWith({ bulkIdsDto: { ids: [asset.id] } });
    expect(onAction).toHaveBeenCalledWith(
      expect.objectContaining({ type: AssetAction.RESTORE, asset: expect.objectContaining({ isTrashed: false }) }),
    );
  });
});
