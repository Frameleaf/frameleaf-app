import { type LookupAddress, lookup as dnsLookup } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { Agent, fetch } from 'undici';

/**
 * Fetches an address a user typed, for reading a page's title and picture (Boards "Save a link").
 *
 * The server is on the user's own network, so a typed address must never reach it: loopback,
 * private, link-local, carrier-grade NAT, unique-local and other non-public ranges are refused.
 * The check runs inside the connection's own DNS lookup, so the address that is checked is the
 * address that is dialled (no DNS-rebinding window), and again for every redirect. Only http and
 * https on their usual ports, no credentials, a size cap and a timeout.
 */
const blocked = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  blocked.addSubnet(network, prefix, 'ipv6');
}

export class PublicFetchError extends Error {}

/** True when `address` is an IP that a typed address may reach. */
export const isPublicAddress = (address: string): boolean => {
  const family = isIP(address);
  if (family === 4) {
    return !blocked.check(address, 'ipv4');
  }
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    return mapped ? isPublicAddress(mapped[1]) : !blocked.check(address, 'ipv6');
  }
  return false;
};

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

const publicLookup = (hostname: string, options: { all?: boolean }, callback: LookupCallback) => {
  dnsLookup(hostname, { all: true }, (error, addresses) => {
    if (error) {
      return callback(error, []);
    }
    if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
      return callback(new PublicFetchError(`${hostname} is not a public address`), []);
    }
    if (options.all) {
      return callback(null, addresses);
    }
    callback(null, addresses[0].address, addresses[0].family);
  });
};

const agent = new Agent({ connect: { lookup: publicLookup as never }, headersTimeout: 10_000, bodyTimeout: 10_000 });

const PORTS = new Set(['', '80', '443']);

const checkUrl = (value: string | URL): URL => {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !PORTS.has(url.port)) {
    throw new PublicFetchError('Only public http and https addresses can be read');
  }
  // An IP literal never goes through the lookup, so check it here.
  const host = url.hostname.replaceAll(/^\[|\]$/g, '');
  if (isIP(host) && !isPublicAddress(host)) {
    throw new PublicFetchError(`${host} is not a public address`);
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new PublicFetchError(`${host} is not a public address`);
  }
  return url;
};

export type PublicResponse = { url: URL; contentType: string; body: Buffer };

/** GETs a public address, following up to three redirects, reading at most `maxBytes`. */
export const fetchPublic = async (
  address: string,
  { maxBytes, accept, timeoutMs = 10_000 }: { maxBytes: number; accept: string; timeoutMs?: number },
): Promise<PublicResponse> => {
  let url = checkUrl(address);
  const signal = AbortSignal.timeout(timeoutMs);
  for (let hop = 0; hop <= 3; hop++) {
    const response = await fetch(url, {
      dispatcher: agent,
      redirect: 'manual',
      signal,
      headers: { accept, 'user-agent': 'Frameleaf link preview' },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) {
        throw new PublicFetchError('The page redirected without an address');
      }
      url = checkUrl(new URL(location, url));
      continue;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new PublicFetchError(`The page answered ${response.status}`);
    }
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > maxBytes) {
      await response.body.cancel();
      throw new PublicFetchError('The response is too large');
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > maxBytes) {
        throw new PublicFetchError('The response is too large');
      }
      chunks.push(Buffer.from(chunk));
    }
    return {
      url,
      contentType: (response.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase(),
      body: Buffer.concat(chunks),
    };
  }
  throw new PublicFetchError('Too many redirects');
};
