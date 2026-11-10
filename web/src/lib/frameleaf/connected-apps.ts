import type { OAuthAppAuthorizeStartDto } from '@frameleaf/sdk';
import type { MessageFormatter, Translations } from 'svelte-i18n';

/**
 * FL-860 (E3-05): connected apps on the web, as mocked in FL-778 (`src/connect.mjs`). Plain words
 * for what an app asked for and what no app can ever do, and how an assistant reaches the server.
 * The server's scopes are FL-803's (`server/src/utils/oauth-apps.ts`); a scope this page does not
 * know is never shown as something it understood.
 */

/** The scopes this server offers, in the order the Allow page lists them. */
export const APP_SCOPES = ['library:read', 'people:read', 'albums:write', 'tags:write', 'library:download'] as const;
export type AppScope = (typeof APP_SCOPES)[number];

const isScope = (scope: string): scope is AppScope => (APP_SCOPES as readonly string[]).includes(scope);
const key = (scope: AppScope) => scope.replace(':', '_');

/** What an app asked for, in the Allow page's words; `unknown` holds anything this page can't name. */
export const plainAccess = ($t: MessageFormatter, scopes: string[]) => {
  const known = APP_SCOPES.filter((scope) => scopes.includes(scope));
  return {
    can: known.map((scope) => $t(`frameleaf_apps_access_${key(scope)}` as Translations)),
    unknown: scopes.filter((scope) => !isScope(scope)),
  };
};

/** What no connected app can do, whatever it asked for. Locked comes first and is never offered. */
export const neverAllowed = ($t: MessageFormatter) => [
  $t('frameleaf_apps_cant_locked'),
  $t('frameleaf_apps_cant_delete'),
  $t('frameleaf_apps_cant_sign_in'),
  $t('frameleaf_apps_cant_others'),
];

/** One line for a list row: "Sees your photos and knows who’s who". */
export const accessSummary = ($t: MessageFormatter, scopes: string[]) => {
  const parts = APP_SCOPES.filter((scope) => scopes.includes(scope)).map((scope) =>
    $t(`frameleaf_apps_summary_${key(scope)}` as Translations),
  );
  if (parts.length === 0) {
    return '';
  }
  const and = ` ${$t('frameleaf_apps_summary_and')} `;
  const text = parts.length < 3 ? parts.join(and) : `${parts.slice(0, -1).join(', ')}${and}${parts.at(-1)}`;
  return text[0].toUpperCase() + text.slice(1);
};

/** The Allow page's request, from the address the server's authorization endpoint opened. */
export const allowAppRequest = (query: URLSearchParams): OAuthAppAuthorizeStartDto | null => {
  const clientId = query.get('client_id') ?? '';
  const redirectUri = query.get('redirect_uri') ?? '';
  const codeChallenge = query.get('code_challenge') ?? '';
  if (!clientId || !redirectUri || !codeChallenge || query.get('error')) {
    return null;
  }
  const optional = (name: string) => query.get(name) ?? undefined;
  return {
    responseType: query.get('response_type') ?? '',
    clientId,
    redirectUri,
    scope: optional('scope'),
    state: optional('state'),
    codeChallenge,
    codeChallengeMethod: query.get('code_challenge_method') ?? '',
    resource: optional('resource'),
  };
};

/** Where the browser may go after Allow or Deny: only the app's own return address. */
export const isReturnTo = (redirectUrl: string, redirectUri: string) => {
  try {
    const next = new URL(redirectUrl);
    const expected = new URL(redirectUri);
    return next.origin === expected.origin && next.pathname === expected.pathname;
  } catch {
    return false;
  }
};

/** An Allow page left open longer than this asks the app to start again (the mock's 10 minutes). */
export const ALLOW_REQUEST_TTL_MS = 10 * 60 * 1000;

/** The assistant address (FL-844's MCP endpoint) on a server's own address. */
export const assistantAddress = (origin: string) => `${origin.replace(/\/+$/, '')}/api/mcp`;

export type AssistantClient = 'claude' | 'chatgpt' | 'local';
/** Assistants that run on the web and so need remote access to reach a server at home. */
export const WEB_ASSISTANTS: AssistantClient[] = ['claude', 'chatgpt'];

/** Months since an app was last used, or null when it never was; 90 days or more is a warning. */
export const staleMonths = (lastUsedAt: string | null | undefined, now = Date.now()) => {
  if (!lastUsedAt) {
    return null;
  }
  const days = (now - Date.parse(lastUsedAt)) / 86_400_000;
  return days >= 90 ? Math.floor(days / 30) : null;
};
