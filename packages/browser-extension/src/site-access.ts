import type { MediaConnectionCreateDto } from '@frameleaf/sdk';
import { mediaUrl } from './media-discovery';

/**
 * FL-1427: "Connect this site" shares the sign-in this browser has for one site with your Library,
 * so the Library can download what you can see there. Only when you press it, only for the site in
 * the tab you are on, and only the cookies the browser itself would send to that site: never the
 * whole profile, never storage, never another site's.
 *
 * The cookies go from here straight to your Library over HTTPS in one request. They are never
 * written to extension storage, the saving list or a log.
 */

type Session = MediaConnectionCreateDto['session'];
export type SiteCookie = NonNullable<Session['cookies']>[number];

/**
 * A second address some sites keep their sign-in on. Listed only where a download is known to need
 * it, and always shown to you before anything is shared.
 */
const ASSOCIATED: Record<string, string[]> = {
  'x.com': ['twitter.com'],
  'twitter.com': ['x.com'],
};
const bare = (host: string) => host.toLowerCase().replace(/^www\./, '');

/** The site in the tab, as addresses to ask the browser about. Null for anything but a web page. */
export function siteOf(
  pageUrl: string,
): { host: string; origins: string[] } | null {
  const url = mediaUrl(pageUrl);
  // A sign-in is only ever read from, and for, an HTTPS site.
  if (!url || url.protocol !== 'https:') return null;
  const host = bare(url.hostname);
  return {
    host,
    origins: [
      url.origin,
      ...(ASSOCIATED[host] ?? []).map((other) => `https://${other}`),
    ],
  };
}
/** What the browser is asked to allow for those addresses: these hosts and no others. */
export const sitePatterns = (origins: string[]) =>
  origins.map((origin) => `${origin}/*`);

/**
 * One browser cookie as the Library takes it, with nothing dropped or flattened: host-only stays
 * host-only, a session cookie stays without an expiry, and a partitioned cookie keeps its partition
 * (the Library then says it can't use it, rather than quietly using it as if it were not).
 */
export function siteCookie(cookie: chrome.cookies.Cookie): SiteCookie {
  const partition = cookie.partitionKey;
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    hostOnly: cookie.hostOnly,
    ...(cookie.expirationDate !== undefined && {
      expires: cookie.expirationDate,
    }),
    ...(cookie.storeId && { storeId: cookie.storeId }),
    ...(partition?.topLevelSite && {
      partitionKey: {
        topLevelSite: partition.topLevelSite,
        ...(partition.hasCrossSiteAncestor !== undefined && {
          hasCrossSiteAncestor: partition.hasCrossSiteAncestor,
        }),
      },
    }),
  };
}

/**
 * The domains the Library is asked to keep access to: exactly the ones the site's cookies are set
 * for, each of which must be the site's own host or a parent of it. A cookie for anywhere else is
 * left out (the browser would not send it to this site either).
 */
export function scopeCookies(
  cookies: SiteCookie[],
  origins: string[],
): { cookies: SiteCookie[]; domains: string[] } {
  const hosts = origins.map((origin) => new URL(origin).hostname.toLowerCase());
  const kept = cookies.filter((cookie) => {
    const domain = cookie.domain.replace(/^\./, '').toLowerCase();
    return (
      domain.includes('.') &&
      hosts.some((host) => host === domain || host.endsWith(`.${domain}`))
    );
  });
  const all = [
    ...new Set(
      kept.map((cookie) => cookie.domain.replace(/^\./, '').toLowerCase()),
    ),
  ];
  // "example.com" already covers "www.example.com".
  const domains = all
    .filter((domain) => !all.some((other) => domain.endsWith(`.${other}`)))
    .sort();
  return { cookies: kept.slice(0, 500), domains };
}

export type SiteAccess =
  | { ok: true; session: Session; domains: string[]; count: number }
  | { ok: false; reason: 'signed-out' | 'partitioned' };
/**
 * Reads the site's cookies from the tab's own cookie jar (so a private window or another profile
 * container is never mixed in). Needs the Cookies permission and access to these addresses, both
 * asked for when you press Connect.
 */
export async function readSiteAccess(
  origins: string[],
  storeId: string | undefined,
): Promise<SiteAccess> {
  const read = await Promise.all(
    origins.map((origin) =>
      chrome.cookies.getAll({ url: `${origin}/`, ...(storeId && { storeId }) }),
    ),
  );
  const seen = new Set<string>();
  const cookies = read
    .flat()
    .filter((cookie) => {
      const key = JSON.stringify([cookie.domain, cookie.path, cookie.name]);
      return !seen.has(key) && seen.add(key);
    })
    .map(siteCookie);
  const scoped = scopeCookies(cookies, origins);
  if (scoped.cookies.length === 0) {
    // A site that keeps its sign-in only in partitioned cookies can't be connected this way.
    const partitioned = await Promise.all(
      origins.map((origin) =>
        chrome.cookies
          .getAll({
            url: `${origin}/`,
            partitionKey: { topLevelSite: origin },
            ...(storeId && { storeId }),
          })
          .catch(() => []),
      ),
    );
    return {
      ok: false,
      reason: partitioned.flat().length > 0 ? 'partitioned' : 'signed-out',
    };
  }
  return {
    ok: true,
    session: { domains: scoped.domains, cookies: scoped.cookies },
    domains: scoped.domains,
    count: scoped.cookies.length,
  };
}
