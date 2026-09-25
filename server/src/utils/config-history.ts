import { get, isEqual, isPlainObject } from 'lodash-es';
import { SystemConfig, mapAdminConfig } from 'src/dtos/config.dto.js';
import { SERVER_MANAGED_CONFIG_PATHS } from 'src/utils/config.js';
import { canonicalJson } from 'src/utils/object.js';

/**
 * FL-66: the settings change history, the design template's "Change history" area of
 * `CommandCenter.jsx`. Each saved settings change is one entry with its time, the administrator
 * who saved it and every changed setting with its value before and after. The history is kept on
 * the server (not on one device) so every administrator sees the same record.
 *
 * Nothing secret enters it. Values are taken from what an administrator can read
 * (`mapAdminConfig`), so write-only credentials never have a value here: a credential change is
 * recorded only as replaced or cleared. User names, passwords and key-like parameters are removed
 * from URLs, and long values are shortened.
 */

export const CONFIG_HISTORY_LIMITS = Object.freeze({ entries: 50, changes: 100, valueCharacters: 300 });

export type ConfigHistoryCredentialChange = 'replaced' | 'cleared';

export type ConfigHistoryChange = {
  /** The setting's dotted path, for example `trash.days`. */
  path: string;
  /** The value before, JSON encoded. Null for a credential. */
  before: string | null;
  /** The value after, JSON encoded. Null for a credential. */
  after: string | null;
  /** Set for a write-only credential: what happened to it. Its value is never recorded. */
  credential?: ConfigHistoryCredentialChange;
};

/**
 * FL-71 (CC-10): what an entry records. A settings save lists its changes ("n settings changed"); a
 * credential entry names the credential and never its value; a review names the reviewed workflow
 * (`CommandCenter.jsx:1447, 2495`). Entries saved before FL-71 have neither title nor kind.
 */
export type ConfigHistoryKind = 'settings' | 'credential' | 'review';

export type ConfigHistoryEntry = {
  id: string;
  createdAt: string;
  /** The entry's own title, such as "Updated email server password"; absent for a settings save. */
  title?: string | null;
  kind?: ConfigHistoryKind;
  actorId: string | null;
  /** The administrator's name when the change was saved. */
  actorName: string | null;
  changes: ConfigHistoryChange[];
  /** Changed settings left out because the entry reached its limit. */
  omittedChanges: number;
};

export type ConfigHistory = { entries: ConfigHistoryEntry[] };

/** Where each write-only credential lives, and the flag an administrator reads for it. */
export const CREDENTIAL_CONFIG_PATHS = ['notifications.smtp.transport.password', 'oauth.clientSecret'] as const;

const CREDENTIAL_FLAG_PATHS = new Set([
  'notifications.smtp.transport.passwordConfigured',
  'oauth.clientSecretConfigured',
]);

const SERVER_MANAGED = new Set<string>(SERVER_MANAGED_CONFIG_PATHS);
const SECRET_NAME = /(password|secret|token|apikey|api_key|credential)$/i;
const SENSITIVE_QUERY_PARAMETER = /(key|token|secret|password|signature|auth|credential)/i;

const isSecretPath = (path: string) =>
  (CREDENTIAL_CONFIG_PATHS as readonly string[]).includes(path) || SECRET_NAME.test(path.split('.').at(-1) ?? '');

/** Every leaf of a configuration by dotted path. Arrays, `null` and empty objects are leaves. */
const leaves = (value: unknown): Map<string, unknown> => {
  const result = new Map<string, unknown>();
  const walk = (current: unknown, path: string) => {
    if (isPlainObject(current)) {
      const entries = Object.entries(current as Record<string, unknown>);
      if (entries.length === 0 && path) {
        result.set(path, current);
        return;
      }
      for (const [key, child] of entries) {
        walk(child, path ? `${path}.${key}` : key);
      }
      return;
    }
    if (path) {
      result.set(path, current);
    }
  };
  walk(value, '');
  return result;
};

/** A URL without its user name, password and key-like query parameters; other text unchanged. */
export const stripUrlCredentials = (value: string): string => {
  const text = value.trim();
  if (!/^[a-z][\d+.a-z-]*:\/\//i.test(text)) {
    return value;
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return value;
  }
  const sensitive = url.searchParams
    .keys()
    .filter((name) => SENSITIVE_QUERY_PARAMETER.test(name))
    .toArray();
  if (!url.username && !url.password && sensitive.length === 0) {
    return value;
  }
  url.username = '';
  url.password = '';
  for (const name of sensitive) {
    url.searchParams.delete(name);
  }
  const stripped = url.href;
  return text.endsWith('/') || url.pathname !== '/' || url.search ? stripped : stripped.replace(/\/$/, '');
};

const redact = (value: unknown): unknown => {
  if (typeof value === 'string') {
    return stripUrlCredentials(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redact(item));
  }
  return value;
};

const encode = (value: unknown): string => {
  const text = canonicalJson(redact(value));
  return text.length > CONFIG_HISTORY_LIMITS.valueCharacters
    ? `${text.slice(0, CONFIG_HISTORY_LIMITS.valueCharacters - 1)}…`
    : text;
};

const credentialValue = (config: SystemConfig, path: string) => {
  const value: unknown = get(config, path);
  return typeof value === 'string' ? value : '';
};

/**
 * FL-71: what changed between two plain objects (an account's preferences), leaf by leaf, with the
 * same redaction as the settings history: secret-looking keys are left out and values are
 * redacted and shortened.
 */
export const describeObjectChanges = (before: unknown, after: unknown): ConfigHistoryChange[] => {
  const previous = leaves(before);
  const next = leaves(after);
  const changes: ConfigHistoryChange[] = [];
  const seen = new Set<string>();
  for (const path of [...next.keys(), ...previous.keys()]) {
    if (seen.has(path) || isSecretPath(path)) {
      continue;
    }
    seen.add(path);
    const was = encode(previous.get(path) ?? null);
    const now = encode(next.get(path) ?? null);
    // A change that redaction hides (a URL's password alone) is not shown as a change of nothing.
    if (!isEqual(previous.get(path), next.get(path)) && was !== now) {
      changes.push({ path, before: was, after: now });
    }
  }
  return changes;
};

/**
 * What changed between two saved configurations, ready for the history: settings with their
 * values (redacted) and credentials as replaced or cleared, never with a value. Server-kept
 * bookkeeping (the re-queue reminder) is not a change.
 */
export const describeConfigChanges = (oldConfig: SystemConfig, newConfig: SystemConfig): ConfigHistoryChange[] => {
  const before = leaves(mapAdminConfig(oldConfig));
  const after = leaves(mapAdminConfig(newConfig));
  const changes: ConfigHistoryChange[] = [];
  const seen = new Set<string>();
  for (const path of [...after.keys(), ...before.keys()]) {
    if (seen.has(path) || SERVER_MANAGED.has(path) || CREDENTIAL_FLAG_PATHS.has(path) || isSecretPath(path)) {
      continue;
    }
    seen.add(path);
    const previous = before.get(path);
    const next = after.get(path);
    if (!isEqual(previous, next)) {
      changes.push({ path, before: encode(previous ?? null), after: encode(next ?? null) });
    }
  }

  for (const path of CREDENTIAL_CONFIG_PATHS) {
    const previous = credentialValue(oldConfig, path);
    const next = credentialValue(newConfig, path);
    if (previous !== next) {
      changes.push({ path, before: null, after: null, credential: next ? 'replaced' : 'cleared' });
    }
  }

  return changes;
};

const isHistoryEntry = (value: unknown): value is ConfigHistoryEntry => {
  if (!isPlainObject(value)) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === 'string' &&
    typeof entry.createdAt === 'string' &&
    Array.isArray(entry.changes) &&
    entry.changes.every((change) => isPlainObject(change) && typeof (change as { path?: unknown }).path === 'string')
  );
};

/** The stored history, or an empty one when nothing (or something unreadable) is stored. */
export const readConfigHistory = (stored: unknown): ConfigHistory => {
  const entries = (stored as Partial<ConfigHistory> | null | undefined)?.entries;
  return { entries: Array.isArray(entries) ? entries.filter((entry) => isHistoryEntry(entry)) : [] };
};

/** The history with a new entry first, keeping the newest entries within the limit. */
export const appendConfigHistory = (
  history: ConfigHistory,
  entry: Omit<ConfigHistoryEntry, 'changes' | 'omittedChanges'>,
  changes: ConfigHistoryChange[],
): ConfigHistory => {
  const kept = changes.slice(0, CONFIG_HISTORY_LIMITS.changes);
  return {
    entries: [{ ...entry, changes: kept, omittedChanges: changes.length - kept.length }, ...history.entries].slice(
      0,
      CONFIG_HISTORY_LIMITS.entries,
    ),
  };
};

/** FL-71 (CC-10): how the history names each write-only credential in its entries. */
export const CREDENTIAL_TITLES: Record<string, string> = {
  'smtp-password': 'email server password',
  'oauth-client-secret': 'OAuth client secret',
};

/** "Updated email server password" / "Cleared email server password": the entry for one credential, never its value. */
export const credentialHistoryTitle = (name: string, change: ConfigHistoryCredentialChange) =>
  `${change === 'replaced' ? 'Updated' : 'Cleared'} ${CREDENTIAL_TITLES[name] ?? name}`;

/** "Reviewed: Recovery readiness" (`CommandCenter.jsx:2495`). */
export const reviewHistoryTitle = (title: string) => `Reviewed: ${title}`;
