import type { Translations } from 'svelte-i18n';
import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';

export const authenticatedPageLoader =
  (title: Translations) =>
  async ({ url }: { url: URL }) => {
    await authenticate(url);
    const $t = await getFormatter();
    return { meta: { title: $t(title) } };
  };
