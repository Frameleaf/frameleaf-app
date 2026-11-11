import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decryptMediaSession,
  encryptMediaSession,
  mediaSourceKey,
  nextMediaCheck,
  subscriptionSince,
  validateMediaSession,
} from 'src/utils/media-import.js';

describe('media import identity and credentials', () => {
  it('adds bounded jitter without shortening the selected check interval', () => {
    for (const minutes of [1, 15, 60, 360, 1440]) {
      expect(nextMediaCheck(minutes, 0, 0).getTime()).toBe(minutes * 60_000);
      const latest = nextMediaCheck(minutes, 0, 1).getTime();
      expect(latest).toBeLessThanOrEqual(minutes * 60_000 + 60_000);
      expect(latest).toBeLessThanOrEqual(minutes * 63_000);
    }
  });
  it('overlaps incremental scans but returns to original history weekly', () => {
    const now = new Date('2026-11-10T00:00:00Z');
    const subscription = {
      history: { mode: 'all' as const },
      historyComplete: true,
      createdAt: new Date('2026-01-01'),
      lastSuccessAt: now,
      lastReconcileAt: now,
    };
    expect(subscriptionSince(subscription, now.getTime())).toBe('2026-11-08T00:00:00.000Z');
    expect(subscriptionSince({ ...subscription, lastReconcileAt: new Date('2026-11-01') }, now.getTime())).toBeNull();
    expect(
      subscriptionSince({ ...subscription, history: { mode: 'new' }, historyComplete: false }, now.getTime()),
    ).toBe(subscription.createdAt.toISOString());
  });
  it('uses provider identity, never a changing CDN URL', () => {
    const entry = { provider: 'twitter', postId: '123', attachmentId: '456' };
    expect(mediaSourceKey(entry)).toBe(mediaSourceKey({ ...entry }));
    expect(mediaSourceKey(entry)).not.toBe(mediaSourceKey({ ...entry, attachmentId: '789' }));
  });

  it('binds encrypted sessions to both owner and connection', () => {
    const key = randomBytes(32);
    const encrypted = encryptMediaSession(key, 'owner', 'connection', { domains: ['example.com'], password: 'secret' });
    expect(encrypted).not.toContain('secret');
    expect(decryptMediaSession(key, 'owner', 'connection', encrypted).password).toBe('secret');
    expect(() => decryptMediaSession(key, 'another', 'connection', encrypted)).toThrow();
    expect(() => decryptMediaSession(key, 'owner', 'another', encrypted)).toThrow();
    expect(() => decryptMediaSession(randomBytes(32), 'owner', 'connection', encrypted)).toThrow();
  });

  it('rejects cookies outside the approved domains and unsupported partition contexts', () => {
    const cookie = {
      name: 'session',
      value: 'secret',
      domain: '.example.com',
      path: '/',
      secure: true,
      httpOnly: true,
      hostOnly: false,
    };
    expect(() => validateMediaSession({ domains: ['example.com'], cookies: [cookie] })).not.toThrow();
    expect(() =>
      validateMediaSession({ domains: ['example.com'], cookies: [{ ...cookie, domain: 'evil-example.com' }] }),
    ).toThrow();
    expect(() =>
      validateMediaSession({
        domains: ['example.com'],
        cookies: [{ ...cookie, partitionKey: { topLevelSite: 'https://example.com' } }],
      }),
    ).toThrow();
    expect(() => validateMediaSession({ domains: ['com'], cookies: [cookie] })).toThrow();
    expect(() => validateMediaSession({ domains: ['example.com'], cookies: [{ ...cookie, value: 'a\nb' }] })).toThrow();
  });
});
