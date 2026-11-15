/**
 * FL-832: the rules a person can order to say which copy in a duplicate group is suggested as the one
 * to keep. Each rule prefers one copy over another or calls them even; an even pair goes to the next
 * rule.
 */
export const DUPLICATE_KEEP_RULES = [
  'raw',
  'heic',
  'largest',
  'highestResolution',
  'oldest',
  'newest',
  'inAlbum',
  'hasEdits',
  'favorite',
  'mostMetadata',
] as const;

export type DuplicateKeepRule = (typeof DUPLICATE_KEEP_RULES)[number];
