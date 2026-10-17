import {
  getAssetInfo,
  getStudioProject,
  getStudioRestoredVersion,
  type StudioRestoredVersionDto,
} from '@frameleaf/sdk';
import { libraryAssetIdsIn, resolveStudioAssets } from '$lib/frameleaf/studio/assets';
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

  // Resolve the caller-authorized stored graph before mount, so reopening needs no selection query.
  // A refused project stays with the session's existing forbidden/missing state; its sources are not read.
  const stored = handoff.projectId ? await getStudioProject({ id: handoff.projectId }).catch(() => null) : null;
  const assetIds = [
    ...new Set([...handoff.assetIds, ...libraryAssetIdsIn(stored?.envelope?.graph)].map((id) => id.toLowerCase())),
  ];
  const assets = await resolveStudioAssets(assetIds, (id) => getAssetInfo({ id }));

  // FL-115: restorations chosen with Use in Studio. The server decides each with the rules a clip of it
  // is resolved by; one that is not the person's is dropped like an unreadable asset, and one that was
  // discarded or expired comes back marked unavailable so Studio says so instead of hiding it.
  const restoredSettled = await Promise.allSettled(
    handoff.restorationIds.map((id) => getStudioRestoredVersion({ id })),
  );
  const restoredVersions = restoredSettled
    .filter((result): result is PromiseFulfilledResult<StudioRestoredVersionDto> => result.status === 'fulfilled')
    .map((result) => result.value);

  return {
    projectId: handoff.projectId,
    assets,
    restoredVersions,
    /** FL-113: the quick editor that opened Studio, and where its playhead was. */
    returnTo: handoff.returnTo,
    at: handoff.at,
    /** Ids the handoff asked for that this session could not read, for the honest count. */
    unavailableAssetCount: assetIds.length - assets.length + handoff.restorationIds.length - restoredVersions.length,
    meta: {
      title: $t('frameleaf_studio_title'),
    },
  };
}) satisfies PageLoad;
