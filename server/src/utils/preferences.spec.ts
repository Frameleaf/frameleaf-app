import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { mapPreferences } from 'src/dtos/user-preferences.dto.js';
import { UserMetadataKey } from 'src/enum.js';
import { UserMetadataItem } from 'src/types.js';
import {
  assertPreferencesRevision,
  changesLockedRules,
  getPreferences,
  getPreferencesPartial,
  getPreferencesRevision,
  mergePreferences,
  restrictPreferencesUpdate,
  withoutStoredLockedRuleIds,
} from 'src/utils/preferences.js';

const stored = (value: Record<string, unknown>) =>
  [{ key: UserMetadataKey.Preferences, value }] as unknown as UserMetadataItem[];

describe('preferences (FL-77 admin casting permission)', () => {
  describe('getPreferences', () => {
    it('defaults to casting allowed by the administrator and off for the user', () => {
      expect(getPreferences([]).cast).toEqual({ gCastEnabled: false, adminDisabled: false });
    });

    it('reads the stored administrator decision alongside the user choice', () => {
      expect(getPreferences(stored({ cast: { gCastEnabled: true, adminDisabled: true } })).cast).toEqual({
        gCastEnabled: true,
        adminDisabled: true,
      });
    });
  });

  describe('mapPreferences', () => {
    it('reports casting off while an administrator has turned it off', () => {
      const preferences = getPreferences(stored({ cast: { gCastEnabled: true, adminDisabled: true } }));
      expect(mapPreferences(preferences).cast).toEqual({ gCastEnabled: false, adminDisabled: true });
    });

    it("reports the user's own choice when the administrator allows casting", () => {
      const preferences = getPreferences(stored({ cast: { gCastEnabled: true } }));
      expect(mapPreferences(preferences).cast).toEqual({ gCastEnabled: true, adminDisabled: false });
    });

    it('does not change unrelated groups', () => {
      const preferences = getPreferences(stored({ memories: { enabled: false } }));
      expect(mapPreferences(preferences).memories).toEqual(preferences.memories);
    });
  });

  describe('restrictPreferencesUpdate as the user', () => {
    it('drops an attempt to set the administrator flag', () => {
      const current = getPreferences([]);
      expect(restrictPreferencesUpdate(current, { cast: { adminDisabled: true } }, 'user').cast).toEqual({});
      expect(restrictPreferencesUpdate(current, { cast: { adminDisabled: false } }, 'user').cast).toEqual({});
    });

    it('lets the user turn casting on while it is allowed', () => {
      const current = getPreferences([]);
      expect(restrictPreferencesUpdate(current, { cast: { gCastEnabled: true } }, 'user').cast).toEqual({
        gCastEnabled: true,
      });
    });

    it('refuses to turn casting on while an administrator has turned it off', () => {
      const current = getPreferences(stored({ cast: { adminDisabled: true } }));
      expect(() => restrictPreferencesUpdate(current, { cast: { gCastEnabled: true } }, 'user')).toThrow(
        ForbiddenException,
      );
    });

    it("keeps the user's stored choice when a save sends casting as off while it is turned off", () => {
      const current = getPreferences(stored({ cast: { gCastEnabled: true, adminDisabled: true } }));
      const merged = mergePreferences(current, { cast: { gCastEnabled: false }, tags: { enabled: true } }, 'user');
      expect(merged.cast).toEqual({ gCastEnabled: true, adminDisabled: true });
      expect(merged.tags.enabled).toBe(true);
    });

    it('passes updates without a cast group through untouched', () => {
      const current = getPreferences(stored({ cast: { adminDisabled: true } }));
      const dto = { memories: { enabled: false } };
      expect(restrictPreferencesUpdate(current, dto, 'user')).toBe(dto);
    });
  });

  describe('restrictPreferencesUpdate as an administrator', () => {
    it("turns casting off without overwriting the user's own choice", () => {
      const current = getPreferences(stored({ cast: { gCastEnabled: true } }));
      const merged = mergePreferences(current, { cast: { gCastEnabled: false, adminDisabled: true } }, 'admin');
      expect(merged.cast).toEqual({ gCastEnabled: true, adminDisabled: true });
      expect(getPreferencesPartial(merged)).toMatchObject({ cast: { gCastEnabled: true, adminDisabled: true } });
      expect(mapPreferences(merged).cast).toEqual({ gCastEnabled: false, adminDisabled: true });
    });

    it("lets the user's own choice apply again when casting is allowed", () => {
      const current = getPreferences(stored({ cast: { gCastEnabled: true, adminDisabled: true } }));
      const merged = mergePreferences(current, { cast: { adminDisabled: false } }, 'admin');
      expect(merged.cast).toEqual({ gCastEnabled: true, adminDisabled: false });
      expect(getPreferencesPartial(merged)).toEqual({ cast: { gCastEnabled: true } });
      expect(mapPreferences(merged).cast).toEqual({ gCastEnabled: true, adminDisabled: false });
    });

    it('still lets an administrator change the casting preference while casting is allowed', () => {
      const current = getPreferences([]);
      const merged = mergePreferences(current, { cast: { gCastEnabled: true } }, 'admin');
      expect(merged.cast).toEqual({ gCastEnabled: true, adminDisabled: false });
    });
  });

  describe('getPreferencesRevision (FL-77 stale-save rejection)', () => {
    it('is the same for equal stored preferences whatever their key order', () => {
      const first = getPreferences(stored({ memories: { enabled: false, duration: 9 }, tags: { enabled: true } }));
      const second = getPreferences(stored({ tags: { enabled: true }, memories: { duration: 9, enabled: false } }));
      expect(getPreferencesRevision(first)).toBe(getPreferencesRevision(second));
    });

    it('treats values equal to the defaults as not stored', () => {
      expect(getPreferencesRevision(getPreferences(stored({ memories: { enabled: true } })))).toBe(
        getPreferencesRevision(getPreferences([])),
      );
    });

    it('changes when any stored value changes, including values a response masks', () => {
      const base = getPreferencesRevision(getPreferences(stored({ cast: { adminDisabled: true } })));
      const userChoice = getPreferencesRevision(
        getPreferences(stored({ cast: { adminDisabled: true, gCastEnabled: true } })),
      );
      const archive = getPreferencesRevision(
        getPreferences(stored({ cast: { adminDisabled: true }, download: { archiveSize: 1_234_567 } })),
      );
      const locked = getPreferencesRevision(
        getPreferences(
          stored({
            cast: { adminDisabled: true },
            privacy: { suppression: { personIds: ['c5f9f5a1-3b8d-4f6e-9a2b-0d1e2f3a4b5c'] } },
          }),
        ),
      );
      expect(new Set([base, userChoice, archive, locked]).size).toBe(4);
    });

    it('is what mapPreferences reports and survives a round trip through storage', () => {
      const merged = mergePreferences(getPreferences([]), { download: { archiveSize: 1_234_567 } }, 'user');
      const reloaded = getPreferences(stored(getPreferencesPartial(merged) as Record<string, unknown>));
      expect(mapPreferences(merged).revision).toBe(getPreferencesRevision(reloaded));
      expect(mapPreferences(reloaded, 'admin').revision).toBe(mapPreferences(reloaded).revision);
    });
  });

  describe('mergePreferences with expectedRevision', () => {
    it('applies an update made against the current revision and never stores the revision', () => {
      const current = getPreferences(stored({ tags: { enabled: true } }));
      const expectedRevision = getPreferencesRevision(current);
      const merged = mergePreferences(current, { expectedRevision, memories: { duration: 7 } }, 'admin');
      expect(merged.memories.duration).toBe(7);
      expect(merged.tags.enabled).toBe(true);
      expect(merged).not.toHaveProperty('expectedRevision');
      expect(getPreferencesPartial(merged)).toEqual({ memories: { duration: 7 }, tags: { enabled: true } });
    });

    it('rejects an update made against an older revision without changing anything', () => {
      const loaded = getPreferences([]);
      const expectedRevision = getPreferencesRevision(loaded);
      const changedElsewhere = getPreferences(stored({ people: { minimumFaces: 8 } }));
      expect(() =>
        mergePreferences(changedElsewhere, { expectedRevision, people: { minimumFaces: 2 } }, 'admin'),
      ).toThrow(ConflictException);
      expect(changedElsewhere.people.minimumFaces).toBe(8);
    });

    it('rejects a stale save from the account itself too', () => {
      const current = getPreferences(stored({ emailNotifications: { enabled: false } }));
      expect(() => assertPreferencesRevision(current, getPreferencesRevision(getPreferences([])))).toThrow(
        ConflictException,
      );
    });

    it('keeps accepting updates that do not send a revision', () => {
      const current = getPreferences(stored({ people: { minimumFaces: 8 } }));
      expect(mergePreferences(current, { people: { minimumFaces: 2 } }, 'user').people.minimumFaces).toBe(2);
    });
  });

  describe('Locked choices and administrators', () => {
    const personId = 'c5f9f5a1-3b8d-4f6e-9a2b-0d1e2f3a4b5c';
    const tagId = '0b8f7e6d-5c4b-4a39-8281-7f6e5d4c3b2a';

    it("never shows an administrator the account's Locked people, pets or tags", () => {
      const preferences = getPreferences(
        stored({ privacy: { suppression: { personIds: [personId], tagIds: [tagId], scope: 'visible' } } }),
      );
      expect(mapPreferences(preferences, 'admin').privacy).toEqual({
        suppression: { tagIds: [], personIds: [], petIds: [], scope: 'visible' },
      });
      expect(mapPreferences(preferences).privacy.suppression.personIds).toEqual([personId]);
    });

    it("drops an administrator's attempt to rewrite Locked choices and keeps the rest", () => {
      const current = getPreferences(stored({ privacy: { suppression: { personIds: [personId] } } }));
      const merged = mergePreferences(
        current,
        { privacy: { suppression: { personIds: [], tagIds: [tagId] } }, ratings: { enabled: true } },
        'admin',
      );
      expect(merged.privacy.suppression.personIds).toEqual([personId]);
      expect(merged.privacy.suppression.tagIds).toEqual([]);
      expect(merged.ratings.enabled).toBe(true);
    });

    it('still lets the account change its own Locked choices', () => {
      const merged = mergePreferences(getPreferences([]), { privacy: { suppression: { tagIds: [tagId] } } }, 'user');
      expect(merged.privacy.suppression.tagIds).toEqual([tagId]);
    });
  });

  describe('Locked rules and sessions that are not unlocked (FL-67)', () => {
    const personId = 'c5f9f5a1-3b8d-4f6e-9a2b-0d1e2f3a4b5c';

    it('shows a session that is not unlocked where the rules apply, but not what they name', () => {
      const preferences = getPreferences(
        stored({ privacy: { suppression: { personIds: [personId], petIds: [personId], scope: 'visible' } } }),
      );
      expect(mapPreferences(preferences, 'locked').privacy).toEqual({
        suppression: { tagIds: [], personIds: [], petIds: [], scope: 'visible' },
      });
      expect(mapPreferences(preferences, 'locked').revision).toBe(mapPreferences(preferences, 'self').revision);
    });

    it('treats any named rule field as a Locked rules change', () => {
      expect(changesLockedRules({ privacy: { suppression: { tagIds: [] } } })).toBe(true);
      expect(changesLockedRules({ privacy: { suppression: { scope: 'owned' } } })).toBe(true);
      expect(changesLockedRules({ privacy: { suppression: { petIds: [personId] } } })).toBe(true);
    });

    it('leaves Locked ids out of a stored preferences value and keeps the rest', () => {
      const value = { tags: { enabled: true }, privacy: { suppression: { personIds: [personId], scope: 'visible' } } };
      expect(withoutStoredLockedRuleIds(value)).toEqual({
        tags: { enabled: true },
        privacy: { suppression: { scope: 'visible' } },
      });
      expect(withoutStoredLockedRuleIds({ tags: { enabled: true } })).toEqual({ tags: { enabled: true } });
      expect(withoutStoredLockedRuleIds(null)).toBeNull();
    });

    it('does not treat an empty or absent privacy group as a Locked rules change', () => {
      expect(changesLockedRules({})).toBe(false);
      expect(changesLockedRules({ privacy: {} })).toBe(false);
      expect(changesLockedRules({ privacy: { suppression: {} } })).toBe(false);
      expect(changesLockedRules({ tags: { enabled: true } })).toBe(false);
    });
  });

  describe('saved searches (FL-49)', () => {
    const lockedPerson = '11111111-1111-4111-8111-111111111111';
    const searches = [
      { name: 'Lisbon', query: { filter: { city: { eq: 'Lisbon' } } } },
      { name: 'With someone', query: { filter: { personIds: { any: [lockedPerson] } } } },
    ];
    const withLockedRules = () =>
      getPreferences(
        stored({ savedSearches: searches, privacy: { suppression: { personIds: [lockedPerson], scope: 'owned' } } }),
      );

    it('defaults to none and stores only a changed list', () => {
      expect(getPreferences([]).savedSearches).toEqual([]);
      expect(getPreferencesPartial(getPreferences([]))).not.toHaveProperty('savedSearches');
      expect(getPreferencesPartial(withLockedRules()).savedSearches).toEqual(searches);
    });

    it('replaces the whole list on update and changes the revision', () => {
      const before = getPreferences([]);
      const revision = getPreferencesRevision(before);
      const updated = mergePreferences(getPreferences([]), { savedSearches: [searches[0]] }, 'user');
      expect(updated.savedSearches).toEqual([searches[0]]);
      expect(getPreferencesRevision(updated)).not.toEqual(revision);
      expect(mergePreferences(updated, { savedSearches: [] }, 'user').savedSearches).toEqual([]);
    });

    it('never lets an administrator read or write them', () => {
      const preferences = withLockedRules();
      expect(mapPreferences(preferences, 'admin').savedSearches).toEqual([]);
      expect(restrictPreferencesUpdate(preferences, { savedSearches: [] }, 'admin')).not.toHaveProperty(
        'savedSearches',
      );
      expect(mergePreferences(preferences, { savedSearches: [] }, 'admin').savedSearches).toEqual(searches);
    });

    it('hides a palette search whose typed chips name a Locked person or tag while the session is locked', () => {
      const lockedTag = '22222222-2222-4222-8222-222222222222';
      // The web palette stores the compiled query with the resolved ids beside the typed text it shows
      const typed = {
        name: 'Jamie at the lake',
        query: {
          version: 1,
          text: 'lake',
          mode: 'smart',
          filter: { personIds: { all: [lockedPerson] } },
          palette: {
            input: 'person:Jamie lake',
            mode: 'smart',
            tokens: [{ raw: 'person:Jamie', ids: [lockedPerson] }],
          },
        },
      };
      const tagged = {
        name: 'Not work',
        query: { version: 1, text: '', mode: 'text', filter: { tagIds: { none: [lockedTag] } } },
      };
      const preferences = getPreferences(
        stored({
          savedSearches: [searches[0], typed, tagged],
          privacy: { suppression: { personIds: [lockedPerson], tagIds: [lockedTag], scope: 'owned' } },
        }),
      );
      expect(mapPreferences(preferences, 'locked').savedSearches).toEqual([searches[0]]);
      expect(mapPreferences(preferences, 'self').savedSearches).toEqual([searches[0], typed, tagged]);
    });

    it('keeps the searches a locked session could not see when it replaces the list', () => {
      const added = { name: 'Snow', query: { filter: { city: { eq: 'Banff' } } } };
      const merged = mergePreferences(withLockedRules(), { savedSearches: [added] }, 'user', { lockedSession: true });
      expect(merged.savedSearches).toEqual([added, searches[1]]);
      const unlocked = mergePreferences(withLockedRules(), { savedSearches: [added] }, 'user');
      expect(unlocked.savedSearches).toEqual([added]);
    });

    it('refuses a locked-session list that clashes with, or with the kept searches exceeds the limits', () => {
      const clash = { name: 'WITH SOMEONE', query: {} };
      expect(() =>
        mergePreferences(withLockedRules(), { savedSearches: [clash] }, 'user', { lockedSession: true }),
      ).toThrow(BadRequestException);
      const full = Array.from({ length: 50 }, (_, index) => ({ name: `search ${index}`, query: {} }));
      expect(() =>
        mergePreferences(withLockedRules(), { savedSearches: full }, 'user', { lockedSession: true }),
      ).toThrow(BadRequestException);
    });

    it('leaves out a search naming a Locked person while the session is locked', () => {
      const preferences = withLockedRules();
      expect(mapPreferences(preferences, 'self').savedSearches).toEqual(searches);
      expect(mapPreferences(preferences, 'locked').savedSearches).toEqual([searches[0]]);
      expect(
        withoutStoredLockedRuleIds({
          savedSearches: searches,
          privacy: { suppression: { personIds: [lockedPerson.toUpperCase()] } },
        }).savedSearches,
      ).toEqual([searches[0]]);
    });
  });
});
