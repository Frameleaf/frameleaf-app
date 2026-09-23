import {
  getDuplicateDecisions,
  getDuplicateReview,
  getLivePhotoCandidates,
  listICloudConnections,
  MediaHealthCategory,
  searchLargeAssets,
} from '@immich/sdk';
import { error } from '@sveltejs/kit';
import { loadLibraryCareHealth } from '$lib/frameleaf/library-care-load';
import { utilityTool, type UtilityId } from '$lib/frameleaf/utilities';

/** Load only the selected tool. Health tools retain their administrator boundary. */
export const loadUtility = async (tool: UtilityId, url: URL, isAdmin: boolean) => {
  if (utilityTool(tool)?.adminOnly && !isAdmin) {
    error(403, 'Administrator access required');
  }
  switch (tool) {
    case 'duplicates': {
      const [groups, history] = await Promise.all([getDuplicateReview(), getDuplicateDecisions()]);
      return { tool, groups, history };
    }
    case 'large-files': {
      return { tool, assets: await searchLargeAssets({ minFileSize: 0 }) };
    }
    case 'live-photos': {
      return { tool, candidates: await getLivePhotoCandidates() };
    }
    case 'icloud': {
      return { tool, initial: await listICloudConnections() };
    }
    case 'missing-media':
    case 'corrupt-media': {
      return {
        tool,
        ...(await loadLibraryCareHealth(
          url,
          tool === 'missing-media' ? MediaHealthCategory.Missing : MediaHealthCategory.Corrupt,
        )),
      };
    }
    case 'geolocation': {
      return { tool };
    }
    default: {
      return { tool };
    }
  }
};
export type UtilityData = Awaited<ReturnType<typeof loadUtility>>;
