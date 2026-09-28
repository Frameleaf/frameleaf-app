import { randomUUID, timingSafeEqual } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import { type ClientAuth } from 'openid-client';
import type { IncomingHttpHeaders } from 'node:http';
import type { OAuthConfig, OAuthProfile } from 'src/repositories/oauth.repository.js';
import type { FrameleafCloudLink } from 'src/types.js';
import { ImmichHeader, OAuthTokenEndpointAuthMethod } from 'src/enum.js';
import { CloudGatewayDeps, loadInstanceIdentity, readCloudLink } from 'src/utils/frameleaf-cloud-gateway.js';
import { cloudAddressProblem } from 'src/utils/frameleaf-cloud.js';

/**
 * Sign in with Frameleaf (FL-158, CLD-005): a second OpenID Connect provider slot beside the
 * administrator's own. Its `OAuthConfig` is derived at runtime from the Frameleaf Cloud link, never
 * read from or written to the `oauth.*` settings:
 *
 * - issuer and client from the link (`clientId` = this server's instance id);
 * - scope `openid email profile`, role claim `frameleaf_role`, no storage label claim;
 * - client authentication by a `private_key_jwt` assertion signed with this server's identity key
 *   only; Frameleaf Cloud never issues a client secret to a server (FL-177);
 * - PKCE S256 when the issuer advertises it (the OAuth repository does that).
 */

export const FRAMELEAF_ROLE_CLAIM = 'frameleaf_role';
export const FRAMELEAF_SCOPE = 'openid email profile';
/** The Frameleaf app's callback (instance contract step 5). */
export const FRAMELEAF_APP_CALLBACK = 'frameleaf-auth:///oauth-callback';

/** Callbacks registered for this server (instance contract step 5), by path. */
const WEB_CALLBACK_PATHS = new Set(['/auth/login', '/user-settings', '/link', '/api/oauth/mobile-redirect']);
const APP_CALLBACKS = new Set([FRAMELEAF_APP_CALLBACK, 'app.immich:///oauth-callback', 'app.immich:/oauth-callback']);

/**
 * The redirect a Frameleaf sign-in may use: one of the web callbacks registered for this server, or
 * the Frameleaf app's callback (the older app scheme is rewritten to it). Anything else is refused.
 */
export const frameleafRedirectUri = (value: string): string | null => {
  if (APP_CALLBACKS.has(value)) {
    return FRAMELEAF_APP_CALLBACK;
  }
  try {
    const url = new URL(value);
    if ((url.protocol === 'https:' || url.protocol === 'http:') && WEB_CALLBACK_PATHS.has(url.pathname)) {
      return `${url.origin}${url.pathname}`;
    }
  } catch {
    // fall through
  }
  return null;
};

/** The callback URL a sign-in finished on, with the Frameleaf app scheme normalised. */
export const frameleafCallbackUrl = (value: string): string => {
  for (const scheme of ['app.immich:///oauth-callback', 'app.immich:/oauth-callback']) {
    if (value.startsWith(scheme)) {
      return FRAMELEAF_APP_CALLBACK + value.slice(scheme.length);
    }
  }
  return value;
};

/**
 * `admin` or `user` from the `frameleaf_role` claim, or null when the cloud sent neither. It is
 * applied on every Sign in with Frameleaf to every linked account (FL-177, as-built decision #32).
 * `frameleaf_access` (`owner`, `admin`, `editor`, `viewer`) is informational in this version: nothing
 * on this server is granted from it beyond what `frameleaf_role` grants.
 */
export const frameleafRole = (profile: OAuthProfile): 'admin' | 'user' | null => {
  const value = profile[FRAMELEAF_ROLE_CLAIM as keyof OAuthProfile];
  return value === 'admin' || value === 'user' ? value : null;
};

/** The link's OpenID client, when this server is linked and the cloud registered one. */
export const signInClient = (link: FrameleafCloudLink | null, linked: boolean) =>
  linked && link?.status === 'linked' && link.oidc?.issuer && link.oidc.clientId ? link.oidc : null;

/**
 * The runtime `OAuthConfig` for Sign in with Frameleaf, or null when the server is not configured
 * or not linked. Nothing here reads the `oauth.*` settings.
 */
export const frameleafOAuthConfig = async (deps: CloudGatewayDeps): Promise<OAuthConfig | null> => {
  const { cloudUrl, link, linked } = await readCloudLink(deps);
  const client = signInClient(link, linked);
  // the issuer must be the configured cloud's, like every address the cloud hands over
  if (!cloudUrl || !client || cloudAddressProblem(cloudUrl, 'sign-in issuer', client.issuer)) {
    return null;
  }
  const identity = await loadInstanceIdentity(deps);
  // FL-177 (as-built decision #10): the key is the only client credential; no client secret exists
  const clientAuth: ClientAuth = (as, _client, body) => {
    const now = Math.floor(Date.now() / 1000);
    body.set('client_id', client.clientId);
    body.set('client_assertion_type', 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
    body.set(
      'client_assertion',
      deps.instanceIdentityRepository.signJws(identity.kid, {
        iss: client.clientId,
        sub: client.clientId,
        aud: as.token_endpoint ?? as.issuer,
        jti: randomUUID(),
        iat: now,
        exp: now + 120,
      }),
    );
  };
  return {
    clientId: client.clientId,
    issuerUrl: client.issuer,
    accountManagementUrl: '',
    // RP-initiated logout uses the issuer's advertised end_session_endpoint (frameleafLogoutUrl)
    endSessionEndpoint: '',
    mobileOverrideEnabled: false,
    mobileRedirectUri: '',
    profileSigningAlgorithm: 'none',
    prompt: '',
    scope: client.scope || FRAMELEAF_SCOPE,
    // the issuer's advertised ID token algorithms (RS256 today, EdDSA accepted too), never a fixed one
    signingAlgorithm: '',
    tokenEndpointAuthMethod: OAuthTokenEndpointAuthMethod.ClientSecretPost,
    timeout: 10_000,
    // only a deployment that configured an http Frameleaf Cloud address (development) allows http
    allowInsecureRequests: cloudUrl.startsWith('http://'),
    clientAuth,
  };
};

/**
 * FL-177 (as-built decision #32): where signing out sends a person who signed in with Frameleaf, so
 * their Frameleaf session ends too (RP-initiated logout): the issuer's advertised
 * `end_session_endpoint` with `client_id` and, when the session kept its ID token, `id_token_hint`.
 * Null when the issuer advertises none, or advertises one outside the configured cloud.
 */
export const frameleafLogoutUrl = (
  cloudUrl: string,
  endSessionEndpoint: string | null | undefined,
  clientId: string,
  idToken?: string | null,
): string | null => {
  if (!endSessionEndpoint || cloudAddressProblem(cloudUrl, 'sign-in logout endpoint', endSessionEndpoint)) {
    return null;
  }
  const url = new URL(endSessionEndpoint);
  url.searchParams.set('client_id', clientId);
  if (idToken) {
    url.searchParams.set('id_token_hint', idToken);
  }
  return url.href;
};

/** The audiences a logout token names, read without verifying it (only to pick the provider). */
export const logoutTokenAudiences = (token: string): string[] => {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.', 3)[1] ?? '', 'base64url').toString('utf8')) as {
      aud?: unknown;
    };
    const aud = payload.aud;
    return Array.isArray(aud)
      ? aud.filter((value): value is string => typeof value === 'string')
      : typeof aud === 'string'
        ? [aud]
        : [];
  } catch {
    return [];
  }
};

export type FrameleafVia = 'lan' | 'wan' | 'relay';

export const httpsOrigin = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
};

/**
 * FL-161: the address Frameleaf Cloud published for a linked server: its public URL (a verified
 * custom hostname) or else its relay origin, https only. Callers check that the server is linked.
 */
export const frameleafPublicUrl = (link: FrameleafCloudLink | null): string | null =>
  httpsOrigin(link?.services?.publicUrl) ?? httpsOrigin(link?.services?.relayOrigin);

/** FL-161: whether an arrival is remote access (the relay, or a direct connection from outside the home). */
export const isRemoteVia = (via: FrameleafVia | null | undefined): via is 'wan' | 'relay' =>
  via === 'relay' || via === 'wan';

const VIAS = new Set<FrameleafVia>(['lan', 'wan', 'relay']);
/** RFC 1918, loopback and IPv6 unique-local addresses are always home (FRAMELEAF_TRUSTED_LAN_CIDRS adds more). */
const HOME_NETWORKS = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8', 'fc00::/7', '::1/128'];

const header = (headers: IncomingHttpHeaders, name: string) => {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
};

/**
 * How a request arrived (instance contract "Via-header contract"): `X-Frameleaf-Via` counts only
 * when `X-Frameleaf-Via-Auth` carries the edge worker's per-boot secret; anything else, including a
 * client-supplied header, is an arrival the server cannot vouch for (`null`).
 */
export const frameleafVia = (headers: IncomingHttpHeaders, edgeSecret: string | null): FrameleafVia | null => {
  const via = header(headers, ImmichHeader.FrameleafVia);
  const auth = header(headers, ImmichHeader.FrameleafViaAuth);
  if (!edgeSecret || !via || !auth || !VIAS.has(via as FrameleafVia)) {
    return null;
  }
  const expected = Buffer.from(edgeSecret);
  const given = Buffer.from(auth);
  return expected.length === given.length && timingSafeEqual(expected, given) ? (via as FrameleafVia) : null;
};

/**
 * FL-161: whether a request claims an arrival (either via header). A claim without the edge worker's
 * secret is refused, never treated as a request from home.
 */
export const claimsFrameleafVia = (headers: IncomingHttpHeaders): boolean =>
  header(headers, ImmichHeader.FrameleafVia) !== undefined ||
  header(headers, ImmichHeader.FrameleafViaAuth) !== undefined;

/** Whether an address is on the home network: private ranges plus FRAMELEAF_TRUSTED_LAN_CIDRS. */
export const isHomeAddress = (address: string | undefined, trustedLanCidrs: string[]): boolean => {
  const ip = address?.replace(/^::ffff:/, '');
  const family = isIP(ip ?? '');
  if (!ip || !family) {
    return false;
  }
  const list = new BlockList();
  for (const cidr of [...HOME_NETWORKS, ...trustedLanCidrs]) {
    const [network, prefix] = cidr.split('/', 2);
    list.addSubnet(network, Number(prefix), isIP(network) === 6 ? 'ipv6' : 'ipv4');
  }
  return list.check(ip, family === 6 ? 'ipv6' : 'ipv4');
};
