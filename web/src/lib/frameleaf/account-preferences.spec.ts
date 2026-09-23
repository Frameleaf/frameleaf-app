import { AssetOrder, SuppressionScope } from '@immich/sdk';
import { describe, expect, it } from 'vitest';
import {
  archiveSizeToGib,
  createDraftState,
  draftFromPreferences,
  followLatestPreferences,
  GIB,
  gibToArchiveSize,
  isDraftDirty,
  preferencesPatch,
  REMINDER_ALLOWED_NOW,
  reminderDateFromInput,
  reminderDateInput,
  resetSection,
  SECTION_KEYS,
  validateDraft,
  withEmailNotifications,
} from '$lib/frameleaf/account-preferences';
import { preferencesFactory } from '@test-data/factories/preferences-factory';

const loaded = (overrides: Parameters<typeof preferencesFactory.build>[0] = {}) =>
  preferencesFactory.build({
    people: { enabled: true, sidebarWeb: true, minimumFaces: 3 },
    download: { archiveSize: 1_234_567, includeEmbeddedVideos: false },
    emailNotifications: { enabled: true, albumInvite: true, albumUpdate: true },
    privacy: {
      suppression: {
        personIds: ['c5f9f5a1-3b8d-4f6e-9a2b-0d1e2f3a4b5c'],
        tagIds: [],
        petIds: [],
        scope: SuppressionScope.Owned,
      },
    },
    revision: 'revision-1',
    ...overrides,
  });

describe('account preferences (FL-77)', () => {
  describe('preferencesPatch', () => {
    it('sends only the values that changed and never any other group', () => {
      const baseline = draftFromPreferences(loaded());
      const draft = { ...baseline, 'tags.enabled': true, 'memories.duration': 9 };

      expect(preferencesPatch(baseline, draft, 'admin')).toEqual({
        tags: { enabled: true },
        memories: { duration: 9 },
      });
    });

    it('sends nothing for an unchanged draft, so private Locked choices are never part of a save', () => {
      const baseline = draftFromPreferences(loaded());
      const patch = preferencesPatch(baseline, { ...baseline }, 'admin');

      expect(patch).toEqual({});
      expect(patch).not.toHaveProperty('privacy');
    });

    it('keeps a navigation choice while its feature is off', () => {
      const baseline = draftFromPreferences(loaded());
      const draft = { ...baseline, 'people.enabled': false };

      expect(draft['people.sidebarWeb']).toBe(true);
      expect(preferencesPatch(baseline, draft, 'self')).toEqual({ people: { enabled: false } });
    });

    it("never sends the administrator's casting decision from the account's own settings", () => {
      const baseline = draftFromPreferences(loaded());
      const draft = { ...baseline, 'cast.adminDisabled': true, 'ratings.enabled': true };

      expect(preferencesPatch(baseline, draft, 'self')).toEqual({ ratings: { enabled: true } });
      expect(preferencesPatch(baseline, draft, 'admin')).toEqual({
        cast: { adminDisabled: true },
        ratings: { enabled: true },
      });
    });

    it('does not send the casting choice while casting is turned off', () => {
      const baseline = draftFromPreferences(loaded({ cast: { adminDisabled: true, gCastEnabled: false } }));
      const draft = { ...baseline, 'cast.gCastEnabled': true };

      expect(preferencesPatch(baseline, draft, 'admin')).toEqual({});
    });

    it('sends the casting choice together with allowing casting again', () => {
      const baseline = draftFromPreferences(loaded({ cast: { adminDisabled: true, gCastEnabled: false } }));
      const draft = { ...baseline, 'cast.adminDisabled': false, 'cast.gCastEnabled': true };

      expect(preferencesPatch(baseline, draft, 'admin')).toEqual({
        cast: { adminDisabled: false, gCastEnabled: true },
      });
    });

    it('only covers the keys of the group being edited', () => {
      const baseline = draftFromPreferences(loaded());
      const draft = { ...baseline, 'tags.enabled': true, 'emailNotifications.enabled': false };

      expect(preferencesPatch(baseline, draft, 'self', SECTION_KEYS.notifications)).toEqual({
        emailNotifications: { enabled: false },
      });
    });
  });

  describe('exact-byte archive sizes', () => {
    it('shows any stored byte count in GiB and turns it back into the same bytes', () => {
      for (const bytes of [1, 1_234_567, 4 * GIB, 7 * GIB + 3, Number.MAX_SAFE_INTEGER - 1]) {
        expect(gibToArchiveSize(archiveSizeToGib(bytes))).toBe(bytes);
      }
    });

    it('rounds a typed size to a whole number of bytes', () => {
      expect(gibToArchiveSize(0.5)).toBe(GIB / 2);
      expect(gibToArchiveSize(1e-9)).toBe(1);
      expect(gibToArchiveSize(null)).toBeNull();
      expect(gibToArchiveSize(NaN)).toBeNull();
    });

    it('never re-sends an unchanged arbitrary size', () => {
      const baseline = draftFromPreferences(loaded());
      const draft = { ...baseline, 'download.includeEmbeddedVideos': true };

      expect(preferencesPatch(baseline, draft, 'admin')).toEqual({ download: { includeEmbeddedVideos: true } });
    });
  });

  describe('validateDraft', () => {
    const baseline = draftFromPreferences(loaded());

    it.each([
      ['people.minimumFaces', 0, 'minimum_faces'],
      ['people.minimumFaces', 2.5, 'minimum_faces'],
      ['people.minimumFaces', null, 'minimum_faces'],
      ['memories.duration', 0, 'memory_duration'],
      ['memories.duration', null, 'memory_duration'],
      ['download.archiveSize', 0, 'archive_size'],
      ['download.archiveSize', null, 'archive_size'],
      ['download.archiveSize', -1, 'archive_size'],
    ] as const)('refuses %s = %s', (key, value, error) => {
      expect(validateDraft(baseline, { ...baseline, [key]: value })).toBe(error);
    });

    it('accepts positive whole numbers', () => {
      expect(
        validateDraft(baseline, {
          ...baseline,
          'people.minimumFaces': 1,
          'memories.duration': 3600,
          'download.archiveSize': 1,
        }),
      ).toBeNull();
    });

    it('does not block a save on an older value that is not being changed', () => {
      const legacy = { ...baseline, 'download.archiveSize': 0 };
      expect(validateDraft(legacy, { ...legacy, 'tags.enabled': true })).toBeNull();
    });
  });

  it('turns album invitations and updates off with email notifications', () => {
    const draft = draftFromPreferences(loaded());
    const off = withEmailNotifications(draft, false);

    expect(off).toMatchObject({
      'emailNotifications.enabled': false,
      'emailNotifications.albumInvite': false,
      'emailNotifications.albumUpdate': false,
    });
    expect(withEmailNotifications(off, true)).toMatchObject({
      'emailNotifications.enabled': true,
      'emailNotifications.albumInvite': false,
      'emailNotifications.albumUpdate': false,
    });
  });

  describe('resetSection', () => {
    it("restores one page's defaults and leaves the other pages and the casting decision alone", () => {
      const draft = {
        ...draftFromPreferences(loaded({ cast: { adminDisabled: true, gCastEnabled: false } })),
        'tags.enabled': true,
        'people.minimumFaces': 9,
        'albums.defaultAssetOrder': AssetOrder.Asc,
      };
      const reset = resetSection(draft, 'features');

      expect(reset['tags.enabled']).toBe(false);
      expect(reset['people.minimumFaces']).toBe(3);
      expect(reset['cast.adminDisabled']).toBe(true);
      expect(reset['albums.defaultAssetOrder']).toBe(AssetOrder.Asc);
      expect(reset['download.archiveSize']).toBe(1_234_567);
    });
  });

  describe('support reminder date', () => {
    it('shows "allow it now" as a blank date', () => {
      expect(reminderDateInput(REMINDER_ALLOWED_NOW)).toBe('');
      expect(reminderDateInput('')).toBe('');
      expect(reminderDateInput('2026-10-01T00:00:00.000Z')).toBe('2026-10-01');
    });

    it('stores a picked date at midnight UTC and a blank date as "allow it now"', () => {
      expect(reminderDateFromInput('2026-10-01')).toBe('2026-10-01T00:00:00.000Z');
      expect(reminderDateFromInput('')).toBe(REMINDER_ALLOWED_NOW);
    });
  });

  describe('followLatestPreferences', () => {
    const newer = (overrides: Parameters<typeof preferencesFactory.build>[0]) =>
      loaded({ revision: 'revision-2', ...overrides });

    it('does nothing for the same revision', () => {
      const state = createDraftState(loaded());
      expect(followLatestPreferences(state, loaded())).toBe(state);
    });

    it('takes newer preferences when there are no unsaved changes', () => {
      const next = followLatestPreferences(
        createDraftState(loaded()),
        newer({ tags: { enabled: true, sidebarWeb: false } }),
      );

      expect(next.revision).toBe('revision-2');
      expect(next.draft['tags.enabled']).toBe(true);
      expect(next.stale).toBe(false);
    });

    it('keeps an unsaved administrator draft and marks it stale', () => {
      const state = createDraftState(loaded());
      state.draft = { ...state.draft, 'memories.duration': 9 };
      const next = followLatestPreferences(state, newer({ ratings: { enabled: true } }));

      expect(next.stale).toBe(true);
      expect(next.revision).toBe('revision-1');
      expect(next.draft['memories.duration']).toBe(9);
    });

    it("moves an account's own settings group onto a revision that did not touch its keys", () => {
      const state = createDraftState(loaded());
      state.draft = withEmailNotifications(state.draft, false);
      const next = followLatestPreferences(state, newer({ ratings: { enabled: true } }), {
        keys: SECTION_KEYS.notifications,
        rebaseUnrelated: true,
      });

      expect(next.stale).toBe(false);
      expect(next.revision).toBe('revision-2');
      expect(next.draft['emailNotifications.enabled']).toBe(false);
      expect(next.draft['ratings.enabled']).toBe(true);
      expect(isDraftDirty(next.baseline, next.draft, SECTION_KEYS.notifications)).toBe(true);
    });

    it("marks an account's own group stale when its keys changed elsewhere", () => {
      const state = createDraftState(loaded());
      state.draft = { ...state.draft, 'emailNotifications.albumInvite': false };
      const next = followLatestPreferences(
        state,
        newer({ emailNotifications: { enabled: false, albumInvite: false, albumUpdate: false } }),
        { keys: SECTION_KEYS.notifications, rebaseUnrelated: true },
      );

      expect(next.stale).toBe(true);
      expect(next.draft['emailNotifications.enabled']).toBe(true);
    });
  });
});
