import { describe, expect, it } from 'vitest';
import { passwordStrength } from './auth-password';

describe('prototype password feedback', () => {
  it('shows each rule independently and recommends the prototype minimum without enforcing it', () => {
    expect(passwordStrength('')).toMatchObject({
      score: 0,
      label: 'frameleaf_auth_password_strength_empty',
      recommended: false,
    });
    expect(passwordStrength('Abcdefg8')).toMatchObject({
      recommended: true,
      checks: { length: true, lower: true, upper: true, number: true, symbol: false },
    });
    expect(passwordStrength('abcdefgh')).toMatchObject({
      recommended: false,
      checks: { upper: false, number: false },
    });
    expect(passwordStrength('Ab1!')).toMatchObject({ recommended: false, checks: { length: false } });
  });
});
