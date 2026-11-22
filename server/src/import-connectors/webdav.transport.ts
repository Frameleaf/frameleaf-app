import { type LookupAddress, lookup as dnsLookup } from 'node:dns';
import { existsSync } from 'node:fs';
import { BlockList, isIP } from 'node:net';
import { type NetworkInterfaceInfo, networkInterfaces } from 'node:os';
import { Agent, type Response, fetch as undiciFetch } from 'undici';
import { RemoteSourceAuthError, RemoteSourceError } from 'src/import-connectors/remote-source.js';
import {
  PublicFetchError,
  isCloudMetadataHost,
  isHomeNetworkAddress,
  isWebhookAddressAllowed,
  unmapped,
} from 'src/utils/public-fetch.js';

/**
 * FL-944: the only way the WebDAV source reaches the network. The address is typed by a user of this
 * server and a password goes with it, so:
 *
 * - Every address a name resolves to is checked inside the connection's own DNS lookup (the address
 *   checked is the address dialled), and every redirect hop is checked again.
 * - A private address needs the person's explicit allowance. Plain http needs that allowance and a
 *   private address, whatever the name resolves to.
 * - Loopback, link-local, metadata and reserved addresses are refused even with the allowance, and so
 *   is this server itself. Inside a container, so is every network the container is attached to: on a
 *   Docker bridge those are the database, Redis and machine-learning containers, and they cannot be told
 *   from a NAS by address.
 * - The Authorization header only ever goes to the origin the person typed.
 */
export const WEBDAV_MAX_REDIRECTS = 3;

const REFUSED = 'This address cannot be used for an import';
const NEEDS_ALLOWANCE = 'This is a private address. Allow private addresses to connect to it.';
const PLAIN_HTTP = 'Plain http is only allowed for a private address, once you allow private addresses';

export type WebDavPolicy = { allowPrivateAddress: boolean };

export type WebDavFetchInit = {
  method: 'PROPFIND' | 'GET';
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
};
export type WebDavFetch = (url: URL, init: WebDavFetchInit, policy: WebDavPolicy) => Promise<Response>;

const inContainer = () =>
  existsSync('/.dockerenv') || existsSync('/run/.containerenv') || !!process.env.KUBERNETES_SERVICE_HOST;

/** This server's own addresses and, inside a container, the networks it is attached to. */
export const serverNetworks = (
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
  container = inContainer(),
) => {
  const list = new BlockList();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      const family = entry.family === 'IPv4' ? 'ipv4' : 'ipv6';
      list.addAddress(entry.address, family);
      const prefix = Number(entry.cidr?.split('/', 2)[1]);
      if (container && !entry.internal && Number.isSafeInteger(prefix) && prefix > 0) {
        list.addSubnet(entry.address, prefix, family);
      }
    }
  }
  return list;
};

/** Whether the source may connect to `address` under this policy. */
export const isSourceAddressAllowed = (
  address: string,
  { allowPrivateAddress }: WebDavPolicy,
  plainHttp: boolean,
  networks: BlockList = serverNetworks(),
): boolean => {
  const plain = unmapped(address);
  const family = isIP(plain);
  if (family === 0 || networks.check(plain, family === 4 ? 'ipv4' : 'ipv6')) {
    return false;
  }
  if (!isWebhookAddressAllowed(plain, allowPrivateAddress)) {
    return false;
  }
  return !plainHttp || isHomeNetworkAddress(plain);
};

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** The DNS lookup every connection dials through. */
export const guardedLookup =
  (policy: WebDavPolicy, plainHttp: boolean) =>
  (hostname: string, options: { all?: boolean }, callback: LookupCallback) => {
    dnsLookup(hostname, { all: true }, (error, addresses) => {
      if (error) {
        return callback(error, []);
      }
      const networks = serverNetworks();
      if (
        addresses.length === 0 ||
        addresses.some(({ address }) => !isSourceAddressAllowed(address, policy, plainHttp, networks))
      ) {
        const privateOnly =
          !policy.allowPrivateAddress && addresses.some(({ address }) => isHomeNetworkAddress(address));
        return callback(new PublicFetchError(privateOnly ? NEEDS_ALLOWANCE : REFUSED), []);
      }
      if (options.all) {
        return callback(null, addresses);
      }
      callback(null, addresses[0].address, addresses[0].family);
    });
  };

const agents = new Map<string, Agent>();
const agentFor = (policy: WebDavPolicy, plainHttp: boolean) => {
  const key = `${policy.allowPrivateAddress}:${plainHttp}`;
  let agent = agents.get(key);
  if (!agent) {
    agent = new Agent({
      connect: { lookup: guardedLookup(policy, plainHttp) as never },
      headersTimeout: 30_000,
      bodyTimeout: 60_000,
    });
    agents.set(key, agent);
  }
  return agent;
};

const guardedFetch: WebDavFetch = (url, init, policy) =>
  undiciFetch(url, {
    ...init,
    redirect: 'manual',
    dispatcher: agentFor(policy, url.protocol === 'http:'),
  });

/** The checks that need no network: run on the typed address and on every redirect target. */
export const checkSourceUrl = (value: string | URL, policy: WebDavPolicy): URL => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RemoteSourceError('Enter the full address, starting with https://');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new RemoteSourceError('Enter an http or https address');
  }
  if (url.username || url.password) {
    throw new RemoteSourceError('Put the user name and password in their own fields, not in the address');
  }
  const host = url.hostname
    .replaceAll(/^\[|\]$/g, '')
    .toLowerCase()
    .replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') || isCloudMetadataHost(host)) {
    throw new RemoteSourceError(REFUSED);
  }
  const plainHttp = url.protocol === 'http:';
  if (plainHttp && !policy.allowPrivateAddress) {
    throw new RemoteSourceError(PLAIN_HTTP);
  }
  if (isIP(host)) {
    if (!policy.allowPrivateAddress && isHomeNetworkAddress(host)) {
      throw new RemoteSourceError(NEEDS_ALLOWANCE);
    }
    if (plainHttp && !isHomeNetworkAddress(host)) {
      throw new RemoteSourceError(isSourceAddressAllowed(host, policy, false) ? PLAIN_HTTP : REFUSED);
    }
    if (!isSourceAddressAllowed(host, policy, plainHttp)) {
      throw new RemoteSourceError(REFUSED);
    }
  }
  return url;
};

/** What a failed request says: never the underlying error, which can quote the request. */
const transportError = (error: unknown, signal?: AbortSignal): unknown => {
  if (signal?.aborted || error instanceof RemoteSourceError) {
    return error;
  }
  const cause = error instanceof Error ? error.cause : undefined;
  if (cause instanceof PublicFetchError) {
    return new RemoteSourceError(cause.message);
  }
  if (error instanceof Error && error.name === 'TimeoutError') {
    return new RemoteSourceError('The server did not answer in time');
  }
  return new RemoteSourceError('The server could not be reached');
};

export type WebDavRequest = WebDavFetchInit & {
  authorization: string;
  policy: WebDavPolicy;
  /** The caller's own stop; a stop is passed on as it is rather than reported as a source failure. */
  stop?: AbortSignal;
};

/** One request, following at most three checked redirects. The method never changes. */
export const webdavRequest = async (
  address: string | URL,
  { authorization, policy, stop, ...init }: WebDavRequest,
  fetcher: WebDavFetch = guardedFetch,
): Promise<{ response: Response; url: URL }> => {
  let url = checkSourceUrl(address, policy);
  const origin = url.origin;
  for (let hop = 0; hop <= WEBDAV_MAX_REDIRECTS; hop++) {
    const sameOrigin = url.origin === origin;
    const headers = { ...init.headers, ...(sameOrigin && { authorization }) };
    const response = await fetcher(url, { ...init, headers }, policy).catch((error: unknown) => {
      throw transportError(error, stop);
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) {
        throw new RemoteSourceError('The server redirected without an address');
      }
      let target: URL;
      try {
        target = new URL(location, url);
      } catch {
        throw new RemoteSourceError('The server redirected to an address that cannot be used');
      }
      const next = checkSourceUrl(target, policy);
      if (url.protocol === 'https:' && next.protocol === 'http:') {
        throw new RemoteSourceError('The server redirected from https to plain http, which is refused');
      }
      url = next;
      continue;
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      if (!sameOrigin) {
        // The password was not sent there, so this says nothing about the saved sign-in.
        throw new RemoteSourceError('The server redirected to another address. Enter that address instead.');
      }
      throw new RemoteSourceAuthError('The server refused this sign-in. Sign in again.');
    }
    return { response, url };
  }
  throw new RemoteSourceError('The server redirected too many times');
};
