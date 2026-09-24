import {
  createSharedLink,
  getSharedLinkById,
  removeSharedLinkAssets,
  updateSharedLink,
  type SharedLinkCreateDto,
  type SharedLinkEditDto,
  type SharedLinkResponseDto,
} from '@immich/sdk';
import { modalManager, toastManager } from '@immich/ui';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { serverConfigManager } from '$lib/managers/server-config-manager.svelte';
import { Route } from '$lib/route';
import { handleError } from '$lib/utils/handle-error';
import { getFormatter } from '$lib/utils/i18n';

export const asUrl = (sharedLink: SharedLinkResponseDto) => {
  const path = Route.viewSharedLink(sharedLink);
  return new URL(path, serverConfigManager.value.externalDomain || location.origin).href;
};

export const handleCreateSharedLink = async (dto: SharedLinkCreateDto) => {
  const $t = await getFormatter();

  try {
    let sharedLink = await createSharedLink({ sharedLinkCreateDto: dto });
    if (dto.albumId) {
      // fetch album details, for event
      sharedLink = await getSharedLinkById({ id: sharedLink.id });
    }

    eventManager.emit('SharedLinkCreate', sharedLink);

    // The caller shows the design's "Link ready" step (SharedLinkForm.jsx:237-303) with this link.
    return sharedLink;
  } catch (error) {
    handleError(error, $t('errors.failed_to_create_shared_link'));
  }
};

export const handleUpdateSharedLink = async (sharedLink: SharedLinkResponseDto, dto: SharedLinkEditDto) => {
  const $t = await getFormatter();

  try {
    const response = await updateSharedLink({ id: sharedLink.id, sharedLinkEditDto: dto });

    eventManager.emit('SharedLinkUpdate', { album: sharedLink.album, ...response });
    toastManager.primary($t('saved'));

    return true;
  } catch (error) {
    handleError(error, $t('errors.failed_to_edit_shared_link'));
    return false;
  }
};

export const handleRemoveSharedLinkAssets = async (sharedLink: SharedLinkResponseDto, assetIds: string[]) => {
  const $t = await getFormatter();
  const success = await modalManager.showDialog({
    title: $t('remove_assets_title'),
    prompt: $t('remove_assets_shared_link_confirmation', { values: { count: assetIds.length } }),
    confirmText: $t('remove'),
  });
  if (!success) {
    return false;
  }

  try {
    const results = await removeSharedLinkAssets({
      id: sharedLink.id,
      assetIdsDto: { assetIds },
    });

    for (const result of results) {
      if (!result.success) {
        continue;
      }

      sharedLink.assets = sharedLink.assets.filter((asset) => asset.id !== result.assetId);
    }

    const count = results.filter((item) => item.success).length;
    toastManager.primary($t('assets_removed_count', { values: { count } }));
    return true;
  } catch (error) {
    handleError(error, $t('errors.unable_to_remove_assets_from_shared_link'));
    return false;
  }
};
