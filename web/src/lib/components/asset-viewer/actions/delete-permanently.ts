import { deleteAssets, restoreAssets, type AssetResponseDto } from '@immich/sdk';
import { toastManager } from '@immich/ui';
import type { OnAction, PreAction } from '$lib/components/asset-viewer/actions/action';
import { AssetAction } from '$lib/constants';
import { confirmFrameleaf } from '$lib/frameleaf/confirm';
import { handleError } from '$lib/utils/handle-error';
import { getFormatter } from '$lib/utils/i18n';
import { toTimelineAsset } from '$lib/utils/timeline-util';

/**
 * The viewer's "Delete permanently" (MediaViewer.jsx:1147-1154, 1866-1890): always confirmed with
 * "Delete permanently? / {name} will be removed from every album and cannot be recovered afterwards."
 * and Keep / Delete permanently, from the trash toolbar, the Trash group of the More menu, Delete or
 * Backspace on a trashed item, and Shift+Delete. Resolves `true` only once the server deleted it.
 */
export const confirmAndDeletePermanently = async ({
  asset,
  preAction,
  onAction,
}: {
  asset: AssetResponseDto;
  preAction: PreAction;
  onAction: OnAction;
}): Promise<boolean> => {
  const $t = await getFormatter();
  const confirmed = await confirmFrameleaf({
    title: $t('frameleaf_viewer_delete_permanently_title'),
    prompt: $t('frameleaf_viewer_delete_permanently_prompt', { values: { name: asset.originalFileName } }),
    confirmText: $t('frameleaf_viewer_delete_permanently'),
    cancelText: $t('frameleaf_viewer_delete_keep'),
    danger: true,
  });
  if (!confirmed) {
    return false;
  }

  const timelineAsset = toTimelineAsset(asset);
  try {
    await preAction({ type: AssetAction.DELETE, asset: timelineAsset });
    await deleteAssets({ assetBulkDeleteDto: { ids: [timelineAsset.id], force: true } });
    onAction({ type: AssetAction.DELETE, asset: timelineAsset });
    toastManager.primary($t('permanently_deleted_asset'));
    return true;
  } catch (error) {
    handleError(error, $t('errors.unable_to_delete_asset'));
    return false;
  }
};

/** The trash toolbar's and the Trash group's Restore (MediaViewer.jsx:1140-1146, media-viewer.mjs:696-701). */
export const restoreFromTrash = async ({
  asset,
  onAction,
}: {
  asset: AssetResponseDto;
  onAction: OnAction;
}): Promise<boolean> => {
  const $t = await getFormatter();
  try {
    await restoreAssets({ bulkIdsDto: { ids: [asset.id] } });
    onAction({ type: AssetAction.RESTORE, asset: toTimelineAsset({ ...asset, isTrashed: false }) });
    toastManager.primary($t('restored_asset'));
    return true;
  } catch (error) {
    handleError(error, $t('errors.unable_to_restore_assets'));
    return false;
  }
};
