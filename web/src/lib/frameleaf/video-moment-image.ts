import { AssetMediaSize, getBaseUrl } from '@frameleaf/sdk';
import { frameImagePath } from '$lib/frameleaf/enrichment';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { getAssetMediaUrl } from '$lib/utils';

/** The picture of a moment inside a video: its own frame when it has one, else the video's thumbnail. */
export const momentImageUrl = ({ assetId, frameId }: { assetId: string; frameId?: string | null }) => {
  if (!frameId) {
    return getAssetMediaUrl({ id: assetId, size: AssetMediaSize.Thumbnail });
  }
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(authManager.params)) {
    if (value) {
      search.set(key, value);
    }
  }
  const text = search.toString();
  return `${getBaseUrl()}${frameImagePath(frameId)}${text ? `?${text}` : ''}`;
};
