import { describe, expect, it } from 'vitest';
import { signInIsRecent } from 'src/utils/confirmed-recently.js';

describe('signInIsRecent (confirmed recently, 600 s)', () => {
  const now = Date.parse('2026-11-11T12:00:00Z');
  const at = (secondsAgo: number) => new Date(now - secondsAgo * 1000);
  const frameleaf = (secondsAgo: number) => ({
    methods: ['email_code'],
    source: 'frameleaf' as const,
    authTime: at(secondsAgo),
  });

  it('counts a Frameleaf sign-in by its auth_time, within 600 seconds', () => {
    expect(signInIsRecent(frameleaf(599), now)).toBe(true);
    expect(signInIsRecent(frameleaf(601), now)).toBe(false);
    expect(signInIsRecent({ ...frameleaf(0), authTime: at(-60) }, now)).toBe(false);
  });
  it('counts a local passkey sign-in, and never a password one or a trusted browser', () => {
    expect(signInIsRecent({ methods: ['passkey'], source: 'local', authTime: at(5) }, now)).toBe(true);
    expect(signInIsRecent({ methods: ['pwd'], source: 'local', authTime: at(5) }, now)).toBe(false);
    expect(signInIsRecent({ methods: ['pwd', 'totp'], source: 'local', authTime: at(5) }, now)).toBe(false);
  });
  it('accepts the time as the string the database returns, and refuses a missing record', () => {
    expect(signInIsRecent({ ...frameleaf(1), authTime: at(1).toISOString() }, now)).toBe(true);
    expect(signInIsRecent(undefined, now)).toBe(false);
    expect(signInIsRecent({ methods: [], source: 'frameleaf' }, now)).toBe(false);
  });
});
