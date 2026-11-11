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
    // IPv4-mapped, dotted (::ffff:127.0.0.1) or as URL parsing writes it (::ffff:7f00:1)
    const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (dotted) {
      return isPublicAddress(dotted[1]);
    }
    const hex = /^::ffff:([\da-f]{1,4}):([\da-f]{1,4})$/i.exec(address);
    if (hex) {
      const [high, low] = [Number.parseInt(hex[1], 16), Number.parseInt(hex[2], 16)];
      return isPublicAddress([high >> 8, high & 255, low >> 8, low & 255].join('.'));
    }
    return !blocked.check(address, 'ipv6');
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

/*
 * FL-819: the webhook step of a workflow that runs on a Frameleaf event. Its address is typed by the
 * owner, so it gets the same protection as a typed link, with two differences: it never follows a
 * redirect (a signed message goes only where it was addressed), and an administrator can let it reach
 * devices at home ("Allow automations to call devices on my network"), such as Home Assistant.
 * Loopback, link-local (where cloud metadata services answer) and other reserved addresses stay out
 * of reach even then.
 */
const subnets = (ranges: ReadonlyArray<readonly [string, number, 'ipv4' | 'ipv6']>) => {
  const list = new BlockList();
  for (const [network, prefix, family] of ranges) {
    list.addSubnet(network, prefix, family);
  }
  return list;
};

const homeNetwork = subnets([
  ['10.0.0.0', 8, 'ipv4'],
  ['100.64.0.0', 10, 'ipv4'],
  ['172.16.0.0', 12, 'ipv4'],
  ['192.168.0.0', 16, 'ipv4'],
  ['fc00::', 7, 'ipv6'],
]);

/** `::ffff:a.b.c.d` (either spelling) as `a.b.c.d`; any other address as it is. */
const unmapped = (address: string): string => {
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (dotted) {
    return dotted[1];
  }
  const hex = /^::ffff:([\da-f]{1,4}):([\da-f]{1,4})$/i.exec(address);
  if (hex) {
    const [high, low] = [Number.parseInt(hex[1], 16), Number.parseInt(hex[2], 16)];
    return [high >> 8, high & 255, low >> 8, low & 255].join('.');
  }
  return address;
};

/** Cloud metadata services that sit inside private ranges (Alibaba, AWS and Google Cloud over IPv6): never reachable. */
const metadataAddresses = subnets([
  ['100.100.100.200', 32, 'ipv4'],
  ['fd00:ec2::254', 128, 'ipv6'],
  ['fd20:ce::254', 128, 'ipv6'],
]);

/** Whether an automation may send to `address`: anywhere public, a home address only when allowed. */
export const isWebhookAddressAllowed = (address: string, allowHomeNetwork: boolean): boolean => {
  const plain = unmapped(address);
  const family = isIP(plain);
  if (family !== 0 && metadataAddresses.check(plain, family === 4 ? 'ipv4' : 'ipv6')) {
    return false;
  }
  if (isPublicAddress(address)) {
    return true;
  }
  return allowHomeNetwork && family !== 0 && homeNetwork.check(plain, family === 4 ? 'ipv4' : 'ipv6');
};

const plainHttpError = 'Plain http only reaches devices on your network; use an https address for anything else';

const webhookLookup =
  (allowHomeNetwork: boolean, homeOnly = false) =>
  (hostname: string, options: { all?: boolean }, callback: LookupCallback) => {
    dnsLookup(hostname, { all: true }, (error, addresses) => {
      if (error) {
        return callback(error, []);
      }
      if (
        addresses.length === 0 ||
        addresses.some(
          ({ address }) =>
            !isWebhookAddressAllowed(address, allowHomeNetwork) || (homeOnly && isPublicAddress(address)),
        )
      ) {
        return callback(
          new PublicFetchError(homeOnly ? plainHttpError : `${hostname} is not an address automations can reach`),
          [],
        );
      }
      if (options.all) {
        return callback(null, addresses);
      }
      callback(null, addresses[0].address, addresses[0].family);
    });
  };

const webhookAgents = {
  public: new Agent({
    connect: { lookup: webhookLookup(false) as never },
    headersTimeout: 10_000,
    bodyTimeout: 10_000,
  }),
  home: new Agent({ connect: { lookup: webhookLookup(true) as never }, headersTimeout: 10_000, bodyTimeout: 10_000 }),
  plainHttp: new Agent({
    connect: { lookup: webhookLookup(true, true) as never },
    headersTimeout: 10_000,
    bodyTimeout: 10_000,
  }),
};

/** Names cloud providers give their metadata services; refused before any lookup. */
const METADATA_HOSTS = new Set([
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'instance-data.ec2.internal',
]);

const WEBHOOK_REQUEST_BYTES = 256_000;
const WEBHOOK_RESPONSE_BYTES = 64_000;

/** A home-network address or name: a private address, a single-label name or a .local/.lan/.internal/.home.arpa name. */
const isHomeDestination = (host: string): boolean => {
  const plain = unmapped(host);
  const family = isIP(plain);
  if (family !== 0) {
    return homeNetwork.check(plain, family === 4 ? 'ipv4' : 'ipv6');
  }
  return !host.includes('.') || /\.(local|internal|lan|home\.arpa)$/i.test(host);
};

const checkWebhookUrl = (value: string, allowHomeNetwork: boolean): URL => {
  const url = new URL(value);
  // plain http only reaches the home network; anywhere else the message is sent encrypted
  const protocols = allowHomeNetwork ? ['http:', 'https:'] : ['https:'];
  if (!protocols.includes(url.protocol) || url.username || url.password) {
    throw new PublicFetchError(
      allowHomeNetwork
        ? 'Automations send to http or https addresses without a user name or password'
        : 'Automations send to https addresses without a user name or password',
    );
  }
  const host = url.hostname.replaceAll(/^\[|\]$/g, '');
  if (url.protocol === 'http:' && !isHomeDestination(host)) {
    // anything sent over plain http can be read on the way, so outside the home it goes encrypted
    throw new PublicFetchError(plainHttpError);
  }
  if (isIP(host) && !isWebhookAddressAllowed(host, allowHomeNetwork)) {
    throw new PublicFetchError(`${host} is not an address automations can reach`);
  }
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    METADATA_HOSTS.has(host.toLowerCase().replace(/\.$/, ''))
  ) {
    throw new PublicFetchError(`${host} is not an address automations can reach`);
  }
  if (!allowHomeNetwork && !isIP(host) && (!host.includes('.') || /\.(local|internal|lan|home\.arpa)$/i.test(host))) {
    throw new PublicFetchError(`${host} is on your network; an administrator can allow automations to reach it`);
  }
  return url;
};

export type WebhookResponse = { ok: boolean; status: number; body: string };

/**
 * FL-1420: one hop of a plugin's HTTP request that is not a signed automation message (a photo
 * trigger's webhook without a secret, a third-party plugin). It goes only where an automation message
 * may: the address is checked before connecting and every DNS answer is checked while connecting, so a
 * redirect or a rebinding name cannot reach the server itself, the home network (unless allowed) or a
 * cloud metadata service. The caller follows redirects one hop at a time through this.
 */
export const fetchAutomationHop = (
  address: string,
  init: { method?: string; headers: Headers; body?: string | null },
  { allowHomeNetwork }: { allowHomeNetwork: boolean },
) => {
  const url = checkWebhookUrl(address, allowHomeNetwork);
  // as sendWebhook: plain http connects only to home-network addresses, whatever the name resolves to
  const secureDispatcher = allowHomeNetwork ? webhookAgents.home : webhookAgents.public;
  return fetch(url, {
    dispatcher: url.protocol === 'http:' ? webhookAgents.plainHttp : secureDispatcher,
    method: init.method,
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
    headers: Object.fromEntries(init.headers.entries()),
    body: init.body ?? undefined,
  });
};

/** FL-1420: at most the first 64 KB of an automation hop's answer; the rest is never read. */
export const readAutomationAnswer = async (response: { body: AsyncIterable<Uint8Array> | null }) => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    const room = WEBHOOK_RESPONSE_BYTES - size;
    chunks.push(Buffer.from(chunk.subarray(0, room)));
    size += Math.min(chunk.byteLength, room);
    if (size >= WEBHOOK_RESPONSE_BYTES) {
      break;
    }
  }
  return Buffer.concat(chunks).toString('utf8');
};

/** Sends one bounded automation message without redirects, using plain HTTP only on the home network. */
export const sendWebhook = async (
  address: string,
  { method = 'POST', headers, body = '' }: { method?: string; headers: Headers; body?: string },
  { allowHomeNetwork }: { allowHomeNetwork: boolean },
): Promise<WebhookResponse> => {
  const url = checkWebhookUrl(address, allowHomeNetwork);
  if (!['POST', 'PUT'].includes(method.toUpperCase())) {
    throw new PublicFetchError('Automations send with POST or PUT');
  }
  if (Buffer.byteLength(body, 'utf8') > WEBHOOK_REQUEST_BYTES) {
    throw new PublicFetchError('The message is too large to send');
  }
  const secureDispatcher = allowHomeNetwork ? webhookAgents.home : webhookAgents.public;
  const response = await fetch(url, {
    dispatcher: url.protocol === 'http:' ? webhookAgents.plainHttp : secureDispatcher,
    method: method.toUpperCase(),
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
    headers: Object.fromEntries(headers.entries()),
    body,
  }).catch((error: unknown) => {
    throw error instanceof TypeError && error.cause instanceof PublicFetchError ? error.cause : error;
  });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    return { ok: false, status: response.status, body: '' };
  }
  const chunks: Buffer[] = [];
  if (response.body) {
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > WEBHOOK_RESPONSE_BYTES) {
        // what the receiver says is not needed; stop reading it
        break;
      }
      chunks.push(Buffer.from(chunk));
    }
  }
  return { ok: response.ok, status: response.status, body: Buffer.concat(chunks).toString('utf8') };
};
