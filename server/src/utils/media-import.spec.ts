import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decryptMediaSession,
  encryptMediaSession,
  mediaEntryDetails,
  mediaPublicUrl,
  mediaReachWidened,
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
  it('takes the latest few first, then only what is new', () => {
    const now = new Date('2026-11-10T00:00:00Z');
    const subscription = {
      history: { mode: 'recent' as const, count: 20 },
      historyComplete: false,
      createdAt: new Date('2026-11-01'),
      lastSuccessAt: null,
      lastReconcileAt: null,
    };
    expect(subscriptionSince(subscription, now.getTime())).toBeNull();
    expect(subscriptionSince({ ...subscription, historyComplete: true }, now.getTime())).toBe(
      subscription.createdAt.toISOString(),
    );
  });
  it('treats only a further reach as a reason to look back again', () => {
    const created = new Date('2026-06-01');
    const since = (date: string) => ({ mode: 'since' as const, since: `${date}T00:00:00Z` });
    const widened = (previous: object, next: object) => mediaReachWidened(previous as never, next as never, created);
    expect(widened({ mode: 'new' }, { mode: 'all' })).toBe(true);
    expect(widened({ mode: 'new' }, { mode: 'recent', count: 20 })).toBe(true);
    expect(widened({ mode: 'recent', count: 20 }, { mode: 'recent', count: 50 })).toBe(true);
    expect(widened({ mode: 'new' }, since('2026-01-01'))).toBe(true);
    expect(widened(since('2026-03-01'), since('2026-01-01'))).toBe(true);
    expect(widened({ mode: 'recent', count: 20 }, since('2026-01-01'))).toBe(true);
    expect(widened({ mode: 'all' }, { mode: 'new' })).toBe(false);
    expect(widened({ mode: 'all' }, { mode: 'all' })).toBe(false);
    expect(widened({ mode: 'all' }, { mode: 'recent', count: 200 })).toBe(false);
    expect(widened({ mode: 'recent', count: 50 }, { mode: 'recent', count: 20 })).toBe(false);
    expect(widened({ mode: 'recent' }, { mode: 'recent', count: 20 })).toBe(false);
    expect(widened(since('2026-01-01'), since('2026-03-01'))).toBe(false);
    expect(widened({ mode: 'new' }, since('2026-07-01'))).toBe(false);
    expect(widened(since('2026-01-01'), { mode: 'new' })).toBe(false);
  });
  it('bounds what an extractor says about an item and drops what it cannot know', () => {
    expect(
      mediaEntryDetails({
        section: 'short',
        tags: ['larch', 'larch', ' ', 7 as never, 'x'.repeat(200), ...Array.from({ length: 40 }, (_, k) => `t${k}`)],
        playlistId: 'list',
        playlistTitle: 'Joinery',
        duration: 12.5,
      }),
    ).toMatchObject({ section: 'short', playlistId: 'list', playlistTitle: 'Joinery', duration: 12.5 });
    const { tags } = mediaEntryDetails({
      tags: ['larch', 'larch', 'x'.repeat(200), ...Array.from({ length: 40 }, (_, k) => `t${k}`)],
    });
    expect(tags.slice(0, 2)).toEqual(['larch', 'x'.repeat(64)]);
    expect(tags).toHaveLength(30);
    expect(mediaEntryDetails({ section: 'story', tags: 'larch' as never, playlistId: 'list', duration: NaN })).toEqual({
      section: null,
      tags: [],
      playlistId: null,
      playlistTitle: null,
      duration: null,
    });
  });
  it('shows a source link only when it is an ordinary web address', () => {
    expect(mediaPublicUrl('https://example.org/post?id=1')).toBe('https://example.org/post?id=1');
    for (const value of ['javascript:alert(1)', 'file:///etc/hosts', 'https://name:secret@example.org/', 'post', null])
      expect(mediaPublicUrl(value)).toBeNull();
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
