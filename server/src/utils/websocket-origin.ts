import type { IncomingHttpHeaders } from 'node:http';

/**
 * FL-161: the origins a browser may open this server's websocket from. The permissive `cors: true`
 * let any web page open a socket with the visitor's cookies (cross-site websocket hijacking); a
 * browser always sends `Origin` on a websocket handshake and a page cannot change it, so it is
 * checked against:
 *
 * - the address the request was sent to (`Host`, or the `X-Forwarded-Host` a reverse proxy or the
 *   edge worker set): the same origin;
 * - the configured external domain (`server.externalDomain`);
 * - the published Frameleaf names of a linked server (its relay origin and public URL).
 *
 * A handshake without `Origin` comes from an app or a script, not a web page, and is left to the
 * usual authentication.
 */

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

/** The last `X-Forwarded-Host` hop: the value the nearest proxy set. */
const forwardedHost = (value: string | string[] | undefined) =>
  first(value)
    ?.split(',')
    .map((hop) => hop.trim())
    .findLast(Boolean);

const originOf = (value: string | null | undefined): string | null => {
  if (!value) {
    return null;
  }
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
};

/** The hosts a same-origin page would carry in its `Origin`. */
export const requestHosts = (headers: IncomingHttpHeaders): string[] =>
  [first(headers.host), forwardedHost(headers['x-forwarded-host'])]
    .filter((host): host is string => !!host)
    .map((host) => host.toLowerCase());

/** The configured origins (external domain, relay origin, public URL), normalized; invalid ones are dropped. */
export const allowedOrigins = (values: Array<string | null | undefined>): string[] =>
  values.map((value) => originOf(value)).filter((origin): origin is string => !!origin);

export const websocketOriginAllowed = (
  origin: string | undefined,
  { hosts, origins }: { hosts: string[]; origins: string[] },
): boolean => {
  if (origin === undefined) {
    return true;
  }
  const normalized = originOf(origin);
  if (!normalized) {
    // `Origin: null` (a sandboxed or file page) or anything unparseable
    return false;
  }
  return origins.includes(normalized) || hosts.includes(new URL(normalized).host);
};
