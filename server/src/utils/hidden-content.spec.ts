import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import {
  type HiddenContentFilter,
  emptyHiddenContentFilter,
  emptySuppressionPreferences,
  getHiddenContentQueryOptions,
  getPrivacyQueryOptions,
  getSuppressedOnlyQueryOptions,
  hasHiddenContentFilter,
  hasSuppressionPreferences,
  isSuppressedWhileLocked,
  requireSuppressedOnlyAccess,
} from 'src/utils/hidden-content.js';

describe('hidden content utils', () => {
  const user = { id: 'user-1' } as AuthDto['user'];
  const hiddenContent: HiddenContentFilter = {
    userId: user.id,
    includeNsfw: true,
    tagIds: ['tag-1'],
    personIds: ['person-1'],
    petIds: ['pet-1'],
    scope: 'visible',
  };

  describe('emptySuppressionPreferences', () => {
    it('defaults to owned scope with no tag, person or pet suppression', () => {
      expect(emptySuppressionPreferences()).toEqual({
        tagIds: [],
        personIds: [],
        petIds: [],
        scope: 'owned',
      });
    });
  });

  describe('emptyHiddenContentFilter', () => {
    it('adds the user id and excludes all hidden-content matchers by default', () => {
      expect(emptyHiddenContentFilter(user.id)).toEqual({
        userId: user.id,
        includeNsfw: false,
        tagIds: [],
        personIds: [],
        petIds: [],
        scope: 'owned',
      });
    });
  });

  describe('hasHiddenContentFilter', () => {
    it('returns true when NSFW, tag, person, or pet filters are configured', () => {
      expect(hasHiddenContentFilter({ ...emptyHiddenContentFilter(user.id), includeNsfw: true })).toBe(true);
      expect(hasHiddenContentFilter({ ...emptyHiddenContentFilter(user.id), tagIds: ['tag-1'] })).toBe(true);
      expect(hasHiddenContentFilter({ ...emptyHiddenContentFilter(user.id), personIds: ['person-1'] })).toBe(true);
      expect(hasHiddenContentFilter({ ...emptyHiddenContentFilter(user.id), petIds: ['pet-1'] })).toBe(true);
    });

    it('returns false for missing or empty filters', () => {
      expect(hasHiddenContentFilter()).toBe(false);
      expect(hasHiddenContentFilter(emptyHiddenContentFilter(user.id))).toBe(false);
    });
  });

  describe('hasSuppressionPreferences', () => {
    it('ignores NSFW and only reflects tag, person or pet preferences', () => {
      expect(hasSuppressionPreferences()).toBe(false);
      expect(hasSuppressionPreferences(emptySuppressionPreferences())).toBe(false);
      expect(hasSuppressionPreferences({ ...emptySuppressionPreferences(), tagIds: ['tag-1'] })).toBe(true);
      expect(hasSuppressionPreferences({ ...emptySuppressionPreferences(), personIds: ['person-1'] })).toBe(true);
      expect(hasSuppressionPreferences({ ...emptySuppressionPreferences(), petIds: ['pet-1'] })).toBe(true);
    });
  });

  describe('getHiddenContentQueryOptions', () => {
    it('prefers the generalized hidden content filter over the legacy NSFW flag', () => {
      expect(getHiddenContentQueryOptions({ user, hideNsfwAssets: true, hiddenContent } as AuthDto)).toEqual({
        hiddenContent,
      });
    });

    it('falls back to excluding NSFW assets when no generalized filter is available', () => {
      expect(getHiddenContentQueryOptions({ user, hideNsfwAssets: true } as AuthDto)).toEqual({
        excludeNsfw: true,
      });
    });

    it('returns no query options when hidden browsing is disabled', () => {
      expect(getHiddenContentQueryOptions({ user } as AuthDto)).toEqual({});
    });
  });

  describe('getSuppressedOnlyQueryOptions', () => {
    it('returns the precomputed suppressed content filter for elevated private-only views', () => {
      expect(getSuppressedOnlyQueryOptions({ user, suppressedContent: hiddenContent } as AuthDto)).toEqual({
        onlyHiddenContent: hiddenContent,
      });
    });

    it('returns an empty hidden filter when the user has no suppressed content preferences', () => {
      expect(getSuppressedOnlyQueryOptions({ user } as AuthDto)).toEqual({
        onlyHiddenContent: emptyHiddenContentFilter(user.id),
      });
    });
  });

  describe('requireSuppressedOnlyAccess', () => {
    it('allows normal browsing without additional checks', () => {
      expect(() => requireSuppressedOnlyAccess({ user, sharedLink: {} } as AuthDto, false)).not.toThrow();
      expect(() => requireSuppressedOnlyAccess({ user } as AuthDto)).not.toThrow();
    });

    it('rejects suppressed-only browsing for shared links', () => {
      expect(() => requireSuppressedOnlyAccess({ user, sharedLink: {} } as AuthDto, true)).toThrow(BadRequestException);
    });

    it('rejects suppressed-only browsing when the session is not elevated', () => {
      expect(() =>
        requireSuppressedOnlyAccess(
          {
            user,
            session: { hasElevatedPermission: false },
          } as AuthDto,
          true,
        ),
      ).toThrow(BadRequestException);
    });

    it('allows suppressed-only browsing for elevated sessions', () => {
      expect(() =>
        requireSuppressedOnlyAccess(
          {
            user,
            session: { hasElevatedPermission: true },
          } as AuthDto,
          true,
        ),
      ).not.toThrow();
    });
  });

  describe('getPrivacyQueryOptions', () => {
    it('uses hidden browsing options for default requests', () => {
      expect(getPrivacyQueryOptions({ user, hiddenContent } as AuthDto)).toEqual({ hiddenContent });
    });

    it('requires elevated access and uses only-hidden options for suppressed-only requests', () => {
      expect(
        getPrivacyQueryOptions(
          {
            user,
            session: { hasElevatedPermission: true },
            suppressedContent: hiddenContent,
          } as AuthDto,
          true,
        ),
      ).toEqual({ onlyHiddenContent: hiddenContent });
    });
  });

  describe('isSuppressedWhileLocked', () => {
    const locked = { user, hiddenContent, suppressedContent: hiddenContent } as AuthDto;
    const unlocked = { user, suppressedContent: hiddenContent } as AuthDto;

    it('matches each suppressed id against its own kind only', () => {
      expect(isSuppressedWhileLocked(locked, 'person', 'person-1')).toBe(true);
      expect(isSuppressedWhileLocked(locked, 'pet', 'pet-1')).toBe(true);
      expect(isSuppressedWhileLocked(locked, 'tag', 'tag-1')).toBe(true);
      expect(isSuppressedWhileLocked(locked, 'pet', 'person-1')).toBe(false);
      expect(isSuppressedWhileLocked(locked, 'person', 'person-2')).toBe(false);
    });

    it('never matches once the session is unlocked', () => {
      expect(isSuppressedWhileLocked(unlocked, 'person', 'person-1')).toBe(false);
      expect(isSuppressedWhileLocked(unlocked, 'pet', 'pet-1')).toBe(false);
      expect(isSuppressedWhileLocked(unlocked, 'tag', 'tag-1')).toBe(false);
    });
  });
});
