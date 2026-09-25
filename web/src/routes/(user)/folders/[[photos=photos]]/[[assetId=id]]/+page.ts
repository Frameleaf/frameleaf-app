import { QueryParameter } from '$lib/constants';
import { resolveFolder } from '$lib/frameleaf/folder-tree';
import { foldersStore } from '$lib/stores/folders.svelte';
import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

export const load = (async ({ url }) => {
  await authenticate(url);
  const requested = url.searchParams.get(QueryParameter.PATH);
  // Arriving at Folders afresh (no folder in the address) reloads the tree and every folder's files,
  // so the counts and the grid never show items that have since been moved, archived or deleted.
  const fresh = requested === null;
  if (fresh) {
    foldersStore.bustAssetCache();
  }
  const [tree, $t] = await Promise.all([foldersStore.fetchTree({ refresh: fresh }), getFormatter()]);

  // An address for a folder that no longer holds anything opens its nearest folder that still does.
  const folder = resolveFolder(tree, requested);
  const assets = folder.directCount > 0 ? await foldersStore.fetchAssetsByPath(folder.path) : [];

  return {
    tree,
    path: folder.path,
    assets,
    meta: {
      title: $t('folders'),
    },
  };
}) satisfies PageLoad;
