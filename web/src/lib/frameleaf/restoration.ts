/**
 * Presentation rules for preview-first restoration (FL-115).
 *
 * Ported from the restoration panel of `design/frameleaf/template/src/Studio.jsx` (`RestorePanel`,
 * `RestoreCompare`) with the prototype's simulation removed. The server owns every decision: which
 * destinations admit the workload, what the measured estimate is, what state a restoration is in.
 * This module only turns those facts into labels, choices and the actions each state allows, so
 * the panel cannot offer something the server would refuse — and never picks a destination on the
 * person's behalf.
 */
import {
  AssetRestorationFileKind,
  AssetRestorationMode,
  AssetRestorationStatus,
  MlDestinationKind,
  getBaseUrl,
  type AssetRestorationDestinationDto,
  type AssetRestorationOptionsDto,
  type AssetRestorationResponseDto,
} from '@immich/sdk';
import type { Translations } from 'svelte-i18n';
import { authManager } from '$lib/managers/auth-manager.svelte';

export const RESTORATION_UPSCALES = [1, 2, 4] as const;
export type RestorationUpscale = (typeof RESTORATION_UPSCALES)[number];

/** How often the panel re-reads the restorations while one is queued or running. */
export const RESTORATION_POLL_MS = 2500;

/** The smallest preview area the server accepts on either edge, as a fraction of the frame. */
const MIN_REGION_EDGE = 0.1;

export type RestorationRegion = { x: number; y: number; w: number; h: number; startSeconds?: number };

/** The centre half of the frame, matching the server's default. */
export const CENTRE_REGION: RestorationRegion = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };

export const RESTORATION_MODES: readonly AssetRestorationMode[] = [
  AssetRestorationMode.Faithful,
  AssetRestorationMode.Creative,
];

const BUSY: ReadonlySet<AssetRestorationStatus> = new Set([
  AssetRestorationStatus.PreviewQueued,
  AssetRestorationStatus.PreviewRendering,
  AssetRestorationStatus.Accepted,
  AssetRestorationStatus.Restoring,
]);

const RETRYABLE: ReadonlySet<AssetRestorationStatus> = new Set([
  AssetRestorationStatus.PreviewFailed,
  AssetRestorationStatus.PreviewCancelled,
  AssetRestorationStatus.RestoreFailed,
  AssetRestorationStatus.RestoreCancelled,
]);

export const isRestorationBusy = (status: AssetRestorationStatus) => BUSY.has(status);

export const anyRestorationBusy = (items: readonly Pick<AssetRestorationResponseDto, 'status'>[]) =>
  items.some((item) => isRestorationBusy(item.status));

/** Accept and reject exist only for a preview waiting on the person's decision. */
export const canDecideRestoration = (status: AssetRestorationStatus) => status === AssetRestorationStatus.PreviewReady;

/** A finished result may be chosen for playback. Nothing chooses it automatically. */
export const canSelectRestoration = (item: Pick<AssetRestorationResponseDto, 'status' | 'hasResult'>) =>
  item.status === AssetRestorationStatus.Restored && item.hasResult;

export const canDiscardRestoration = (status: AssetRestorationStatus) =>
  status !== AssetRestorationStatus.Discarded && status !== AssetRestorationStatus.Expired;

/**
 * The job to retry, when the last stage failed or was cancelled. Retry goes through the media
 * operations API (FL-104), which copies the immutable snapshot into a new job; the server binds the
 * restoration to it when the worker picks it up.
 */
export const retryOperationIdFor = (
  item: Pick<AssetRestorationResponseDto, 'status' | 'previewOperationId' | 'fullOperationId'>,
): string | null => {
  if (!RETRYABLE.has(item.status)) {
    return null;
  }
  return item.status === AssetRestorationStatus.RestoreFailed || item.status === AssetRestorationStatus.RestoreCancelled
    ? item.fullOperationId
    : item.previewOperationId;
};

/**
 * When the finished chunks of a stopped full render go (FL-115 result retention). Only a failed or
 * cancelled full render carries this date; a finished result never expires on its own.
 */
export const abandonedResultKeptUntil = (
  item: Pick<AssetRestorationResponseDto, 'status' | 'resultExpiresAt'>,
): string | null =>
  item.status === AssetRestorationStatus.RestoreFailed || item.status === AssetRestorationStatus.RestoreCancelled
    ? item.resultExpiresAt
    : null;

/** Which comparison a restoration can show: the preview crop, or the finished result against the original. */
export const compareKindFor = (
  item: Pick<AssetRestorationResponseDto, 'status' | 'hasPreview' | 'hasResult'>,
): 'preview' | 'result' | null => {
  if (item.status === AssetRestorationStatus.Restored && item.hasResult) {
    return 'result';
  }
  if (
    item.hasPreview &&
    item.status !== AssetRestorationStatus.Discarded &&
    item.status !== AssetRestorationStatus.Expired
  ) {
    return 'preview';
  }
  return null;
};

export type RestorationTone = 'neutral' | 'busy' | 'ready' | 'done' | 'failed';

export const restorationStatusTone = (status: AssetRestorationStatus): RestorationTone => {
  switch (status) {
    case AssetRestorationStatus.PreviewQueued:
    case AssetRestorationStatus.PreviewRendering:
    case AssetRestorationStatus.Accepted:
    case AssetRestorationStatus.Restoring: {
      return 'busy';
    }
    case AssetRestorationStatus.PreviewReady: {
      return 'ready';
    }
    case AssetRestorationStatus.Restored: {
      return 'done';
    }
    case AssetRestorationStatus.PreviewFailed:
    case AssetRestorationStatus.RestoreFailed: {
      return 'failed';
    }
    default: {
      return 'neutral';
    }
  }
};

export const restorationStatusKey = (status: AssetRestorationStatus): Translations =>
  `frameleaf_restoration_status_${status}`;
export const restorationModeKey = (mode: AssetRestorationMode): Translations => `frameleaf_restoration_mode_${mode}`;
export const restorationModeHelpKey = (mode: AssetRestorationMode): Translations =>
  `frameleaf_restoration_mode_${mode}_help`;

export const destinationKindKey = (kind: MlDestinationKind) => {
  switch (kind) {
    case MlDestinationKind.Local: {
      return 'frameleaf_activity_destination_local';
    }
    case MlDestinationKind.Lan: {
      return 'frameleaf_activity_destination_lan';
    }
    case MlDestinationKind.FrameleafCloud: {
      return 'frameleaf_activity_destination_frameleaf_cloud';
    }
  }
};

const KIND_ORDER: Record<MlDestinationKind, number> = {
  [MlDestinationKind.Local]: 0,
  [MlDestinationKind.Lan]: 1,
  [MlDestinationKind.FrameleafCloud]: 2,
};

/**
 * Destinations in the order the picker shows them: admissible ones first, then local before LAN
 * before cloud, then by name. Nothing is dropped — a refused destination is shown with its reason
 * rather than hidden, and a cloud destination is never moved up.
 */
export const orderedDestinations = (destinations: readonly AssetRestorationDestinationDto[]) =>
  [...destinations].sort((a, b) => {
    if (a.available !== b.available) {
      return a.available ? -1 : 1;
    }
    if (KIND_ORDER[a.kind] !== KIND_ORDER[b.kind]) {
      return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    }
    return a.name.localeCompare(b.name);
  });

/**
 * The destination the picker should start on: the previously chosen one if it is still admissible,
 * otherwise the first admissible one that keeps media on the network, otherwise nothing. A cloud
 * destination is never the default; it has to be chosen.
 */
export const defaultDestinationId = (
  destinations: readonly AssetRestorationDestinationDto[],
  previous: string | null,
) => {
  const ordered = orderedDestinations(destinations);
  const kept = previous && ordered.find((item) => item.id === previous && item.available);
  if (kept) {
    return kept.id;
  }
  return ordered.find((item) => item.available && !item.leavesNetwork)?.id ?? null;
};

/** Whether the picked upscale was reduced by the 4K cap. */
export const isOutputCapped = (
  options: Pick<
    AssetRestorationOptionsDto,
    'sourceWidth' | 'sourceHeight' | 'outputWidth' | 'outputHeight' | 'upscale'
  >,
) =>
  options.outputWidth < options.sourceWidth * options.upscale - 1 ||
  options.outputHeight < options.sourceHeight * options.upscale - 1;

/**
 * A crop from the quick editor as a preview area. Widened to the server's minimum when the crop is
 * narrower than a tenth of the frame, and kept inside it.
 */
export const regionFromCrop = (crop: { x: number; y: number; w: number; h: number }): RestorationRegion => {
  const w = Math.min(1, Math.max(MIN_REGION_EDGE, crop.w));
  const h = Math.min(1, Math.max(MIN_REGION_EDGE, crop.h));
  const x = Math.min(Math.max(0, crop.x), 1 - w);
  const y = Math.min(Math.max(0, crop.y), 1 - h);
  return { x: round(x), y: round(y), w: round(w), h: round(h) };
};

const round = (value: number) => Math.round(value * 10_000) / 10_000;

export const isFullCropRect = (crop: { x: number; y: number; w: number; h: number }) =>
  crop.x <= 0 && crop.y <= 0 && crop.w >= 0.999 && crop.h >= 0.999;

/** "about 2 min" from measured seconds; null when nothing is measured, so the caller says so. */
export const formatEstimateSeconds = (seconds: number | null, locale?: string | null): string | null => {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) {
    return null;
  }
  const format = (value: number, unit: 'second' | 'minute' | 'hour') =>
    new Intl.NumberFormat(locale ?? undefined, {
      style: 'unit',
      unit,
      unitDisplay: 'long',
      maximumFractionDigits: 0,
    }).format(value);
  if (seconds < 60) {
    return format(Math.max(1, Math.round(seconds)), 'second');
  }
  if (seconds < 3600) {
    return format(Math.round(seconds / 60), 'minute');
  }
  return format(Math.round((seconds / 3600) * 10) / 10, 'hour');
};

/** Where the panel fetches a restoration file from; the same auth parameters as every other media URL. */
export const restorationFileUrl = (
  assetId: string,
  restorationId: string,
  kind: AssetRestorationFileKind,
  cacheKey?: string | null,
) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries({ ...authManager.params, kind, c: cacheKey ?? undefined })) {
    if (value !== undefined && value !== null) {
      search.set(key, value);
    }
  }
  return `${getBaseUrl()}/assets/${encodeURIComponent(assetId)}/restorations/${encodeURIComponent(restorationId)}/file?${search.toString()}`;
};
