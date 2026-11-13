import type { t } from 'svelte-i18n';
import type { Readable } from 'svelte/store';

type Translate = typeof t extends Readable<infer T> ? T : never;
/** Translate automatic source labels while preserving names chosen by the owner. */
export const developLabel = (version: { label?: string | null; software?: string | null }, translate: Translate) =>
  version.software &&
  ['Lightroom', 'darktable'].includes(version.software) &&
  version.label === `From ${version.software}`
    ? translate('frameleaf_develop_from_app', { values: { app: version.software } })
    : version.label;
