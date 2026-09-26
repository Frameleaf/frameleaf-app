/**
 * Sample-first enrichment and the timestamped moment workbench (FL-59, `REC-101`).
 *
 * The rules the workbench shows, kept free of Svelte so they can be read and tested on their own.
 * They mirror the server's (`server/src/utils/enrichment-plan.ts`): the server decides, and these
 * only make sure the page never offers a choice the server would refuse or silently change.
 */
import {
  EnrichmentItemState,
  EnrichmentStage,
  EnrichmentStaleReason,
  MediaOperationStatus,
  type EnrichmentDestinationOptionDto,
} from '@immich/sdk';
import type { Translations } from 'svelte-i18n';

/** The order stages run in, per asset. */
export const ENRICHMENT_STAGE_ORDER: readonly EnrichmentStage[] = [
  EnrichmentStage.Frames,
  EnrichmentStage.LockedCheck,
  EnrichmentStage.Description,
  EnrichmentStage.MomentIndex,
  EnrichmentStage.MomentCaptions,
];

/** What each stage needs to have run first. */
export const ENRICHMENT_STAGE_REQUIRES: Readonly<Record<EnrichmentStage, readonly EnrichmentStage[]>> = {
  [EnrichmentStage.Frames]: [],
  [EnrichmentStage.LockedCheck]: [],
  [EnrichmentStage.Description]: [],
  [EnrichmentStage.MomentIndex]: [EnrichmentStage.Frames],
  [EnrichmentStage.MomentCaptions]: [EnrichmentStage.Frames],
};

export const VIDEO_ONLY_STAGES: ReadonlySet<EnrichmentStage> = new Set([
  EnrichmentStage.Frames,
  EnrichmentStage.MomentIndex,
  EnrichmentStage.MomentCaptions,
]);

export const stageLabelKey: Readonly<Record<EnrichmentStage, Translations>> = {
  [EnrichmentStage.Frames]: 'frameleaf_enrichment_stage_frames',
  [EnrichmentStage.LockedCheck]: 'frameleaf_enrichment_stage_locked_check',
  [EnrichmentStage.Description]: 'frameleaf_enrichment_stage_description',
  [EnrichmentStage.MomentIndex]: 'frameleaf_enrichment_stage_moment_index',
  [EnrichmentStage.MomentCaptions]: 'frameleaf_enrichment_stage_moment_captions',
};

export const stageHelpKey: Readonly<Record<EnrichmentStage, Translations>> = {
  [EnrichmentStage.Frames]: 'frameleaf_enrichment_stage_frames_help',
  [EnrichmentStage.LockedCheck]: 'frameleaf_enrichment_stage_locked_check_help',
  [EnrichmentStage.Description]: 'frameleaf_enrichment_stage_description_help',
  [EnrichmentStage.MomentIndex]: 'frameleaf_enrichment_stage_moment_index_help',
  [EnrichmentStage.MomentCaptions]: 'frameleaf_enrichment_stage_moment_captions_help',
};

export const itemStateKey: Readonly<Record<EnrichmentItemState, Translations>> = {
  [EnrichmentItemState.Queued]: 'frameleaf_enrichment_state_queued',
  [EnrichmentItemState.Running]: 'frameleaf_enrichment_state_running',
  [EnrichmentItemState.Skipped]: 'frameleaf_enrichment_state_skipped',
  [EnrichmentItemState.Failed]: 'frameleaf_enrichment_state_failed',
  [EnrichmentItemState.Completed]: 'frameleaf_enrichment_state_completed',
  [EnrichmentItemState.Cancelled]: 'frameleaf_enrichment_state_cancelled',
};

export type EnrichmentTone = 'neutral' | 'blue' | 'teal' | 'warning' | 'danger';

/** Teal and blue carry status; the accent green is kept for primary actions and selection. */
export const itemStateTone: Readonly<Record<EnrichmentItemState, EnrichmentTone>> = {
  [EnrichmentItemState.Queued]: 'neutral',
  [EnrichmentItemState.Running]: 'blue',
  [EnrichmentItemState.Skipped]: 'neutral',
  [EnrichmentItemState.Failed]: 'danger',
  [EnrichmentItemState.Completed]: 'teal',
  [EnrichmentItemState.Cancelled]: 'warning',
};

const REASON_KEYS: Readonly<Record<string, Translations>> = {
  'not-a-video': 'frameleaf_enrichment_reason_not_a_video',
  'not-an-image': 'frameleaf_enrichment_reason_not_an_image',
  'not-eligible': 'frameleaf_enrichment_reason_not_eligible',
  'not-found': 'frameleaf_enrichment_reason_not_found',
  'no-access': 'frameleaf_enrichment_reason_no_access',
  'no-preview': 'frameleaf_enrichment_reason_no_preview',
  'no-frames': 'frameleaf_enrichment_reason_no_frames',
  'too-short': 'frameleaf_enrichment_reason_too_short',
  'too-long': 'frameleaf_enrichment_reason_too_long',
  disabled: 'frameleaf_enrichment_reason_disabled',
  current: 'frameleaf_enrichment_reason_current',
  'dependency-failed': 'frameleaf_enrichment_reason_dependency_failed',
  'source-changed': 'frameleaf_enrichment_reason_source_changed',
  'model-error': 'frameleaf_enrichment_reason_model_error',
  'stage-error': 'frameleaf_enrichment_reason_model_error',
  'video-frames-unavailable': 'frameleaf_enrichment_reason_no_frames',
  // FL-163: the description stage routed to Frameleaf Cloud runs in batches
  'cloud-batch': 'frameleaf_enrichment_reason_cloud_batch',
  'cloud-photos-only': 'frameleaf_enrichment_reason_cloud_photos_only',
  'cloud-turned-off': 'frameleaf_enrichment_reason_cloud_turned_off',
};

/** The message for a stage's reason code; unknown codes get the generic one, never the raw code. */
export const reasonKey = (code: string | null | undefined): Translations | null =>
  code ? (REASON_KEYS[code] ?? 'frameleaf_enrichment_reason_other') : null;

export const staleReasonKey: Readonly<Record<EnrichmentStaleReason, Translations>> = {
  [EnrichmentStaleReason.SourceChanged]: 'frameleaf_enrichment_stale_source_changed',
  [EnrichmentStaleReason.IdentityChanged]: 'frameleaf_enrichment_stale_identity_changed',
  [EnrichmentStaleReason.ConfigChanged]: 'frameleaf_enrichment_stale_config_changed',
};

/** The chosen stages in running order, with everything a chosen stage needs. */
export const withRequiredStages = (chosen: Iterable<EnrichmentStage>): EnrichmentStage[] => {
  const all = new Set<EnrichmentStage>();
  const pending = [...chosen];
  while (pending.length > 0) {
    const stage = pending.pop()!;
    if (!all.has(stage)) {
      all.add(stage);
      pending.push(...ENRICHMENT_STAGE_REQUIRES[stage]);
    }
  }
  return ENRICHMENT_STAGE_ORDER.filter((stage) => all.has(stage));
};

/**
 * Tick or untick a stage. Ticking pulls in what it needs; unticking removes the stages that need
 * it, so the page never shows a plan the server would run differently.
 */
export const toggleStage = (
  selected: readonly EnrichmentStage[],
  stage: EnrichmentStage,
  on: boolean,
): EnrichmentStage[] => {
  if (on) {
    return withRequiredStages([...selected, stage]);
  }
  const remaining = selected.filter((item) => item !== stage && !ENRICHMENT_STAGE_REQUIRES[item].includes(stage));
  return withRequiredStages(remaining);
};

/** The ticked stages that need this one, for the "needed by" hint. */
export const neededBy = (selected: readonly EnrichmentStage[], stage: EnrichmentStage): EnrichmentStage[] =>
  selected.filter((item) => ENRICHMENT_STAGE_REQUIRES[item].includes(stage));

/**
 * A new plan's stages: the server's defaults, less any whose feature is switched off. Moment
 * captions are never among them.
 */
export const initialStages = (
  defaults: readonly EnrichmentStage[],
  enabled: { description: boolean; lockedCheck: boolean; search: boolean },
): EnrichmentStage[] =>
  withRequiredStages(
    defaults.filter((stage) => {
      if (stage === EnrichmentStage.MomentCaptions) {
        return false;
      }
      if (stage === EnrichmentStage.Description) {
        return enabled.description;
      }
      if (stage === EnrichmentStage.LockedCheck) {
        return enabled.lockedCheck;
      }
      if (stage === EnrichmentStage.MomentIndex) {
        return enabled.search;
      }
      return true;
    }),
  );

/** Extra model requests moment captions add: one per reusable frame of every video. */
export const captionRequestCount = (videoCount: number, framesPerVideo: number): number =>
  Math.max(0, videoCount) * Math.max(0, framesPerVideo);

/** A destination the page may offer for a workload: allowed there, even if unhealthy right now. */
export const destinationChoices = (
  destinations: readonly EnrichmentDestinationOptionDto[],
  workload: 'enrichment' | 'search',
): EnrichmentDestinationOptionDto[] =>
  destinations.filter((destination) => {
    const admission = destination[workload];
    return (
      admission.admitted ||
      admission.refusal === 'destination-unhealthy' ||
      admission.refusal === 'endpoint-unresolved' ||
      admission.refusal === 'workload-not-served'
    );
  });

/** A plan's overall state in the workbench. Working statuses all read as running. */
export const planStatusKey: Readonly<Record<MediaOperationStatus, Translations>> = {
  [MediaOperationStatus.Queued]: 'frameleaf_enrichment_plan_queued',
  [MediaOperationStatus.Preparing]: 'frameleaf_enrichment_plan_running',
  [MediaOperationStatus.Rendering]: 'frameleaf_enrichment_plan_running',
  [MediaOperationStatus.Validating]: 'frameleaf_enrichment_plan_running',
  [MediaOperationStatus.Cancelling]: 'frameleaf_enrichment_plan_cancelling',
  [MediaOperationStatus.Paused]: 'frameleaf_enrichment_plan_paused',
  [MediaOperationStatus.Completed]: 'frameleaf_enrichment_plan_completed',
  [MediaOperationStatus.Cancelled]: 'frameleaf_enrichment_plan_cancelled',
  [MediaOperationStatus.Failed]: 'frameleaf_enrichment_plan_failed',
};

const ACTIVE_STATUSES: ReadonlySet<MediaOperationStatus> = new Set([
  MediaOperationStatus.Queued,
  MediaOperationStatus.Preparing,
  MediaOperationStatus.Rendering,
  MediaOperationStatus.Validating,
  MediaOperationStatus.Cancelling,
  MediaOperationStatus.Paused,
]);

export const isPlanActive = (status: MediaOperationStatus) => ACTIVE_STATUSES.has(status);

/** How long to wait before reading a plan again: often while it runs, never once it has finished. */
export const planPollDelay = (status: MediaOperationStatus): number | null => {
  if (!isPlanActive(status)) {
    return null;
  }
  return status === MediaOperationStatus.Paused || status === MediaOperationStatus.Queued ? 5000 : 2000;
};

/** A time in a video as m:ss, or h:mm:ss past an hour. */
export const formatMomentTime = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
};

/** Parse "m:ss", "h:mm:ss" or plain seconds into milliseconds; null when it is not a time. */
export const parseMomentTime = (value: string): number | null => {
  const text = value.trim();
  if (!text) {
    return null;
  }
  const parts = text.split(':');
  if (parts.length > 3 || parts.some((part) => !/^\d+(\.\d+)?$/.test(part))) {
    return null;
  }
  const seconds = parts.reduce((sum, part) => sum * 60 + Number(part), 0);
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : null;
};

/** Where a reusable frame's image is served; the caller adds the session parameters. */
export const frameImagePath = (frameId: string) => `/enrichment/frames/${encodeURIComponent(frameId)}`;

/**
 * A version 4 UUID for a plan's idempotency key. `crypto.randomUUID` only exists on secure
 * origins, and many home servers are reached over plain http, so the key falls back to
 * `getRandomValues`, which works everywhere.
 */
export const newRequestKey = (): string => {
  const native = globalThis.crypto?.randomUUID?.();
  if (native) {
    return native;
  }
  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index++) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/**
 * The last plan this browser opened for this account, so reopening the workbench returns to it. A
 * convenience only, keyed by user so an account never reopens another account's plan here.
 */
export const lastPlanKey = (userId: string) => `frameleaf.enrichment.lastPlan.${userId}`;

export const rememberPlan = (userId: string, id: string | null) => {
  try {
    if (id) {
      localStorage.setItem(lastPlanKey(userId), id);
    } else {
      localStorage.removeItem(lastPlanKey(userId));
    }
  } catch {
    // Storage may be unavailable; the plan itself is durable on the server.
  }
};

export const lastPlan = (userId: string): string | null => {
  try {
    return localStorage.getItem(lastPlanKey(userId));
  } catch {
    return null;
  }
};
