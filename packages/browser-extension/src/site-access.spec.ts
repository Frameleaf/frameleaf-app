import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  readSiteAccess,
  scopeCookies,
  siteCookie,
  siteOf,
  sitePatterns,
} from './site-access';

const cookie = (
  overrides: Partial<chrome.cookies.Cookie> = {},
): chrome.cookies.Cookie => ({
  name: 'session',
  value: 'cookie-secret',
  domain: '.video.example',
  path: '/',
  secure: true,
  httpOnly: true,
  hostOnly: false,
  session: false,
  sameSite: 'lax',
  storeId: '0',
  expirationDate: 1_900_000_000.5,
  ...overrides,
});
afterEach(() => vi.unstubAllGlobals());

describe('Connect this site: which sign-in is shared (FL-1427)', () => {
  it('asks only for the site in the tab, over HTTPS', () => {
    expect(siteOf('https://www.video.example/watch?v=1')).toEqual({
      host: 'video.example',
      origins: ['https://www.video.example'],
    });
    expect(sitePatterns(['https://www.video.example'])).toEqual([
      'https://www.video.example/*',
    ]);
    expect(siteOf('http://video.example/')).toBeNull();
    expect(siteOf('chrome://settings')).toBeNull();
    expect(siteOf('https://me:pw@video.example/')).toBeNull();
  });

  it('adds a second address only for a site known to need it', () => {
    expect(siteOf('https://x.com/someone')?.origins).toEqual([
      'https://x.com',
      'https://twitter.com',
    ]);
    expect(siteOf('https://example.com/')?.origins).toEqual([
      'https://example.com',
    ]);
  });

  it('keeps every part of a cookie, and never flattens a partitioned one', () => {
    expect(siteCookie(cookie())).toEqual({
      name: 'session',
      value: 'cookie-secret',
      domain: '.video.example',
      path: '/',
      secure: true,
      httpOnly: true,
      hostOnly: false,
      expires: 1_900_000_000.5,
      storeId: '0',
    });
    // a session cookie stays without an expiry, a host-only cookie stays host-only
    const hostOnly = siteCookie(
      cookie({
        hostOnly: true,
        domain: 'www.video.example',
        expirationDate: undefined,
      }),
    );
    expect(hostOnly.hostOnly).toBe(true);
    expect(hostOnly).not.toHaveProperty('expires');
    expect(
      siteCookie(
        cookie({
          partitionKey: {
            topLevelSite: 'https://embedder.example',
            hasCrossSiteAncestor: true,
          },
        }),
      ).partitionKey,
    ).toEqual({
      topLevelSite: 'https://embedder.example',
      hasCrossSiteAncestor: true,
    });
  });

  it('shares only cookies for the site’s own host or a parent of it', () => {
    const scoped = scopeCookies(
      [
        siteCookie(cookie()),
        siteCookie(cookie({ name: 'pref', domain: 'www.video.example' })),
        siteCookie(cookie({ name: 'tracker', domain: '.ads.example' })),
        siteCookie(cookie({ name: 'sibling', domain: 'mail.video.example' })),
        siteCookie(cookie({ name: 'suffix', domain: 'example' })),
      ],
      ['https://www.video.example'],
    );

    expect(scoped.cookies.map((item) => item.name)).toEqual([
      'session',
      'pref',
    ]);
    // one line for the person to read: the parent already covers "www."
    expect(scoped.domains).toEqual(['video.example']);
  });

  it('reads from the tab’s own cookie jar, by the site’s address, and nothing wider', async () => {
    const getAll = vi.fn().mockResolvedValue([cookie(), cookie()]);
    vi.stubGlobal('chrome', { cookies: { getAll } });

    const access = await readSiteAccess(['https://www.video.example'], '1');

    expect(getAll).toHaveBeenCalledTimes(1);
    expect(getAll).toHaveBeenCalledWith({
      url: 'https://www.video.example/',
      storeId: '1',
    });
    expect(access).toEqual({
      ok: true,
      domains: ['video.example'],
      count: 1,
      session: {
        domains: ['video.example'],
        cookies: [expect.objectContaining({ name: 'session' })],
      },
    });
  });

  it('says when there is no sign-in to share, or only one it can’t share', async () => {
    const getAll = vi.fn().mockResolvedValue([]);
    vi.stubGlobal('chrome', { cookies: { getAll } });
    await expect(
      readSiteAccess(['https://video.example'], undefined),
    ).resolves.toEqual({ ok: false, reason: 'signed-out' });

    getAll.mockImplementation(async (details: { partitionKey?: unknown }) =>
      details.partitionKey
        ? [cookie({ partitionKey: { topLevelSite: 'https://video.example' } })]
        : [],
    );
    await expect(
      readSiteAccess(['https://video.example'], undefined),
    ).resolves.toEqual({ ok: false, reason: 'partitioned' });
  });
});
