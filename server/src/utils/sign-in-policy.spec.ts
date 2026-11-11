import { describe, expect, it } from 'vitest';
import { type PolicyInput, type PolicyRecord, evaluateSession } from 'src/utils/sign-in-policy.js';

const record = (over: Partial<PolicyRecord> = {}): PolicyRecord => ({
  level: 'basic',
  methods: [],
  source: 'frameleaf',
  legacy: false,
  ...over,
});
const input = (over: Partial<PolicyInput> = {}): PolicyInput => ({
  away: true,
  isAdmin: false,
  adminRoute: false,
  record: record(),
  requirement: 'administrators-away',
  applyToOlderApps: false,
  allowPasswordOverRelay: false,
  hasAuthenticator: false,
  ...over,
});
const code = (over: Partial<PolicyInput>) => {
  const decision = evaluateSession(input(over));
  return decision.ok ? 'ok' : decision.code;
};

describe('away from home', () => {
  it('lets a Basic Frameleaf administrator work as a member, and refuses administrator routes', () => {
    expect(code({ isAdmin: true })).toBe('ok');
    expect(code({ isAdmin: true, adminRoute: true })).toBe('verification_required');
  });
  it('asks a Verified administrator for nothing', () => {
    expect(code({ isAdmin: true, adminRoute: true, record: record({ level: 'verified' }) })).toBe('ok');
  });
  it('accepts a passkey session, and refuses a password session', () => {
    const passkey = record({ source: 'local', level: 'verified', methods: ['passkey'] });
    expect(code({ record: passkey, isAdmin: true, adminRoute: true })).toBe('ok');
    const password = record({ source: 'local', methods: ['pwd'] });
    expect(code({ record: password })).toBe('frameleaf_sign_in_required');
  });
  it('accepts a password away from home only with the authenticator, when the owner allowed passwords', () => {
    const password = record({ source: 'local', methods: ['pwd'] });
    const both = record({ source: 'local', methods: ['pwd', 'totp'], level: 'verified' });
    expect(code({ record: password, allowPasswordOverRelay: true })).toBe('frameleaf_sign_in_required');
    expect(code({ record: both, allowPasswordOverRelay: true })).toBe('ok');
    expect(code({ record: both })).toBe('frameleaf_sign_in_required');
  });
  it('asks everyone for Verified under "everyone away"', () => {
    expect(code({ requirement: 'everyone-away' })).toBe('verification_required');
    expect(code({ requirement: 'everyone-away', record: record({ level: 'verified' }) })).toBe('ok');
  });
});

describe('at home', () => {
  it('accepts a Basic Frameleaf sign-in for a person with no authenticator', () => {
    expect(code({ away: false, isAdmin: true, adminRoute: true })).toBe('ok');
  });
  it('never skips a local authenticator after a Basic Frameleaf sign-in, but asks nothing after a Verified one', () => {
    expect(code({ away: false, hasAuthenticator: true })).toBe('verification_required');
    expect(code({ away: false, hasAuthenticator: true, record: record({ level: 'verified' }) })).toBe('ok');
  });
  it('sends a password-only person to authenticator setup under "everyone, everywhere"', () => {
    const password = record({ source: 'local', methods: ['pwd'] });
    expect(code({ away: false, requirement: 'everyone', record: password })).toBe('two_factor_setup_required');
    expect(code({ away: false, requirement: 'everyone' })).toBe('verification_required');
  });
});

describe('older sessions', () => {
  const legacy = record({ legacy: true });
  it('keep today’s rights, including administrator access away from home', () => {
    expect(code({ record: legacy, isAdmin: true, adminRoute: true })).toBe('ok');
    expect(code({ record: legacy, hasAuthenticator: true, away: false })).toBe('ok');
    expect(code({ record: record({ legacy: true, source: 'local' }), allowPasswordOverRelay: true })).toBe('ok');
  });
  it('follow the rule once the owner turns on "Apply to older apps too"', () => {
    expect(code({ record: legacy, isAdmin: true, adminRoute: true, applyToOlderApps: true })).toBe(
      'verification_required',
    );
  });
  it('a session with no record is treated as legacy', () => {
    expect(code({ record: undefined, isAdmin: true, adminRoute: true })).toBe('frameleaf_sign_in_required');
  });
});
