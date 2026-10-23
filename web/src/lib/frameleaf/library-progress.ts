/**
 * FL-521: the reading progress of each feature in plain words (Library care › Search and recognition
 * progress), the time doing it all again takes, "waiting for a computer", and "Save and start tonight /
 * now" for the settings whose change only applies from now on.
 */
import {
  LibraryProgressFeature,
  LibraryRedoWhen,
  MlDestinationKind,
  MlWorkload,
  redoLibraryWork,
  type LibraryFeatureProgressDto,
  type LibraryRedoQueue,
  type MlCapabilitiesResponseDto,
} from '@frameleaf/sdk';
import type { SystemConfigDraftStore } from '$lib/frameleaf/system-config-draft.svelte';

/** "about 40 minutes", "about 3 hours", "about 2 days": a translation key and its values. */
export const aboutTime = (seconds: number) => {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 90) {
    return { key: 'frameleaf_progress_about_minutes' as const, values: { count: minutes } };
  }
  const hours = Math.round(minutes / 60);
  return hours < 36
    ? { key: 'frameleaf_progress_about_hours' as const, values: { count: hours } }
    : { key: 'frameleaf_progress_about_days' as const, values: { count: Math.round(hours / 24) } };
};

/** How long reading every photo again takes at the recent rate, or undefined when it is not known. */
export const rereadSeconds = (progress?: LibraryFeatureProgressDto) =>
  progress && progress.perHour && progress.perHour > 0
    ? Math.round((progress.total / progress.perHour) * 3600)
    : undefined;

/** Which part of the machine-learning service each feature needs. */
export const FEATURE_WORKLOAD: Record<LibraryProgressFeature, MlWorkload> = {
  [LibraryProgressFeature.Search]: MlWorkload.Clip,
  [LibraryProgressFeature.Faces]: MlWorkload.Face,
  [LibraryProgressFeature.Text]: MlWorkload.Ocr,
  [LibraryProgressFeature.Captions]: MlWorkload.Enrichment,
  [LibraryProgressFeature.Locked]: MlWorkload.Enrichment,
};

/**
 * "Waiting for a computer": the work is sent to another computer (a helper on this network, or
 * Frameleaf Cloud) that cannot take it now, and nothing else can. Says which and since when it was
 * last seen; undefined when the work can run.
 */
export const waitingFor = (capabilities: MlCapabilitiesResponseDto | undefined, workload: MlWorkload) => {
  const capability = capabilities?.workloads.find((item) => item.workload === workload);
  if (!capability || capability.available) {
    return;
  }
  const routed = capability.destinations.find((destination) => destination.id === capability.routedDestinationId);
  if (!routed || routed.kind === MlDestinationKind.Local) {
    return;
  }
  return { name: routed.name, since: routed.checkedAt, cloud: routed.kind === MlDestinationKind.FrameleafCloud };
};

/**
 * Saves the page's settings, then starts the work again over every photo now or tonight. False when the
 * save did not go through (nothing is started then).
 */
export const saveAndRedo = async (
  draft: Pick<SystemConfigDraftStore, 'saveKeys'>,
  keys: Parameters<SystemConfigDraftStore['saveKeys']>[0],
  queue: LibraryRedoQueue,
  when: LibraryRedoWhen,
) => {
  if (!(await draft.saveKeys(keys))) {
    return false;
  }
  await redoLibraryWork({ libraryRedoDto: { queue, when } });
  return true;
};
