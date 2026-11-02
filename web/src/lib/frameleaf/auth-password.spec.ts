import { describe, expect, it } from 'vitest';
import { MIN_PASSWORD_LENGTH, passwordRequirements, passwordStrength } from './auth-password';

describe('password rule (FL-708 item 19)', () => {
  it('has one rule: at least 8 characters', () => {
    expect(MIN_PASSWORD_LENGTH).toBe(8);
    expect(passwordRequirements.map((rule) => rule.id)).toEqual(['length']);
  });

  it('accepts any password of 8 characters or more, whatever it is made of', () => {
    expect(passwordStrength('aaaaaaaa')).toMatchObject({ acceptable: true, checks: { length: true } });
    expect(passwordStrength('correct horse battery')).toMatchObject({ acceptable: true });
    expect(passwordStrength('Ab1!Ab1')).toMatchObject({ acceptable: false, checks: { length: false } });
    expect(passwordStrength('')).toMatchObject({
      score: 0,
      label: 'frameleaf_auth_password_strength_empty',
      acceptable: false,
    });
  });

  it('lets length and variety lift the meter without blocking anything', () => {
    expect(passwordStrength('short').score).toBe(1);
    expect(passwordStrength('aaaaaaaa').score).toBe(2);
    expect(passwordStrength('Abcdefg1').score).toBe(3);
    expect(passwordStrength('aaaaaaaaaaaa').score).toBe(3);
    expect(passwordStrength('Aaaaaaaaaaaaaaaa').score).toBe(4);
    expect(passwordStrength('aaaaaaaaaaaaaaaaaaaa')).toMatchObject({
      score: 4,
      label: 'frameleaf_auth_password_strength_strong',
    });
  });
});
