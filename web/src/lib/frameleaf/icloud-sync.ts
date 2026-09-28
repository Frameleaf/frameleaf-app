import {
  ICloudReviewKind,
  MediaOperationStatus,
  type ICloudConnectionResponseDto,
  type ICloudConnectionUpdateDto,
  type ICloudInventoryResponseDto,
  type ICloudSyncRunDto,
} from '@immich/sdk';
import type { Translations } from 'svelte-i18n';

/**
 * The iCloud Photos connection rules the page shows (FL-68), kept free of Svelte so they can be read
 * and tested on their own. Ported from the `ICloudPanel` of the design template's
 * `UtilitiesManager.jsx`; the server decides every one of them again, so these only keep controls
 * from being offered pointlessly.
 */

/** Connections one account may keep; the server refuses the twenty-first. */
export const ICLOUD_MAX_CONNECTIONS = 20;

export const GIB = 1024 ** 3;
const MIN_STAGING_BYTES = 1024 ** 2;
const MAX_STAGING_BYTES = Number.MAX_SAFE_INTEGER;

/** What the connection's badge says: its account state first, then its current run. */
export type ICloudStatus =
  | 'not-connected'
  | 'connecting'
  | 'awaiting-code'
  | 'awaiting-approval'
  | 'sign-in-again'
  | 'needs-attention'
  | 'connected'
  | 'queued'
  | 'waiting'
  | 'retrying'
  | 'syncing'
  | 'pausing'
  | 'paused'
  | 'cancelling'
  | 'cancelled'
  | 'failed'
  | 'completed';

export type ICloudTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

const ACTIVE_RUN_STATUSES: ReadonlySet<MediaOperationStatus> = new Set([
  MediaOperationStatus.Queued,
  MediaOperationStatus.Preparing,
  MediaOperationStatus.Rendering,
  MediaOperationStatus.Validating,
  MediaOperationStatus.Cancelling,
  MediaOperationStatus.Paused,
]);

/** A run the server is still responsible for: queued, working, stopping or paused. */
export const isActiveRun = (run: ICloudSyncRunDto | null | undefined): boolean =>
  !!run && ACTIVE_RUN_STATUSES.has(run.status);

type Connection = Pick<ICloudConnectionResponseDto, 'state' | 'authenticated' | 'run'>;

export const icloudStatus = (connection: Connection): ICloudStatus => {
  switch (connection.state) {
    case 'authenticating': {
      return 'connecting';
    }
    case 'awaiting-2fa': {
      return 'awaiting-code';
    }
    case 'awaiting-device-approval': {
      return 'awaiting-approval';
    }
    case 'reauthentication-required': {
      return 'sign-in-again';
    }
    case 'disconnected': {
      return 'not-connected';
    }
    case 'error': {
      return 'needs-attention';
    }
  }
  if (!connection.authenticated) {
    return 'not-connected';
  }
  const run = connection.run;
  if (!run) {
    return 'connected';
  }
  switch (run.status) {
    case MediaOperationStatus.Queued: {
      return run.waiting ? 'waiting' : run.retrying ? 'retrying' : 'queued';
    }
    case MediaOperationStatus.Preparing:
    case MediaOperationStatus.Rendering:
    case MediaOperationStatus.Validating: {
      return run.pauseRequested ? 'pausing' : 'syncing';
    }
    case MediaOperationStatus.Paused: {
      return 'paused';
    }
    case MediaOperationStatus.Cancelling: {
      return 'cancelling';
    }
    case MediaOperationStatus.Cancelled: {
      return 'cancelled';
    }
    case MediaOperationStatus.Failed: {
      return 'failed';
    }
    case MediaOperationStatus.Completed: {
      return 'completed';
    }
  }
  return 'connected';
};

const STATUS_TONE: Record<ICloudStatus, ICloudTone> = {
  'not-connected': 'neutral',
  connecting: 'info',
  'awaiting-code': 'warning',
  'awaiting-approval': 'warning',
  'sign-in-again': 'warning',
  'needs-attention': 'danger',
  connected: 'success',
  queued: 'info',
  waiting: 'warning',
  retrying: 'warning',
  syncing: 'info',
  pausing: 'warning',
  paused: 'warning',
  cancelling: 'warning',
  cancelled: 'neutral',
  failed: 'danger',
  completed: 'success',
};

export const icloudStatusTone = (status: ICloudStatus): ICloudTone => STATUS_TONE[status];

export const icloudStatusKey = (status: ICloudStatus): Translations =>
  `frameleaf_icloud_status_${status.replaceAll('-', '_')}` as Translations;

/**
 * Which sign-in step the connection dialog asks for. The account is only ever asked for what the
 * server says is next: a password, a code, a device approval — or nothing, when it is connected. A
 * connection stopped by an error offers the password again, beside a check of the saved session.
 */
export type ICloudAuthStep = 'sign-in' | 'code' | 'approval' | 'connected';

export const icloudAuthStep = (connection: Connection): ICloudAuthStep => {
  switch (connection.state) {
    case 'awaiting-2fa': {
      return 'code';
    }
    case 'awaiting-device-approval': {
      return 'approval';
    }
    case 'connected':
    case 'paused': {
      return connection.authenticated ? 'connected' : 'sign-in';
    }
    default: {
      return 'sign-in';
    }
  }
};

/** Which run controls are offered, mirroring what the server will accept. */
export type ICloudRunControls = {
  syncNow: boolean;
  pause: boolean;
  resume: boolean;
  cancel: boolean;
  retry: boolean;
  rescan: boolean;
};

export const icloudRunControls = (connection: Connection): ICloudRunControls => {
  const run = connection.run;
  const active = isActiveRun(run);
  const signedIn = connection.authenticated && ['connected', 'paused', 'error'].includes(connection.state);
  const resume = !!run && (run.status === MediaOperationStatus.Paused || (active && run.pauseRequested));
  return {
    syncNow: connection.authenticated && ['connected', 'paused'].includes(connection.state) && !active,
    pause:
      !!run &&
      active &&
      !run.pauseRequested &&
      [MediaOperationStatus.Queued, MediaOperationStatus.Preparing, MediaOperationStatus.Rendering].includes(
        run.status,
      ),
    resume,
    cancel: !!run && active && run.status !== MediaOperationStatus.Cancelling,
    retry:
      signedIn &&
      !active &&
      (connection.state === 'error' ||
        run?.status === MediaOperationStatus.Failed ||
        run?.status === MediaOperationStatus.Cancelled),
    rescan: signedIn && !active,
  };
};

/** Progress of the current run, or null when nothing has been counted yet (no bar beats a stuck bar). */
export const icloudRunProgress = (run: ICloudSyncRunDto | null | undefined): number | null => {
  if (!run) {
    return null;
  }
  if (run.status === MediaOperationStatus.Completed) {
    return 100;
  }
  if (!run.totalUnits) {
    return null;
  }
  return Math.min(100, Math.max(0, Math.round(run.progress)));
};

/* ------------------------------------------------------------------ */
/* Sync preferences                                                    */
/* ------------------------------------------------------------------ */

/**
 * The editable preferences. Numbers stay as typed text until saved so a half-typed value is never
 * silently coerced; `librariesAll` is the server's empty list, which also takes in libraries that
 * appear later.
 */
export type ICloudDraft = {
  label: string;
  librariesAll: boolean;
  libraries: string[];
  albums: string[];
  includeEdits: boolean;
  includeHidden: boolean;
  intervalHours: string;
  concurrency: string;
  stagingGiB: string;
};

/** Bytes as GiB text that reads back to exactly the same bytes (a power-of-two division). */
export const formatGiB = (bytes: number) => String(bytes / GIB);

export const icloudDraft = (connection: Pick<ICloudConnectionResponseDto, 'label' | 'config'>): ICloudDraft => ({
  label: connection.label,
  librariesAll: connection.config.libraries.length === 0,
  libraries: [...connection.config.libraries],
  albums: [...connection.config.albums],
  includeEdits: connection.config.includeEdits,
  includeHidden: connection.config.includeHidden,
  intervalHours: String(connection.config.intervalHours),
  concurrency: String(connection.config.concurrency),
  stagingGiB: formatGiB(connection.config.stagingBytes),
});

/** A draft for no connection, so the page never has to carry an optional one. */
export const icloudBlankDraft = (): ICloudDraft => ({
  label: '',
  librariesAll: true,
  libraries: [],
  albums: [],
  includeEdits: true,
  includeHidden: false,
  intervalHours: '24',
  concurrency: '1',
  stagingGiB: '20',
});

export const isLibrarySelected = (draft: ICloudDraft, id: string) => draft.librariesAll || draft.libraries.includes(id);

/**
 * Toggle one library. Unchecking one of "all" makes the rest explicit; checking the last missing one
 * returns to "all". An empty explicit selection is allowed here and refused by validation, as in the
 * design, rather than silently meaning every library.
 */
export const toggleLibrary = (draft: ICloudDraft, id: string, available: string[]): ICloudDraft => {
  const current = draft.librariesAll ? available : draft.libraries;
  const next = current.includes(id) ? current.filter((value) => value !== id) : [...current, id];
  const all = available.length > 0 && available.every((value) => next.includes(value));
  return { ...draft, librariesAll: all, libraries: all ? [] : next };
};

export const toggleAlbum = (draft: ICloudDraft, id: string): ICloudDraft => ({
  ...draft,
  albums: draft.albums.includes(id) ? draft.albums.filter((value) => value !== id) : [...draft.albums, id],
});

const integerIn = (value: string, min: number, max: number) => {
  const number = Number(value);
  return value.trim() !== '' && Number.isSafeInteger(number) && number >= min && number <= max;
};

export type ICloudDraftProblem = 'label' | 'libraries' | 'interval' | 'concurrency' | 'staging';

/** Every problem with the draft, in the order the form shows its fields. Empty means it can be saved. */
export const icloudDraftProblems = (draft: ICloudDraft): ICloudDraftProblem[] => {
  const problems: ICloudDraftProblem[] = [];
  const label = draft.label.trim();
  if (label.length === 0 || label.length > 100) {
    problems.push('label');
  }
  if (!draft.librariesAll && draft.libraries.length === 0) {
    problems.push('libraries');
  }
  if (!integerIn(draft.intervalHours, 1, 8760)) {
    problems.push('interval');
  }
  if (!integerIn(draft.concurrency, 1, 4)) {
    problems.push('concurrency');
  }
  const gib = Number(draft.stagingGiB);
  if (
    draft.stagingGiB.trim() === '' ||
    !Number.isFinite(gib) ||
    gib * GIB < MIN_STAGING_BYTES ||
    gib * GIB > MAX_STAGING_BYTES
  ) {
    problems.push('staging');
  }
  return problems;
};

/**
 * What saving would newly allow; the design asks for explicit consent to each before saving. A match
 * in an external library needs none: the item is always imported as a managed copy beside it, and the
 * external file is only evidence (owner decision, FL-69).
 */
export const icloudConsentNeeded = (
  draft: ICloudDraft,
  connection: Pick<ICloudConnectionResponseDto, 'config'>,
): { hidden: boolean } => ({
  hidden: draft.includeHidden && !connection.config.includeHidden,
});

/**
 * The update to send. An album of a library that is no longer selected is dropped, since it would
 * no longer be read; the staging budget keeps its exact bytes when the GiB text was not changed.
 */
export const icloudDraftUpdate = (
  draft: ICloudDraft,
  connection: Pick<ICloudConnectionResponseDto, 'config'>,
  inventory?: Pick<ICloudInventoryResponseDto, 'albums'>,
): ICloudConnectionUpdateDto => {
  const libraries = draft.librariesAll ? [] : [...draft.libraries];
  const albums =
    inventory && libraries.length > 0
      ? draft.albums.filter((id) => {
          const album = inventory.albums.find((candidate) => candidate.id === id);
          return !album || libraries.includes(album.libraryId);
        })
      : [...draft.albums];
  const stagingBytes =
    draft.stagingGiB === formatGiB(connection.config.stagingBytes)
      ? connection.config.stagingBytes
      : Math.min(MAX_STAGING_BYTES, Math.max(MIN_STAGING_BYTES, Math.round(Number(draft.stagingGiB) * GIB)));
  return {
    label: draft.label.trim(),
    config: {
      libraries,
      albums,
      includeEdits: draft.includeEdits,
      includeHidden: draft.includeHidden,
      intervalHours: Number(draft.intervalHours),
      concurrency: Number(draft.concurrency),
      stagingBytes,
    },
  };
};

/* ------------------------------------------------------------------ */
/* Reconciliation                                                      */
/* ------------------------------------------------------------------ */

export type ICloudSummary = {
  imported: number;
  matched: number;
  repaired: number;
  review: number;
  skipped: number;
  failed: number;
  sourceRemoved: number;
  discovered: number;
};

/** The reconciliation line: counts the server saved, never estimated here. */
export const icloudSummary = (counts: Record<string, number>): ICloudSummary => {
  const count = (key: string) => (Number.isFinite(counts[key]) ? counts[key] : 0);
  return {
    imported: count('imported'),
    matched: count('reused'),
    repaired: count('repaired-missing') + count('repaired-corrupt'),
    review: count('needs-review'),
    skipped: count('unsupported') + count('preserve-trashed'),
    failed: count('failed'),
    sourceRemoved: count('source_removed'),
    discovered: count('discoveredLogicalAssets'),
  };
};

type ReviewItem = ICloudInventoryResponseDto['review'][number];

const LIVE_PHOTO_REASONS = new Set([
  'live_photo_identity_conflict',
  'local_live_photo_override',
  'motion_visibility_override',
  'motion_has_manual_membership',
]);

const REASON_KEYS: Record<string, string> = {
  source_hidden_requires_consent: 'hidden',
  hidden_match_requires_consent: 'hidden',
  external_conversion_requires_consent: 'external',
  multiple_content_matches: 'ambiguous_match',
  saved_checksum_conflict: 'ambiguous_match',
  mapped_asset_identity_changed: 'ambiguous_match',
  reserved_import_content_match: 'ambiguous_match',
  media_type_mismatch: 'unsupported',
  media_type_unsupported: 'unsupported',
  no_original_or_render_descriptor: 'unsupported',
  quota_exceeded: 'quota',
  retained_edit_limit: 'edit_limit',
  destination_not_active: 'kept_trashed',
  live_photo_identity_conflict: 'live_photo',
  local_live_photo_override: 'live_photo',
  motion_visibility_override: 'live_photo',
  motion_has_manual_membership: 'live_photo',
  local_stack_membership_override: 'stack',
  manual_stack_conflict: 'stack',
  source_stack_removed: 'stack',
  source_metadata_conflict: 'metadata',
};

/** A plain explanation of one finding: by its reason when known, else by what kind of finding it is. */
export const icloudReviewReasonKey = (item: Pick<ReviewItem, 'kind' | 'reason'>): Translations => {
  if (item.kind === ICloudReviewKind.SourceRemoved) {
    return 'frameleaf_icloud_reason_source_removed';
  }
  if (item.kind === ICloudReviewKind.KeptTrashed) {
    return 'frameleaf_icloud_reason_kept_trashed';
  }
  const known = item.reason ? REASON_KEYS[item.reason] : undefined;
  if (known) {
    return `frameleaf_icloud_reason_${known}` as Translations;
  }
  return `frameleaf_icloud_reason_kind_${item.kind.replaceAll('-', '_')}` as Translations;
};

/** Where a finding is reviewed: Live Photo pairs in their utility, anything with a photo in the viewer. */
export const icloudReviewTarget = (item: Pick<ReviewItem, 'reason' | 'assetId'>): 'live-photos' | 'asset' | null => {
  if (item.reason && LIVE_PHOTO_REASONS.has(item.reason)) {
    return 'live-photos';
  }
  return item.assetId ? 'asset' : null;
};

const OUTCOME_KEYS: Record<string, string> = {
  imported: 'imported',
  reused: 'matched',
  'repaired-missing': 'repaired_missing',
  'repaired-corrupt': 'repaired_corrupt',
};

export const icloudOutcomeKey = (outcome: string): Translations =>
  `frameleaf_icloud_outcome_${OUTCOME_KEYS[outcome] ?? 'other'}` as Translations;

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

const ERROR_KEYS: Record<string, string> = {
  two_factor_required: 'two_factor_required',
  device_approval_required: 'device_approval_required',
  reauthentication_required: 'reauthentication_required',
  icloud_authenticating: 'authenticating',
  icloud_sign_in_required: 'sign_in_required',
  icloud_disconnected: 'disconnected',
  rate_limited: 'rate_limited',
  icloud_transport_failed: 'provider_unavailable',
  icloud_transport_timeout: 'provider_unavailable',
  invalid_change_token: 'change_token',
  resource_changed: 'resource_changed',
  staging_retained_capacity: 'staging_full',
  staging_disk_full: 'staging_full',
  icloud_finalization_failed: 'finalization',
  icloud_disabled: 'disabled',
  icloud_bridge_configuration_invalid: 'configuration',
  icloud_secrets_not_configured: 'configuration',
  icloud_secrets_invalid: 'configuration',
  staging_not_configured: 'configuration',
  staging_permissions_invalid: 'configuration',
  staging_overlaps_library: 'configuration',
  staging_symlink: 'configuration',
  icloud_admin_limit_exceeded: 'admin_limit',
  icloud_auth_rate_limited: 'auth_rate_limited',
  icloud_requires_https: 'requires_https',
  icloud_run_active: 'run_active',
  icloud_no_active_run: 'no_active_run',
  icloud_run_not_pausable: 'no_active_run',
  icloud_connection_limit: 'connection_limit',
  icloud_remove_in_flight: 'remove_in_flight',
  icloud_disconnect_first: 'disconnect_first',
  icloud_connection_unavailable: 'connection_unavailable',
  icloud_sync_stalled: 'stalled',
};

/** A stable server code as a translated message; anything unknown reads as a general failure. */
export const icloudErrorKey = (code: string | null | undefined): Translations =>
  `frameleaf_icloud_error_${(code && ERROR_KEYS[code]) || 'generic'}` as Translations;
