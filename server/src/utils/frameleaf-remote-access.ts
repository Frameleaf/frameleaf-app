import { X509Certificate, createHash, createPrivateKey } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { BlockList, isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import z from 'zod';
import type {
  FrameleafEdgeCertificate,
  FrameleafRemoteAccess,
  FrameleafRemoteConnection,
  FrameleafRemoteEnrollment,
} from 'src/types.js';
import { SystemMetadataKey } from 'src/enum.js';
import { type CloudGatewayDeps, readCloudLink } from 'src/utils/frameleaf-cloud-gateway.js';
import { entitlementFlags } from 'src/utils/frameleaf-license.js';
import { isHomeAddress } from 'src/utils/frameleaf-sign-in.js';

/**
 * Remote access through Frameleaf Cloud (FL-165, CLD-102; cloud `docs/remote-access.md` and the
 * `packages/contracts` `remote/*` schemas), shared by the edge worker and the API: the instance label
 * and names, the enrolment and DNS TXT answers, the custom hostname rules and records, connection
 * candidates, the public URL, the certificate renewal window and the retry backoff. Everything is a
 * pure function except `remoteAccessUnavailable`, which reads the link and licence it is given.
 *
 * The direct domain comes from the enrolment answer (`domain`), else from discovery
 * (`remote.directDomain`); `DEFAULT_DIRECT_DOMAIN` is only the documented default.
 */

/** The documented default direct domain; the cloud's enrolment answer or discovery always wins. */
export const DEFAULT_DIRECT_DOMAIN = 'frameleaf.net';

/**
 * Frameleaf's own domains. A custom hostname under any of them, or under the direct domain in use, is
 * refused: those names are already set up (`frameleaf-direct.net` and `frameleaf.direct` are reserved).
 */
export const RESERVED_DOMAINS: readonly string[] = [
  'frameleaf.net',
  'frameleaf-direct.net',
  'frameleaf.direct',
  'frameleaf.cloud',
];

/** Let's Encrypt production; `FRAMELEAF_ACME_DIRECTORY_URL` replaces it (staging, a test CA). */
export const LETS_ENCRYPT_DIRECTORY = 'https://acme-v02.api.letsencrypt.org/directory';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** How often the edge worker re-reads what remote access should be doing. */
export const EDGE_POLL_MS = 10 * 1000;
/** Renewal is checked daily, at a random moment up to six hours later. */
export const RENEWAL_CHECK_MS = DAY_MS;
export const RENEWAL_JITTER_MS = 6 * HOUR_MS;
/** A certificate is renewed once less than this, or a third of its lifetime, is left (whichever is longer). */
export const RENEW_BEFORE_MS = 25 * DAY_MS;
/** A failed issuance is retried after an hour, doubling each time, at most once a day. */
export const RETRY_FIRST_MS = HOUR_MS;
export const RETRY_MAX_MS = DAY_MS;
/** Every socket is closed within this long when the edge worker shuts down or remote access stops. */
export const TEARDOWN_MS = 5000;
/** The edge proxy's connection caps. */
export const MAX_CONNECTIONS = 512;
export const MAX_CONNECTIONS_PER_ADDRESS = 64;
/** A request (an upload or a long video) may take a day. */
export const REQUEST_TIMEOUT_MS = DAY_MS;
/** HSTS for every answer the edge worker gives (one year). */
export const HSTS_HEADER = 'max-age=31536000';
/** The cloud waits up to 25 s for the name servers before it answers a TXT write. */
export const DNS_TXT_TIMEOUT_MS = 40 * 1000;
/** The state the edge worker writes counts as current for this long. */
export const EDGE_STATE_STALE_MS = 60 * 1000;

// ------------------------------------------------------------------ label and names

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** RFC 4648 base32, lowercase, without padding. */
const base32 = (bytes: Uint8Array): string => {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 65_535;
    bits += 8;
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32[(value << (5 - bits)) & 31];
  }
  return output;
};

/**
 * The instance's DNS label (contract `remote/enroll.ts`): lowercase base32 of the first 80 bits of
 * SHA-256 over the lowercase instance id's UTF-8 text. Golden vectors: `remote/label-vectors.json`.
 */
export const remoteLabel = (instanceId: string): string =>
  base32(createHash('sha256').update(instanceId.toLowerCase(), 'utf8').digest().subarray(0, 10));

const HOST_LABEL = /^[\da-z](?:[\da-z-]{0,61}[\da-z])?$/;

/** A lowercase DNS name of at least two labels whose last label is alphabetic. */
export const isDnsName = (value: string): boolean => {
  const labels = value.split('.');
  return (
    value.length <= 253 &&
    labels.length >= 2 &&
    labels.every((label) => HOST_LABEL.test(label)) &&
    /^[a-z]{2,63}$/.test(labels.at(-1) ?? '')
  );
};

const underDomain = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

/** The compressed IPv6 form (`2001:db8::1`), or null. */
const compressIpv6 = (address: string): string | null => {
  if (isIP(address) !== 6) {
    return null;
  }
  try {
    return new URL(`http://[${address}]/`).hostname.slice(1, -1);
  } catch {
    return null;
  }
};

/** The LAN (or WAN) name for an IPv4 address: `192-168-1-10.<label>.<domain>`. */
export const ipv4Name = (enrollment: Pick<FrameleafRemoteEnrollment, 'names'>, address: string): string | null =>
  isIP(address) === 4 ? enrollment.names.lanPattern.replace('{ipv4}', () => address.replaceAll('.', '-')) : null;

/** The IPv6 name for an address: `2001-db8--1.<label>.<domain>`. */
export const ipv6Name = (enrollment: Pick<FrameleafRemoteEnrollment, 'names'>, address: string): string | null => {
  const compressed = compressIpv6(address);
  return compressed ? enrollment.names.ipv6Pattern.replace('{ipv6}', () => compressed.replaceAll(':', '-')) : null;
};

/**
 * The address a per-server name encodes (`192-168-1-10.<label>.<domain>` → `192.168.1.10`), or null
 * for any other name, including the relay name and custom hostnames.
 */
export const addressOfName = (
  enrollment: Pick<FrameleafRemoteEnrollment, 'label' | 'domain'>,
  servername: string | null | undefined,
): string | null => {
  const name = (servername ?? '').toLowerCase().replace(/\.$/, '');
  const suffix = `.${enrollment.label}.${enrollment.domain}`;
  if (!name.endsWith(suffix)) {
    return null;
  }
  const encoded = name.slice(0, -suffix.length);
  if (encoded.includes('.')) {
    return null;
  }
  if (/^\d{1,3}(?:-\d{1,3}){3}$/.test(encoded)) {
    const ipv4 = encoded.replaceAll('-', '.');
    return isIP(ipv4) === 4 ? ipv4 : null;
  }
  return compressIpv6(encoded.replaceAll('-', ':'));
};

/** The certificate names of the wildcard order: `*.<label>.<domain>` and `<label>.<domain>`. */
export const wildcardNames = (enrollment: Pick<FrameleafRemoteEnrollment, 'label' | 'domain'>): string[] => [
  `*.${enrollment.label}.${enrollment.domain}`,
  `${enrollment.label}.${enrollment.domain}`,
];

/**
 * The TXT record name the DNS API accepts for every order of this server, the custom hostname's
 * included: its `_acme-challenge` CNAME delegates to this name.
 */
export const challengeRecordName = (enrollment: Pick<FrameleafRemoteEnrollment, 'label'>): string =>
  `_acme-challenge.${enrollment.label}`;

// ------------------------------------------------------------------ cloud answers

/** A DNS-01 value: base64url SHA-256 of the key authorization (RFC 8555 section 8.4), 43 characters. */
export const ACME_CHALLENGE_VALUE = /^[\w-]{43}$/;

/** `POST /v1/remote/enroll` (contract `remote/enroll.ts`). Unknown fields are ignored. */
export const enrollResponseSchema = z.object({
  label: z.string().regex(/^[2-7a-z]{16}$/),
  domain: z.string().min(3).max(200).refine(isDnsName, 'not a DNS name'),
  status: z.literal('enrolled'),
  names: z.object({
    relay: z.string().max(253),
    lanPattern: z.string().max(253),
    ipv6Pattern: z.string().max(253),
  }),
  relay: z.object({ id: z.string().min(1).max(40), host: z.string().max(253), port: z.number().int() }),
  caa: z.object({
    issue: z.string().max(100),
    validationMethods: z.string().max(100),
    accountUri: z.url().nullable(),
  }),
  certProfile: z.string().min(1).max(40),
  renewBeforeDays: z.number().int().min(1).max(365),
  cloneSuspected: z.boolean(),
});
export type EnrollResponse = z.infer<typeof enrollResponseSchema>;

/**
 * Why an enrolment answer must not be used, or null: its label must be this server's own, and its names
 * must be exactly the ones the label and domain make, so no answer can make this server serve, or
 * ask a CA for, a name that is not its own.
 */
export const enrollmentProblem = (instanceId: string, answer: EnrollResponse): string | null => {
  if (answer.label !== remoteLabel(instanceId)) {
    return 'the enrolment is for another server';
  }
  const base = `${answer.label}.${answer.domain}`;
  if (
    answer.names.relay !== `r.${base}` ||
    // `{ipv4}` and `{ipv6}` are the contract's literal placeholders, not interpolations
    // eslint-disable-next-line unicorn/no-incorrect-template-string-interpolation
    answer.names.lanPattern !== `{ipv4}.${base}` ||
    // eslint-disable-next-line unicorn/no-incorrect-template-string-interpolation
    answer.names.ipv6Pattern !== `{ipv6}.${base}`
  ) {
    return 'the enrolment names do not match its label';
  }
  if (underDomain(answer.domain, 'frameleaf.cloud')) {
    return 'the direct domain is not a per-server domain';
  }
  return null;
};

/** `PUT /v1/remote/dns/txt` answer (contract `remote/dns-txt.ts`). */
export const dnsTxtPutResponseSchema = z.object({
  propagated: z.boolean(),
  servers: z.array(z.object({ name: z.string().max(253), propagated: z.boolean() })).min(1),
  expiresAt: z.string(),
});

/** `PUT /v1/remote/caa` answer. */
export const caaPutResponseSchema = z.object({
  caa: z.object({ accountUri: z.string().nullable() }).loose(),
});

/** An ACME account URL as the CA returns it; it is written into a CAA `accounturi` parameter. */
export const ACME_ACCOUNT_URI = /^https:\/\/[\d.a-z-]+(?::\d{1,5})?\/[\w./~-]+$/;

/** One custom hostname as the cloud reports it (contract `remote/hostnames.ts`). */
export const remoteHostnameSchema = z.object({
  hostname: z.string().max(253),
  state: z.enum(['pending', 'verified', 'failing', 'failed', 'caa_blocked']),
  records: z.array(z.object({ name: z.string().max(253), type: z.literal('CNAME'), value: z.string().max(253) })),
  checkedAt: z.string().nullable(),
  verifiedAt: z.string().nullable(),
  failureReason: z
    .enum([
      'cname_missing',
      'cname_mismatch',
      'acme_cname_missing',
      'acme_cname_mismatch',
      'caa_forbids_letsencrypt',
      'verification_timeout',
      'claimed_elsewhere',
    ])
    .nullable()
    // an unknown reason is shown as no reason rather than refusing the answer
    .catch(null),
});
export type RemoteHostname = z.infer<typeof remoteHostnameSchema>;
export const remoteHostnameListSchema = z.object({ hostnames: z.array(remoteHostnameSchema).max(100) });

/**
 * This server's relay use this month (contract `remote/relay.ts` `RemoteUsageResponse`, `GET
 * /v1/remote/usage`): the UTC calendar month, bytes in and out (custom hostnames included), the
 * allowance the owner's plan gives (`limitBytes`), and the slowdown the cloud applies once it is used up
 * (never a cut-off) with when it lifts.
 */
export const remoteUsageSchema = z.object({
  period: z.string().regex(/^\d{4}-\d{2}$/),
  periodStart: z.iso.datetime({ offset: true }),
  periodEnd: z.iso.datetime({ offset: true }),
  bytes: z.number().int().min(0),
  limitBytes: z.number().int().min(0),
  throttle: z.object({ bps: z.number().int().min(0), until: z.iso.datetime({ offset: true }) }).nullable(),
  days: z
    .array(
      z.object({
        date: z.string(),
        bytesIn: z.number().int().min(0),
        bytesOut: z.number().int().min(0),
        connectionSeconds: z.number().min(0),
      }),
    )
    .max(31),
});
export type RemoteUsage = z.infer<typeof remoteUsageSchema>;

/** Remote access endpoints of the cloud API, from discovery. */
export const remoteEndpoints = (document: { api: string }) => {
  const api = document.api.replace(/\/+$/, '');
  return {
    enroll: `${api}/v1/remote/enroll`,
    dnsTxt: `${api}/v1/remote/dns/txt`,
    caa: `${api}/v1/remote/caa`,
    certs: `${api}/v1/remote/certs`,
    hostnames: `${api}/v1/remote/hostnames`,
    hostname: (host: string) => `${api}/v1/remote/hostnames/${encodeURIComponent(host)}`,
    relayToken: `${api}/v1/remote/relay-token`,
    relayCandidates: `${api}/v1/remote/relays/candidates`,
    relaySelect: `${api}/v1/remote/relays/select`,
    wanProbe: `${api}/v1/remote/wan-probe`,
    usage: `${api}/v1/remote/usage`,
  };
};

/** The direct domain in use: the enrolment's, else discovery's, else the documented default. */
export const directDomainOf = (
  enrollment: Pick<FrameleafRemoteEnrollment, 'domain'> | null | undefined,
  document: { remote?: { directDomain: string } } | null | undefined,
): string => enrollment?.domain ?? document?.remote?.directDomain ?? DEFAULT_DIRECT_DOMAIN;

// ------------------------------------------------------------------ certificates

/** Certificate serials compare as lowercase hex without separators or leading zeros (the cloud agrees). */
export const normalizeSerial = (serial: string) => serial.replaceAll(':', '').replace(/^0+/, '').toLowerCase();

/** The facts of a PEM certificate: its names, serial, issuer and validity. */
export const certificateFacts = (pem: string): Omit<FrameleafEdgeCertificate, 'reported'> => {
  const certificate = new X509Certificate(pem);
  const names = (certificate.subjectAltName ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith('DNS:'))
    .map((entry) => entry.slice(4).toLowerCase());
  return {
    names,
    serial: normalizeSerial(certificate.serialNumber),
    // one line: the contract refuses control characters
    issuer: certificate.issuer
      .split('\n')
      .map((part) => part.trim())
      .filter(Boolean)
      .join(', '),
    notBefore: new Date(certificate.validFrom).toISOString(),
    notAfter: new Date(certificate.validTo).toISOString(),
  };
};

/** Whether a certificate was made for this private key (a pair written half-way does not match). */
export const certificateMatchesKey = (certificatePem: string, keyPem: string): boolean => {
  try {
    return new X509Certificate(certificatePem).checkPrivateKey(createPrivateKey(keyPem));
  } catch {
    return false;
  }
};

/** `POST /v1/remote/certs`: the facts only; the certificate and its key never leave this server. */
export const certificateReport = (facts: Omit<FrameleafEdgeCertificate, 'reported'>) => ({
  serial: facts.serial,
  issuer: facts.issuer.slice(0, 200),
  notBefore: facts.notBefore,
  notAfter: facts.notAfter,
  names: facts.names.slice(0, 20),
});

/** Whether a certificate is due for renewal: less than max(25 days, a third of its lifetime) is left. */
export const renewalDue = (
  certificate: Pick<FrameleafEdgeCertificate, 'notBefore' | 'notAfter'>,
  now = Date.now(),
  renewBeforeDays = 25,
): boolean => {
  const notBefore = Date.parse(certificate.notBefore);
  const notAfter = Date.parse(certificate.notAfter);
  if (!Number.isFinite(notBefore) || !Number.isFinite(notAfter)) {
    return true;
  }
  const window = Math.max(RENEW_BEFORE_MS, renewBeforeDays * DAY_MS, (notAfter - notBefore) / 3);
  return notAfter - now < window;
};

/** When renewal is checked next: a day from now plus up to six hours of jitter. */
export const nextRenewalCheck = (now = Date.now(), random = Math.random): string =>
  new Date(now + RENEWAL_CHECK_MS + Math.floor(random() * RENEWAL_JITTER_MS)).toISOString();

/** How long to wait after the `failures`-th failure in a row: 1 h, 2 h, 4 h … at most 24 h. */
export const retryDelayMs = (failures: number): number =>
  Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** Math.max(0, failures - 1));

// ------------------------------------------------------------------ custom hostnames

export type HostnameCheck = { valid: boolean; host: string; message: string };

/**
 * A hostname the administrator owns, such as `photos.example.com` (prototype `validateCustomHostname`):
 * no scheme or path, at least three labels, and never under Frameleaf's own domains or the direct
 * domain in use.
 */
export const validateCustomHostname = (value: unknown, directDomain = DEFAULT_DIRECT_DOMAIN): HostnameCheck => {
  const host = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');
  if (!host) {
    return { valid: false, host, message: 'Enter a hostname such as photos.example.com.' };
  }
  if (/^[a-z]+:\/\//.test(host) || host.includes('/')) {
    return { valid: false, host, message: 'Enter only the hostname, without https:// or a path.' };
  }
  if (host.split('.').length < 3 || !isDnsName(host)) {
    return { valid: false, host, message: 'Use a subdomain you own, such as photos.example.com.' };
  }
  if ([...RESERVED_DOMAINS, directDomain].some((domain) => underDomain(host, domain))) {
    return { valid: false, host, message: 'Use a domain you own; Frameleaf addresses are already set up.' };
  }
  return { valid: true, host, message: '' };
};

export type CustomHostnameRecord = { type: 'CNAME'; name: string; value: string; purpose: string };

/** The two records the administrator adds at their DNS provider (prototype `customHostnameRecords`). */
export const customHostnameRecords = (
  host: string,
  enrollment: Pick<FrameleafRemoteEnrollment, 'label' | 'domain'>,
): CustomHostnameRecord[] => [
  {
    type: 'CNAME',
    name: host,
    value: `r.${enrollment.label}.${enrollment.domain}`,
    purpose: 'Sends visitors to your server through Frameleaf.',
  },
  {
    type: 'CNAME',
    name: `_acme-challenge.${host}`,
    value: `_acme-challenge.${enrollment.label}.${enrollment.domain}`,
    purpose: 'Lets this server renew its own certificate for your domain.',
  },
];

/** What the cloud's hostname states mean for the setting: routed hostnames count as verified. */
export const hostnameStatus = (state: RemoteHostname['state']): 'pending' | 'verified' =>
  state === 'verified' || state === 'failing' ? 'verified' : 'pending';

/** Why a hostname is not verified yet, in plain words. */
export const hostnameProblem = (hostname: Pick<RemoteHostname, 'state' | 'failureReason'>): string | null => {
  switch (hostname.failureReason) {
    case 'cname_missing': {
      return 'The CNAME record for the hostname is not visible yet.';
    }
    case 'cname_mismatch': {
      return 'The CNAME record for the hostname points somewhere else.';
    }
    case 'acme_cname_missing': {
      return 'The _acme-challenge CNAME record is not visible yet.';
    }
    case 'acme_cname_mismatch': {
      return 'The _acme-challenge CNAME record points somewhere else.';
    }
    case 'caa_forbids_letsencrypt': {
      return 'A CAA record on your domain does not allow Let’s Encrypt certificates.';
    }
    case 'verification_timeout': {
      return 'The records could not be found for seven days. Add them and add the hostname again.';
    }
    case 'claimed_elsewhere': {
      return 'The records point to another server.';
    }
    case null: {
      break;
    }
  }
  if (hostname.state === 'failed') {
    return 'The hostname stopped pointing to this server. Add it again once its records are back.';
  }
  if (hostname.state === 'caa_blocked') {
    return 'A CAA record on your domain does not allow Let’s Encrypt certificates.';
  }
  return null;
};

// ------------------------------------------------------------------ availability

/**
 * Why remote access cannot be turned on, or null when it can (prototype `remoteAvailability`): it
 * needs Frameleaf Cloud set up, a linked server and an active or grace remote access entitlement.
 */
export const remoteAccessUnavailable = async (
  deps: Pick<CloudGatewayDeps, 'configRepository' | 'systemMetadataRepository'>,
  now = Date.now(),
): Promise<string | null> => {
  const { cloudUrl, linked } = await readCloudLink(deps);
  if (!cloudUrl) {
    return 'Frameleaf Cloud is not set up on this server.';
  }
  if (!linked) {
    return 'Link this server to a Frameleaf account first.';
  }
  const licenses = await deps.systemMetadataRepository.get(SystemMetadataKey.FrameleafLicense);
  if (!entitlementFlags([licenses?.key, licenses?.plan], now).remoteAccess) {
    return 'Remote access is included with a Frameleaf Cloud plan.';
  }
  return null;
};

// ------------------------------------------------------------------ public URL and candidates

type RemoteSettings = {
  mode: 'relay' | 'relay-and-direct';
  directPort: number;
  publicUrl: 'frameleaf' | 'custom';
  customHostname: { host: string; status: 'pending' | 'verified' };
};

/** The verified custom hostname, or null. */
export const verifiedCustomHost = (settings: Pick<RemoteSettings, 'customHostname'>): string | null =>
  settings.customHostname.status === 'verified' && settings.customHostname.host ? settings.customHostname.host : null;

/**
 * The address this server publishes for remote access: the verified custom hostname when "Use my
 * domain" is chosen, else `https://r.<label>.<domain>`; null before enrolment.
 */
export const remotePublicUrl = (
  enrollment: Pick<FrameleafRemoteEnrollment, 'names'> | null | undefined,
  settings: Pick<RemoteSettings, 'publicUrl' | 'customHostname'>,
): string | null => {
  if (!enrollment) {
    return null;
  }
  const custom = verifiedCustomHost(settings);
  return settings.publicUrl === 'custom' && custom ? `https://${custom}` : `https://${enrollment.names.relay}`;
};

/** Whether an address is a public (global unicast) IPv6 address. */
const isGlobalIpv6 = (address: string) => isIP(address) === 6 && /^[23][\da-f]{0,3}:/i.test(address);

const withPort = (host: string, port: number) => (port === 443 ? `https://${host}` : `https://${host}:${port}`);

const connection = (
  kind: FrameleafRemoteConnection['kind'],
  address: string,
  port: number,
  flags: Partial<Pick<FrameleafRemoteConnection, 'local' | 'relay' | 'ipv6' | 'custom'>> = {},
): FrameleafRemoteConnection => ({
  kind,
  uri: withPort(address, port),
  protocol: 'https',
  address,
  port,
  local: flags.local ?? false,
  relay: flags.relay ?? false,
  ipv6: flags.ipv6 ?? false,
  custom: flags.custom ?? false,
  // this server does not refuse requests for another Host; routers with DNS rebinding protection may
  // still refuse to resolve the LAN names, which apps handle by decoding the address from the name
  dnsRebindingProtection: false,
  httpsRequired: true,
  verified: false,
});

/** The most candidates a server publishes (the heartbeat carries at most 16). */
export const MAX_CANDIDATES = 16;

/**
 * Connection candidates in preference order: local (LAN names), wan (a public IPv4 once a mapping is
 * known), ipv6, the verified custom hostname, then the relay (the cloud's `CONNECTION_ORDER`). Direct
 * WAN and IPv6 entries are published only in "Relay and direct" mode.
 */
export const buildCandidates = (input: {
  enrollment: Pick<FrameleafRemoteEnrollment, 'names'>;
  settings: RemoteSettings;
  listenPort: number;
  lanAddresses: string[];
  ipv6Addresses: string[];
  /** Whether the listener accepts IPv6 at all (bound to `::` or an IPv6 address). */
  ipv6Listening?: boolean;
  publicIpv4?: string | null;
  trustedLanCidrs?: string[];
  /** The relay tunnel is READY: only then are the relay name and the custom hostname published (FL-166). */
  relayConnected?: boolean;
  /** The public port direct connections reach (the router's, FL-167); the configured one by default. */
  wanPort?: number;
  /** The WAN name Frameleaf Cloud's probe reached (FL-167); any other WAN entry is published unverified. */
  wanVerifiedUri?: string | null;
}): FrameleafRemoteConnection[] => {
  const { enrollment, settings } = input;
  const direct = settings.mode === 'relay-and-direct';
  const candidates: FrameleafRemoteConnection[] = [];
  for (const address of input.lanAddresses) {
    const name = isHomeAddress(address, input.trustedLanCidrs ?? []) ? ipv4Name(enrollment, address) : null;
    if (name) {
      candidates.push(connection('local', name, input.listenPort, { local: true }));
    }
  }
  if (direct && input.publicIpv4 && !isHomeAddress(input.publicIpv4, [])) {
    const name = ipv4Name(enrollment, input.publicIpv4);
    if (name) {
      const wan = connection('wan', name, input.wanPort ?? settings.directPort);
      candidates.push({ ...wan, verified: !!input.wanVerifiedUri && wan.uri === input.wanVerifiedUri });
    }
  }
  // IPv6 has no router mapping: the listener's own port is the one visitors connect to
  if (direct && input.ipv6Listening) {
    for (const address of input.ipv6Addresses) {
      const name = isGlobalIpv6(address) ? ipv6Name(enrollment, address) : null;
      if (name) {
        candidates.push(connection('ipv6', name, input.listenPort, { ipv6: true }));
      }
    }
  }
  if (input.relayConnected === false) {
    return candidates.slice(0, MAX_CANDIDATES);
  }
  const custom = verifiedCustomHost(settings);
  if (custom) {
    candidates.push(connection('wan', custom, 443, { relay: true, custom: true }));
  }
  candidates.push(connection('relay', enrollment.names.relay, 443, { relay: true }));
  if (candidates.length <= MAX_CANDIDATES) {
    return candidates;
  }
  // the relay is always published, whatever else is cut
  return [...candidates.slice(0, MAX_CANDIDATES - 1), candidates.at(-1)!];
};

/** The heartbeat's `endpoints` for the candidates (kind `custom` for a custom hostname). */
export const heartbeatEndpoints = (candidates: FrameleafRemoteConnection[]) =>
  candidates.map((candidate) => ({ kind: candidate.custom ? 'custom' : candidate.kind, url: candidate.uri }));

/** Whether the edge worker's state is recent enough to be believed (it writes every 10 s while serving). */
export const edgeStateCurrent = (state: Pick<FrameleafRemoteAccess, 'updatedAt'> | null, now = Date.now()) =>
  !!state && now - Date.parse(state.updatedAt) < EDGE_STATE_STALE_MS;

// ------------------------------------------------------------------ this host's addresses

/** Interfaces that are never the home network: container bridges, virtual machines, tunnels. */
const VIRTUAL_INTERFACE =
  /^(?:docker|br-|veth|virbr|vnet|cni|flannel|cali|weave|vxlan|kube|lxc|lxd|podman|tun|tap|wg|zt|tailscale|vmnet|vboxnet|utun)/;

export type HostInterface = { name: string; address: string; family: 'IPv4' | 'IPv6'; internal: boolean };

/**
 * The addresses this server publishes LAN (and IPv6) names for, which are also the only addresses
 * that can make a direct arrival `lan`:
 *
 * - `FRAMELEAF_LOCAL_URL`, when its host is an IPv4 address, is the one LAN address;
 * - otherwise, in a container, none: its own interfaces are on a bridge other containers share;
 * - otherwise (bare metal) the addresses of the default-route interface, never a container bridge,
 *   virtual machine or tunnel interface.
 */
export const hostAddresses = (input: {
  localUrl: string | null;
  inContainer: boolean;
  interfaces: HostInterface[];
  defaultInterfaces: string[];
}): { lanAddresses: string[]; ipv6Addresses: string[] } => {
  const localHost = input.localUrl ? new URL(input.localUrl).hostname : null;
  if (localHost && isIP(localHost) === 4) {
    return { lanAddresses: [localHost], ipv6Addresses: [] };
  }
  if (input.inContainer) {
    return { lanAddresses: [], ipv6Addresses: [] };
  }
  const usable = input.interfaces.filter(
    (entry) => !entry.internal && !VIRTUAL_INTERFACE.test(entry.name) && input.defaultInterfaces.includes(entry.name),
  );
  return {
    lanAddresses: usable.filter((entry) => entry.family === 'IPv4').map((entry) => entry.address),
    ipv6Addresses: usable.filter((entry) => entry.family === 'IPv6').map((entry) => entry.address.split('%', 1)[0]),
  };
};

/** Whether this process is running inside a container (Docker/Podman). */
export const inContainer = (): boolean => existsSync('/.dockerenv') || existsSync('/run/.containerenv');

/** The interfaces the default routes use (Linux `/proc/net/route` and `ipv6_route`). Specs replace it. */
export const defaultRouteInterfaces = (): string[] => {
  const names = new Set<string>();
  try {
    for (const line of readFileSync('/proc/net/route', 'utf8').split('\n').slice(1)) {
      const [name, destination] = line.trim().split(/\s+/, 2);
      if (destination === '00000000' && name) {
        names.add(name);
      }
    }
    for (const line of readFileSync('/proc/net/ipv6_route', 'utf8').split('\n')) {
      const fields = line.trim().split(/\s+/);
      if (fields[0] === '0'.repeat(32) && fields[1] === '00' && fields[9] && fields[9] !== 'lo') {
        names.add(fields[9]);
      }
    }
  } catch {
    // not Linux: no LAN names are published unless FRAMELEAF_LOCAL_URL names the address
  }
  return [...names];
};

/**
 * `hostAddresses` fed from this process's real interfaces - the one call site FL-229's LAN discovery
 * and the edge worker's own address detection (`EdgeStateService.addresses`) both use, so a change to
 * what counts as "this server's LAN address" (container detection, virtual-interface filtering,
 * `FRAMELEAF_LOCAL_URL` override) only has to be made once.
 */
export const detectHostAddresses = (localUrl: string | null): { lanAddresses: string[]; ipv6Addresses: string[] } => {
  const interfaces = Object.entries(networkInterfaces()).flatMap(([name, entries]) =>
    (entries ?? []).map(({ address, family, internal }) => ({ name, address, family, internal })),
  );
  return hostAddresses({
    localUrl,
    inContainer: inContainer(),
    interfaces,
    defaultInterfaces: defaultRouteInterfaces(),
  });
};

// ------------------------------------------------------------------ arrivals

/**
 * The address a visitor's connections are counted by: IPv4 as it is (an IPv4-mapped IPv6 address as
 * IPv4), IPv6 by its /64, since one household usually holds a whole /64.
 */
export const addressBucket = (address: string | undefined | null): string => {
  const value = (address ?? '').trim().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');
  if (isIP(value) === 4) {
    return value;
  }
  const compressed = compressIpv6(value.split('%', 1)[0]);
  if (!compressed) {
    return 'unknown';
  }
  const [head, tail = ''] = compressed.split('::', 2);
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = compressed.includes('::')
    ? [...left, ...Array.from({ length: 8 - left.length - right.length }, () => '0'), ...right]
    : left;
  return `${groups.slice(0, 4).join(':')}::/64`;
};

const normalizeAddress = (address: string | null | undefined): string | null => {
  const value = (address ?? '').trim().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');
  if (isIP(value) === 4) {
    return value;
  }
  return compressIpv6(value.split('%', 1)[0]);
};

/** A loopback peer: this host itself (the self-check), or a proxy that hides every visitor's address. */
export const isLoopbackPeer = (address: string | null | undefined): boolean =>
  /^127\.|^::1$/.test(normalizeAddress(address) ?? '');

/** Whether an address is inside one of the given networks (only those). */
const inCidrs = (address: string, cidrs: string[]): boolean => {
  const family = isIP(address);
  if (!family || cidrs.length === 0) {
    return false;
  }
  const list = new BlockList();
  for (const cidr of cidrs) {
    const [network, prefix] = cidr.split('/', 2);
    list.addSubnet(network, Number(prefix), isIP(network) === 6 ? 'ipv6' : 'ipv4');
  }
  return list.check(address, family === 6 ? 'ipv6' : 'ipv4');
};

/** Whether two addresses share a /24 (IPv4) or a /64 (IPv6). */
export const sameSubnet = (a: string, b: string): boolean => {
  const left = normalizeAddress(a);
  const right = normalizeAddress(b);
  if (!left || !right || isIP(left) !== isIP(right)) {
    return false;
  }
  if (isIP(left) === 4) {
    return left.split('.').slice(0, 3).join('.') === right.split('.').slice(0, 3).join('.');
  }
  return addressBucket(left) === addressBucket(right);
};

/**
 * How a direct connection arrived (instance contract "Via-header contract"). `lan` needs all of:
 *
 * - the SNI names one of the LAN addresses this edge worker advertised (`advertised`) — the name alone
 *   proves nothing, since a client chooses it;
 * - the peer is on the home network (RFC 1918, ULA, loopback or `FRAMELEAF_TRUSTED_LAN_CIDRS`);
 * - the peer shares that address's /24 (IPv4) or /64 (IPv6), or is inside `FRAMELEAF_TRUSTED_LAN_CIDRS`;
 * - the peer is not the container's own gateway (`gateways`): behind Docker's userland proxy or
 *   slirp4netns every visitor arrives from that address, so it counts as home only when an
 *   administrator listed it in `FRAMELEAF_TRUSTED_LAN_CIDRS`.
 *
 * A device on the home network that forwards internet traffic with source NAT (a router's port
 * forward that rewrites the source, a VPN endpoint, a TCP proxy) makes visitors look like neighbours:
 * such a forwarder must not sit on the advertised /24 (see the edge worker's documentation).
 *
 * A loopback peer is never `lan`: a proxy on the host can make every visitor look like one. Anything
 * else is `wan`. Being wrong in that direction only asks a visitor to sign in with Frameleaf; the
 * other direction would skip it.
 */
export const classifyArrival = (input: {
  peer: string | undefined;
  servername: string | null | undefined;
  enrollment: Pick<FrameleafRemoteEnrollment, 'label' | 'domain'>;
  trustedLanCidrs: string[];
  advertised: string[];
  gateways?: string[];
}): 'lan' | 'wan' => {
  const peer = normalizeAddress(input.peer);
  const named = normalizeAddress(addressOfName(input.enrollment, input.servername));
  if (!peer || !named) {
    return 'wan';
  }
  if (isLoopbackPeer(peer)) {
    return 'wan';
  }
  const explicitlyTrusted = inCidrs(peer, input.trustedLanCidrs);
  if (!isHomeAddress(peer, input.trustedLanCidrs)) {
    return 'wan';
  }
  if ((input.gateways ?? []).some((gateway) => normalizeAddress(gateway) === peer) && !explicitlyTrusted) {
    return 'wan';
  }
  if (input.advertised.every((address) => normalizeAddress(address) !== named)) {
    return 'wan';
  }
  return sameSubnet(peer, named) || explicitlyTrusted ? 'lan' : 'wan';
};
