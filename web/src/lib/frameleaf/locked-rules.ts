/**
 * Locked rules (FL-67): the tags, people and pets whose photos and videos stay Locked until the
 * session is unlocked, and whether the rules cover only the account's own media or everything it
 * can see. Ported from the design template's `ProtectedContent.jsx` and `locked-rules.mjs`.
 *
 * The server keeps the rules in the account's preferences, accepts a change only from an unlocked
 * session, and refuses one made against a revision that has since changed. This module holds the
 * rules draft logic that does not need the network:
 *
 * - An id that no longer resolves (a deleted tag, a person merged away, a pet that is gone) is
 *   kept in the rules until the owner removes it, so saving an unrelated change never silently
 *   unlocks anything.
 * - A tag inside a Locked tag is Locked through it (the server matches nested tags); the list
 *   shows that ancestry rather than implying the nested tag is unlocked.
 * - A save refused because the preferences changed elsewhere is retried against the latest
 *   revision only when the Locked rules themselves did not change; otherwise the draft stays and
 *   the owner decides.
 */
import {
  SuppressionScope,
  type TagResponseDto,
  type UserPreferencesResponseDto,
  type UserPreferencesUpdateDto,
} from '@immich/sdk';

export type LockedRules = {
  tagIds: string[];
  personIds: string[];
  petIds: string[];
  scope: SuppressionScope;
};

export type LockedRuleField = 'tagIds' | 'personIds' | 'petIds';

export const emptyLockedRules = (): LockedRules => ({
  tagIds: [],
  personIds: [],
  petIds: [],
  scope: SuppressionScope.Owned,
});

export const lockedRulesFrom = (preferences: Pick<UserPreferencesResponseDto, 'privacy'>): LockedRules => {
  const suppression = preferences.privacy?.suppression;
  return {
    tagIds: [...(suppression?.tagIds ?? [])],
    personIds: [...(suppression?.personIds ?? [])],
    petIds: [...(suppression?.petIds ?? [])],
    scope: suppression?.scope ?? SuppressionScope.Owned,
  };
};

const sameIds = (a: string[], b: string[]) => {
  if (a.length !== b.length) {
    return false;
  }
  const set = new Set(a);
  return b.every((id) => set.has(id));
};

/** Whether two sets of rules lock exactly the same things; order does not matter. */
export const sameLockedRules = (a: LockedRules, b: LockedRules) =>
  a.scope === b.scope &&
  sameIds(a.tagIds, b.tagIds) &&
  sameIds(a.personIds, b.personIds) &&
  sameIds(a.petIds, b.petIds);

export const toggleLockedRule = (rules: LockedRules, field: LockedRuleField, id: string): LockedRules => ({
  ...rules,
  [field]: rules[field].includes(id) ? rules[field].filter((value) => value !== id) : [...rules[field], id],
});

/** The update for a save: the whole rules, including ids that no longer resolve, and the revision. */
export const lockedRulesUpdate = (rules: LockedRules, expectedRevision: string): UserPreferencesUpdateDto => ({
  expectedRevision,
  privacy: {
    suppression: {
      tagIds: [...rules.tagIds],
      personIds: [...rules.personIds],
      petIds: [...rules.petIds],
      scope: rules.scope,
    },
  },
});

/**
 * Preferences for the session-wide store with the Locked ids blanked. The ids are only needed by
 * the Locked rules editor while the session is unlocked, so they are never kept in shared state
 * that outlives it.
 */
export const withoutLockedRuleIds = (preferences: UserPreferencesResponseDto): UserPreferencesResponseDto => ({
  ...preferences,
  privacy: {
    suppression: {
      tagIds: [],
      personIds: [],
      petIds: [],
      scope: preferences.privacy?.suppression?.scope ?? SuppressionScope.Owned,
    },
  },
});

export type ConflictDecision =
  /** Only unrelated preferences changed: save the draft again against `revision`. */
  | { action: 'retry'; revision: string }
  /** The Locked rules changed elsewhere: keep the draft and let the owner reload. */
  | { action: 'conflict'; latest: LockedRules; revision: string };

/**
 * After a save was refused as stale: compare the rules the draft was based on with the latest
 * stored rules.
 */
export const decideAfterConflict = (baseline: LockedRules, latest: UserPreferencesResponseDto): ConflictDecision => {
  const rules = lockedRulesFrom(latest);
  return sameLockedRules(baseline, rules)
    ? { action: 'retry', revision: latest.revision }
    : { action: 'conflict', latest: rules, revision: latest.revision };
};

export type TagRuleEntry = {
  id: string;
  /** The full path, for example `Family/Medical`, so the ancestry is visible. */
  label: string;
  available: boolean;
  selected: boolean;
  /** The Locked ancestor this tag is Locked through, when it is not selected itself. */
  lockedThrough?: string;
};

const ancestorsOf = (tag: TagResponseDto, byId: Map<string, TagResponseDto>) => {
  const ancestors: TagResponseDto[] = [];
  const seen = new Set<string>([tag.id]);
  let parentId = tag.parentId;
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) {
      break;
    }
    ancestors.push(parent);
    parentId = parent.parentId;
  }
  return ancestors;
};

/**
 * The tag list for the rules editor: selected tags first (including ones that no longer resolve),
 * then the tags matching `query` by full path, each marked when a Locked ancestor already covers
 * it. At most `limit` unselected matches are listed; the search narrows the rest.
 */
export const tagRuleEntries = (
  tags: TagResponseDto[],
  selectedIds: string[],
  query: string,
  limit = 50,
): TagRuleEntry[] => {
  const byId = new Map(tags.map((tag) => [tag.id, tag]));
  const selected = new Set(selectedIds);
  const needle = query.trim().toLocaleLowerCase();

  const entryFor = (tag: TagResponseDto): TagRuleEntry => {
    const lockedAncestor = selected.has(tag.id)
      ? undefined
      : ancestorsOf(tag, byId).find((ancestor) => selected.has(ancestor.id));
    return {
      id: tag.id,
      label: tag.value,
      available: true,
      selected: selected.has(tag.id),
      lockedThrough: lockedAncestor?.value,
    };
  };

  const selectedEntries: TagRuleEntry[] = selectedIds.map((id) => {
    const tag = byId.get(id);
    return tag ? entryFor(tag) : { id, label: '', available: false, selected: true };
  });

  const matches = tags
    .filter((tag) => !selected.has(tag.id) && (!needle || tag.value.toLocaleLowerCase().includes(needle)))
    .sort((a, b) => a.value.localeCompare(b.value))
    .slice(0, limit)
    .map((tag) => entryFor(tag));

  const availableFirst = (a: TagRuleEntry, b: TagRuleEntry) =>
    Number(!a.available) - Number(!b.available) || a.label.localeCompare(b.label);

  return [...selectedEntries.sort(availableFirst), ...matches];
};

/** Whether `query` names a tag that does not exist yet, so it can be created and Locked. */
export const canCreateTag = (tags: TagResponseDto[], query: string) => {
  const name = query.trim();
  if (!name || name.length > 100) {
    return false;
  }
  const needle = name.toLocaleLowerCase();
  return tags.every((tag) => tag.value.toLocaleLowerCase() !== needle);
};
