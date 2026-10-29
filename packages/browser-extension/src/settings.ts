import type { CaptureCatalogDto } from '@frameleaf/sdk';
import {
  CaptureFailure,
  sameBinding,
  normalizeServerAddress,
  type ServerBinding,
} from './api';
import { trustedStorage } from './platform';

/**
 * FL-655: how this browser got its access. `sign-in`: Save to Frameleaf signed in with your
 * Frameleaf account and the server listed it in API keys (`apiKeyId`). `key`: a key pasted by hand
 * (the fallback). A connection saved before sign-in existed has no method and is a key connection,
 * so it keeps working without signing in again.
 */
export type ConnectionMethod = 'sign-in' | 'key';
type Connection = {
  version: 1;
  binding: ServerBinding;
  token?: string;
  status: 'connected' | 'needs-attention';
  catalog: CaptureCatalogDto | null;
  method?: ConnectionMethod;
  apiKeyId?: string;
};
export type ConnectionStatus = Omit<
  Connection,
  'version' | 'token' | 'apiKeyId'
>;
const key = 'frameleafConnectionV1';
let secured: Promise<void> | undefined;
export function initializeStorage() {
  return (secured ??= trustedStorage().setAccessLevel({
    accessLevel: 'TRUSTED_CONTEXTS',
  }));
}
async function read(): Promise<Connection | null> {
  await initializeStorage();
  const value = (await trustedStorage().get(key))[key] as
    Partial<Connection> | undefined;
  if (value === undefined) return null;
  const binding = value?.binding;
  const catalog = value?.catalog;
  if (
    value?.version !== 1 ||
    !binding ||
    !(['serverId', 'userId', 'origin', 'credentialId'] as const).every(
      (field) =>
        typeof binding[field] === 'string' && binding[field].length > 0,
    ) ||
    !['connected', 'needs-attention'].includes(value.status ?? '') ||
    (value.status === 'connected' &&
      (typeof value.token !== 'string' || !value.token)) ||
    !(
      catalog === null ||
      (catalog && Array.isArray(catalog.albums) && Array.isArray(catalog.tags))
    ) ||
    !(
      value.method === undefined || ['sign-in', 'key'].includes(value.method)
    ) ||
    !(value.apiKeyId === undefined || typeof value.apiKeyId === 'string')
  )
    throw new CaptureFailure('credential');
  try {
    if (normalizeServerAddress(binding.origin, true) !== binding.origin)
      throw new Error();
  } catch {
    throw new CaptureFailure('credential');
  }
  return value as Connection;
}
export async function connectionStatus(): Promise<ConnectionStatus | null> {
  const value = await read();
  return value
    ? {
        binding: value.binding,
        status: value.status,
        catalog: value.catalog,
        method: value.method ?? 'key',
      }
    : null;
}
// Only the background's serialized trusted-message handler writes settings.
export async function saveConnection(
  binding: ServerBinding,
  token: string,
  access: { method: ConnectionMethod; apiKeyId?: string } = { method: 'key' },
) {
  await initializeStorage();
  await trustedStorage().set({
    [key]: {
      version: 1,
      binding,
      token,
      status: 'connected',
      catalog: null,
      method: access.method,
      ...(access.apiKeyId && { apiKeyId: access.apiKeyId }),
    } satisfies Connection,
  });
}
/** FL-655: the key and its access id, for signing out on the server. */
export async function accessFor(binding: ServerBinding) {
  const value = await read();
  if (!value || !value.token || !sameBinding(value.binding, binding))
    return null;
  return {
    token: value.token,
    method: value.method ?? 'key',
    apiKeyId: value.apiKeyId,
  };
}
export async function credentialFor(binding: ServerBinding): Promise<string> {
  const value = await read();
  if (
    !value ||
    value.status !== 'connected' ||
    !value.token ||
    !sameBinding(value.binding, binding)
  )
    throw new CaptureFailure('credential');
  return value.token;
}
export async function saveCatalog(
  binding: ServerBinding,
  catalog: CaptureCatalogDto,
) {
  const value = await read();
  if (
    value &&
    value.status === 'connected' &&
    sameBinding(value.binding, binding)
  )
    await trustedStorage().set({ [key]: { ...value, catalog } });
}
export async function pauseConnection(binding: ServerBinding) {
  const value = await read();
  if (value && sameBinding(value.binding, binding))
    await trustedStorage().set({
      [key]: {
        version: 1,
        binding: value.binding,
        status: 'needs-attention',
        catalog: null,
        ...(value.method && { method: value.method }),
      } satisfies Connection,
    });
}
export async function disconnect() {
  await initializeStorage();
  await trustedStorage().remove(key);
}

/** FL-655: a server this browser signed in to before. It holds no password or key. */
export type RecentServer = { origin: string; account?: string; usedAt: number };
const recentKey = 'frameleafRecentServersV1';
const MAX_RECENT = 5;
const validRecent = (value: unknown): value is RecentServer => {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<RecentServer>;
  try {
    return (
      typeof item.origin === 'string' &&
      normalizeServerAddress(item.origin, true) === item.origin &&
      Number.isSafeInteger(item.usedAt) &&
      (item.account === undefined ||
        (typeof item.account === 'string' && item.account.length <= 200))
    );
  } catch {
    return false;
  }
};
/**
 * Servers signed in to before, newest first. A connection saved before this list existed is
 * offered too, so nobody has to type their server again after the update.
 */
export async function recentServers(): Promise<RecentServer[]> {
  await initializeStorage();
  const stored = (await trustedStorage().get(recentKey))[recentKey];
  const list = Array.isArray(stored) ? stored.filter(validRecent) : [];
  if (list.length === 0) {
    const current = await read().catch(() => null);
    if (current)
      return [
        {
          origin: current.binding.origin,
          account: current.binding.userName,
          usedAt: 0,
        },
      ];
  }
  return list.toSorted((a, b) => b.usedAt - a.usedAt).slice(0, MAX_RECENT);
}
export async function rememberServer(origin: string, account?: string) {
  const others = (await recentServers()).filter(
    (item) => item.origin !== origin,
  );
  await trustedStorage().set({
    [recentKey]: [
      { origin, ...(account && { account }), usedAt: Date.now() },
      ...others,
    ].slice(0, MAX_RECENT),
  });
}

/**
 * FL-655: what the popup says about the last sign-in when it opens again (Chrome closes the popup
 * while the sign-in window is open): "You're signed in" once, or the problem, with its server.
 */
export type SignInProblem =
  | 'address'
  | 'unreachable'
  | 'cancelled'
  | 'expired'
  | 'old-server'
  | 'permission'
  | 'busy'
  | 'failed';
export type SignInNotice =
  | { kind: 'welcome' }
  | { kind: 'problem'; problem: SignInProblem; origin: string };
const noticeKey = 'frameleafSignInNoticeV1';
const PROBLEMS: SignInProblem[] = [
  'address',
  'unreachable',
  'cancelled',
  'expired',
  'old-server',
  'permission',
  'busy',
  'failed',
];
export async function signInNotice(): Promise<SignInNotice | null> {
  await initializeStorage();
  const value = (await trustedStorage().get(noticeKey))[noticeKey] as
    | Partial<{ kind: string; problem: SignInProblem; origin: string }>
    | undefined;
  if (value?.kind === 'welcome') return { kind: 'welcome' };
  if (
    value?.kind === 'problem' &&
    PROBLEMS.includes(value.problem as SignInProblem) &&
    typeof value.origin === 'string'
  )
    return { kind: 'problem', problem: value.problem!, origin: value.origin };
  return null;
}
export async function setSignInNotice(notice: SignInNotice | null) {
  await initializeStorage();
  if (notice) await trustedStorage().set({ [noticeKey]: notice });
  else await trustedStorage().remove(noticeKey);
}
