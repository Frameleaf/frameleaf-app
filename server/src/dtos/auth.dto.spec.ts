import { describe, expect, it } from 'vitest';
import { ChangePasswordDto, MIN_PASSWORD_LENGTH, PasswordLinkRedeemDto } from 'src/dtos/auth.dto.js';
import { FrameleafSetupAdminDto } from 'src/dtos/frameleaf-server-setup.dto.js';

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
