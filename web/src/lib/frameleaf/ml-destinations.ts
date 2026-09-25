/**
 * Presentation rules for the Processing destinations admin surface (FL-110).
 *
 * The server owns every decision: which destination a workload may run on, whether consent
 * exists, whether the last probe was healthy. This module only turns those facts into labels
 * and into the eligibility the route pickers show, so the admin page cannot offer a choice
 * the server would refuse. Nothing here ever picks a destination on the person's behalf.
 */
import {
  MlAdmissionRefusal,
  MlDestinationHealth,
  MlDestinationKind,
  MlWorkerRole,
  MlWorkload,
  type MlDestinationResponseDto,
} from '@immich/sdk';
import type { Translations } from 'svelte-i18n';

/** The order workloads are listed in: library work first, then restoration, then Studio. */
export const ML_WORKLOAD_ORDER: readonly MlWorkload[] = [
  MlWorkload.Face,
  MlWorkload.Clip,
  MlWorkload.Ocr,
  MlWorkload.Enrichment,
  MlWorkload.PetRecognition,
  MlWorkload.RestorationFaithful,
  MlWorkload.RestorationCreative,
  MlWorkload.StudioAi,
];

export const mlWorkloadLabelKey = (workload: MlWorkload): Translations => {
  switch (workload) {
    case MlWorkload.Face: {
      return 'admin.frameleaf_ml_workload_face';
    }
    case MlWorkload.Clip: {
      return 'admin.frameleaf_ml_workload_clip';
    }
    case MlWorkload.Ocr: {
      return 'admin.frameleaf_ml_workload_ocr';
    }
    case MlWorkload.Enrichment: {
      return 'admin.frameleaf_ml_workload_enrichment';
    }
    case MlWorkload.RestorationFaithful: {
      return 'admin.frameleaf_ml_workload_restoration_faithful';
    }
    case MlWorkload.RestorationCreative: {
      return 'admin.frameleaf_ml_workload_restoration_creative';
    }
    case MlWorkload.StudioAi: {
      return 'admin.frameleaf_ml_workload_studio_ai';
    }
    case MlWorkload.PetRecognition: {
      return 'admin.frameleaf_ml_workload_pet_recognition';
    }
  }
};

export const mlDestinationKindLabelKey = (kind: MlDestinationKind): Translations => {
  switch (kind) {
    case MlDestinationKind.Local: {
      return 'admin.frameleaf_ml_destination_kind_local';
    }
    case MlDestinationKind.Lan: {
      return 'admin.frameleaf_ml_destination_kind_lan';
    }
    case MlDestinationKind.Runpod: {
      return 'admin.frameleaf_ml_destination_kind_runpod';
    }
    case MlDestinationKind.RunpodVideo: {
      return 'admin.frameleaf_ml_destination_kind_runpod_video';
    }
  }
};

export const mlHealthLabelKey = (health: MlDestinationHealth): Translations => {
  switch (health) {
    case MlDestinationHealth.Healthy: {
      return 'admin.frameleaf_ml_health_healthy';
    }
    case MlDestinationHealth.Unhealthy: {
      return 'admin.frameleaf_ml_health_unhealthy';
    }
    case MlDestinationHealth.Unknown: {
      return 'admin.frameleaf_ml_health_unknown';
    }
  }
};

/** Badge tone for a health state. Teal and blue carry status; warning and danger carry problems. */
export const mlHealthTone = (health: MlDestinationHealth): 'teal' | 'danger' | 'neutral' => {
  switch (health) {
    case MlDestinationHealth.Healthy: {
      return 'teal';
    }
    case MlDestinationHealth.Unhealthy: {
      return 'danger';
    }
    case MlDestinationHealth.Unknown: {
      return 'neutral';
    }
  }
};

export const mlRefusalLabelKey = (refusal: MlAdmissionRefusal): Translations => {
  switch (refusal) {
    case MlAdmissionRefusal.DestinationMissing: {
      return 'admin.frameleaf_ml_refusal_destination_missing';
    }
    case MlAdmissionRefusal.DestinationDisabled: {
      return 'admin.frameleaf_ml_refusal_destination_disabled';
    }
    case MlAdmissionRefusal.WorkloadNotRouted: {
      return 'admin.frameleaf_ml_refusal_workload_not_routed';
    }
    case MlAdmissionRefusal.WorkloadNotAllowed: {
      return 'admin.frameleaf_ml_refusal_workload_not_allowed';
    }
    case MlAdmissionRefusal.WorkloadNotServed: {
      return 'admin.frameleaf_ml_refusal_workload_not_served';
    }
    case MlAdmissionRefusal.ConsentMissing: {
      return 'admin.frameleaf_ml_refusal_consent_missing';
    }
    case MlAdmissionRefusal.BudgetExceeded: {
      return 'admin.frameleaf_ml_refusal_budget_exceeded';
    }
    case MlAdmissionRefusal.EndpointUnresolved: {
      return 'admin.frameleaf_ml_refusal_endpoint_unresolved';
    }
    case MlAdmissionRefusal.DestinationUnhealthy: {
      return 'admin.frameleaf_ml_refusal_destination_unhealthy';
    }
    case MlAdmissionRefusal.RoleConflict: {
      return 'admin.frameleaf_ml_refusal_role_conflict';
    }
    case MlAdmissionRefusal.InsufficientMemory: {
      return 'admin.frameleaf_ml_refusal_insufficient_memory';
    }
  }
};

/* -------------------------------------------------------------------------- */
/* Separate library-analysis and restoration workers (FL-72)                   */
/* -------------------------------------------------------------------------- */

export const LIBRARY_WORKLOADS: readonly MlWorkload[] = [
  MlWorkload.Face,
  MlWorkload.Clip,
  MlWorkload.Ocr,
  MlWorkload.Enrichment,
  MlWorkload.PetRecognition,
];
export const RESTORATION_WORKLOADS: readonly MlWorkload[] = [
  MlWorkload.RestorationFaithful,
  MlWorkload.RestorationCreative,
];

export const isLibraryWorkload = (workload: MlWorkload) => LIBRARY_WORKLOADS.includes(workload);
export const isRestorationWorkload = (workload: MlWorkload) => RESTORATION_WORKLOADS.includes(workload);

/**
 * The workloads a destination of this kind may be allowed at all. The managed RunPod pod runs
 * the ordinary image and never restoration; a RunPod video worker runs restoration only.
 */
export const workloadsForKind = (kind: MlDestinationKind): MlWorkload[] => {
  switch (kind) {
    case MlDestinationKind.Runpod: {
      return ML_WORKLOAD_ORDER.filter((workload) => !isRestorationWorkload(workload));
    }
    case MlDestinationKind.RunpodVideo: {
      return [...RESTORATION_WORKLOADS];
    }
    default: {
      return [...ML_WORKLOAD_ORDER];
    }
  }
};

/**
 * Whether a workload checkbox is unavailable in the destination form: library analysis and
 * restoration never share a worker, so choosing one kind of work closes the other. Mirrors the
 * server's refusal so the form never offers a combination it would reject.
 */
export const workloadBlockedInDraft = (
  kind: MlDestinationKind,
  selected: readonly MlWorkload[],
  workload: MlWorkload,
) => {
  if (!workloadsForKind(kind).includes(workload)) {
    return true;
  }
  if (selected.includes(workload)) {
    return false;
  }
  if (isRestorationWorkload(workload)) {
    return selected.some((entry) => isLibraryWorkload(entry));
  }
  if (isLibraryWorkload(workload)) {
    return selected.some((entry) => isRestorationWorkload(entry));
  }
  return false;
};

/** A cloud destination whose consent has not been recorded cannot be routed to or admitted. */
export const isConsentBlocking = (destination: Pick<MlDestinationResponseDto, 'consent'>): boolean =>
  destination.consent.required && destination.consent.acknowledgedAt === null;

/**
 * Whether the admin may route `workload` to `destination`: it must be enabled, allow the
 * workload and, for cloud kinds, have consent recorded. Mirrors the server's `setRoute`
 * checks so the picker never offers a destination the server would refuse.
 */
export const canRouteTo = (
  destination: Pick<MlDestinationResponseDto, 'enabled' | 'workloads' | 'consent'> &
    Partial<Pick<MlDestinationResponseDto, 'kind' | 'role'>>,
  workload: MlWorkload,
): boolean =>
  destination.enabled &&
  destination.workloads.includes(workload) &&
  !isConsentBlocking(destination) &&
  // FL-72: restoration is never routed to the library-analysis pod or to a worker that also runs
  // library analysis. (The server additionally refuses an endpoint a library route uses.)
  !(
    isRestorationWorkload(workload) &&
    (destination.kind === MlDestinationKind.Runpod || destination.role === MlWorkerRole.Mixed)
  );

/** Destinations that may currently be routed to for `workload`, in the order the server listed them. */
export const routableDestinations = (
  destinations: readonly MlDestinationResponseDto[],
  workload: MlWorkload,
): MlDestinationResponseDto[] => destinations.filter((destination) => canRouteTo(destination, workload));

/** Whether the destination's stored budget is used up; the server refuses at or past the limit. */
export const isOverBudget = (destination: Pick<MlDestinationResponseDto, 'costControls'>): boolean =>
  destination.costControls.budgetLimitUsd !== null &&
  destination.costControls.spentUsd >= destination.costControls.budgetLimitUsd;

/**
 * A measured throughput for display, or null when there is nothing measured. The prototype's
 * constants are not a fallback: with no samples the estimate is simply not shown.
 */
export const formatThroughput = (bytesPerSecond: number | null, locale: string): string | null => {
  if (bytesPerSecond === null || !Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) {
    return null;
  }
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  let value = bytesPerSecond;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: value >= 100 ? 0 : 1 }).format(value)} ${units[unit]}`;
};

/** Parse an optional numeric form field: empty means "no limit" (null), anything invalid is rejected. */
export const parseOptionalNumber = (raw: string): number | null | undefined => {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return null;
  }
  const value = Number(trimmed);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
};
