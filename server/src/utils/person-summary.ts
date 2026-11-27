import { createHash } from 'node:crypto';
import type { HiddenContentQueryOptions } from 'src/utils/hidden-content.js';

/**
 * Raise when what a person's summary counts changes, so rows computed under the old rule are never
 * read again (they are recomputed on the next read and swept after 30 days).
 */
const SUMMARY_RULES = 1;

/** Object keys and array items in one order, whatever order the session built them in. */
const stable = (_key: string, value: unknown) => {
  if (Array.isArray(value)) {
    return value.map((item) => JSON.stringify(item, stable)).toSorted();
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  }
  return value;
};

/**
 * FL-1789: which stored people summaries this viewer may read. A hash of everything that decides
 * which photos count for a person, so two sessions share rows only when they would count exactly the
 * same photos. Never derive this from part of the options: a session without its PIN must not match
 * an unlocked one.
 */
export const personViewerKey = (options: HiddenContentQueryOptions, includeArchived: boolean): string =>
  createHash('sha256')
    .update(`${SUMMARY_RULES}:${includeArchived}:${JSON.stringify(options, stable)}`)
    .digest('hex');
