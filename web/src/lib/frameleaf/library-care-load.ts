import {
  getRoots,
  getSummary,
  list as listMediaHealth,
  MediaHealthCategory,
  MediaHealthStatus,
  searchUsersAdmin,
} from '@immich/sdk';
import { initialOwner, ownerScope } from '$lib/frameleaf/library-care';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';

/**
 * What Library Care's Missing media and Damaged media pages load (FL-69): the findings that still
 * need attention (or one status, when a link asks for it), the queue summary with the latest scan,
 * the locations this reader may search, and — for the administrator's account filter — every
 * account. Administrators only, as the prototype marks both tools and as before.
 */
export const loadLibraryCareHealth = async (url: URL, category: MediaHealthCategory) => {
  await authenticate(url, { admin: true });
  const $t = await getFormatter();
  const requested = url.searchParams.get('status');
  const status = Object.values(MediaHealthStatus).includes(requested as MediaHealthStatus)
    ? (requested as MediaHealthStatus)
    : undefined;

  // Whose findings: the Command Center's "Viewing" account, or all accounts (UT-13).
  const users = await searchUsersAdmin({});
  const self = authManager.user;
  const owner = initialOwner(url.searchParams.get('scope'), users, self.id, self.isAdmin);
  const scope = ownerScope(owner, self.id);

  const [mediaHealth, summary, roots] = await Promise.all([
    listMediaHealth({ category, status, needsAttention: status ? undefined : true, size: 200, ...scope }),
    getSummary(scope),
    getRoots(),
  ]);

  return {
    category,
    mediaHealth,
    summary,
    roots: roots.roots,
    users,
    owner,
    status,
    meta: {
      title:
        category === MediaHealthCategory.Missing ? $t('library_care_missing_title') : $t('library_care_damaged_title'),
    },
  };
};
