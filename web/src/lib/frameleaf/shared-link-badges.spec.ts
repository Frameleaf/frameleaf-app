import { describe, expect, it } from 'vitest';
import { isLinkExpired, relativeTime, sharedLinkBadges } from './shared-link-badges';

const now = Date.parse('2026-09-24T12:00:00.000Z');
const link = {
  expiresAt: null,
  password: null,
  allowDownload: false,
  allowUpload: false,
  showMetadata: false,
};

describe('shared link badges (AL-21)', () => {
  it('lists the prototype badges in its order, expired first', () => {
    expect(
      sharedLinkBadges(
        { ...link, expiresAt: '2026-09-20T00:00:00.000Z', password: 'x', allowDownload: true, showMetadata: true },
        now,
      ).map(({ id, tone }) => `${id}:${tone}`),
    ).toEqual(['expired:danger', 'password:neutral', 'download:neutral', 'metadata:neutral']);
  });

  it('says when an open link expires, and nothing for one that never does', () => {
    expect(sharedLinkBadges({ ...link, expiresAt: '2026-09-27T12:00:00.000Z' }, now)).toEqual([
      { id: 'expiry', tone: 'info', at: '2026-09-27T12:00:00.000Z' },
    ]);
    expect(sharedLinkBadges(link, now)).toEqual([]);
    expect(isLinkExpired({ expiresAt: null }, now)).toBe(false);
  });

  it('phrases durations in the prototype steps', () => {
    expect(relativeTime('2026-09-24T12:20:00.000Z', now, 'en')).toBe('in 20 minutes');
    expect(relativeTime('2026-09-24T07:00:00.000Z', now, 'en')).toBe('5 hours ago');
    expect(relativeTime('2026-09-27T12:00:00.000Z', now, 'en')).toBe('in 3 days');
    expect(relativeTime('2026-06-24T12:00:00.000Z', now, 'en')).toBe('3 months ago');
    expect(relativeTime('2024-09-24T12:00:00.000Z', now, 'en')).toBe('2 years ago');
  });
});
