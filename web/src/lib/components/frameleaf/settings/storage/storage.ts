/**
 * Storage & originals (FL-365) in plain words: the rules of the pages, kept apart from the drawing so
 * they can be tested on their own.
 */
import handlebars from 'handlebars';
import { DateTime } from 'luxon';

const DAY_MS = 86_400_000;

/** "Keep deleted photos for": the lengths offered. No "delete straight away" (owner call defaulted on FL-365). */
export const KEEP_PHOTO_DAYS = [7, 30, 60, 90, 365] as const;
/** The recommended length, marked in the list. */
export const RECOMMENDED_PHOTO_DAYS = 30;
/** "Keep a deleted account for": the lengths offered. */
export const KEEP_ACCOUNT_DAYS = [1, 7, 30] as const;
export const RECOMMENDED_ACCOUNT_DAYS = 7;

/** "Warn me when the disk is nearly full": Off, At 85% (recommended), At 95%, and a saved value outside them. */
export const WARN_PERCENTS = [0, 85, 95] as const;

/** The value a "keep for" list shows: a listed length, else `custom`. */
export const keepChoice = (days: number, listed: readonly number[]) =>
  listed.includes(days) ? String(days) : 'custom';

/** The day something deleted today can last be brought back. */
export const lastDay = (days: number, from: Date = new Date()) => new Date(from.getTime() + days * DAY_MS);

/** The same pace and room-left estimates the Overview shows for the same drive. */
export { growthPerDay, roomLeft } from '$lib/components/frameleaf/settings/overview/overview';

/** A named folder layout: the storage template it writes, offered as a choice with an example. */
export type FolderLayout = { id: string; template: string };

/** The named layouts: dates only (owner call defaulted on FL-365: no "By album" or "By camera"). */
export const FOLDER_LAYOUTS: readonly FolderLayout[] = [
  { id: 'day', template: '{{y}}/{{y}}-{{MM}}-{{dd}}/{{filename}}' },
  { id: 'month', template: '{{y}}/{{MM}}/{{filename}}' },
  { id: 'monthname', template: '{{y}}/{{MMMM}}/{{filename}}' },
  { id: 'year', template: '{{y}}/{{filename}}' },
];

/** The layout a template is, or `custom`. */
export const layoutOf = (template: string) =>
  FOLDER_LAYOUTS.find((layout) => layout.template === template.trim())?.id ?? 'custom';

/** The date tokens the server fills (StorageTemplateService `storageTokens`); album dates use the same ones. */
const DATE_TOKENS = [
  's',
  'ss',
  'SSS',
  'm',
  'mm',
  'd',
  'dd',
  'W',
  'WW',
  'h',
  'hh',
  'H',
  'HH',
  'y',
  'yy',
  'M',
  'MM',
  'MMM',
  'MMMM',
];

/** The sample photo every example uses: taken 15 June 2024, in an album that ran 10–20 June 2024. */
const SAMPLE_TAKEN = DateTime.fromISO('2024-06-15T14:22:33.000');
const SAMPLE_ALBUM_START = DateTime.fromISO('2024-06-10T09:00:00.000');
const SAMPLE_ALBUM_END = DateTime.fromISO('2024-06-20T18:00:00.000');
const SAMPLE: ReadonlyMap<string, string> = new Map([
  ...Object.entries({
    filename: 'IMG_1234',
    ext: 'jpg',
    filetype: 'IMG',
    filetypefull: 'IMAGE',
    assetId: 'a1b2c3d4-e5f6-4789-8abc-def012345678',
    assetIdShort: 'def012345678',
    album: 'Summer in Banff',
    make: 'FUJIFILM',
    model: 'X-T50',
    lensModel: 'XF27mm F2.8 R WR',
  }),
  ...DATE_TOKENS.flatMap((token) => [
    [token, SAMPLE_TAKEN.toFormat(token)] as const,
    [`album-startDate-${token}`, SAMPLE_ALBUM_START.toFormat(token)] as const,
    [`album-endDate-${token}`, SAMPLE_ALBUM_END.toFormat(token)] as const,
  ]),
]);

/** Names used in `{{name}}`, `{{#if name}}` and `{{#unless name}}`; helpers and `else` are not names. */
const NAMES = /\{\{(?:#(?:if|unless)\s+)?\s*([\w-]+)\s*\}\}/g;

/**
 * Where the sample photo would go under a template, as folder names and a file name, and the
 * placeholders Frameleaf does not know. Rendered with Handlebars like the server, so every
 * Immich-era template (album dates, `#if`/`#unless`/`else`) previews the way it will be filed.
 */
export const placeSample = (template: string): { parts: string[]; unknown: string[] } => {
  const unknown: string[] = [];
  const values: Record<string, string> = Object.fromEntries(SAMPLE);
  for (const [whole, name] of template.matchAll(NAMES)) {
    if (name !== 'else' && !SAMPLE.has(name) && !unknown.includes(`{{${name}}}`)) {
      unknown.push(`{{${name}}}`);
      // shown as written, so the example points at the misspelling
      values[name] = whole.startsWith('{{#') ? '' : whole;
    }
  }
  let filled: string;
  try {
    filled = handlebars.compile(template, { noEscape: true })(values);
  } catch {
    return { parts: [template], unknown: unknown.length > 0 ? unknown : [template] };
  }
  const parts = filled
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length > 0 && !/\.\w+$/.test(parts.at(-1)!)) {
    parts[parts.length - 1] += '.jpg';
  }
  return { parts, unknown };
};
