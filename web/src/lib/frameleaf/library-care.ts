import {
  MediaHealthCategory,
  MediaHealthRootKind,
  MediaHealthStatus,
  MediaOperationStatus,
  type MediaHealthCandidateDto,
  type MediaHealthItemDto,
  type MediaHealthListResponseDto,
  type MediaHealthOperationDto,
  type MediaHealthRunResponseDto,
  type MediaHealthSummaryResponseDto,
} from '@immich/sdk';
import type { Translations } from 'svelte-i18n';

/**
 * Library Care (FL-69): the view model behind Settings → Utilities → Missing media and Damaged
 * media, ported from the September 22, 2026 prototype's `UtilitiesManager` and `UtilityRecovery`.
 *
 * The prototype decides what each button may do from a row's status, checksum and candidate; this
 * module makes the same decisions from what the server actually recorded, so the page never offers
 * an action the server would refuse. The server re-checks everything anyway: this only keeps the
 * interface honest. Kept free of Svelte so it can be tested on its own.
 */

/** One finding as a table row. */
export type LibraryCareRow = {
  id: string;
  assetId: string;
  ownerId: string;
  name: string;
  path: string;
  status: MediaHealthStatus;
  category: MediaHealthCategory;
  sizeInBytes: number | null;
  thumbhash: string | null;
  evidence: string | null;
  candidates: MediaHealthCandidateDto[];
  item: MediaHealthItemDto;
};

/** Statuses nothing is left to decide about. Everything else needs attention (the default view). */
export const SETTLED_STATUSES: readonly MediaHealthStatus[] = [
  MediaHealthStatus.Relinked,
  MediaHealthStatus.Resolved,
  MediaHealthStatus.Dismissed,
  MediaHealthStatus.Trashed,
  MediaHealthStatus.Deleted,
];

export const needsAttention = (status: MediaHealthStatus) => !SETTLED_STATUSES.includes(status);

/**
 * Customer words for a status. Unsupported RAW, suspected damage and confirmed damage are kept
 * visibly distinct: only confirmed damage is ever offered for replacement or the trash.
 */
export const STATUS_LABEL_KEY: Readonly<Record<MediaHealthStatus, Translations>> = {
  [MediaHealthStatus.Missing]: 'library_care_status_missing',
  [MediaHealthStatus.Candidate]: 'library_care_status_candidate',
  [MediaHealthStatus.Found]: 'library_care_status_found',
  [MediaHealthStatus.Relinked]: 'library_care_status_relinked',
  [MediaHealthStatus.Dismissed]: 'library_care_status_dismissed',
  [MediaHealthStatus.Resolved]: 'library_care_status_resolved',
  [MediaHealthStatus.UnsupportedRaw]: 'library_care_status_unsupported_raw',
  [MediaHealthStatus.CorruptSuspect]: 'library_care_status_suspected',
  [MediaHealthStatus.CorruptConfirmed]: 'library_care_status_confirmed',
  [MediaHealthStatus.TrashQueued]: 'library_care_status_trash_queued',
  [MediaHealthStatus.Trashed]: 'library_care_status_trashed',
  [MediaHealthStatus.DeleteQueued]: 'library_care_status_trash_queued',
  [MediaHealthStatus.Deleted]: 'library_care_status_trashed',
};

export type StatusTone = 'danger' | 'warning' | 'info' | 'success' | 'neutral';

export const statusTone = (status: MediaHealthStatus): StatusTone => {
  switch (status) {
    case MediaHealthStatus.Missing:
    case MediaHealthStatus.CorruptConfirmed: {
      return 'danger';
    }
    case MediaHealthStatus.Candidate:
    case MediaHealthStatus.CorruptSuspect:
    case MediaHealthStatus.TrashQueued:
    case MediaHealthStatus.DeleteQueued: {
      return 'warning';
    }
    case MediaHealthStatus.Found:
    case MediaHealthStatus.UnsupportedRaw: {
      return 'info';
    }
    case MediaHealthStatus.Relinked:
    case MediaHealthStatus.Resolved: {
      return 'success';
    }
    default: {
      return 'neutral';
    }
  }
};

const text = (value: unknown) => (typeof value === 'string' && value.trim() !== '' ? value : null);

/**
 * The server's evidence as a sentence a person can read. Reasons are stable codes; anything the
 * server did not explain stays unexplained rather than being dumped as JSON.
 */
export const EVIDENCE_REASON_KEY: Readonly<Record<string, Translations>> = {
  source_file_missing_or_unreadable: 'library_care_evidence_missing',
  file_missing: 'library_care_evidence_missing',
  access_denied: 'library_care_evidence_unreadable',
  not_regular_file: 'library_care_evidence_unreadable',
  expected_mismatch: 'library_care_evidence_checksum_mismatch',
  empty_file: 'library_care_evidence_empty',
  decode_failed: 'library_care_evidence_decode_failed',
  raw_decode_unsupported: 'library_care_evidence_raw_unsupported',
  media_type_unsupported: 'library_care_evidence_format_unsupported',
  decode_unsupported: 'library_care_evidence_format_unsupported',
  validation_timeout: 'library_care_evidence_timeout',
  decode_timeout: 'library_care_evidence_timeout',
  decode_unverified: 'library_care_evidence_unverified',
  candidate_relinked: 'library_care_evidence_relinked',
  recovered_from_verified_copy: 'library_care_evidence_recovered',
  revalidation_passed: 'library_care_evidence_revalidated',
  trash_revalidation_passed: 'library_care_evidence_revalidated',
};

export const evidenceKey = (item: Pick<MediaHealthItemDto, 'evidence'>): Translations | null => {
  const reason = text(item.evidence?.reason);
  return reason ? (EVIDENCE_REASON_KEY[reason] ?? null) : null;
};

export const toRows = (list: MediaHealthListResponseDto): LibraryCareRow[] =>
  list.buckets.flatMap((bucket) =>
    bucket.items.map((item) => ({
      id: item.id,
      assetId: item.assetId,
      ownerId: item.asset.ownerId,
      name: item.originalFileName,
      path: item.originalPath,
      status: item.status,
      category: item.category,
      sizeInBytes: item.asset.exifInfo?.fileSizeInByte ?? null,
      thumbhash: item.asset.thumbhash,
      evidence: text(item.evidence?.error) ?? text(item.evidence?.reason),
      candidates: item.candidates,
      item,
    })),
  );

/** The prototype's "Find items": filename, account or status, case-insensitive. */
export const filterRows = (
  rows: readonly LibraryCareRow[],
  query: string,
  describe: (row: LibraryCareRow) => string,
): LibraryCareRow[] => {
  const needle = query.trim().toLowerCase();
  return needle ? rows.filter((row) => describe(row).toLowerCase().includes(needle)) : [...rows];
};

/** A candidate that proves identity: an exact checksum match the server verified. */
export const isVerified = (candidate: MediaHealthCandidateDto) =>
  candidate.status === MediaHealthStatus.Found && candidate.checksumMatch;

/**
 * The copy a relink will use, exactly as the server picks it: the one the reviewer chose among
 * several verified copies, or the only verified copy. None while the search was incomplete.
 */
export const relinkCandidate = (row: LibraryCareRow): MediaHealthCandidateDto | undefined => {
  if (row.category !== MediaHealthCategory.Missing || row.status !== MediaHealthStatus.Found) {
    return undefined;
  }
  const verified = row.candidates.filter(
    (candidate) => isVerified(candidate) && candidate.resolution?.autoRelinkable === true,
  );
  return verified.find((candidate) => candidate.chosen) ?? (verified.length === 1 ? verified[0] : undefined);
};

/** "Relink verified matches" needs a verified copy for every chosen row. */
export const canRelink = (rows: readonly LibraryCareRow[]) =>
  rows.length > 0 && rows.every((row) => relinkCandidate(row) !== undefined);

/** A copy that may replace confirmed damage: exact checksum and a successful decode. */
export const isRecoveryCandidate = (candidate: MediaHealthCandidateDto) =>
  isVerified(candidate) && candidate.decodeValid === true && candidate.rootKind !== MediaHealthRootKind.Library;

/** "Recover from a verified copy" is only for confirmed damage (never RAW or suspected damage). */
export const canRecover = (rows: readonly LibraryCareRow[]) =>
  rows.length > 0 && rows.every((row) => row.status === MediaHealthStatus.CorruptConfirmed);

/** Rows the trash action may take: confirmed damage, or damage still queued from a cancelled job. */
export const trashable = (rows: readonly LibraryCareRow[]) =>
  rows.filter(
    (row) => row.status === MediaHealthStatus.CorruptConfirmed || row.status === MediaHealthStatus.TrashQueued,
  );

/** RAW originals, by the extensions the server reads as RAW (server/src/utils/mime-types.ts `raw`). */
const RAW_EXTENSIONS: ReadonlySet<string> = new Set([
  '3fr',
  'ari',
  'arw',
  'cap',
  'cin',
  'cr2',
  'cr3',
  'crw',
  'dcr',
  'dng',
  'erf',
  'fff',
  'iiq',
  'k25',
  'kdc',
  'mrw',
  'nef',
  'nrw',
  'orf',
  'ori',
  'pef',
  'psd',
  'raf',
  'raw',
  'rw2',
  'rwl',
  'sr2',
  'srf',
  'srw',
  'x3f',
]);

export const isRawName = (name: string) => RAW_EXTENSIONS.has(name.split('.').pop()?.toLowerCase() ?? '');

/**
 * Rows a search for originals can cover. With Library care's "Suggest recoverable RAW sources" off,
 * RAW originals are not searched for (the server refuses them too).
 */
export const locatable = (rows: readonly LibraryCareRow[], { rawRecovery = true }: { rawRecovery?: boolean } = {}) =>
  rows.filter(
    (row) =>
      ((row.category === MediaHealthCategory.Missing && needsAttention(row.status)) ||
        row.status === MediaHealthStatus.CorruptConfirmed) &&
      (rawRecovery || !isRawName(row.name)),
  );

/**
 * Whether a chosen set of candidates for the recovery dialog is complete: every row has a
 * candidate inside a selected location, and for replacement it must be exact and decoded.
 */
export const recoveryChoicesValid = (
  rows: readonly LibraryCareRow[],
  choices: Readonly<Record<string, string | undefined>>,
  rootIds: readonly string[],
  mode: 'locate' | 'replace',
) =>
  rows.length > 0 &&
  rows.every((row) => {
    const candidate = row.candidates.find((item) => item.id === choices[row.id]);
    if (!candidate || !candidate.rootId || !rootIds.includes(candidate.rootId)) {
      return false;
    }
    return mode === 'replace' ? isRecoveryCandidate(candidate) : isVerified(candidate);
  });

/** Candidates the dialog shows for a row: those inside the selected search locations. */
export const candidatesIn = (row: LibraryCareRow, rootIds: readonly string[]) =>
  row.candidates.filter((candidate) => !candidate.rootId || rootIds.includes(candidate.rootId));

/* ------------------------------------------------------------------ */
/* The scan bar                                                        */
/* ------------------------------------------------------------------ */

export type ScanState =
  | { kind: 'never' }
  | { kind: 'queued'; operation: MediaHealthOperationDto }
  | { kind: 'running'; operation: MediaHealthOperationDto; done: number; total: number | null }
  | { kind: 'pausing'; operation: MediaHealthOperationDto }
  | { kind: 'paused'; operation: MediaHealthOperationDto }
  | { kind: 'retrying'; operation: MediaHealthOperationDto; error: string | null }
  | { kind: 'failed'; at: string | null; error: string | null }
  | { kind: 'cancelled'; at: string | null }
  /** A run left open with no job working on it: stopped before it finished. */
  | { kind: 'interrupted'; at: string | null }
  | { kind: 'completed'; at: string | null };

const WORKING: ReadonlySet<MediaOperationStatus> = new Set([
  MediaOperationStatus.Preparing,
  MediaOperationStatus.Rendering,
  MediaOperationStatus.Validating,
  MediaOperationStatus.Cancelling,
]);

/** A scan or search is still the server's problem: Scan again is held back until it ends. */
export const isActiveOperation = (operation: MediaHealthOperationDto | null | undefined) =>
  !!operation &&
  (operation.status === MediaOperationStatus.Queued ||
    operation.status === MediaOperationStatus.Paused ||
    WORKING.has(operation.status));

/**
 * The scan bar's state, from the latest job and the latest health run of the category. A job that
 * is running, paused or waiting for its automatic retry wins; after that the run says how the last
 * scan ended and when.
 */
export const scanState = (
  summary: Pick<MediaHealthSummaryResponseDto, 'operation' | 'runs'>,
  category: MediaHealthCategory,
): ScanState => {
  const operation = summary.operation;
  if (operation && isActiveOperation(operation)) {
    if (operation.status === MediaOperationStatus.Paused) {
      return { kind: 'paused', operation };
    }
    if (operation.pauseRequestedAt) {
      return { kind: 'pausing', operation };
    }
    if (operation.status === MediaOperationStatus.Queued) {
      return operation.autoRetries > 0
        ? { kind: 'retrying', operation, error: operation.error }
        : { kind: 'queued', operation };
    }
    return {
      kind: 'running',
      operation,
      done: operation.processedUnits,
      total: operation.totalUnits,
    };
  }

  const run: MediaHealthRunResponseDto | null =
    category === MediaHealthCategory.Missing ? summary.runs.missing : summary.runs.corrupt;
  if (!run) {
    return { kind: 'never' };
  }
  const at = run.finishedAt ?? run.startedAt;
  switch (run.status) {
    case 'completed': {
      return { kind: 'completed', at };
    }
    case 'failed': {
      return { kind: 'failed', at, error: run.error };
    }
    case 'cancelled': {
      return { kind: 'cancelled', at };
    }
    default: {
      // running, paused or retrying with no job left to finish it, or a state this page does not know
      return { kind: 'interrupted', at };
    }
  }
};

/** Bytes for people: the prototype's `formatBytes`, with the unit it chose. */
export const formatBytes = (bytes: number | null | undefined): string => {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) {
    return '';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
};

/** How long a finished job may be followed before the page stops asking about it. */
export const LIBRARY_CARE_POLL_MS = 3000;

/** The label of one Library Care activity action the server reports. */
export const libraryCareActivityKey = (action: string): Translations =>
  `library_care_activity_${action.replaceAll('-', '_')}` as Translations;

/* ------------------------------------------------------------------ */
/* Whose findings (UT-13)                                              */
/* ------------------------------------------------------------------ */

/** `all`, or one account's id. */
export type LibraryCareOwner = string;

export type AccountOption = { value: LibraryCareOwner; name: string | null };

/**
 * The Account select (UtilitiesManager.jsx:158-172): "All accounts" and then every account by name,
 * the administrator's own first. Somebody who is not an administrator reviews only their own
 * findings, so they are offered only themselves. `name: null` is "All accounts".
 */
export const accountOptions = (
  users: readonly { id: string; name: string }[],
  self: { id: string; name: string },
  isAdmin: boolean,
): AccountOption[] => {
  if (!isAdmin) {
    return [{ value: self.id, name: self.name }];
  }
  // The signed-in administrator comes first, then the other accounts (UtilitiesManager.jsx:270-276:
  // taylor, then jamie and emma), whatever order the server listed them in.
  const everyone = [self, ...users.filter(({ id }) => id !== self.id)];
  return [{ value: 'all', name: null }, ...everyone.map(({ id, name }) => ({ value: id, name }))];
};

/**
 * Whose findings the page opens on: the account the Command Center's "Viewing" scope names
 * (`?scope=user:<id>`), or — as the template defaults — all accounts. Only ever the reader's own for
 * somebody who is not an administrator.
 */
export const initialOwner = (
  scope: string | null,
  users: readonly { id: string }[],
  selfId: string,
  isAdmin: boolean,
): LibraryCareOwner => {
  if (!isAdmin) {
    return selfId;
  }
  const id = scope?.startsWith('user:') ? scope.slice('user:'.length) : null;
  return id && (id === selfId || users.some((user) => user.id === id)) ? id : 'all';
};

/** The owner choice as the query the server reads. */
export const ownerScope = (owner: LibraryCareOwner, selfId: string) =>
  owner === 'all' ? { allAccounts: true } : owner === selfId ? {} : { ownerId: owner };

/* ------------------------------------------------------------------ */
/* Undo (UT-2)                                                         */
/* ------------------------------------------------------------------ */

/**
 * Whether moving these rows to the trash can be undone from this page: the viewer can restore only
 * their own items from the trash, so a set that includes another account's items offers no Undo.
 */
export const trashUndoable = (rows: readonly Pick<LibraryCareRow, 'ownerId'>[], selfId: string) =>
  rows.length > 0 && rows.every((row) => row.ownerId === selfId);
