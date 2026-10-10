/**
 * Centralized bulk-download archive naming (FL-45).
 *
 * Every route that mounts `LibraryView` or `ResultsView` can hand the selection bar's download
 * action a `downloadFileName`, which seeds `BulkPayload.fileName` (see `bulk-operations.ts`). Before
 * this module every route did its own ad hoc string-building — or nothing, which fell through to
 * the literal `'frameleaf'` default and left every unrelated download indistinguishable from every
 * other one. This module is the one place that turns a destination's descriptive parts (an album
 * name, a search query, an active filter, a memory title, ...) into a name that is:
 *
 * - filesystem-safe: no path separators or reserved characters, no control characters, one run of
 *   hyphens between words;
 * - ASCII-safe: diacritics are folded off and anything left outside printable ASCII is dropped, so a
 *   name a browser or OS might otherwise mangle degrades to the caller's fallback word instead;
 * - bounded in length, so a long title cannot crowd out the date suffix `downloadArchive` appends;
 * - optionally dated (`YYYY-MM-DD`), for a destination whose name alone would not distinguish one
 *   day's download from the next (the archive/search cases below).
 *
 * Callers pass already-localized text (an i18n `frameleaf_archive_name_*` string, an entity's own
 * name, a filter's detail text); this module does no translation itself, only sanitization.
 */

/** Comfortably under filesystem limits, with room for `downloadArchive`'s own `-yyyyLLdd_HHmmss`
 *  (and, for a multi-part archive, a `+N`) suffix. */
const ARCHIVE_NAME_MAX_LENGTH = 70;
/** A single segment (one name, one filter's detail, ...) is capped on its own so one long segment
 *  cannot crowd out every other one before the final join is capped. */
const SEGMENT_MAX_LENGTH = 40;
/** Never "Immich" or "fork" (product invariant) — and never empty. The one hardcoded English word
 *  in this module, used only when every localized input sanitizes away to nothing. */
const ASCII_SAFE_FALLBACK = 'frameleaf';

// Control characters never get this far: NON_ASCII_PRINTABLE has already removed them.
const RESERVED_CHARACTERS = /[<>:"/\\|?*]/g;
const SEPARATOR_RUN = /[\s_]+/g;
const HYPHEN_RUN = /-+/g;
const EDGE_HYPHENS = /^-+|-+$/g;
const COMBINING_MARKS = /[̀-ͯ]/g;
/** Anything outside printable ASCII, space (U+0020) through tilde (U+007E). */
const NON_ASCII_PRINTABLE = /[^ -~]/g;

/**
 * One name, filter detail or other descriptive fragment, made filesystem- and ASCII-safe.
 *
 * Diacritics are folded off first (so "Café" becomes "Cafe", not empty), then anything still
 * outside printable ASCII is dropped — a name in a non-Latin script sanitizes to `''`, which is
 * deliberate: callers are expected to fall back to a translated, Latin-script label rather than
 * silently ship a mangled filename. Returns `''` when nothing usable is left.
 */
export const sanitizeArchiveSegment = (input: string | null | undefined): string => {
  if (!input) {
    return '';
  }
  const withoutDiacritics = input.normalize('NFKD').replaceAll(COMBINING_MARKS, '');
  const asciiOnly = withoutDiacritics.replaceAll(NON_ASCII_PRINTABLE, '');
  const withoutReserved = asciiOnly.replaceAll(RESERVED_CHARACTERS, ' ');
  const hyphenated = withoutReserved
    .replaceAll(SEPARATOR_RUN, '-')
    .replaceAll(HYPHEN_RUN, '-')
    .replaceAll(EDGE_HYPHENS, '');
  return hyphenated.slice(0, SEGMENT_MAX_LENGTH).replaceAll(EDGE_HYPHENS, '');
};

/** The local calendar date as `YYYY-MM-DD`, for a destination whose own name would not otherwise
 *  distinguish today's download from tomorrow's. */
export const formatArchiveDate = (now: Date = new Date()): string => {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

export interface BuildArchiveNameOptions {
  /**
   * Used verbatim (after sanitizing) when every segment sanitizes away to nothing — e.g. every
   * segment was a name in a script this module strips. Pass an already-localized label; the
   * hardcoded ASCII fallback below that only applies if the localized label itself sanitizes away.
   */
  fallback: string;
  /** Prefix the result with the product name. For a destination with no name of its own (Favorites,
   * Archive, Search, ...); a named entity (an album, a person, a tag) reads better bare. */
  brand?: boolean;
  /** Append the local calendar date. */
  withDate?: boolean;
  /** Reference instant for `withDate`; defaults to now. Exposed for tests. */
  now?: Date;
  maxLength?: number;
}

/**
 * Join sanitized, non-empty segments with hyphens, or fall back to `options.fallback` when every
 * segment sanitized away to nothing. Never returns an empty string — the module's own ASCII-safe
 * fallback backstops even a fallback that itself sanitizes to nothing.
 */
export const buildArchiveName = (
  segments: Array<string | null | undefined>,
  options: BuildArchiveNameOptions,
): string => {
  const { fallback, brand = false, withDate = false, now = new Date(), maxLength = ARCHIVE_NAME_MAX_LENGTH } = options;

  const cleanedSegments = segments
    .map((segment) => sanitizeArchiveSegment(segment))
    .filter((segment) => segment.length > 0);
  const body =
    cleanedSegments.length > 0 ? cleanedSegments.join('-') : sanitizeArchiveSegment(fallback) || ASCII_SAFE_FALLBACK;

  const parts = brand ? ['frameleaf', body] : [body];
  if (withDate) {
    parts.push(formatArchiveDate(now));
  }

  const joined = parts.join('-').replaceAll(HYPHEN_RUN, '-').replaceAll(EDGE_HYPHENS, '');
  return joined.slice(0, maxLength).replaceAll(EDGE_HYPHENS, '') || ASCII_SAFE_FALLBACK;
};

/**
 * A named entity's own archive name — an album, a person, a tag, a place, a pet, a shared space, a
 * memory. Bare (no "frameleaf-" prefix): the entity's name is already what makes the download
 * distinct, and legacy per-route filenames (the album/person names this replaces, see FL-45) read
 * the same way. `kind` is a short, already-localized noun ("Album", "Tag", ...) used only when
 * `name` itself sanitizes away to nothing.
 */
export const namedArchiveName = (
  name: string | null | undefined,
  kind: string,
  options: Omit<BuildArchiveNameOptions, 'fallback' | 'brand'> = {},
): string => buildArchiveName([name], { ...options, fallback: kind, brand: false });

/**
 * A generic, unnamed view's archive name — Favorites, Archive, Trash, a search's results. Always
 * branded ("frameleaf-..."): there is no entity name to carry the distinction, so the label itself
 * (an already-localized word like "Favorites") plus any extra descriptive segments (a search query,
 * a filter's detail text) is what makes the download recognizable.
 */
export const brandedArchiveName = (
  label: string,
  segments: Array<string | null | undefined> = [],
  options: Omit<BuildArchiveNameOptions, 'fallback' | 'brand'> = {},
): string => buildArchiveName([label, ...segments], { ...options, fallback: label, brand: true });

/**
 * Layer extra descriptive detail (an active filter's literal text, e.g.) onto a name a route already
 * built with `namedArchiveName`/`brandedArchiveName`. `base` is re-sanitized like any other segment,
 * so this is safe to call with an already-branded name.
 */
export const withArchiveDetail = (base: string, ...details: Array<string | null | undefined>): string =>
  buildArchiveName([base, ...details], { fallback: base });

/**
 * Segments for a resolved list of person/pet/tag names behind an id-list filter (FL-45 owner
 * decision): up to `maxNames` names, followed by a translated "and N more" tail when more remain,
 * so a filter naming several people does not grow the filename without bound. `names` carries one
 * entry per id in the original filter, `null` where that id's name could not or should not be
 * shown (unresolvable, unnamed, hidden — see `filter-entity-names.ts`); those still count toward
 * "more" so the total is honest even though no fabricated name is ever shown for them.
 *
 * Returns `[]` when nothing could be named at all, which tells the caller to fall back to its own
 * generic, translated field label instead (e.g. "People", "Tags") rather than emit an empty or
 * placeholder-only segment.
 */
export const namedEntitySegments = (
  names: Array<string | null | undefined>,
  totalCount: number,
  andMoreLabel: (remaining: number) => string,
  maxNames = 2,
): string[] => {
  const usable = names.filter((name): name is string => !!name && name.trim().length > 0);
  if (usable.length === 0) {
    return [];
  }
  const shown = usable.slice(0, maxNames);
  const remaining = totalCount - shown.length;
  return remaining > 0 ? [...shown, andMoreLabel(remaining)] : shown;
};
