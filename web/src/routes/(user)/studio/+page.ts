import { getAssetInfo, type AssetResponseDto } from '@immich/sdk';
import { parseStudioHandoff } from '$lib/frameleaf/studio/handoff';
import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

/**
 * The Studio route load (FL-88).
 *
 * Studio is an authenticated route like any other: the shell authenticates first, and only
 * then resolves what the editor may see. The "make a movie" handoff from a memory, a
 * selection or an album arrives as `?assets=`, in the order the person chose; `?project=`
 * reopens an existing project.
 *
 * Assets are resolved one by one and settled, because a handoff list can legitimately
 * contain an id this session may no longer read (moved to Locked, trashed, or shared from a
 * partner who revoked access). Those are dropped rather than failing the route: losing one
 * item from a selection must not cost the person the whole editor, and the server, not this
 * loader, remains the access boundary.
 */
export const load = (async ({ url }) => {
  await authenticate(url);

  const handoff = parseStudioHandoff(url.searchParams);
  const $t = await getFormatter();

  const settled = await Promise.allSettled(handoff.assetIds.map((id) => getAssetInfo({ id })));
  const assets = settled
    .filter((result): result is PromiseFulfilledResult<AssetResponseDto> => result.status === 'fulfilled')
    .map((result) => result.value);

  return {
    projectId: handoff.projectId,
    assets,
    /** FL-113: the quick editor that opened Studio, and where its playhead was. */
    returnTo: handoff.returnTo,
    at: handoff.at,
    /** Ids the handoff asked for that this session could not read, for the honest count. */
    unavailableAssetCount: handoff.assetIds.length - assets.length,
    meta: {
      title: $t('frameleaf_studio_title'),
    },
  };
}) satisfies PageLoad;
