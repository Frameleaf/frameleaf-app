import { getPartners, PartnerDirection } from '@frameleaf/sdk';
import { QueryParameter } from '$lib/constants';
import { resolveFolder } from '$lib/frameleaf/folder-tree';
import { foldersShowColumns, foldersStore } from '$lib/stores/folders.svelte';
import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

export const load = (async ({ url, params }) => {
  await authenticate(url);
  const requested = url.searchParams.get(QueryParameter.PATH);
  // Arriving at Folders afresh (no folder in the address) reloads the tree and every folder's files,
  // so the counts and the grid never show items that have since been moved, archived or deleted.
  const fresh = requested === null;
  if (fresh) {
    foldersStore.bustAssetCache();
  }
  const [tree, $t, partners] = await Promise.all([
    foldersStore.fetchTree({ refresh: fresh }),
    getFormatter(),
    // People who share their library with this account: their upload folders are named after them
    // too. The browser works without the names, so failing to read them is not an error.
    getPartners({ direction: PartnerDirection.SharedWith }).catch(() => []),
  ]);

  // An address for a folder that no longer holds anything opens its nearest folder that still does.
  const folder = resolveFolder(tree, requested);
  // The columns show a folder from the tree alone, so walking through them asks for no files; the
  // grid and the viewer do need them.
  const deferred = folder.directCount > 0 && !params.assetId && foldersShowColumns();
  // The open folder's files are one section of the page: if they cannot load, the folders, the counts
  // and the path still show, and that section offers a retry.
  const assets =
    folder.directCount > 0 && !deferred ? await foldersStore.fetchAssetsByPath(folder.path).catch(() => null) : [];

  return {
    tree,
    path: folder.path,
    assets: assets ?? [],
    assetsFailed: assets === null,
    assetsDeferred: deferred,
    partners: partners.map(({ id, name }) => ({ id, name })),
    meta: {
      title: $t('folders'),
    },
  };
}) satisfies PageLoad;
