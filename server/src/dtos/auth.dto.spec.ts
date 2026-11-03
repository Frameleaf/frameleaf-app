import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ChangePasswordDto, MIN_PASSWORD_LENGTH, PasswordLinkRedeemDto } from 'src/dtos/auth.dto.js';
import { FrameleafSetupAdminDto } from 'src/dtos/frameleaf-server-setup.dto.js';

/*
 * `packages/patches/zod@4.6.7.patch` keeps the minute-only datetime forms (`2026-01-01T10:00Z`) that
 * every `z.iso.datetime()` field of the published API accepted before Zod 4.6. The patch is applied
 * by pnpm; a Zod bump that drops it would change API validation silently, so its behaviour is pinned
 * here (the DTOs in this file are the login and password bodies, the first validation a client meets).
 */
describe('the patched zod datetime (packages/patches/zod@4.6.7.patch)', () => {
  it('accepts minute-only times with Z and with an offset, as the published API always has', () => {
    for (const value of ['2026-01-01T10:00Z', '2026-01-01T10:00:00Z', '2026-01-01T10:00:00.123Z']) {
      expect(z.iso.datetime().safeParse(value).success, value).toBe(true);
      expect(z.iso.datetime({ offset: true }).safeParse(value).success, value).toBe(true);
    }
    for (const value of ['2026-01-01T10:00+02:00', '2026-01-01T10:00:00-05:00']) {
      expect(z.iso.datetime({ offset: true }).safeParse(value).success, value).toBe(true);
    }
    expect(z.iso.datetime({ local: true }).safeParse('2026-01-01T10:00').success).toBe(true);
  });

  it('still refuses what was never accepted', () => {
    for (const value of ['2026-01-01T10Z', '2026-01-01 10:00Z', '2026-01-01T10:00', '2026-13-01T10:00Z', '']) {
      expect(z.iso.datetime().safeParse(value).success, value).toBe(false);
    }
  });
});

// FL-708 (UI review item 19, owner 2026-10-31): one password rule wherever a person chooses a password: length 8.
describe('the password rule', () => {
  const seven = 'sevench';
  const eight = 'aaaaaaaa';

  it('is eight characters, the same as Frameleaf Cloud', () => {
    expect(MIN_PASSWORD_LENGTH).toBe(8);
  });

  it('applies to the first administrator made from the apps', () => {
    const admin = { email: 'admin@example.com', name: 'Admin' };
    expect(FrameleafSetupAdminDto.schema.safeParse({ ...admin, password: seven }).success).toBe(false);
    expect(FrameleafSetupAdminDto.schema.safeParse({ ...admin, password: eight }).success).toBe(true);
  });

  it('applies to a changed password and to one chosen from an emailed link', () => {
    expect(ChangePasswordDto.schema.safeParse({ password: 'old', newPassword: seven }).success).toBe(false);
    expect(ChangePasswordDto.schema.safeParse({ password: 'old', newPassword: eight }).success).toBe(true);
    expect(PasswordLinkRedeemDto.schema.safeParse({ token: 'token', newPassword: seven }).success).toBe(false);
    expect(PasswordLinkRedeemDto.schema.safeParse({ token: 'token', newPassword: eight }).success).toBe(true);
  });

  it('has no character-class rules', () => {
    for (const password of ['correct horse battery', '12345678', 'ALLCAPSPASSWORD']) {
      expect(ChangePasswordDto.schema.safeParse({ password: 'old', newPassword: password }).success).toBe(true);
    }
  });
});
