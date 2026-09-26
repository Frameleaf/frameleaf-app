/**
 * Render worker rules for the Frameleaf admin page (FL-95 `STU-401`).
 *
 * The server owns admission: `RenderWorkerService` decides who is admitted, what may be claimed
 * and when a job is stopped, and writes every decision to the audit trail. This module only turns
 * what the admin endpoints return into rows an administrator can read and forms they can fill in,
 * so the components stay about presentation and these rules stay testable without a DOM.
 *
 * Nothing here ever sees a secret: `RenderWorkerDto` carries no enrolment secret and no session,
 * and the one time a secret is visible (`RenderWorkerCreateResponseDto`) it goes straight from
 * the response to the dialog that shows it once.
 */
import {
  MediaOperationDestination,
  MediaOperationKind,
  RenderWorkerAuditEvent,
  RenderWorkerRefusalReason,
  RenderWorkerStatus,
  type RenderWorkerDto,
  type RenderWorkerLimitDto,
} from '@immich/sdk';
import type { Translations } from 'svelte-i18n';

/** Bounds a pasted block of text so every keystroke cannot re-filter against a huge string. */
export const RENDER_WORKER_QUERY_MAX_LENGTH = 200;

/**
 * A worker heartbeats a held claim every 30 seconds and re-admits within a session of hours.
 * Five minutes without any call is many missed beats: the worker is shown as unreachable, which
 * is a display state only; the server's lease recovery is what actually reassigns its jobs.
 */
export const RENDER_WORKER_UNREACHABLE_MS = 5 * 60_000;

/** The server's ceiling on any concurrency figure (`RenderWorkerLimitUpdateDto`). */
export const RENDER_LIMIT_MAX_CONCURRENCY = 64;

/** The server refuses conformance evidence windows under one minute. */
export const RENDER_WORKER_MIN_CONFORMANCE_AGE_MS = 60_000;

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const BYTES_PER_GIB = 1024 ** 3;

/* ------------------------------------------------------------------ */
/* Worker rows                                                          */
/* ------------------------------------------------------------------ */

export type RenderWorkerHealth = 'revoked' | 'busy' | 'ready' | 'unreachable' | 'never_admitted';

export type RenderWorkerRow = Pick<
  RenderWorkerDto,
  | 'id'
  | 'name'
  | 'destination'
  | 'status'
  | 'kinds'
  | 'activeOperations'
  | 'maxConcurrentOperations'
  | 'lastSeenAt'
  | 'lastAdmittedAt'
  | 'engineDigest'
>;

/**
 * What the administrator should read at a glance. Revocation wins over everything; a worker that
 * was never admitted has nothing to be stale about; then reachability, then whether it is working.
 */
export const workerHealth = (
  worker: Pick<RenderWorkerRow, 'status' | 'activeOperations' | 'lastSeenAt' | 'lastAdmittedAt'>,
  now: Date,
): RenderWorkerHealth => {
  if (worker.status === RenderWorkerStatus.Revoked) {
    return 'revoked';
  }
  if (!worker.lastAdmittedAt) {
    return 'never_admitted';
  }
  const seen = worker.lastSeenAt ? Date.parse(worker.lastSeenAt) : NaN;
  if (Number.isNaN(seen) || now.getTime() - seen > RENDER_WORKER_UNREACHABLE_MS) {
    return 'unreachable';
  }
  return worker.activeOperations > 0 ? 'busy' : 'ready';
};

export type RenderWorkerFilter = 'active' | 'all' | 'revoked';

export const normalizeWorkerQuery = (query: string | undefined | null): string =>
  (query ?? '').trim().slice(0, RENDER_WORKER_QUERY_MAX_LENGTH).toLowerCase();

export const filterWorkers = <T extends RenderWorkerRow>(
  workers: readonly T[],
  options: { query?: string; filter: RenderWorkerFilter; destination?: MediaOperationDestination | 'all' },
): T[] => {
  const query = normalizeWorkerQuery(options.query);
  const destination = options.destination ?? 'all';

  return workers.filter((worker) => {
    if (options.filter === 'active' && worker.status !== RenderWorkerStatus.Active) {
      return false;
    }
    if (options.filter === 'revoked' && worker.status !== RenderWorkerStatus.Revoked) {
      return false;
    }
    if (destination !== 'all' && worker.destination !== destination) {
      return false;
    }
    if (query.length === 0) {
      return true;
    }
    return (
      worker.name.toLowerCase().includes(query) ||
      worker.id.toLowerCase().includes(query) ||
      (worker.engineDigest ?? '').toLowerCase().includes(query)
    );
  });
};

/** Active identities first, then by name, so a revoked worker never sorts above a live one. */
export const sortWorkers = <T extends RenderWorkerRow>(workers: readonly T[]): T[] =>
  [...workers].sort((a, b) => {
    if (a.status !== b.status) {
      return a.status === RenderWorkerStatus.Active ? -1 : 1;
    }
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id);
  });

/* ------------------------------------------------------------------ */
/* Vocabulary                                                           */
/* ------------------------------------------------------------------ */

export const workerHealthKey: Readonly<Record<RenderWorkerHealth, Translations>> = {
  busy: 'frameleaf_render_workers_health_busy',
  ready: 'frameleaf_render_workers_health_ready',
  unreachable: 'frameleaf_render_workers_health_unreachable',
  never_admitted: 'frameleaf_render_workers_health_never_admitted',
  revoked: 'frameleaf_render_workers_health_revoked',
};

export const workerHealthTone: Readonly<Record<RenderWorkerHealth, 'teal' | 'blue' | 'warning' | 'neutral'>> = {
  busy: 'blue',
  ready: 'teal',
  unreachable: 'warning',
  never_admitted: 'neutral',
  revoked: 'neutral',
};

export const destinationKey: Readonly<Record<MediaOperationDestination, Translations>> = {
  [MediaOperationDestination.Local]: 'frameleaf_render_workers_destination_local',
  [MediaOperationDestination.Lan]: 'frameleaf_render_workers_destination_lan',
  [MediaOperationDestination.FrameleafCloud]: 'frameleaf_render_workers_destination_frameleaf_cloud',
};

export const operationKindKey: Readonly<Record<MediaOperationKind, Translations>> = {
  [MediaOperationKind.StudioExport]: 'frameleaf_render_workers_kind_studio_export',
  [MediaOperationKind.StudioPreview]: 'frameleaf_render_workers_kind_studio_preview',
  [MediaOperationKind.Restoration]: 'frameleaf_render_workers_kind_restoration',
  [MediaOperationKind.RestorationPreview]: 'frameleaf_render_workers_kind_restoration_preview',
  [MediaOperationKind.QuickEdit]: 'frameleaf_render_workers_kind_quick_edit',
  [MediaOperationKind.Bulk]: 'frameleaf_render_workers_kind_bulk',
  [MediaOperationKind.StudioBundleExport]: 'frameleaf_render_workers_kind_studio_bundle_export',
  [MediaOperationKind.StudioBundleImport]: 'frameleaf_render_workers_kind_studio_bundle_import',
  [MediaOperationKind.EnrichmentPlan]: 'frameleaf_render_workers_kind_enrichment_plan',
  [MediaOperationKind.MediaHealth]: 'frameleaf_render_workers_kind_media_health',
  [MediaOperationKind.IcloudSync]: 'frameleaf_render_workers_kind_icloud_sync',
  [MediaOperationKind.TakeoutImport]: 'frameleaf_render_workers_kind_takeout_import',
  [MediaOperationKind.PhysicalDeduplication]: 'frameleaf_render_workers_kind_physical_deduplication',
  [MediaOperationKind.LibraryScan]: 'frameleaf_render_workers_kind_library_scan',
  [MediaOperationKind.PreservationExport]: 'frameleaf_render_workers_kind_preservation_export',
  [MediaOperationKind.PreservationVerify]: 'frameleaf_render_workers_kind_preservation_verify',
  [MediaOperationKind.PreservationReview]: 'frameleaf_render_workers_kind_preservation_review',
  [MediaOperationKind.PreservationRestore]: 'frameleaf_render_workers_kind_preservation_restore',
  [MediaOperationKind.StudioExportPublish]: 'frameleaf_render_workers_kind_studio_export_publish',
  [MediaOperationKind.CloudBackup]: 'frameleaf_render_workers_kind_cloud_backup',
};

/**
 * The kinds a render worker can be scoped to (FL-73): the renders. Bulk jobs (duplicate decisions
 * included), portable project bundles, enrichment plans, Library Care, iCloud and Google Photos
 * imports, physical deduplication, preservation packages (FL-74) and other server-side jobs run on
 * this server's own workers and are never offered to a remote renderer; the server refuses them
 * too. {@link operationKindKey} still names every kind, because a worker enrolled before this list
 * existed may carry one in its saved scope.
 */
export const RENDER_WORKER_KINDS: readonly MediaOperationKind[] = [
  MediaOperationKind.StudioExport,
  MediaOperationKind.StudioPreview,
  MediaOperationKind.Restoration,
  MediaOperationKind.RestorationPreview,
  MediaOperationKind.QuickEdit,
];

export const isRenderWorkerKind = (kind: MediaOperationKind) => RENDER_WORKER_KINDS.includes(kind);

export const auditEventKey: Readonly<Record<RenderWorkerAuditEvent, Translations>> = {
  [RenderWorkerAuditEvent.Enrolled]: 'frameleaf_render_workers_event_enrolled',
  [RenderWorkerAuditEvent.Admitted]: 'frameleaf_render_workers_event_admitted',
  [RenderWorkerAuditEvent.Refused]: 'frameleaf_render_workers_event_refused',
  [RenderWorkerAuditEvent.ClaimRefused]: 'frameleaf_render_workers_event_claim_refused',
  [RenderWorkerAuditEvent.LimitExceeded]: 'frameleaf_render_workers_event_limit_exceeded',
  [RenderWorkerAuditEvent.Revoked]: 'frameleaf_render_workers_event_revoked',
  [RenderWorkerAuditEvent.Updated]: 'frameleaf_render_workers_event_updated',
  [RenderWorkerAuditEvent.DeviceLost]: 'frameleaf_render_workers_event_device_lost',
};

/** Events that mean something was turned away or stopped; the audit list marks them. */
export const auditEventIsRefusal = (event: RenderWorkerAuditEvent): boolean =>
  [
    RenderWorkerAuditEvent.Refused,
    RenderWorkerAuditEvent.ClaimRefused,
    RenderWorkerAuditEvent.LimitExceeded,
    RenderWorkerAuditEvent.DeviceLost,
  ].includes(event);

/**
 * Every stable refusal code the server writes, as a sentence an administrator can act on. The
 * same codes appear on a refused operation, so Activity (FL-104) can reuse these keys.
 */
export const refusalReasonKey: Readonly<Record<RenderWorkerRefusalReason, Translations>> = {
  [RenderWorkerRefusalReason.InvalidCredential]: 'frameleaf_render_workers_refusal_invalid_credential',
  [RenderWorkerRefusalReason.WorkerRevoked]: 'frameleaf_render_workers_refusal_worker_revoked',
  [RenderWorkerRefusalReason.SessionExpired]: 'frameleaf_render_workers_refusal_session_expired',
  [RenderWorkerRefusalReason.ConformanceStale]: 'frameleaf_render_workers_refusal_conformance_stale',
  [RenderWorkerRefusalReason.ConformanceReplayed]: 'frameleaf_render_workers_refusal_conformance_replayed',
  [RenderWorkerRefusalReason.EngineDigestMismatch]: 'frameleaf_render_workers_refusal_engine_digest_mismatch',
  [RenderWorkerRefusalReason.SoftwareRenderer]: 'frameleaf_render_workers_refusal_software_renderer',
  [RenderWorkerRefusalReason.DestinationMismatch]: 'frameleaf_render_workers_refusal_destination_mismatch',
  [RenderWorkerRefusalReason.WorkerMismatch]: 'frameleaf_render_workers_refusal_worker_mismatch',
  [RenderWorkerRefusalReason.ScopeExceeded]: 'frameleaf_render_workers_refusal_scope_exceeded',
  [RenderWorkerRefusalReason.WorkerConcurrencyExceeded]: 'frameleaf_render_workers_refusal_worker_concurrency',
  [RenderWorkerRefusalReason.UserConcurrencyExceeded]: 'frameleaf_render_workers_refusal_user_concurrency',
  [RenderWorkerRefusalReason.GpuMemoryInsufficient]: 'frameleaf_render_workers_refusal_gpu_memory_insufficient',
  [RenderWorkerRefusalReason.WallClockExceeded]: 'frameleaf_render_workers_refusal_wall_clock_exceeded',
  [RenderWorkerRefusalReason.OutputBytesExceeded]: 'frameleaf_render_workers_refusal_output_bytes_exceeded',
  [RenderWorkerRefusalReason.DestinationUnavailable]: 'frameleaf_render_workers_refusal_destination_unavailable',
  [RenderWorkerRefusalReason.ManifestIncomplete]: 'frameleaf_render_workers_refusal_manifest_incomplete',
  [RenderWorkerRefusalReason.CodecUnsupported]: 'frameleaf_render_workers_refusal_codec_unsupported',
};

/**
 * Flatten an audit row's operator detail into label/value pairs. The server never writes a
 * secret or a path into `detail`, so everything present may be shown; nested objects are
 * compacted rather than hidden so an administrator can still read a refused-reference list.
 */
export const auditDetailEntries = (detail: Record<string, unknown> | null | undefined): Array<[string, string]> => {
  if (!detail) {
    return [];
  }
  const entries: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(detail)) {
    if (value === null || value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      const items = value.map((item) => (typeof item === 'object' ? JSON.stringify(item) : String(item)));
      entries.push([key, items.join(', ')]);
    } else if (typeof value === 'object') {
      entries.push([key, JSON.stringify(value)]);
    } else {
      entries.push([key, String(value)]);
    }
  }
  return entries;
};

/* ------------------------------------------------------------------ */
/* Units                                                                */
/* ------------------------------------------------------------------ */

/** Decimal strings from bigint columns are read as numbers: ceilings never reach 2^53. */
const asNumber = (value: string | number | null | undefined): number | null => {
  if (value === null || value === undefined || String(value).trim() === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const roundTo = (value: number, decimals: number) => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

export const msToMinutes = (ms: string | number | null | undefined): number | null => {
  const value = asNumber(ms);
  return value === null ? null : roundTo(value / MS_PER_MINUTE, 1);
};

export const minutesToMs = (minutes: number): string => String(Math.round(minutes * MS_PER_MINUTE));

export const msToHours = (ms: string | number | null | undefined): number | null => {
  const value = asNumber(ms);
  return value === null ? null : roundTo(value / MS_PER_HOUR, 2);
};

export const hoursToMs = (hours: number): number => Math.round(hours * MS_PER_HOUR);

export const bytesToGiB = (bytes: string | number | null | undefined): number | null => {
  const value = asNumber(bytes);
  return value === null ? null : roundTo(value / BYTES_PER_GIB, 1);
};

export const gibToBytes = (gib: number): string => String(Math.round(gib * BYTES_PER_GIB));

/* ------------------------------------------------------------------ */
/* Limit forms                                                          */
/* ------------------------------------------------------------------ */

export type RenderLimitValues = Pick<
  RenderWorkerLimitDto,
  'maxConcurrentOperations' | 'maxWallClockMs' | 'maxOutputBytes'
>;

/** What the dialog binds to. Strings, because an emptied number input is "no ceiling". */
export type RenderLimitForm = {
  concurrency: string;
  wallClockMinutes: string;
  outputGiB: string;
};

export type RenderLimitField = keyof RenderLimitForm;

export const limitFormFrom = (limit: RenderLimitValues | null | undefined): RenderLimitForm => ({
  concurrency: limit ? String(limit.maxConcurrentOperations) : '',
  wallClockMinutes: limit ? String(msToMinutes(limit.maxWallClockMs) ?? '') : '',
  outputGiB: limit ? String(bytesToGiB(limit.maxOutputBytes) ?? '') : '',
});

export type ParsedLimitForm = { ok: true; value: RenderLimitValues } | { ok: false; field: RenderLimitField };

/** A blank wall-clock or output field means no ceiling; a blank concurrency is a mistake. */
const parseOptionalPositive = (raw: string): { ok: true; value: number | null } | { ok: false } => {
  if (raw.trim() === '') {
    return { ok: true, value: null };
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    return { ok: false };
  }
  return { ok: true, value };
};

/**
 * Validate a limit form against the server's bounds. `minConcurrency` is 1 for a worker (a
 * worker that may hold nothing is a revoked worker) and 0 for an account or the instance
 * default (zero is how an administrator pauses an account's rendering without revoking anything).
 */
export const parseLimitForm = (form: RenderLimitForm, options: { minConcurrency: 0 | 1 }): ParsedLimitForm => {
  const concurrency = Number(form.concurrency);
  if (
    form.concurrency.trim() === '' ||
    !Number.isSafeInteger(concurrency) ||
    concurrency < options.minConcurrency ||
    concurrency > RENDER_LIMIT_MAX_CONCURRENCY
  ) {
    return { ok: false, field: 'concurrency' };
  }

  const wallClock = parseOptionalPositive(form.wallClockMinutes);
  if (!wallClock.ok) {
    return { ok: false, field: 'wallClockMinutes' };
  }

  const output = parseOptionalPositive(form.outputGiB);
  if (!output.ok) {
    return { ok: false, field: 'outputGiB' };
  }

  return {
    ok: true,
    value: {
      maxConcurrentOperations: concurrency,
      maxWallClockMs: wallClock.value === null ? null : minutesToMs(wallClock.value),
      maxOutputBytes: output.value === null ? null : gibToBytes(output.value),
    },
  };
};

/* ------------------------------------------------------------------ */
/* Worker forms                                                         */
/* ------------------------------------------------------------------ */

export type RenderWorkerForm = RenderLimitForm & {
  name: string;
  destination: MediaOperationDestination;
  kinds: MediaOperationKind[];
  engineDigest: string;
  conformanceMaxAgeHours: string;
  gpuMemoryGiB: string;
};

export type RenderWorkerField = keyof RenderWorkerForm;

/** The server's defaults, mirrored so a fresh form shows what enrolment will use. */
export const DEFAULT_WORKER_FORM: Readonly<RenderWorkerForm> = {
  name: '',
  destination: MediaOperationDestination.Lan,
  kinds: [MediaOperationKind.StudioExport, MediaOperationKind.Restoration, MediaOperationKind.QuickEdit],
  engineDigest: '',
  conformanceMaxAgeHours: '24',
  gpuMemoryGiB: '',
  concurrency: '1',
  wallClockMinutes: '',
  outputGiB: '',
};

export const workerFormFrom = (worker: RenderWorkerDto | null | undefined): RenderWorkerForm => {
  if (!worker) {
    return { ...DEFAULT_WORKER_FORM, kinds: [...DEFAULT_WORKER_FORM.kinds] };
  }
  return {
    name: worker.name,
    destination: worker.destination,
    // A scope saved before RENDER_WORKER_KINDS existed keeps only its renders when edited (FL-73).
    kinds: worker.kinds.filter((kind) => isRenderWorkerKind(kind)),
    engineDigest: worker.engineDigest ?? '',
    conformanceMaxAgeHours: String(msToHours(worker.conformanceMaxAgeMs) ?? ''),
    gpuMemoryGiB: String(bytesToGiB(worker.gpuMemoryBytes) ?? ''),
    ...limitFormFrom(worker),
  };
};

export type RenderWorkerFormValues = {
  name: string;
  destination: MediaOperationDestination;
  kinds: MediaOperationKind[];
  engineDigest: string | null;
  conformanceMaxAgeMs: number;
  gpuMemoryBytes: string | null;
} & RenderLimitValues;

export type ParsedWorkerForm = { ok: true; value: RenderWorkerFormValues } | { ok: false; field: RenderWorkerField };

export const parseWorkerForm = (form: RenderWorkerForm): ParsedWorkerForm => {
  const name = form.name.trim();
  if (name.length === 0 || name.length > 120) {
    return { ok: false, field: 'name' };
  }
  if (!Object.values(MediaOperationDestination).includes(form.destination)) {
    return { ok: false, field: 'destination' };
  }
  const kinds = [...new Set(form.kinds)].filter((kind) => isRenderWorkerKind(kind));
  if (kinds.length === 0) {
    return { ok: false, field: 'kinds' };
  }
  const engineDigest = form.engineDigest.trim();
  if (engineDigest.length > 200) {
    return { ok: false, field: 'engineDigest' };
  }

  const hours = Number(form.conformanceMaxAgeHours);
  if (form.conformanceMaxAgeHours.trim() === '' || !Number.isFinite(hours)) {
    return { ok: false, field: 'conformanceMaxAgeHours' };
  }
  const conformanceMaxAgeMs = hoursToMs(hours);
  if (conformanceMaxAgeMs < RENDER_WORKER_MIN_CONFORMANCE_AGE_MS) {
    return { ok: false, field: 'conformanceMaxAgeHours' };
  }

  const gpu = parseOptionalPositive(form.gpuMemoryGiB);
  if (!gpu.ok) {
    return { ok: false, field: 'gpuMemoryGiB' };
  }

  const limits = parseLimitForm(form, { minConcurrency: 1 });
  if (!limits.ok) {
    return limits;
  }

  return {
    ok: true,
    value: {
      name,
      destination: form.destination,
      kinds,
      engineDigest: engineDigest.length === 0 ? null : engineDigest,
      conformanceMaxAgeMs,
      gpuMemoryBytes: gpu.value === null ? null : gibToBytes(gpu.value),
      ...limits.value,
    },
  };
};
