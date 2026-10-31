import { ChangePasswordDto, MIN_PASSWORD_LENGTH, PasswordLinkRedeemDto, SignUpDto } from 'src/dtos/auth.dto';
import { FrameleafSetupAdminDto } from 'src/dtos/frameleaf-server-setup.dto';
import { UserUpdateMeSchema } from 'src/dtos/user.dto';
import { describe, expect, it } from 'vitest';

// FL-708 (UI review item 19): one password rule wherever a person chooses a password: length.
describe('the password rule', () => {
  const eleven = 'elevenchars';
  const twelve = 'aaaaaaaaaaaa';

  it('is twelve characters', () => {
    expect(MIN_PASSWORD_LENGTH).toBe(12);
  });

  it('applies to the first administrator, from the web and from the apps', () => {
    const admin = { email: 'admin@example.com', name: 'Admin' };
    expect(SignUpDto.schema.safeParse({ ...admin, password: eleven }).success).toBe(false);
    expect(SignUpDto.schema.safeParse({ ...admin, password: twelve }).success).toBe(true);
    expect(FrameleafSetupAdminDto.schema.safeParse({ ...admin, password: eleven }).success).toBe(false);
    expect(FrameleafSetupAdminDto.schema.safeParse({ ...admin, password: twelve }).success).toBe(true);
  });

  it('applies to a changed password and to one chosen from an emailed link', () => {
    expect(ChangePasswordDto.schema.safeParse({ password: 'old', newPassword: eleven }).success).toBe(false);
    expect(ChangePasswordDto.schema.safeParse({ password: 'old', newPassword: twelve }).success).toBe(true);
    expect(PasswordLinkRedeemDto.schema.safeParse({ token: 'token', newPassword: eleven }).success).toBe(false);
    expect(PasswordLinkRedeemDto.schema.safeParse({ token: 'token', newPassword: twelve }).success).toBe(true);
    expect(UserUpdateMeSchema.safeParse({ password: eleven }).success).toBe(false);
    expect(UserUpdateMeSchema.safeParse({ password: twelve }).success).toBe(true);
    expect(UserUpdateMeSchema.safeParse({ name: 'No password change' }).success).toBe(true);
  });

  it('has no character-class rules', () => {
    for (const password of ['correct horse battery', '123456789012', 'ALLCAPSPASSWORD']) {
      expect(ChangePasswordDto.schema.safeParse({ password: 'old', newPassword: password }).success).toBe(true);
    }
  });
});
