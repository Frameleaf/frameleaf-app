import { describe, expect, it } from 'vitest';
import { passwordStrength } from './password-strength';

describe('passwordStrength', () => {
  it('reports an empty password as score 0 and not acceptable', () => {
    const result = passwordStrength('');
    expect(result.score).toBe(0);
    expect(result.acceptable).toBe(false);
    expect(result.passed).toBe(0);
  });

  it('needs three rules for an acceptable password, as the prototype does', () => {
    expect(passwordStrength('abcdefgh').acceptable).toBe(false); // length + lower
    expect(passwordStrength('Abcdefgh').acceptable).toBe(true); // + upper
    expect(passwordStrength('Abcdefgh').score).toBe(2);
  });

  it('rewards fourteen or more characters with one extra step, capped at strong', () => {
    expect(passwordStrength('Abcdefgh1!').score).toBe(4);
    expect(passwordStrength('Abcdefghijklmn').score).toBe(3);
    expect(passwordStrength('Abcdefghijklmn1!').score).toBe(4);
  });
});
