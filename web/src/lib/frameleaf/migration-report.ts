/**
 * Read-only import of a server-to-server migration audit report (FL-75).
 *
 * The migration itself runs from the command line on a machine the administrator controls;
 * the web app never executes it and never receives API keys. The CLI writes
 * `<ledger>.audit.json`, and the Maintenance area opens that file locally in the browser to
 * review it before the source server is retired. Nothing is uploaded or stored.
 *
 * A report is accepted only when it is the expected format, carries no credentials and no
 * filesystem paths from either machine, and its counts are internally consistent. The pass
 * verdict is recomputed here from the counts rather than trusted from the file.
 */

export const MIGRATION_REPORT_FORMAT = 'frameleaf-migration-audit';
export const MIGRATION_REPORT_VERSION = 1;
/** Bigger than any report the CLI writes (it caps item detail at 5,000 rows). */
export const MIGRATION_REPORT_MAX_BYTES = 20 * 1024 * 1024;
export const MIGRATION_REPORT_MAX_ITEMS = 10_000;
const MAX_COUNT = 1_000_000_000;

export const unresolvedKinds = ['asset', 'album', 'tag', 'stack', 'person'] as const;
export type UnresolvedKind = (typeof unresolvedKinds)[number];
export const unresolvedReasons = [
  'not-transferred',
  'transfer-failed',
  'absent-on-destination',
  'metadata-failed',
  'not-created',
  'not-linked',
  'not-assigned',
  'not-attached',
] as const;
export type UnresolvedReason = (typeof unresolvedReasons)[number];

export type MigrationUnresolvedItem = {
  kind: UnresolvedKind;
  id: string;
  name: string;
  reason: UnresolvedReason;
  detail: string;
};

export type MigrationReportStatus = 'pass' | 'incomplete' | 'audit-incomplete' | 'dry-run';

export type MigrationReport = {
  generatedAt: string;
  status: MigrationReportStatus;
  dryRun: boolean;
  complete: boolean;
  source: string;
  destination: string;
  owners: Array<{ source: string | null; destination: string }>;
  /**
   * `transferred`: the ledger records the original on the destination. `checked`: looked up
   * on the destination by checksum during the audit. `verified`: checked and found. Only
   * verified originals count towards retiring the source.
   */
  assets: { total: number; transferred: number; checked: number; verified: number; missing: number; failed: number };
  albums: { total: number; topLevel: number; nested: number; maxDepth: number; created: number; linked: number };
  tags: { total: number; assigned: number };
  people: { total: number; attached: number };
  stacks: { total: number; created: number };
  physicalReferences: {
    newUploads: number;
    matchedExisting: number;
    livePhotoPairs: number;
    livePhotoPairsLinked: number;
  };
  unresolved: MigrationUnresolvedItem[];
  /** Exact number of unresolved items; `unresolved` may list fewer. */
  unresolvedCount: number;
};

export type MigrationReportError =
  'too-large' | 'not-json' | 'unsupported-format' | 'invalid' | 'secret' | 'foreign-path' | 'inconsistent';

export type MigrationReportResult = { ok: true; report: MigrationReport } | { ok: false; error: MigrationReportError };

class ReportError extends Error {
  constructor(readonly code: MigrationReportError) {
    super(code);
  }
}
const reject = (code: MigrationReportError): never => {
  throw new ReportError(code);
};

// Same rule as the CLI's report writer: absolute, home-relative, Windows drive or UNC paths,
// file: URLs and `..` walks. A slash between words ("Trips / Banff", "Travel/Canada") is a name.
export const FOREIGN_PATH =
  /(?:^|[\s"'(=:,])(?:\/[^\s/]\S*|~[/\\]\S*|[A-Za-z]:[/\\]\S*|\\\\\S+|file:\S*)|(?:^|[/\\])\.\.(?:[/\\]|$)/;

const SECRET_KEY = /api[_-]?key|secret|token|passw|authori[sz]ation|cookie|credential|private[_-]?key|session|^key$/i;
const SECRET_VALUE = [
  /-----BEGIN [A-Z ]*PRIVATE KEY/,
  /\bbearer\s+[\w.~+/-]+/i,
  /x-api-key/i,
  /[?&](?:api[_-]?key|key|token|access_token|sig|signature|password)=/i,
  /\b[a-z][\d+.a-z-]*:\/\/[^\s/@]+@/i,
  /\beyJ[\w-]+\.[\w-]+\.[\w-]+/,
];
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
// A bare key-shaped token: long, mixed case and digits, no separators a name would have.
const RAW_TOKEN = /^(?=.*\d)(?=.*[a-z])(?=.*[A-Z])[\w-]{32,}$/;

const looksSecret = (value: string) =>
  SECRET_VALUE.some((pattern) => pattern.test(value)) || (RAW_TOKEN.test(value) && !UUID.test(value));

/** Walk every key and string once; the report is small enough (bounded above) to do this eagerly. */
const scan = (value: unknown, isUrlField: boolean, onString: (value: string, isUrlField: boolean) => void) => {
  if (typeof value === 'string') {
    onString(value, isUrlField);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      scan(item, false, onString);
    }
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_KEY.test(key)) {
        reject('secret');
      }
      onString(key, false);
      scan(item, false, onString);
    }
  }
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : reject('invalid');
const count = (value: unknown): number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_COUNT
    ? value
    : reject('invalid');
const text = (value: unknown, max: number, { optional = false } = {}): string => {
  if (optional && (value === undefined || value === null)) {
    return '';
  }
  return typeof value === 'string' && value.length <= max ? value : reject('invalid');
};
const bool = (value: unknown): boolean => (typeof value === 'boolean' ? value : reject('invalid'));
const serverUrl = (value: unknown): string => {
  const raw = text(value, 2048);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return reject('invalid');
  }
  if (url.username || url.password || url.search || url.hash) {
    reject('secret');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    reject('invalid');
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
};
const counts = <K extends string>(value: unknown, keys: readonly K[]): Record<K, number> => {
  const source = record(value);
  return Object.fromEntries(keys.map((key) => [key, count(source[key])])) as Record<K, number>;
};
const oneOf = <T extends string>(value: unknown, allowed: readonly T[]): T =>
  allowed.includes(value as T) ? (value as T) : reject('invalid');

const parseItem = (value: unknown): MigrationUnresolvedItem => {
  const item = record(value);
  return {
    kind: oneOf(item.kind, unresolvedKinds),
    id: text(item.id, 128),
    name: text(item.name, 1024),
    reason: oneOf(item.reason, unresolvedReasons),
    detail: text(item.detail, 500, { optional: true }),
  };
};

export const migrationReportStatus = (report: Pick<MigrationReport, 'dryRun' | 'complete' | 'assets'>) => {
  if (report.dryRun) {
    return 'dry-run';
  }
  if (!report.complete) {
    return 'audit-incomplete';
  }
  const { total, verified, missing, failed } = report.assets;
  return missing === 0 && failed === 0 && verified === total ? 'pass' : 'incomplete';
};

function parse(raw: string): MigrationReport {
  if (raw.length > MIGRATION_REPORT_MAX_BYTES) {
    reject('too-large');
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return reject('not-json');
  }
  const root = record(json);
  if (root.format !== MIGRATION_REPORT_FORMAT || root.formatVersion !== MIGRATION_REPORT_VERSION) {
    reject('unsupported-format');
  }

  // Unresolved item names are the person's own album, tag, person and file names from the
  // source library ("/Backup", a Windows-style drive name, a long hyphenated title). They are display text
  // (rendered escaped), so they are exempt from the path and key-shape rules; any
  // unambiguous credential pattern still rejects them. Everything else, including every
  // `detail`, is checked in full.
  const names: string[] = [];
  const checked = {
    ...root,
    unresolved: Array.isArray(root.unresolved)
      ? root.unresolved.map((item: unknown) => {
          if (item && typeof item === 'object' && !Array.isArray(item)) {
            const { name, ...rest } = item as Record<string, unknown>;
            if (typeof name === 'string') {
              names.push(name);
            }
            return { ...rest, name: '' };
          }
          return item;
        })
      : root.unresolved,
    // The legacy list repeats original file names (already reduced to the last segment).
    missing: Array.isArray(root.missing)
      ? root.missing.map((item: unknown) => {
          if (item && typeof item === 'object' && !Array.isArray(item)) {
            const { filename, ...rest } = item as Record<string, unknown>;
            if (typeof filename === 'string') {
              names.push(filename);
            }
            return { ...rest, filename: '' };
          }
          return item;
        })
      : root.missing,
  };
  if (names.some((name) => SECRET_VALUE.some((pattern) => pattern.test(name)))) {
    reject('secret');
  }
  // Credentials first (anywhere, including the server URLs), then local paths anywhere but
  // the two server URLs, which are checked as URLs below.
  scan(checked, false, (value) => {
    if (looksSecret(value)) {
      reject('secret');
    }
  });
  for (const [key, value] of Object.entries(checked)) {
    if (key === 'from' || key === 'to') {
      continue;
    }
    scan(value, false, (item) => {
      if (FOREIGN_PATH.test(item)) {
        reject('foreign-path');
      }
    });
  }

  if (root.sourceDeletion !== 'never-automatic') {
    reject('invalid');
  }
  const generatedAt = text(root.generatedAt, 40);
  if (!Number.isFinite(Date.parse(generatedAt))) {
    reject('invalid');
  }
  const owners = Array.isArray(root.owners) ? root.owners : reject('invalid');
  if (owners.length === 0 || owners.length > 100) {
    reject('invalid');
  }
  const items = Array.isArray(root.unresolved) ? root.unresolved : reject('invalid');
  if (items.length > MIGRATION_REPORT_MAX_ITEMS) {
    reject('too-large');
  }

  const report: MigrationReport = {
    generatedAt: new Date(generatedAt).toISOString(),
    status: 'incomplete',
    dryRun: bool(root.dryRun),
    complete: bool(root.complete),
    source: serverUrl(root.from),
    destination: serverUrl(root.to),
    owners: owners.map((value) => {
      const owner = record(value);
      return {
        source: owner.source === null ? null : text(owner.source, 320),
        destination: text(owner.destination, 320),
      };
    }),
    assets: counts(root.assets, ['total', 'transferred', 'checked', 'verified', 'missing', 'failed']),
    albums: counts(root.albums, ['total', 'topLevel', 'nested', 'maxDepth', 'created', 'linked']),
    tags: counts(root.tags, ['total', 'assigned']),
    people: counts(root.people, ['total', 'attached']),
    stacks: counts(root.stacks, ['total', 'created']),
    physicalReferences: counts(root.physicalReferences, [
      'newUploads',
      'matchedExisting',
      'livePhotoPairs',
      'livePhotoPairsLinked',
    ]),
    unresolved: items.map((item) => parseItem(item)),
    unresolvedCount: count(root.unresolvedCount),
  };

  const { assets, albums, tags, people, stacks, physicalReferences: physical } = report;
  const consistent =
    assets.verified <= assets.checked &&
    assets.checked <= assets.transferred &&
    assets.transferred <= assets.total &&
    assets.missing <= assets.total &&
    assets.failed <= assets.total &&
    albums.topLevel + albums.nested === albums.total &&
    albums.linked <= albums.created &&
    albums.created <= albums.total &&
    tags.assigned <= tags.total &&
    people.attached <= people.total &&
    stacks.created <= stacks.total &&
    physical.newUploads + physical.matchedExisting === assets.transferred &&
    physical.livePhotoPairsLinked <= physical.livePhotoPairs &&
    report.unresolvedCount >= report.unresolved.length;
  if (!consistent) {
    reject('inconsistent');
  }

  report.status = migrationReportStatus(report);
  // The file's own verdict must agree with its counts; a hand-edited "ok" is not a pass.
  if (bool(root.ok) !== (report.status === 'pass')) {
    reject('inconsistent');
  }
  return report;
}

export function parseMigrationReport(raw: string): MigrationReportResult {
  try {
    return { ok: true, report: parse(raw) };
  } catch (error) {
    if (error instanceof ReportError) {
      return { ok: false, error: error.code };
    }
    throw error;
  }
}

export type UnresolvedFilter = { kind?: UnresolvedKind | ''; query?: string };

export function filterUnresolved(items: MigrationUnresolvedItem[], { kind = '', query = '' }: UnresolvedFilter) {
  const needle = query.trim().toLowerCase();
  return items.filter(
    (item) =>
      (!kind || item.kind === kind) &&
      (!needle || `${item.name} ${item.id} ${item.detail}`.toLowerCase().includes(needle)),
  );
}

export function countUnresolvedByKind(items: MigrationUnresolvedItem[]): Record<UnresolvedKind, number> {
  const result = Object.fromEntries(unresolvedKinds.map((kind) => [kind, 0])) as Record<UnresolvedKind, number>;
  for (const item of items) {
    result[item.kind]++;
  }
  return result;
}
