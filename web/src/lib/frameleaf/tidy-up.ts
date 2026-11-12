/**
 * Library care › Tidy up (FL-1470, approved prototype `settings-v2/care/tidy-up.jsx`, FL-1468): memes,
 * receipts, screenshots and other clutter suggested for the Archive. Nothing is deleted.
 */
import {
  mdiCellphoneScreenshot,
  mdiEmoticonLolOutline,
  mdiImageBrokenVariant,
  mdiMessageImageOutline,
  mdiNoteTextOutline,
  mdiPresentation,
  mdiReceiptTextOutline,
  mdiStorefrontOutline,
} from '@mdi/js';
import type { Translations } from 'svelte-i18n';

/** The kinds in the prototype's order. The server answers with these as plain strings. */
export const TIDY_KINDS = [
  { id: 'memes', icon: mdiEmoticonLolOutline },
  { id: 'documents', icon: mdiReceiptTextOutline },
  { id: 'screenshots', icon: mdiCellphoneScreenshot },
  { id: 'shop', icon: mdiStorefrontOutline },
  { id: 'chat', icon: mdiMessageImageOutline },
  { id: 'slides', icon: mdiPresentation },
  { id: 'notes', icon: mdiNoteTextOutline },
  { id: 'accidental', icon: mdiImageBrokenVariant },
] as const;

export type TidyKindId = (typeof TIDY_KINDS)[number]['id'];
export const TIDY_STRICTNESS = ['surer', 'balanced', 'more'] as const;

export const kindName = (id: string) => `frameleaf_tidy_kind_${id}` as Translations;
export const kindWhat = (id: string) => `frameleaf_tidy_kind_${id}_what` as Translations;
export const kindWhy = (id: string) => `frameleaf_tidy_kind_${id}_why` as Translations;
export const strictnessName = (id: string) => `frameleaf_tidy_strictness_${id}` as Translations;
export const strictnessSaid = (id: string) => `frameleaf_tidy_strictness_${id}_said` as Translations;

/** How many the server takes in one decision. */
export const TIDY_DECIDE_LIMIT = 500;

/** Every suggestion goes to the Archive unless it was set to Keep. */
export const archiveCount = (total: number, kept: ReadonlySet<string>) => Math.max(0, total - kept.size);

/** Split ids into the chunks one decision accepts. */
export const chunks = <T>(items: T[], size = TIDY_DECIDE_LIMIT): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));
