import { Permission } from 'src/enum.js';

/**
 * FL-803 (E3-03): connected apps sign in through OAuth 2.1 (authorization code with PKCE S256,
 * no implicit or password grants). These are the rules the authorization server applies; the
 * threat model is on FL-780.
 */

/** An authorization code can be exchanged for five minutes, once. */
export const OAUTH_CODE_TTL_SECONDS = 5 * 60;
/** An access token lasts an hour; the app refreshes it while it is used. */
export const OAUTH_ACCESS_TTL_SECONDS = 60 * 60;
/** "Last used" (and the activity log's "used" row) is written at most this often per app. */
export const OAUTH_USE_RECORD_INTERVAL_MS = 60 * 60 * 1000;
/** At most this many self-registered apps are kept; unused ones are tidied away first. */
export const OAUTH_DYNAMIC_CLIENT_LIMIT = 500;

/**
 * Prefixes that tell app tokens apart from session tokens, which are base64 without `_`. An
 * `Authorization: Bearer fla_…` is always checked as an app's access token, never as a session.
 */
export const MCP_PATH = '/api/mcp';
export const MCP_RESOURCE_METADATA_PATH = `/.well-known/oauth-protected-resource${MCP_PATH}`;
export const OAUTH_ACCESS_TOKEN_PREFIX = 'fla_';
export const OAUTH_REFRESH_TOKEN_PREFIX = 'flr_';

export const isOAuthAccessToken = (token: string | null | undefined): token is string =>
  typeof token === 'string' && token.startsWith(OAUTH_ACCESS_TOKEN_PREFIX);

/**
 * What an app may ask for, each mapped onto the permissions API keys already use. Locked items are
 * never a scope: app tokens have no session, so they can never be unlocked, and every read already
 * leaves Locked and rule-hidden items out for them. Nothing here reaches an admin route, sharing,
 * deleting, sign-in or Trash. Anything not listed is refused (`invalid_scope`), never guessed.
 */
export const OAUTH_APP_SCOPES = Object.freeze({
  /** See photos, videos, albums, memories, tags and places, and search them. */
  'library:read': [
    Permission.AssetRead,
    // FL-866: how many photos and videos there are (Home Assistant's sensors); counts only
    Permission.AssetStatistics,
    Permission.AssetView,
    Permission.AlbumRead,
    Permission.TimelineRead,
    Permission.MemoryRead,
    Permission.MapRead,
    Permission.TagRead,
    Permission.StackRead,
  ],
  /** Download original files. */
  'library:download': [Permission.AssetDownload],
  /** Make new albums and add photos to albums (no renaming, removing, sharing or deleting). */
  'albums:write': [Permission.AlbumCreate, Permission.AlbumAssetCreate],
  /** Make tags and tag photos. */
  'tags:write': [Permission.TagCreate, Permission.TagAsset],
  /** See the names of people and pets the person named. */
  'people:read': [Permission.PersonRead],
} satisfies Record<string, Permission[]>);

export type OAuthAppScope = keyof typeof OAUTH_APP_SCOPES;
export const OAUTH_SCOPES_SUPPORTED = Object.keys(OAUTH_APP_SCOPES) as OAuthAppScope[];
/** What an app gets when it names no scope: seeing the library, nothing more. */
export const OAUTH_DEFAULT_SCOPES: OAuthAppScope[] = ['library:read'];

/**
 * Splits a `scope` parameter (space-separated, RFC 6749 §3.3). `unknown` holds anything this server
 * does not offer; a request with any unknown scope is refused as a whole.
 */
export const parseScopes = (value: unknown): { scopes: OAuthAppScope[]; unknown: string[] } => {
  if ([undefined, null, ''].includes(value as string)) {
    return { scopes: [...OAUTH_DEFAULT_SCOPES], unknown: [] };
  }
  if (typeof value !== 'string' || value.length > 1000) {
    return { scopes: [], unknown: [String(value).slice(0, 100)] };
  }
  const names = [...new Set(value.split(' ').filter(Boolean))];
  const scopes = new Set(names.filter((name): name is OAuthAppScope => Object.hasOwn(OAUTH_APP_SCOPES, name)));
  const unknown = names.filter((name) => !Object.hasOwn(OAUTH_APP_SCOPES, name));
  return { scopes: OAUTH_SCOPES_SUPPORTED.filter((scope) => scopes.has(scope)), unknown };
};

/** The permissions a set of granted scopes carries; unknown scope names carry nothing. */
export const scopePermissions = (scopes: readonly string[]): Permission[] => [
  ...new Set(
    scopes.flatMap((scope) => (Object.hasOwn(OAUTH_APP_SCOPES, scope) ? OAUTH_APP_SCOPES[scope as OAuthAppScope] : [])),
  ),
];

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);

const parseUrl = (value: unknown): URL | null => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2000 || /[\s\\]/.test(value)) {
    return null;
  }
  try {
    return new URL(value);
  } catch {
    return null;
  }
};

/**
 * A return address an app may register: `https://` anywhere, or `http://` on a loopback address
 * (127.0.0.1, [::1] or localhost) for apps on the person's own computer (RFC 8252 §7.3). No user
 * name or password, no fragment, no dot segments or encoded slashes, and already in canonical form
 * so it can be compared exactly. Returns the address or null.
 */
export const checkRegisteredRedirectUri = (value: unknown): string | null => {
  const url = parseUrl(value);
  if (!url || typeof value !== 'string') {
    return null;
  }
  const loopback = url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
  if (
    !(url.protocol === 'https:' || loopback) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.hash ||
    value.includes('#') ||
    /%2[ef]|%5c/i.test(url.pathname) ||
    url.pathname.split('/').some((part) => part === '.' || part === '..') ||
    url.href !== value
  ) {
    return null;
  }
  return url.href;
};

/**
 * Whether the return address in a request matches one the app registered: exactly, except that
 * an app on a loopback address may use any port (its listener picks one when it starts).
 */
export const matchRedirectUri = (registered: readonly string[], requested: unknown): string | null => {
  if (typeof requested !== 'string') {
    return null;
  }
  if (registered.includes(requested)) {
    return requested;
  }
  const url = parseUrl(requested);
  if (!url || url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname) || url.href !== requested) {
    return null;
  }
  const withoutPort = (address: URL) => `${address.protocol}//${address.hostname}${address.pathname}${address.search}`;
  const wanted = withoutPort(url);
  const found = registered.some((uri) => {
    const candidate = parseUrl(uri);
    return (
      !!candidate &&
      candidate.protocol === 'http:' &&
      LOOPBACK_HOSTS.has(candidate.hostname) &&
      !candidate.username &&
      !candidate.password &&
      !url.username &&
      !url.password &&
      !url.hash &&
      withoutPort(candidate) === wanted
    );
  });
  return found ? requested : null;
};

/**
 * Apps Frameleaf checked (owner's open question on FL-778: a Frameleaf-maintained list). An app is
 * shown as one of these, with this name, only when every return address it registered is one of
 * that app's own; otherwise it is "an app Frameleaf hasn't checked" with the name it gave itself.
 */
export const VERIFIED_OAUTH_APPS = Object.freeze([
  {
    key: 'claude',
    name: 'Claude',
    maker: 'Anthropic',
    redirectUris: ['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback'],
  },
  {
    key: 'chatgpt',
    name: 'ChatGPT',
    maker: 'OpenAI',
    redirectUris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
  },
  {
    key: 'homeassistant',
    name: 'Home Assistant',
    maker: 'Home Assistant',
    redirectUris: ['https://my.home-assistant.io/redirect/oauth'],
  },
]);

export type VerifiedOAuthApp = (typeof VERIFIED_OAUTH_APPS)[number];

export const verifiedApp = (redirectUris: readonly string[]): VerifiedOAuthApp | null =>
  (redirectUris.length > 0 &&
    VERIFIED_OAUTH_APPS.find((app) => redirectUris.every((uri) => app.redirectUris.includes(uri)))) ||
  null;

/** An app's own name, trimmed of control characters and kept short; shown as plain text only. */
export const cleanClientName = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const name = value
    // eslint-disable-next-line no-control-regex -- control and direction characters are removed on purpose
    .replaceAll(/[\u{0}-\u{1F}\u{7F}-\u{9F}\u{200B}-\u{200F}\u{202A}-\u{202E}\u{2066}-\u{2069}]/gu, '')
    .trim();
  return name.length > 0 ? name.slice(0, 80) : null;
};

/** A resource indicator (RFC 8707): an absolute http(s) address without a fragment, or null. */
export const checkResource = (value: unknown): string | null | false => {
  if ([undefined, null, ''].includes(value as string)) {
    return null;
  }
  const url = parseUrl(value);
  if (!url || !['https:', 'http:'].includes(url.protocol) || url.hash || url.username || url.password) {
    return false;
  }
  return url.href;
};

/** The address an app is sent back to, with the result in its query (and `iss`, RFC 9207). */
export const oauthReturnAddress = (redirectUri: string, values: Record<string, string | undefined>) => {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) {
      url.searchParams.set(key, value);
    }
  }
  return url.href;
};

/** Where an app's requests come back to, shown on the Allow page: `claude.ai`, `localhost:3000`. */
export const redirectDisplay = (redirectUri: string) => {
  try {
    return new URL(redirectUri).host;
  } catch {
    return redirectUri;
  }
};
