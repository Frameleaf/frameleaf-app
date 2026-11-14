import {
  AssetMediaSize,
  FoundFileOutcome,
  getBaseUrl,
  type FoundFileGroupDto,
  type FoundFileResponseDto,
} from '@frameleaf/sdk';
import type { Translations } from 'svelte-i18n';
import { getAssetMediaUrl } from '$lib/utils';

/** File endings a browser shows as a picture straight from the file. */
const SHOWN_AS_IS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif']);

/** The found file itself, as the server sends it to an administrator who may see it. */
export const foundFileUrl = (id: string) => `${getBaseUrl()}/admin/found-files/files/${encodeURIComponent(id)}/file`;

/** FL-1579: the name the archive of a group's files that won't open is saved under. */
export const WONT_OPEN_ARCHIVE = 'frameleaf-files-that-wont-open.zip';

/** FL-1579: a group's files that won't open, as they are, in one archive. */
export const foundArchiveUrl = (group: Pick<FoundFileGroupDto, 'ownerId' | 'folder'>) => {
  const query = new URLSearchParams();
  if (group.ownerId) {
    query.set('ownerId', group.ownerId);
  } else if (group.folder) {
    query.set('folder', group.folder);
  }
  const asked = query.toString();
  return `${getBaseUrl()}/admin/found-files/wont-open/archive${asked ? `?${asked}` : ''}`;
};

/**
 * FL-1533: the address of a found file's picture, or undefined when there is none to show. Another
 * account's file has none, and none is asked for. A file that is a photo (it was put back, added, or
 * copies one) shows that photo's preview; a file in no library shows itself when a browser can.
 */
export const foundPicture = (
  file: Pick<FoundFileResponseDto, 'id' | 'assetId' | 'viewable' | 'fileName' | 'sortedAt'>,
  size: AssetMediaSize = AssetMediaSize.Thumbnail,
): string | undefined => {
  if (!file.viewable) {
    return undefined;
  }
  if (file.assetId) {
    return getAssetMediaUrl({ id: file.assetId, size, cacheKey: file.sortedAt });
  }
  const ending = file.fileName.split('.').pop()?.toLowerCase() ?? '';
  return SHOWN_AS_IS.has(ending) ? foundFileUrl(file.id) : undefined;
};

/** FL-1579: what to say once a file that was left alone has been sorted again, by what became of it. */
export const sortedAgainWords = (outcome: FoundFileOutcome): Translations => {
  switch (outcome) {
    case FoundFileOutcome.Back: {
      return 'frameleaf_found_again_back';
    }
    case FoundFileOutcome.Added: {
      return 'frameleaf_found_again_added';
    }
    case FoundFileOutcome.Spare: {
      return 'frameleaf_found_again_spare';
    }
    default: {
      return 'frameleaf_found_again_needs';
    }
  }
};
