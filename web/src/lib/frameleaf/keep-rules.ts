/**
 * Rules for which duplicate copy is suggested as the keeper (FL-832, after the approved prototype's
 * `quick-wins-jan-mar.mjs`). The server applies the saved order (`duplicates.keepRules`); this file
 * names the rules, puts a saved list in the order the page shows, and works the page's example.
 */
import { DuplicateKeepRule } from '@frameleaf/sdk';

/** What the server uses when nothing is saved (`DEFAULT_DUPLICATE_KEEP_RULES`), then the other rules. */
export const DEFAULT_KEEP_ORDER: readonly DuplicateKeepRule[] = [
  DuplicateKeepRule.Raw,
  DuplicateKeepRule.Heic,
  DuplicateKeepRule.Largest,
  DuplicateKeepRule.MostMetadata,
  DuplicateKeepRule.HighestResolution,
  DuplicateKeepRule.Oldest,
  DuplicateKeepRule.Newest,
  DuplicateKeepRule.InAlbum,
  DuplicateKeepRule.HasEdits,
  DuplicateKeepRule.Favorite,
];

/** Message key stems: `frameleaf_keep_rule_<stem>` and `…_<stem>_help`. */
export const KEEP_RULE_WORDS: Record<DuplicateKeepRule, string> = {
  [DuplicateKeepRule.Raw]: 'raw',
  [DuplicateKeepRule.Heic]: 'heic',
  [DuplicateKeepRule.Largest]: 'largest',
  [DuplicateKeepRule.HighestResolution]: 'resolution',
  [DuplicateKeepRule.Oldest]: 'oldest',
  [DuplicateKeepRule.Newest]: 'newest',
  [DuplicateKeepRule.InAlbum]: 'album',
  [DuplicateKeepRule.HasEdits]: 'edited',
  [DuplicateKeepRule.Favorite]: 'favorite',
  [DuplicateKeepRule.MostMetadata]: 'details',
};

/** Every rule once: the saved ones first, in their order, then the rest in the default order. */
export const keepOrder = (saved: readonly string[] = []): DuplicateKeepRule[] => {
  const known = saved.filter((rule): rule is DuplicateKeepRule => Object.hasOwn(KEEP_RULE_WORDS, rule));
  return [...new Set([...known, ...DEFAULT_KEEP_ORDER])];
};

export const isDefaultKeepOrder = (order: readonly string[]) => order.join(',') === DEFAULT_KEEP_ORDER.join(',');

/** Moves one rule up (-1) or down (+1). */
export const moveKeepRule = (order: readonly DuplicateKeepRule[], rule: DuplicateKeepRule, step: -1 | 1) => {
  const from = order.indexOf(rule);
  const to = from + step;
  if (from === -1 || to < 0 || to >= order.length) {
    return [...order];
  }
  const next = [...order];
  next[from] = order[to];
  next[to] = rule;
  return next;
};

/** Puts `rule` where `target` is, as a drag over `target` does. */
export const dropKeepRule = (
  order: readonly DuplicateKeepRule[],
  rule: DuplicateKeepRule,
  target: DuplicateKeepRule,
) => {
  const to = order.indexOf(target);
  if (rule === target || to === -1 || !order.includes(rule)) {
    return [...order];
  }
  const next = order.filter((other) => other !== rule);
  next.splice(to, 0, rule);
  return next;
};

export type KeepCopy = {
  name: string;
  format: 'JPEG' | 'HEIC' | 'RAW';
  bytes: number;
  width: number;
  height: number;
  takenAt: string;
  inAlbum: boolean;
  edited: boolean;
  favorite: boolean;
  details: number;
};

/** The page's example: two copies of one photo that most rules tell apart. */
export const KEEP_EXAMPLE: readonly KeepCopy[] = [
  {
    name: 'IMG_2048.JPG',
    format: 'JPEG',
    bytes: 4_200_000,
    width: 4032,
    height: 3024,
    takenAt: '2026-08-14T08:12:00Z',
    inAlbum: true,
    edited: false,
    favorite: true,
    details: 6,
  },
  {
    name: 'IMG_2048.CR3',
    format: 'RAW',
    bytes: 24_800_000,
    width: 6000,
    height: 4000,
    takenAt: '2026-08-14T08:12:00Z',
    inAlbum: false,
    edited: true,
    favorite: false,
    details: 9,
  },
];

const SCORE: Record<DuplicateKeepRule, (copy: KeepCopy) => number> = {
  [DuplicateKeepRule.Raw]: (copy) => Number(copy.format === 'RAW'),
  [DuplicateKeepRule.Heic]: (copy) => Number(copy.format === 'HEIC'),
  [DuplicateKeepRule.Largest]: (copy) => copy.bytes,
  [DuplicateKeepRule.HighestResolution]: (copy) => copy.width * copy.height,
  [DuplicateKeepRule.Oldest]: (copy) => -Date.parse(copy.takenAt),
  [DuplicateKeepRule.Newest]: (copy) => Date.parse(copy.takenAt),
  [DuplicateKeepRule.InAlbum]: (copy) => Number(copy.inAlbum),
  [DuplicateKeepRule.HasEdits]: (copy) => Number(copy.edited),
  [DuplicateKeepRule.Favorite]: (copy) => Number(copy.favorite),
  [DuplicateKeepRule.MostMetadata]: (copy) => copy.details,
};

/**
 * Which copy the order suggests keeping: its index and the first rule that told the copies apart,
 * or no rule when they tie on every one (the first copy is suggested).
 */
export const suggestKeep = (
  copies: readonly KeepCopy[],
  order: readonly DuplicateKeepRule[],
): { keep: number; rule?: DuplicateKeepRule } => {
  for (const rule of order) {
    const values = copies.map((copy) => SCORE[rule](copy));
    const best = Math.max(...values);
    if (values.filter((value) => value === best).length === 1) {
      return { keep: values.indexOf(best), rule };
    }
  }
  return { keep: 0 };
};
