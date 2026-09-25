import { randomUUID, timingSafeEqual } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import { type ClientAuth, ClientSecretPost } from 'openid-client';
import type { IncomingHttpHeaders } from 'node:http';
import type { SystemConfig } from 'src/config.js';
import type { OAuthConfig, OAuthProfile } from 'src/repositories/oauth.repository.js';
import type { FrameleafCloudLink } from 'src/types.js';
import { OAuthTokenEndpointAuthMethod } from 'src/enum.js';
import { cloudAddressProblem } from 'src/utils/frameleaf-cloud.js';
import { CloudGatewayDeps, loadInstanceIdentity, readCloudLink } from 'src/utils/frameleaf-cloud-gateway.js';

/**
 * Sign in with Frameleaf (FL-158, CLD-005): a second OpenID Connect provider slot beside the
 * administrator's own. Its `OAuthConfig` is derived at runtime from the Frameleaf Cloud link, never
 * read from or written to the `oauth.*` settings:
 *
 * - issuer and client from the link (`clientId` = this server's instance id);
 * - scope `openid email profile`, role claim `frameleaf_role`, no storage label claim;
 * - client authentication by a `private_key_jwt` assertion signed with this server's identity key,
 *   or the write-only client secret when the cloud registered the server with one;
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

/** `admin` or `user` from the `frameleaf_role` claim, or null when the cloud sent neither. */
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
export const frameleafOAuthConfig = async (
  deps: CloudGatewayDeps,
  config: SystemConfig,
): Promise<OAuthConfig | null> => {
  const { cloudUrl, link, linked } = await readCloudLink(deps);
  const client = signInClient(link, linked);
  // the issuer must be the configured cloud's, like every address the cloud hands over
  if (!cloudUrl || !client || cloudAddressProblem(cloudUrl, 'sign-in issuer', client.issuer)) {
    return null;
  }
  const clientSecret = config.frameleafCloud.signIn?.clientSecret ?? '';
  let clientAuth: ClientAuth;
  if (clientSecret) {
    clientAuth = ClientSecretPost(clientSecret);
  } else {
    const identity = await loadInstanceIdentity(deps);
    clientAuth = (as, _client, body) => {
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
  }
  return {
    clientId: client.clientId,
    clientSecret: clientSecret || undefined,
    issuerUrl: client.issuer,
    accountManagementUrl: '',
    endSessionEndpoint: '',
    mobileOverrideEnabled: false,
    mobileRedirectUri: '',
    profileSigningAlgorithm: 'none',
    prompt: '',
    scope: client.scope || FRAMELEAF_SCOPE,
    signingAlgorithm: 'RS256',
    tokenEndpointAuthMethod: OAuthTokenEndpointAuthMethod.ClientSecretPost,
    timeout: 10_000,
    // only a deployment that configured an http Frameleaf Cloud address (development) allows http
    allowInsecureRequests: cloudUrl.startsWith('http://'),
    clientAuth,
  };
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
  const via = header(headers, 'x-frameleaf-via');
  const auth = header(headers, 'x-frameleaf-via-auth');
  if (!edgeSecret || !via || !auth || !VIAS.has(via as FrameleafVia)) {
    return null;
  }
  const expected = Buffer.from(edgeSecret);
  const given = Buffer.from(auth);
  return expected.length === given.length && timingSafeEqual(expected, given) ? (via as FrameleafVia) : null;
};

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
