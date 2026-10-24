/**
 * Storage & originals (FL-365) in plain words: the rules of the pages, kept apart from the drawing so
 * they can be tested on their own.
 */
import type { AnalyticsBucketDto } from '@frameleaf/sdk';

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

/**
 * How fast the photos and videos grow, in bytes a day, from the growth series: the first and the last
 * period that were measured. Null while there is less than a month between them or nothing grew.
 */
export const growthPerDay = (series: Pick<AnalyticsBucketDto, 'through' | 'physicalBytes'>[]): number | null => {
  const measured = series.filter((row) => row.physicalBytes !== null);
  if (measured.length < 2) {
    return null;
  }
  const first = measured[0];
  const last = measured.at(-1)!;
  const days = (new Date(last.through).getTime() - new Date(first.through).getTime()) / DAY_MS;
  const grew = last.physicalBytes! - first.physicalBytes!;
  return days >= 28 && grew > 0 ? grew / days : null;
};

/** How long the free space lasts at that pace, as a unit and a count ("about 4 months"). */
export const roomLeft = (
  freeBytes: number,
  perDay: number | null,
): { unit: 'years' | 'months' | 'weeks' | 'days'; count: number } | null => {
  if (perDay === null || perDay <= 0) {
    return null;
  }
  const days = freeBytes / perDay;
  if (days >= 730) {
    return { unit: 'years', count: Math.floor(days / 365) };
  }
  if (days >= 60) {
    return { unit: 'months', count: Math.floor(days / 30) };
  }
  if (days >= 14) {
    return { unit: 'weeks', count: Math.floor(days / 7) };
  }
  return { unit: 'days', count: Math.max(1, Math.floor(days)) };
};

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

/** The sample photo every example uses. */
const SAMPLE: ReadonlyMap<string, string> = new Map(
  Object.entries({
    y: '2024',
    yy: '24',
    MM: '06',
    MMM: 'Jun',
    MMMM: 'June',
    M: '6',
    dd: '15',
    d: '15',
    HH: '14',
    hh: '02',
    mm: '22',
    ss: '33',
    filename: 'IMG_1234',
    ext: 'jpg',
    filetype: 'IMG',
    filetypefull: 'IMAGE',
    assetId: 'a1b2c3',
    assetIdShort: 'a1b2',
    album: 'Summer in Banff',
    make: 'FUJIFILM',
    model: 'X-T50',
  }),
);

/**
 * Where the sample photo would go under a template, as folder names and a file name, and the
 * placeholders Frameleaf does not know. Conditional blocks are kept simple: their first branch.
 */
export const placeSample = (template: string): { parts: string[]; unknown: string[] } => {
  const unknown: string[] = [];
  const filled = template
    .replaceAll(/\{\{#if (\w+)\}\}(.*?)(?:\{\{else\}\}(.*?))?\{\{\/if\}\}/g, (_, name: string, yes: string, no = '') =>
      SAMPLE.has(name) ? yes : no,
    )
    .replaceAll(/\{\{\s*([\w-]+)\s*\}\}/g, (whole, name: string) => {
      const value = SAMPLE.get(name);
      if (value !== undefined) {
        return value;
      }
      unknown.push(whole);
      return whole;
    });
  const parts = filled
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length > 0 && !/\.\w+$/.test(parts.at(-1)!)) {
    parts[parts.length - 1] += '.jpg';
  }
  return { parts, unknown };
};
