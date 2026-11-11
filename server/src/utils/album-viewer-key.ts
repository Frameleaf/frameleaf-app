import { createHash } from 'node:crypto';
import type { AlbumReadOptions } from 'src/repositories/album.repository.js';

const compare = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => canonical(item)).toSorted((a, b) => compare(JSON.stringify(a), JSON.stringify(b)));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .toSorted(([a], [b]) => compare(a, b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
};

/**
 * Raise when what a summary counts changes, so rows computed under the old rule are never read again (they are
 * recomputed on the next read and swept after 30 days). 2: FL-1410 leaves dates that cannot be right out of the
 * range; without this an upgraded library kept its 1970-to-2031 ranges for up to a day.
 */
const SUMMARY_RULES = 2;

/**
 * FL-1297: which stored album summary this viewer may read. A hash of everything that decides what an
 * album read shows, so two sessions share a row only when they would count exactly the same items.
 * Never derive this from part of the options: a session without its PIN must not match an unlocked one.
 */
export const albumViewerKey = (options: AlbumReadOptions): string =>
  createHash('sha256')
    .update(`${SUMMARY_RULES}:${JSON.stringify(canonical(options))}`)
    .digest('hex');
