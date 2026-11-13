import { AssetMediaSize, getBaseUrl, type FoundFileResponseDto } from '@frameleaf/sdk';
import { getAssetMediaUrl } from '$lib/utils';

/** File endings a browser shows as a picture straight from the file. */
const SHOWN_AS_IS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif']);

/** The found file itself, as the server sends it to an administrator who may see it. */
export const foundFileUrl = (id: string) => `${getBaseUrl()}/admin/found-files/files/${encodeURIComponent(id)}/file`;

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
