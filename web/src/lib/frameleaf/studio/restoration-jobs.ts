/**
 * Host handlers for Studio's restoration and Smooth motion commands (FL-115, FL-162; prototype
 * `Studio.jsx` Restore tab and `FrameMethod`).
 *
 * `job.enqueueRestoration` and `job.enqueueInterpolation` never change the open project's graph.
 * Each becomes the same preview-first restoration the editor's Enhance panel makes, on the
 * destination the command names: a preview first, then the full render of the reviewed preview,
 * saved as a new version of the photo or video. The original is never touched, and nothing reaches
 * the project until the person chooses Use in Studio for a finished version.
 *
 * Frameleaf Cloud is never reached from a command. A command naming the Frameleaf Cloud destination
 * opens the Studio Restore panel instead, where the job is estimated and confirmed on its own
 * (CloudJobDialog, with the model slider); the command itself is refused with that reason.
 */
import {
  AssetRestorationMode,
  AssetTypeEnum,
  MlDestinationKind,
  acceptAssetRestoration,
  getAssetInfo,
  getAssetRestorations,
  getAssetRestorationOptions,
  requestAssetRestoration,
  type AssetResponseDto,
  type AssetRestorationListResponseDto,
  type AssetRestorationOptionsDto,
  type AssetRestorationRequestDto,
  type AssetRestorationResponseDto,
} from '@frameleaf/sdk';
import type { Translations } from 'svelte-i18n';
import { restorationIdOfMedia } from './assets';
import type { StudioCommandEnvelope, StudioCommandPayloads } from './commands';

export interface StudioRestorationApi {
  getAsset(id: string): Promise<AssetResponseDto>;
  getRestorations(id: string): Promise<AssetRestorationListResponseDto>;
  getOptions(id: string, mode: AssetRestorationMode): Promise<AssetRestorationOptionsDto>;
  request(id: string, dto: AssetRestorationRequestDto): Promise<AssetRestorationResponseDto>;
  accept(id: string, restorationId: string): Promise<AssetRestorationResponseDto>;
}

export const sdkStudioRestorationApi: StudioRestorationApi = {
  getAsset: (id) => getAssetInfo({ id }),
  getRestorations: (id) => getAssetRestorations({ id }),
  getOptions: (id, mode) => getAssetRestorationOptions({ id, mode }),
  request: (id, assetRestorationRequestDto) => requestAssetRestoration({ id, assetRestorationRequestDto }),
  accept: (id, restorationId) => acceptAssetRestoration({ id, restorationId }),
};

/** A refusal the person can read. The handler throws it; the host has already shown `messageKey`. */
export class StudioRestorationCommandError extends Error {
  constructor(readonly messageKey: Translations) {
    super(messageKey);
  }
}

export const SMOOTH_MOTION_FACTORS = [2, 4, 8] as const;
export type SmoothMotionFactor = (typeof SMOOTH_MOTION_FACTORS)[number];

/**
 * Frames per source frame for a target frame rate: the smallest factor that reaches it. With no
 * known source rate the lowest factor is used rather than a guess at a larger one.
 */
export const smoothMotionFactorFor = (targetFps: number, sourceFps: number | null | undefined): SmoothMotionFactor => {
  if (!sourceFps || sourceFps <= 0 || !Number.isFinite(targetFps)) {
    return 2;
  }
  const ratio = targetFps / sourceFps;
  return SMOOTH_MOTION_FACTORS.find((factor) => factor >= ratio - 1e-6) ?? 8;
};

/** The media a clip of the stored graph places: the `mediaId` (or `assetId`) of the item with `clipId`. */
export const clipMediaId = (graph: unknown, clipId: string): string | null => {
  const stack: { node: unknown; depth: number }[] = [{ node: graph, depth: 0 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    if (depth > 64 || !node || typeof node !== 'object') {
      continue;
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        stack.push({ node: item, depth: depth + 1 });
      }
      continue;
    }
    const record = node as Record<string, unknown>;
    if (record.id === clipId) {
      const media = record.mediaId ?? record.assetId;
      if (typeof media === 'string') {
        return media;
      }
    }
    for (const value of Object.values(record)) {
      stack.push({ node: value, depth: depth + 1 });
    }
  }
  return null;
};

export interface StudioRestorationHandlerOptions {
  api?: StudioRestorationApi;
  /** Cancel by durable MediaOperation ID, with the Activity service's ownership and acknowledgment rules. */
  cancel: (operationId: string) => Promise<void>;
  /** The graph the editor works on, to find a clip's media. */
  graph: () => unknown;
  /** A job was queued; the host points the person at Activity. */
  onQueued: (restoration: AssetRestorationResponseDto) => void;
  /** A refusal to show. The handler still throws, so the bridge reports the command as failed. */
  onRefused: (messageKey: Translations) => void;
  /**
   * The command named Frameleaf Cloud. The host opens its Restore panel on this asset, where the job
   * is estimated and confirmed on its own; nothing is sent from here.
   */
  onConfirmOnCloud: (assetId: string, focus: 'restore' | 'smooth-motion') => void;
  /** The revision the editor holds, answered back unchanged: a job never edits the graph. */
  revision: () => number;
}

export const createStudioRestorationHandlers = ({
  api = sdkStudioRestorationApi,
  cancel,
  graph,
  onQueued,
  onRefused,
  onConfirmOnCloud,
  revision,
}: StudioRestorationHandlerOptions) => {
  const refuse = (messageKey: Translations): never => {
    onRefused(messageKey);
    throw new StudioRestorationCommandError(messageKey);
  };

  /** The destination as the server judges it for this work now; a cloud one is confirmed elsewhere. */
  const admitted = async (assetId: string, mode: AssetRestorationMode, destinationId: string) => {
    const options = await api.getOptions(assetId, mode);
    const destination = options.destinations.find((candidate) => candidate.id === destinationId);
    if (!destination) {
      return refuse('frameleaf_studio_job_destination_missing');
    }
    return { destination, options };
  };

  return {
    'job.cancel': async (envelope: StudioCommandEnvelope) => {
      const payload = envelope.payload as StudioCommandPayloads['job.cancel'];
      await cancel(payload.jobId);
      return revision();
    },
    'job.enqueueRestoration': async (envelope: StudioCommandEnvelope) => {
      const payload = envelope.payload as StudioCommandPayloads['job.enqueueRestoration'];
      const assetId = payload.assetId;
      if (!assetId) {
        return refuse('frameleaf_studio_restore_choose_source');
      }
      const mode = payload.mode as AssetRestorationMode;
      if (mode !== AssetRestorationMode.Faithful && mode !== AssetRestorationMode.Creative) {
        return refuse('frameleaf_studio_restore_choose_source');
      }
      if (!payload.preview) {
        if (!payload.restorationId) {
          return refuse('frameleaf_studio_restore_preview_first');
        }
        const reviewed = (await api.getRestorations(assetId)).items.find((item) => item.id === payload.restorationId);
        if (!reviewed) {
          return refuse('frameleaf_studio_restore_preview_first');
        }
        if (reviewed.destinationId !== payload.destinationId) {
          return refuse('frameleaf_studio_restore_destination_changed');
        }
      }
      const { destination } = await admitted(assetId, mode, payload.destinationId);
      if (destination.kind === MlDestinationKind.FrameleafCloud) {
        onConfirmOnCloud(assetId, 'restore');
        return refuse('frameleaf_studio_job_confirm_on_cloud');
      }
      if (!destination.available) {
        return refuse('frameleaf_studio_job_destination_unavailable');
      }
      if (payload.preview) {
        const upscale = [1, 2, 4].includes(payload.upscale) ? (payload.upscale as 1 | 2 | 4) : 2;
        onQueued(
          await api.request(assetId, {
            mode,
            upscale,
            keepGrain: payload.keepGrain ?? false,
            destinationId: destination.id,
          }),
        );
      } else {
        // The full render is always the reviewed preview's: same destination, model, mode and size.
        onQueued(await api.accept(assetId, payload.restorationId!));
      }
      return revision();
    },

    'job.enqueueInterpolation': async (envelope: StudioCommandEnvelope) => {
      const payload = envelope.payload as StudioCommandPayloads['job.enqueueInterpolation'];
      const mediaId = clipMediaId(graph(), payload.clipId);
      if (!mediaId) {
        return refuse('frameleaf_studio_smooth_motion_no_clip');
      }
      if (restorationIdOfMedia(mediaId)) {
        // A restored version is already its own version; Smooth motion is made from the original.
        return refuse('frameleaf_studio_smooth_motion_from_original');
      }
      const asset = await api.getAsset(mediaId);
      if (asset.type !== AssetTypeEnum.Video) {
        return refuse('frameleaf_studio_smooth_motion_video_only');
      }
      const { destination } = await admitted(asset.id, AssetRestorationMode.SmoothMotion, payload.destinationId);
      if (destination.kind === MlDestinationKind.FrameleafCloud) {
        onConfirmOnCloud(asset.id, 'smooth-motion');
        return refuse('frameleaf_studio_job_confirm_on_cloud');
      }
      if (!destination.available) {
        return refuse('frameleaf_studio_job_destination_unavailable');
      }
      const requested = payload.factor as SmoothMotionFactor | undefined;
      const factor =
        requested && SMOOTH_MOTION_FACTORS.includes(requested)
          ? requested
          : smoothMotionFactorFor(payload.targetFps.num / payload.targetFps.den, asset.exifInfo?.fps);
      onQueued(
        await api.request(asset.id, {
          mode: AssetRestorationMode.SmoothMotion,
          upscale: 1,
          smoothMotionFactor: factor,
          keepGrain: false,
          destinationId: destination.id,
        }),
      );
      return revision();
    },
  };
};
