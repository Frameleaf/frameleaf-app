import {
  createSharedLink,
  isHttpError,
  updateSharedLink,
  type SharedLinkCreateDto,
  type SharedLinkEditDto,
  type SharedLinkResponseDto,
} from '@frameleaf/sdk';
import { toastManager } from '@frameleaf/ui';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { serverConfigManager } from '$lib/managers/server-config-manager.svelte';
import { Route } from '$lib/route';
import { getServerErrorMessage, handleError } from '$lib/utils/handle-error';
import { getFormatter } from '$lib/utils/i18n';

/**
 * FL-1771: a web address, or undefined. The server's link address and the administrator's external
 * domain are opened and copied as links, so anything but http(s) (`javascript:` and the like) is
 * never used; the link is then built on this server's own address instead.
 */
const webAddress = (value: string | null | undefined, base?: string): URL | undefined => {
  if (!value) {
    return undefined;
  }
  try {
    const url = new URL(value, base);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : undefined;
  } catch {
    return undefined;
  }
};

const linkBase = () => (webAddress(serverConfigManager.value.externalDomain) ?? new URL(location.origin)).href;

export const asUrl = (sharedLink: SharedLinkResponseDto) => {
  // FL-305: the server's address when it has one (an external domain is set)
  const given = webAddress(sharedLink.url);
  if (given) {
    return given.href;
  }
  const path = Route.viewSharedLink(sharedLink);
  return new URL(path, linkBase()).href;
};

/**
 * FL-788: the address of a single-photo link's image file, for embedding in forums and websites; empty
 * when the link has none (more than one item, a video, a password, downloads off or expired).
 */
export const asDirectImageUrl = (sharedLink: SharedLinkResponseDto) =>
  webAddress(sharedLink.directUrl, linkBase())?.href ?? '';

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
