import { getTakeoutImport, listTakeoutImports } from '@immich/sdk';
import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

/**
 * The Google Photos import wizard (FL-65). The list and the selected import are read from the
 * server on every visit: nothing about an import lives in the browser, so a reload, another tab or
 * another device all open the import where the server has it.
 */
export const load = (async ({ url }) => {
  await authenticate(url);
  const $t = await getFormatter();
  const selected = url.searchParams.get('import');
  const [imports, current] = await Promise.all([
    listTakeoutImports(),
    selected ? getTakeoutImport({ id: selected }).catch(() => undefined) : Promise.resolve(undefined),
  ]);

  return {
    imports,
    current,
    meta: {
      title: $t('frameleaf_takeout_title'),
    },
  };
}) satisfies PageLoad;
