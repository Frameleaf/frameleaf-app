import { SuppressionScope, type TagResponseDto, type UserPreferencesResponseDto } from '@immich/sdk';
import { describe, expect, it } from 'vitest';
import {
  canCreateTag,
  decideAfterConflict,
  emptyLockedRules,
  lockedRulesFrom,
  lockedRulesUpdate,
  sameLockedRules,
  tagRuleEntries,
  toggleLockedRule,
  withoutLockedRuleIds,
  type LockedRules,
} from '$lib/frameleaf/locked-rules';

const tag = (id: string, value: string, parentId?: string): TagResponseDto => ({
  id,
  value,
  name: value.split('/').at(-1) ?? value,
  parentId,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

const family = tag('family', 'Family');
const medical = tag('medical', 'Family/Medical', 'family');
const xrays = tag('xrays', 'Family/Medical/X-rays', 'medical');
const receipts = tag('receipts', 'Receipts');
const tags = [receipts, xrays, family, medical];

const preferences = (rules: Partial<LockedRules>, revision = 'rev-1') =>
  ({
    privacy: { suppression: { ...emptyLockedRules(), ...rules } },
    revision,
    tags: { enabled: true, sidebarWeb: false },
  }) as unknown as UserPreferencesResponseDto;

describe('Locked rules (FL-67)', () => {
  it('reads the rules from preferences without sharing their arrays', () => {
    const source = preferences({ tagIds: ['family'], personIds: ['p1'], scope: SuppressionScope.Visible });
    const rules = lockedRulesFrom(source);

    expect(rules).toEqual({ tagIds: ['family'], personIds: ['p1'], petIds: [], scope: SuppressionScope.Visible });
    rules.tagIds.push('other');
    expect(source.privacy.suppression.tagIds).toEqual(['family']);
  });

  it('compares rules as sets and includes the scope', () => {
    const a = { ...emptyLockedRules(), tagIds: ['a', 'b'] };
    expect(sameLockedRules(a, { ...a, tagIds: ['b', 'a'] })).toBe(true);
    expect(sameLockedRules(a, { ...a, tagIds: ['a'] })).toBe(false);
    expect(sameLockedRules(a, { ...a, scope: SuppressionScope.Visible })).toBe(false);
  });

  it('toggles one id without touching the others', () => {
    const rules = { ...emptyLockedRules(), personIds: ['p1', 'p2'] };
    expect(toggleLockedRule(rules, 'personIds', 'p1').personIds).toEqual(['p2']);
    expect(toggleLockedRule(rules, 'petIds', 'pet').petIds).toEqual(['pet']);
    expect(rules.personIds).toEqual(['p1', 'p2']);
  });

  it('saves every id, including ones that no longer resolve, with the loaded revision', () => {
    const rules = { ...emptyLockedRules(), tagIds: ['gone-tag', 'family'], personIds: ['merged-away'] };
    expect(lockedRulesUpdate(rules, 'rev-7')).toEqual({
      expectedRevision: 'rev-7',
      privacy: {
        suppression: { tagIds: ['gone-tag', 'family'], personIds: ['merged-away'], petIds: [], scope: 'owned' },
      },
    });
  });

  it('keeps Locked ids out of the session-wide preferences', () => {
    const blanked = withoutLockedRuleIds(preferences({ tagIds: ['family'], scope: SuppressionScope.Visible }));
    expect(blanked.privacy.suppression).toEqual({ tagIds: [], personIds: [], petIds: [], scope: 'visible' });
    expect(blanked.revision).toBe('rev-1');
  });

  describe('after a save is refused as stale', () => {
    const baseline = { ...emptyLockedRules(), tagIds: ['family'] };

    it('retries against the latest revision when only unrelated preferences changed', () => {
      expect(decideAfterConflict(baseline, preferences({ tagIds: ['family'] }, 'rev-2'))).toEqual({
        action: 'retry',
        revision: 'rev-2',
      });
    });

    it('keeps the draft for the owner when the Locked rules changed in another tab', () => {
      expect(decideAfterConflict(baseline, preferences({ tagIds: ['family', 'receipts'] }, 'rev-3'))).toEqual({
        action: 'conflict',
        latest: { ...baseline, tagIds: ['family', 'receipts'] },
        revision: 'rev-3',
      });
    });
  });

  describe('tag list', () => {
    it('lists selected tags first, then matches by full path in order', () => {
      const entries = tagRuleEntries(tags, ['receipts'], '');
      expect(entries.map(({ id }) => id)).toEqual(['receipts', 'family', 'medical', 'xrays']);
      expect(entries[0]).toMatchObject({ selected: true, available: true, label: 'Receipts' });
    });

    it('shows that a tag inside a Locked tag is Locked through it', () => {
      const entries = tagRuleEntries(tags, ['family'], 'medical');
      expect(entries.find(({ id }) => id === 'medical')).toMatchObject({ selected: false, lockedThrough: 'Family' });
      expect(entries.find(({ id }) => id === 'xrays')).toMatchObject({ lockedThrough: 'Family' });
    });

    it('keeps a selected tag that no longer exists, marked unavailable, after the available ones', () => {
      const entries = tagRuleEntries(tags, ['deleted-tag', 'family'], 'zzz');
      expect(entries).toEqual([
        { id: 'family', label: 'Family', available: true, selected: true, lockedThrough: undefined },
        { id: 'deleted-tag', label: '', available: false, selected: true },
      ]);
    });

    it('limits unselected matches but never selected tags', () => {
      const many = Array.from({ length: 80 }, (_, index) => tag(`t${index}`, `Tag ${String(index).padStart(2, '0')}`));
      const entries = tagRuleEntries(many, ['t79'], '', 10);
      expect(entries).toHaveLength(11);
      expect(entries[0].id).toBe('t79');
    });

    it('offers to create a tag only when no tag has that full path', () => {
      expect(canCreateTag(tags, 'Pets')).toBe(true);
      expect(canCreateTag(tags, 'family/medical')).toBe(false);
      expect(canCreateTag(tags, ' '.repeat(3))).toBe(false);
      expect(canCreateTag(tags, 'x'.repeat(101))).toBe(false);
    });
  });
});
