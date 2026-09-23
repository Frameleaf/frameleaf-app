import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { mapPreferences } from 'src/dtos/user-preferences.dto.js';
import { UserMetadataKey } from 'src/enum.js';
import { UserMetadataItem } from 'src/types.js';
import {
  getPreferences,
  getPreferencesPartial,
  mergePreferences,
  restrictPreferencesUpdate,
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
});
