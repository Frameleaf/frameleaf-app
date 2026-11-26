import { DuplicateKeepRule as Rule } from '@frameleaf/sdk';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_KEEP_ORDER,
  dropKeepRule,
  isDefaultKeepOrder,
  KEEP_EXAMPLE,
  keepOrder,
  moveKeepRule,
  suggestKeep,
} from './keep-rules';

describe('keep rules (FL-832)', () => {
  it('shows the default order when nothing is saved', () => {
    expect(keepOrder([])).toEqual(DEFAULT_KEEP_ORDER);
    expect(isDefaultKeepOrder(keepOrder())).toBe(true);
  });

  it('puts saved rules first, once each, and drops ones it has never heard of', () => {
    const order = keepOrder(['favorite', 'someday', 'raw', 'favorite']);
    expect(order.slice(0, 3)).toEqual([Rule.Favorite, Rule.Raw, Rule.Heic]);
    expect(order).toHaveLength(DEFAULT_KEEP_ORDER.length);
  });

  it('moves a rule one step and stops at the ends', () => {
    expect(moveKeepRule(DEFAULT_KEEP_ORDER, Rule.Heic, -1).slice(0, 2)).toEqual([Rule.Heic, Rule.Raw]);
    expect(moveKeepRule(DEFAULT_KEEP_ORDER, Rule.Raw, -1)).toEqual(DEFAULT_KEEP_ORDER);
    expect(moveKeepRule(DEFAULT_KEEP_ORDER, Rule.Favorite, 1)).toEqual(DEFAULT_KEEP_ORDER);
  });

  it('drops a dragged rule where the one under it is', () => {
    expect(dropKeepRule(DEFAULT_KEEP_ORDER, Rule.Favorite, Rule.Raw)[0]).toBe(Rule.Favorite);
    expect(dropKeepRule(DEFAULT_KEEP_ORDER, Rule.Raw, Rule.Largest).slice(0, 3)).toEqual([
      Rule.Heic,
      Rule.Largest,
      Rule.Raw,
    ]);
  });

  it('suggests the copy the first telling rule prefers', () => {
    expect(suggestKeep(KEEP_EXAMPLE, DEFAULT_KEEP_ORDER)).toEqual({ keep: 1, rule: Rule.Raw });
    expect(suggestKeep(KEEP_EXAMPLE, keepOrder(['favorite']))).toEqual({ keep: 0, rule: Rule.Favorite });
    // Same day, so neither Oldest nor Newest decides; HEIC is neither copy.
    expect(suggestKeep(KEEP_EXAMPLE, [Rule.Oldest, Rule.Heic, Rule.InAlbum])).toEqual({ keep: 0, rule: Rule.InAlbum });
    expect(suggestKeep(KEEP_EXAMPLE, [Rule.Oldest])).toEqual({ keep: 0 });
  });
});
