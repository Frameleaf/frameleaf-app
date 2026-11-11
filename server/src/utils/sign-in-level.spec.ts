import { describe, expect, it } from 'vitest';
import { levelFromAcr, levelFromMethods, parseAmr } from 'src/utils/sign-in-level.js';

describe('levelFromMethods (shared vectors, spec appendix)', () => {
  it.each([
    [['passkey'], 'verified'],
    [['pwd'], 'basic'],
    [['email_code'], 'basic'],
    [['magic_link'], 'basic'],
    [['pwd', 'totp'], 'verified'],
    [['pwd', 'recovery_code'], 'verified'],
    [['pwd', 'email_code'], 'verified'],
    [['email_code', 'totp'], 'verified'],
    [['email_code', 'recovery_code'], 'verified'],
    [['email_code', 'magic_link'], 'basic'],
    [['email_code', 'email_code'], 'basic'],
    [[], 'basic'],
    [['totp'], 'basic'],
    [['pwd', 'passkey'], 'verified'],
  ] as const)('%j is %s', (methods, level) => {
    expect(levelFromMethods(methods)).toBe(level);
  });

  it('treats unknown methods as nothing', () => {
    expect(levelFromMethods(['pwd', 'fl-session'])).toBe('basic');
  });
});

describe('claims', () => {
  it('reads acr; a missing or unknown acr is Basic', () => {
    expect(levelFromAcr('urn:frameleaf:acr:verified')).toBe('verified');
    expect(levelFromAcr('urn:frameleaf:acr:basic')).toBe('basic');
    expect(levelFromAcr(undefined)).toBe('basic');
    expect(levelFromAcr('x')).toBe('basic');
  });
  it('reads amr, keeping known names once each', () => {
    expect(parseAmr(['pwd', 'totp', 'pwd', 'fl-session', 3])).toEqual(['pwd', 'totp']);
    expect(parseAmr('pwd')).toEqual([]);
    expect(parseAmr(undefined)).toEqual([]);
  });
});
