import { redirect } from '@sveltejs/kit';
import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
import { utilitiesUrl, type UtilityId } from '$lib/frameleaf/utilities';
import { authenticate } from '$lib/utils/auth';

/** Keep bookmarked utility URLs while rendering tools only inside the Command Center. */
export const redirectUtility = async (url: URL, section?: UtilityId, assetId?: string) => {
  await authenticate(url);
  const params: Record<string, string> = {};
  for (const key of ['status', 'index', 'at', 'workflowId']) {
    const value = url.searchParams.get(key);
    if (value) {
      params[key] = value;
    }
  }
  if (assetId) {
    params.assetId = assetId;
  }
  // FL-1807: the Tools directory is gone; its old address opens Library care.
  redirect(307, section ? utilitiesUrl(section, params) : commandCenterUrl('care'));
};
