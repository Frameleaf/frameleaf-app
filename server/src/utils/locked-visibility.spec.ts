import { describe, expect, it } from 'vitest';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { getLockedOwnerId, getLockedVisibilityOptions } from 'src/utils/locked-visibility.js';

describe('locked visibility utils', () => {
  const user = { id: 'user-1' } as AuthDto['user'];
  const elevated = { id: 'session-1', hasElevatedPermission: true } as NonNullable<AuthDto['session']>;
  const ordinary = { id: 'session-2', hasElevatedPermission: false } as NonNullable<AuthDto['session']>;

  describe('getLockedOwnerId', () => {
    it('names the viewer when their session is elevated', () => {
      expect(getLockedOwnerId({ user, session: elevated } as AuthDto)).toBe(user.id);
    });

    it('names nobody for an ordinary session', () => {
      expect(getLockedOwnerId({ user, session: ordinary } as AuthDto)).toBeUndefined();
    });

    it('names nobody without a session', () => {
      expect(getLockedOwnerId({ user } as AuthDto)).toBeUndefined();
    });

    it('names nobody for a shared link, even one carrying an elevated session', () => {
      const sharedLink = { id: 'link-1' } as NonNullable<AuthDto['sharedLink']>;
      expect(getLockedOwnerId({ user, session: elevated, sharedLink } as AuthDto)).toBeUndefined();
    });
  });

  describe('getLockedVisibilityOptions', () => {
    it('spreads to nothing when no Locked media may show', () => {
      expect(getLockedVisibilityOptions({ user, session: ordinary } as AuthDto)).toEqual({});
    });

    it('carries the viewer as the Locked owner when elevated', () => {
      expect(getLockedVisibilityOptions({ user, session: elevated } as AuthDto)).toEqual({ lockedOwnerId: user.id });
    });
  });
});
