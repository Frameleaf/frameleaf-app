import {
  createSharedLink,
  isHttpError,
  removeSharedLinkAssets,
  updateSharedLink,
  type SharedLinkCreateDto,
  type SharedLinkEditDto,
  type SharedLinkResponseDto,
} from '@frameleaf/sdk';
import { modalManager, toastManager } from '@frameleaf/ui';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { serverConfigManager } from '$lib/managers/server-config-manager.svelte';
import { Route } from '$lib/route';
import { getServerErrorMessage, handleError } from '$lib/utils/handle-error';
import { getFormatter } from '$lib/utils/i18n';

export const asUrl = (sharedLink: SharedLinkResponseDto) => {
  // FL-305: the server's address when it has one (an external domain is set)
  if (sharedLink.url) {
    return sharedLink.url;
  }
  const path = Route.viewSharedLink(sharedLink);
  return new URL(path, serverConfigManager.value.externalDomain || location.origin).href;
};

/** The server's refusal when a custom address (slug) is held by another link (FL-83 AL-26). */
export const SHARED_LINK_SLUG_TAKEN = 'Shared link slug is already in use';

export const isSlugTakenError = (error: unknown) =>
  isHttpError(error) && error.status === 400 && getServerErrorMessage(error) === SHARED_LINK_SLUG_TAKEN;

type SaveOptions = {
  /** Called instead of the generic failure toast when the custom address is already used. */
  onSlugTaken?: () => void;
};

export const handleCreateSharedLink = async (dto: SharedLinkCreateDto, options?: SaveOptions) => {
  const $t = await getFormatter();

  try {
    // The answer is the whole link: for an album link it carries the album, its item count and its cover.
    const sharedLink = await createSharedLink({ sharedLinkCreateDto: dto });

    eventManager.emit('SharedLinkCreate', sharedLink);

    // The caller shows the design's "Link ready" step (SharedLinkForm.jsx:237-303) with this link.
    return sharedLink;
  } catch (error) {
    if (options?.onSlugTaken && isSlugTakenError(error)) {
      options.onSlugTaken();
      return;
    }
    handleError(error, $t('errors.failed_to_create_shared_link'));
  }
};

export const handleUpdateSharedLink = async (
  sharedLink: SharedLinkResponseDto,
  dto: SharedLinkEditDto,
  options?: SaveOptions,
) => {
  const $t = await getFormatter();

  try {
    const response = await updateSharedLink({ id: sharedLink.id, sharedLinkEditDto: dto });

    eventManager.emit('SharedLinkUpdate', { album: sharedLink.album, ...response });
    toastManager.primary($t('saved'));

    return true;
  } catch (error) {
    if (options?.onSlugTaken && isSlugTakenError(error)) {
      options.onSlugTaken();
      return false;
    }
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
