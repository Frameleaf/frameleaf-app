/**
 * The system settings draft rules for the Frameleaf settings host (FL-66), ported from the design
 * template's `settings-state.mjs` and the draft, review, reset and conflict flow of
 * `CommandCenter.jsx`.
 *
 * The draft is a full copy of the saved configuration that every settings page edits in place, so
 * one draft spans every area. A change is a leaf path (`trash.days`) with the saved value it was
 * made against and the draft value; arrays are single leaves. Everything here is pure so the
 * rules can be tested without a server:
 *
 * - `diffConfig` lists what a save would change.
 * - `rebaseDraft` carries the draft onto newer saved settings and names the conflicts: settings
 *   the draft changes that were also changed to something else since.
 * - `importConfig` takes a configuration file into the draft (never straight to the server) and
 *   reports the leaves it does not recognise.
 * - Secrets (passwords, client secrets, API keys, tokens) and credentials inside URLs never go
 *   into the reload journal or an export.
 */
import type { AdminConfigDto } from '@immich/sdk';
import { cloneDeep, get, isEqual, isPlainObject, set, unset } from 'lodash-es';

export type ConfigLeafValue = unknown;

export type ConfigChange = {
  path: string;
  before: ConfigLeafValue;
  after: ConfigLeafValue;
};

export type ConfigConflict = {
  path: string;
  /** What the draft started from. */
  before: ConfigLeafValue;
  /** What the draft wants. */
  mine: ConfigLeafValue;
  /** What is saved now. */
  theirs: ConfigLeafValue;
};

/**
 * Values the server keeps on its own: the re-queue reminder bookkeeping and the "a credential is
 * stored" indicators (FL-67). A save never changes them, so they are never a change, a conflict or
 * journaled.
 */
export const SERVER_MANAGED_CONFIG_PATHS: ReadonlySet<string> = new Set([
  'machineLearning.imageDescription.pendingRequeueAt',
  'machineLearning.imageDescription.lastConfigChangeAt',
  'notifications.smtp.transport.passwordConfigured',
  'oauth.clientSecretConfigured',
]);

/**
 * Write-only credentials stored in the configuration (FL-67). The server reads them back empty and
 * they change only through their own credential dialogs, so a draft never carries a value: they
 * are never a reviewable value, never journaled, exported or taken from an imported file.
 */
export const SECRET_CONFIG_PATHS: ReadonlySet<string> = new Set([
  'notifications.smtp.transport.password',
  'oauth.clientSecret',
  'frameleafCloud.cloudBackup.s3.secretAccessKey',
]);

const SECRET_NAME = /(password|secret|token|apikey|api_key|credential)$/i;
const SENSITIVE_QUERY_PARAMETER = /(key|token|secret|password|signature|auth|credential)/i;

export const isSecretConfigPath = (path: string) =>
  SECRET_CONFIG_PATHS.has(path) || SECRET_NAME.test(path.split('.').at(-1) ?? '');

export const isServerManagedConfigPath = (path: string) => SERVER_MANAGED_CONFIG_PATHS.has(path);

/**
 * Which top-level configuration groups each settings section edits. These are the keys each
 * section's form saved before the draft existed; "Reset this page" restores exactly these groups.
 */
export const SECTION_CONFIG_KEYS: Readonly<Record<string, readonly (keyof AdminConfigDto)[]>> = Object.freeze({
  authentication: ['passwordLogin', 'oauth'],
  backup: ['backup'],
  image: ['image'],
  'cloud-processing': ['frameleafCloud'],
  // FL-160: what a backup includes; the bucket, key and target change only through setup
  'cloud-backup': ['frameleafCloud'],
  'integrity-checks': ['integrityChecks', 'libraryCare'],
  'external-library': ['library'],
  // FL-71: "Logs & diagnostics" also holds the local analytics settings; the search models page
  // holds Ask Search, which is its own top-level group.
  logging: ['logging', 'analytics'],
  'machine-learning': ['machineLearning', 'localFeatures'],
  location: ['map', 'reverseGeocoding'],
  metadata: ['metadata'],
  'nightly-tasks': ['nightlyTasks'],
  // Queue concurrency, edited in the Job manager's concurrency dialog (FL-71).
  queues: ['job'],
  notifications: ['notifications', 'templates'],
  server: ['server'],
  'smart-albums': ['smartAlbums'],
  'storage-template': ['storageTemplate', 'physicalDeduplication'],
  theme: ['theme'],
  trash: ['trash'],
  'user-settings': ['user'],
  'version-check': ['newVersionCheck'],
  'video-transcoding': ['ffmpeg'],
});

/**
 * Settings one group spreads over several sections (FL-69): Library care's toggles sit on the
 * template's Media health & integrity, Repair queues and Enrichment completeness pages
 * (settings-catalog.mjs:905-977). A changed path goes to the page that shows it.
 */
const SECTION_CONFIG_PATHS: Readonly<Record<string, string>> = Object.freeze({
  'libraryCare.livePhotoRepair': 'repair',
  'libraryCare.rawRecovery': 'repair',
  'libraryCare.duplicateReview': 'repair',
  'libraryCare.incrementalEnrichment': 'enrichment-care',
  'libraryCare.manualMetadata': 'enrichment-care',
  libraryCare: 'integrity-checks',
});

/** The settings section a changed path belongs to, if any section edits it. */
export const sectionForConfigPath = (path: string): string | undefined => {
  const specific = Object.keys(SECTION_CONFIG_PATHS).find((prefix) => path === prefix || path.startsWith(`${prefix}.`));
  if (specific) {
    return SECTION_CONFIG_PATHS[specific];
  }
  const [top] = path.split('.', 1);
  return Object.entries(SECTION_CONFIG_KEYS).find(([, keys]) => (keys as readonly string[]).includes(top))?.[0];
};

export const cloneConfig = <T>(config: T): T => cloneDeep(config);

/** Every leaf of a configuration value keyed by its dotted path. Arrays and `null` are leaves. */
export const configLeaves = (value: unknown, prefix = ''): Map<string, unknown> => {
  const leaves = new Map<string, unknown>();
  const walk = (current: unknown, path: string) => {
    if (isPlainObject(current)) {
      const entries = Object.entries(current as Record<string, unknown>);
      if (entries.length === 0 && path) {
        leaves.set(path, current);
        return;
      }
      for (const [key, child] of entries) {
        walk(child, path ? `${path}.${key}` : key);
      }
      return;
    }
    if (path) {
      leaves.set(path, current);
    }
  };
  walk(value, prefix);
  return leaves;
};

/** What a save of `draft` would change compared with `baseline`, in the draft's order. */
export const diffConfig = (baseline: unknown, draft: unknown): ConfigChange[] => {
  const before = configLeaves(baseline);
  const after = configLeaves(draft);
  const changes: ConfigChange[] = [];
  const seen = new Set<string>();
  for (const path of [...after.keys(), ...before.keys()]) {
    if (seen.has(path) || isServerManagedConfigPath(path)) {
      continue;
    }
    seen.add(path);
    const previous = before.get(path);
    const next = after.get(path);
    if (!isEqual(previous, next)) {
      changes.push({ path, before: previous, after: next });
    }
  }
  return changes;
};

/** The top-level groups a list of changes touches. */
export const changedConfigKeys = (changes: readonly ConfigChange[]) =>
  new Set(changes.map(({ path }) => path.split('.', 1)[0]));

const applyChanges = <T extends object>(target: T, changes: readonly ConfigChange[]): T => {
  const next = cloneConfig(target);
  for (const change of changes) {
    set(next, change.path, cloneConfig(change.after));
  }
  return next;
};

/**
 * Carries a draft made against `baseline` onto newer saved settings. A draft change conflicts
 * when the saved value moved to something other than both what the draft started from and what
 * it wants. Without `force` conflicting changes are left out of the returned draft; with `force`
 * (the administrator reviewed them and chose their own values) every change is applied.
 * Server-managed values always come from `latest`.
 */
export const rebaseDraft = <T extends object>(
  baseline: T,
  draft: T,
  latest: T,
  options: { force?: boolean } = {},
): { draft: T; conflicts: ConfigConflict[] } => {
  const mine = diffConfig(baseline, draft);
  const conflicts: ConfigConflict[] = [];
  const apply: ConfigChange[] = [];
  for (const change of mine) {
    const theirs = get(latest, change.path);
    if (!isEqual(theirs, change.before) && !isEqual(theirs, change.after)) {
      conflicts.push({ path: change.path, before: change.before, mine: change.after, theirs });
      if (!options.force) {
        continue;
      }
    }
    apply.push(change);
  }
  return { draft: applyChanges(latest, apply), conflicts };
};

/** "Reset this page": the defaults of the given groups go into the draft. Save applies them. */
export const resetConfigKeys = <T extends object>(draft: T, defaults: T, keys: readonly (keyof T)[]): T => {
  const next = cloneConfig(draft);
  for (const key of keys) {
    if (Object.hasOwn(defaults as object, key)) {
      next[key] = cloneConfig(defaults[key]);
    }
  }
  return next;
};

/** Whether the given groups differ between two configurations. */
export const configKeysDiffer = <T extends object>(a: T, b: T, keys: readonly (keyof T)[]) =>
  keys.some((key) => !isEqual(a[key], b[key]));

/**
 * A copy of `baseline` with only the given groups taken from `draft`: a save that commits part of
 * the draft (the email delivery test saves email settings) and leaves the rest pending.
 */
export const pickConfigKeys = <T extends object>(baseline: T, draft: T, keys: readonly (keyof T)[]): T => {
  const next = cloneConfig(baseline);
  for (const key of keys) {
    if (Object.hasOwn(draft as object, key)) {
      next[key] = cloneConfig(draft[key]);
    }
  }
  return next;
};

/** The names of key-like query parameters. Collected up front so they can be deleted safely. */
const sensitiveParameters = (url: URL) => {
  const names: string[] = [];
  url.searchParams.forEach((_value, name) => {
    if (SENSITIVE_QUERY_PARAMETER.test(name)) {
      names.push(name);
    }
  });
  return names;
};

const parseUrl = (value: string) => {
  if (!/^[a-z][\d+.a-z-]*:\/\//i.test(value.trim())) {
    return;
  }
  try {
    return new URL(value.trim());
  } catch {
    return;
  }
};

/** A URL carrying a user name, password or key-like query parameter. */
export const urlHasCredentials = (value: string) => {
  const url = parseUrl(value);
  if (!url) {
    return false;
  }
  return !!url.username || !!url.password || sensitiveParameters(url).length > 0;
};

/** The URL without user name, password or key-like query parameters; other text is unchanged. */
export const stripUrlCredentials = (value: string) => {
  const url = parseUrl(value);
  if (!url || !urlHasCredentials(value)) {
    return value;
  }
  url.username = '';
  url.password = '';
  for (const name of sensitiveParameters(url)) {
    url.searchParams.delete(name);
  }
  const text = url.toString();
  // `new URL` adds a trailing slash to a bare origin; keep what the administrator typed.
  return value.trimEnd().endsWith('/') || url.pathname !== '/' || url.search ? text : text.replace(/\/$/, '');
};

const containsCredentials = (value: unknown): boolean => {
  if (typeof value === 'string') {
    return urlHasCredentials(value);
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsCredentials(item));
  }
  return false;
};

/** Whether a change may be kept on this device: no secrets, no URL credentials, nothing server-kept. */
export const isJournalSafe = (change: ConfigChange) =>
  !isSecretConfigPath(change.path) &&
  !isServerManagedConfigPath(change.path) &&
  !containsCredentials(change.before) &&
  !containsCredentials(change.after);

/**
 * A configuration safe to copy or download: secrets are emptied (an empty secret is "keep the
 * saved value" on import) and credentials are removed from URLs. Server-kept values and the
 * revision are left out.
 */
export const redactConfigForExport = <T extends object>(config: T): T => {
  const next = cloneConfig(config) as Record<string, unknown>;
  delete next.revision;
  for (const [path, value] of configLeaves(next)) {
    if (isServerManagedConfigPath(path)) {
      unset(next, path);
    } else if (isSecretConfigPath(path)) {
      set(next, path, typeof value === 'string' ? '' : value);
    } else if (typeof value === 'string') {
      set(next, path, stripUrlCredentials(value));
    } else if (Array.isArray(value)) {
      set(
        next,
        path,
        value.map((item) => (typeof item === 'string' ? stripUrlCredentials(item) : item)),
      );
    }
  }
  return next as T;
};

export type ConfigImportResult<T> = {
  draft: T;
  /** Leaves the file changed in the draft. */
  applied: string[];
  /** Leaves this server does not have, or whose value has the wrong type. They were ignored. */
  unsupported: string[];
  /** Empty secrets in the file: the saved secret is kept. */
  keptSecrets: string[];
  /**
   * Secrets the file carries a value for (an export from an older server). Credentials are never
   * taken from a file (FL-67); they are replaced through their own dialogs.
   */
  skippedSecrets: string[];
};

const sameKind = (current: unknown, incoming: unknown) => {
  if (current === null || current === undefined) {
    // An unset optional value (a retained account, a timestamp) takes text or nothing.
    return incoming === null || typeof incoming === 'string';
  }
  if (Array.isArray(current)) {
    return Array.isArray(incoming);
  }
  if (isPlainObject(current)) {
    return isPlainObject(incoming);
  }
  if (typeof current === 'number') {
    return typeof incoming === 'number' && Number.isFinite(incoming);
  }
  return typeof current === typeof incoming;
};

/**
 * Takes an imported configuration file into the draft. Only leaves this server has, with a value
 * of the same kind, are applied; everything else is reported and ignored. Secrets are never
 * applied: an empty one keeps the saved secret, a value is reported as skipped. Server-kept values
 * are ignored. Nothing is sent to the server: the administrator
 * reviews the result like any other draft.
 */
export const importConfig = <T extends object>(draft: T, imported: unknown): ConfigImportResult<T> => {
  if (!isPlainObject(imported)) {
    throw new TypeError('A settings file must contain one JSON object');
  }
  const known = configLeaves(draft);
  const next = cloneConfig(draft);
  const applied: string[] = [];
  const unsupported: string[] = [];
  const keptSecrets: string[] = [];
  const skippedSecrets: string[] = [];
  const source = { ...(imported as Record<string, unknown>) };
  delete source.revision;
  delete source.expectedRevision;

  for (const [path, value] of configLeaves(source)) {
    if (isServerManagedConfigPath(path)) {
      continue;
    }
    if (!known.has(path) || !sameKind(known.get(path), value)) {
      unsupported.push(path);
      continue;
    }
    if (isSecretConfigPath(path)) {
      (value === '' ? keptSecrets : skippedSecrets).push(path);
      continue;
    }
    if (!isEqual(known.get(path), value)) {
      set(next, path, cloneConfig(value));
      applied.push(path);
    }
  }

  return { draft: next, applied, unsupported, keptSecrets, skippedSecrets };
};

/* ------------------------------------------------------------------------------------------ */
/* Reload journal                                                                              */
/* ------------------------------------------------------------------------------------------ */

export const SYSTEM_CONFIG_JOURNAL_PREFIX = 'frameleaf:system-settings-draft:v1:';
export const SYSTEM_CONFIG_JOURNAL_LIMITS = Object.freeze({ characters: 1024 * 1024, changes: 2000 });

const CONFIG_PATH = /^[\w-]+(\.[\w-]+)*$/;
const UNSAFE_PATH_SEGMENT = /(^|\.)(__proto__|prototype|constructor)(\.|$)/;

export type SystemConfigJournal = {
  version: 1;
  revision: string;
  changes: ConfigChange[];
};

/**
 * The unsaved draft as it may be kept in this tab's session storage so a reload can recover it.
 * Secrets and credentials are left out; `skipped` counts them so the page can say so.
 */
export const createJournal = (
  revision: string,
  changes: readonly ConfigChange[],
): { journal: SystemConfigJournal; skipped: number } => {
  const safe = changes.filter((change) => isJournalSafe(change));
  const kept = safe.slice(0, SYSTEM_CONFIG_JOURNAL_LIMITS.changes).map((change) => ({ ...change }));
  return {
    journal: { version: 1, revision, changes: kept },
    skipped: changes.length - kept.length,
  };
};

/** Reads a journal back; anything malformed, oversized or unsafe is dropped. */
export const parseJournal = (raw: string | null | undefined): SystemConfigJournal | undefined => {
  if (!raw || raw.length > SYSTEM_CONFIG_JOURNAL_LIMITS.characters) {
    return;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return;
  }
  if (!isPlainObject(value)) {
    return;
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || typeof record.revision !== 'string' || !Array.isArray(record.changes)) {
    return;
  }
  const changes: ConfigChange[] = [];
  for (const item of record.changes.slice(0, SYSTEM_CONFIG_JOURNAL_LIMITS.changes)) {
    if (!isPlainObject(item)) {
      continue;
    }
    const { path, before, after } = item as Record<string, unknown>;
    if (typeof path !== 'string' || !CONFIG_PATH.test(path) || UNSAFE_PATH_SEGMENT.test(path)) {
      continue;
    }
    const change = { path, before, after };
    if (isJournalSafe(change)) {
      changes.push(change);
    }
  }
  return { version: 1, revision: record.revision, changes };
};

/**
 * Re-applies a journal to freshly loaded saved settings. A journaled change whose setting was
 * changed to something else since is a conflict; it stays in the draft for the administrator to
 * review. Paths this server does not have, or values of the wrong kind, are dropped.
 */
export const recoverJournal = <T extends object>(
  baseline: T,
  journal: SystemConfigJournal,
): { draft: T; recovered: number; conflicts: ConfigConflict[]; dropped: number } => {
  const known = configLeaves(baseline);
  const draft = cloneConfig(baseline);
  const conflicts: ConfigConflict[] = [];
  let recovered = 0;
  let dropped = 0;
  for (const change of journal.changes) {
    if (!known.has(change.path) || !sameKind(known.get(change.path), change.after)) {
      dropped++;
      continue;
    }
    const saved = known.get(change.path);
    if (isEqual(saved, change.after)) {
      continue;
    }
    if (!isEqual(saved, change.before)) {
      conflicts.push({ path: change.path, before: change.before, mine: change.after, theirs: saved });
    }
    set(draft, change.path, cloneConfig(change.after));
    recovered++;
  }
  return { draft, recovered, conflicts, dropped };
};

/* ------------------------------------------------------------------------------------------ */
/* Review copy                                                                                 */
/* ------------------------------------------------------------------------------------------ */

const humanize = (segment: string) => {
  const words = segment
    .replaceAll(/([a-z\d])([A-Z])/g, '$1 $2')
    .replaceAll(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** A readable label for a changed setting, for example `ffmpeg.targetVideoCodec` → "Target video codec". */
export const configPathLabel = (path: string) => {
  const segments = path.split('.');
  const rest = segments.length > 1 ? segments.slice(1) : segments;
  return rest.map((segment) => humanize(segment)).join(' › ');
};

export const MAX_REVIEW_VALUE_CHARACTERS = 160;

export type ReviewValue =
  { kind: 'secret' } | { kind: 'empty' } | { kind: 'on' } | { kind: 'off' } | { kind: 'text'; text: string };

/** How one value is shown in the review. Secrets are never shown. */
export const reviewValue = (path: string, value: unknown): ReviewValue => {
  if (isSecretConfigPath(path)) {
    return { kind: 'secret' };
  }
  if (value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) {
    return { kind: 'empty' };
  }
  if (typeof value === 'boolean') {
    return { kind: value ? 'on' : 'off' };
  }
  const redact = (item: unknown) => (typeof item === 'string' ? stripUrlCredentials(item) : item);
  const text = Array.isArray(value)
    ? value.map((item) => String(redact(item))).join(', ')
    : typeof value === 'object'
      ? JSON.stringify(value)
      : String(redact(value));
  return {
    kind: 'text',
    text: text.length > MAX_REVIEW_VALUE_CHARACTERS ? `${text.slice(0, MAX_REVIEW_VALUE_CHARACTERS - 1)}…` : text,
  };
};
