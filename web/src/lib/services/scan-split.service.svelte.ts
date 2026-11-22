import { getAssetInfo, getScanSplit, type ScanSplitInfoResponseDto } from '@frameleaf/sdk';
import { modalManager, toastManager } from '@frameleaf/ui';
import { t } from 'svelte-i18n';
import { get } from 'svelte/store';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';
import ScanSplitSheet from '$lib/modals/ScanSplitSheet.svelte';
import { handleError } from '$lib/utils/handle-error';

const POLL_MS = 3000;
const POLL_TRIES = 40;

/** Bumped when a split finishes, so an open Information panel reads the scan again. */
export const scanSplitChanges = $state({ revision: 0 });

const cropIds = (info: ScanSplitInfoResponseDto) =>
  info.crops
    .map(({ assetId }) => assetId)
    .sort()
    .join(',');

/**
 * The split is a queued job with no event of its own, so this reads the scan's photos gently until they change.
 * A job that fails or takes longer than two minutes ends on the plain "still splitting" line.
 */
export const waitForScanSplit = async (
  id: string,
  before: ScanSplitInfoResponseDto,
  options: { intervalMs?: number; tries?: number } = {},
) => {
  const { intervalMs = POLL_MS, tries = POLL_TRIES } = options;
  const start = cropIds(before);
  for (let attempt = 0; attempt < tries; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    try {
      const now = await getScanSplit({ id });
      if (cropIds(now) !== start || now.cropCount !== before.cropCount) {
        return true;
      }
    } catch {
      // a dropped request is not a failed split: ask again
    }
  }
  return false;
};

/** Opens the review sheet for a photo, then reports how the split went. */
export const openScanSplit = async (id: string) => {
  const isCurrentSession = authManager.captureSession();
  const translate = get(t);
  let info: ScanSplitInfoResponseDto;
  let asset: Awaited<ReturnType<typeof getAssetInfo>>;
  try {
    [asset, info] = await Promise.all([getAssetInfo({ id }), getScanSplit({ id })]);
  } catch (error) {
    handleError(error, translate('frameleaf_scan_split_open_failed'));
    return;
  }
  if (!isCurrentSession()) {
    return;
  }
  const count: number | undefined = await modalManager.show(ScanSplitSheet, { asset, info });
  if (!count) {
    return;
  }
  const name = asset.originalFileName;
  const finished = await waitForScanSplit(id, info);
  if (!isCurrentSession()) {
    return;
  }
  if (finished) {
    scanSplitChanges.revision++;
    // a first split moves the scan from the timeline to Archive
    if (info.cropCount === 0 && !asset.isArchived) {
      eventManager.emit('AssetsArchive', [id]);
    }
    toastManager.primary(translate('frameleaf_scan_split_done', { values: { count, name } }));
  } else {
    toastManager.primary(translate('frameleaf_scan_split_still_working', { values: { name } }));
  }
};
