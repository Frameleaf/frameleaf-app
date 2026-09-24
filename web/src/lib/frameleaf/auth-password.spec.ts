import { describe, expect, it } from 'vitest';
import { passwordStrength } from './auth-password';

describe('prototype password feedback', () => {
  it('shows each rule independently and accepts the prototype minimum', () => {
    expect(passwordStrength('')).toMatchObject({ score: 0, label: 'Enter a password', acceptable: false });
    expect(passwordStrength('Abcdefg8')).toMatchObject({
      acceptable: true,
      checks: { length: true, lower: true, upper: true, number: true, symbol: false },
    });
    expect(passwordStrength('abcdefgh')).toMatchObject({ acceptable: false, checks: { upper: false, number: false } });
    expect(passwordStrength('Ab1!')).toMatchObject({ acceptable: false, checks: { length: false } });
  });
});
