<script lang="ts" module>
  import { rovingFocus } from '$lib/frameleaf/roving-focus';
  /** What the panel asks the stage to show: two real files, before and after. */
  export type RestorationCompareRequest = {
    before: string;
    after: string;
    isVideo: boolean;
    beforeLabel: string;
    afterLabel: string;
  };
</script>

<script lang="ts">
  /**
   * The restoration panel of the quick editor (FL-115), ported from the prototype's `RestorePanel`.
   *
   * Preview first: the person picks a model family, an upscale, a preview area and — explicitly — a
   * destination, then asks for a small preview. Only after reviewing it before and after do they
   * accept it, which renders the full-resolution derivative on the same destination with the same
   * model and size, as a new version of the photo; the original is never touched.
   *
   * Everything shown comes from the server: which destinations would admit the work right now (a
   * refused one is listed with its reason, not hidden, and a cloud destination is never chosen for
   * anybody), the estimate from measured throughput (or an honest "not measured yet"), and each
   * restoration's state. Progress, cancel and retry are the durable job's (FL-104), read through the
   * same session the Activity page uses, so both always agree.
   *
   * Frameleaf Cloud (FL-162) is never a silent route: choosing it turns the preview and the accept into
   * an estimate the owner confirms in CloudJobDialog, one job at a time. Smooth motion (video only)
   * adds in-between frames on Frameleaf Cloud as its own confirmed job, preview first, and is saved as a
   * new version like a restoration.
   */
  import CloudJobDialog from '$lib/components/frameleaf/cloud/CloudJobDialog.svelte';
  import ModelSlider from '$lib/components/frameleaf/cloud/ModelSlider.svelte';
  import { resolvePosition, type DetectedGpu } from '$lib/frameleaf/gpu-model-catalog';
  import { activitySession } from '$lib/frameleaf/activity-session.svelte';
  import {
    CENTRE_REGION,
    RESTORATION_MODES,
    RESTORATION_POLL_MS,
    RESTORATION_UPSCALES,
    abandonedResultKeptUntil,
    anyRestorationBusy,
    canDecideRestoration,
    canDiscardRestoration,
    canSelectRestoration,
    compareKindFor,
    defaultDestinationId,
    destinationKindKey,
    formatEstimateSeconds,
    isFullCropRect,
    isOutputCapped,
    isRestorationBusy,
    orderedDestinations,
    regionFromCrop,
    restorationFileUrl,
    restorationModeHelpKey,
    restorationModeKey,
    restorationStatusKey,
    restorationStatusTone,
    retryOperationIdFor,
    type RestorationRegion,
    type RestorationUpscale,
  } from '$lib/frameleaf/restoration';
  import { mlRefusalLabelKey } from '$lib/frameleaf/ml-destinations';
  import { isVideoAsset } from '$lib/frameleaf/viewer-media';
  import { Route } from '$lib/route';
  import { getAssetMediaUrl, getAssetPlaybackUrl } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import {
    AssetMediaSize,
    AssetRestorationFileKind,
    AssetRestorationMode,
    CloudMlJobPurpose,
    CloudMlJobStage,
    MlDestinationKind,
    acceptAssetRestoration,
    discardAssetRestoration,
    getAssetRestorationOptions,
    getAssetRestorations,
    rejectAssetRestoration,
    requestAssetRestoration,
    setCurrentAssetRestoration,
    type AssetResponseDto,
    type AssetRestorationListResponseDto,
    type AssetRestorationOptionsDto,
    type AssetRestorationResponseDto,
    type CloudMlJobEstimateRequestDto,
  } from '@frameleaf/sdk';
  import { Icon, modalManager, toastManager } from '@frameleaf/ui';
  import {
    mdiAutoFix,
    mdiCheck,
    mdiCloudOutline,
    mdiCompare,
    mdiDeleteOutline,
    mdiDownload,
    mdiMagnify,
    mdiMovieOpenOutline,
    mdiPlayCircleOutline,
    mdiRefresh,
    mdiStop,
  } from '@mdi/js';
  import { onDestroy, onMount, untrack } from 'svelte';
  import { locale, t } from 'svelte-i18n';

  type Props = {
    asset: AssetResponseDto;
    /** The quick editor's current crop, offered as the preview area when it is not the whole frame. */
    crop?: { x: number; y: number; w: number; h: number } | null;
    /** The comparison to show on the stage, or null to clear it. */
    onCompare: (compare: RestorationCompareRequest | null) => void;
    /** The chosen playback version changed, so the viewer should refresh when the editor closes. */
    onCurrentChanged?: () => void;
    /** Whether the stage's comparison shows the 100% loupe (prototype `Studio.jsx:1634`). */
    loupe?: boolean;
    onLoupeChange?: (loupe: boolean) => void;
    /** Video only: the stage's playhead, for "Use current frame" (prototype `Studio.jsx:1637`). */
    currentFrameSeconds?: () => number | null;
    /**
     * FL-115: inside Studio, Use in Studio puts the restored version in the open project's bin. Without
     * it the action opens Studio with that version, beside the original and never instead of it.
     */
    onUseInStudio?: (item: AssetRestorationResponseDto) => void;
    /**
     * FL-83 (E-9): the quick editor shows restoration under the prototype's Enhance tool
     * (`Editor.jsx:1826-1930`): a photo's Enhance panel is this panel, titled Enhance; a clip's
     * Enhance panel ends with it as its "Restore video" section (`subsection`).
     */
    title?: string;
    subsection?: boolean;
  };

  let {
    asset,
    crop = null,
    onCompare,
    onCurrentChanged,
    loupe = false,
    onLoupeChange,
    currentFrameSeconds,
    onUseInStudio,
    title,
    subsection = false,
  }: Props = $props();

  const isVideo = isVideoAsset(asset);
  /** How many frames each frame becomes with Smooth motion. */
  const SMOOTH_MOTION_FACTORS = [2, 4, 8] as const;
  type SmoothMotionFactor = (typeof SMOOTH_MOTION_FACTORS)[number];

  /* Choices ------------------------------------------------------------- */
  let mode = $state<AssetRestorationMode>(AssetRestorationMode.Faithful);
  let upscale = $state<RestorationUpscale>(2);
  let keepGrain = $state(false);
  let destinationId = $state<string | null>(null);
  let regionChoice = $state<'centre' | 'crop'>('centre');
  let startSeconds = $state<number | null>(null);
  let smoothFactor = $state<SmoothMotionFactor>(2);
  /** FL-162/FL-159: the Smooth motion model on its slider, and where that stop runs. */
  let smoothModelId = $state<string | null>(null);
  let smoothRunsOn = $state<'local' | 'cloud' | null>(null);
  let smoothOptions = $state<AssetRestorationOptionsDto | null>(null);

  /* A Frameleaf Cloud job waiting for its estimate to be confirmed (FL-162). */
  type CloudJobRequest = {
    title: string;
    summary: string;
    request: Omit<CloudMlJobEstimateRequestDto, 'modelSku'>;
  };
  let cloudJob = $state<CloudJobRequest | null>(null);
  let cloudJobOpen = $state(false);

  /* Server state ---------------------------------------------------------- */
  let options = $state<AssetRestorationOptionsDto | null>(null);
  let list = $state<AssetRestorationListResponseDto | null>(null);
  let loadError = $state<string | null>(null);
  let optionsPending = $state(false);
  let submitting = $state(false);
  let busyId = $state<string | null>(null);
  let compareId = $state<string | null>(null);
  let announce = $state('');
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let stopActivity: (() => void) | undefined;

  const items = $derived(list?.items ?? []);
  const cropUsable = $derived(!!crop && !isFullCropRect(crop));
  const destinations = $derived(orderedDestinations(options?.destinations ?? []));
  const selected = $derived(destinations.find((item) => item.id === destinationId) ?? null);
  const capped = $derived(options ? isOutputCapped(options) : false);
  const onCloud = $derived(selected?.kind === MlDestinationKind.FrameleafCloud);
  /** Frameleaf Cloud restores at 2× or 4×; the same size is a job for this server or the network. */
  const cloudUpscale = $derived(upscale === 1 ? null : upscale);
  const canRequest = $derived(
    !!options && !!selected && selected.available && !submitting && !loadError && (!onCloud || !!cloudUpscale),
  );
  /** Frameleaf Cloud, for a Smooth motion or restoration job confirmed in CloudJobDialog. */
  const cloudDestinationId = $derived(
    destinations.find((candidate) => candidate.kind === MlDestinationKind.FrameleafCloud)?.id ?? null,
  );
  /**
   * FL-162: the home worker that runs Smooth motion (RIFE) right now, this server's first. The server
   * decides availability with the interpolation row of Where each job runs; nothing moves elsewhere.
   */
  const smoothLocal = $derived(
    orderedDestinations(smoothOptions?.destinations ?? []).find(
      (candidate) => candidate.kind !== MlDestinationKind.FrameleafCloud && candidate.available,
    ) ?? null,
  );
  const smoothGpu = $derived.by((): DetectedGpu | null => {
    const gpu = smoothLocal?.gpu;
    return gpu ? { name: gpu.name, vramGb: gpu.memoryTotalBytes / 1024 ** 3, backend: 'CUDA', profile: null } : null;
  });
  const smoothRoute = $derived(smoothOptions?.route ?? 'local');
  // The slider starts on the model that fits here, as Where each job runs would choose it.
  $effect(() => {
    if (!smoothOptions || smoothModelId) {
      return;
    }
    const start = resolvePosition('interpolation', null, { gpu: smoothGpu, route: smoothRoute });
    if (start) {
      smoothModelId = start.item.id;
      smoothRunsOn = start.runsOn;
    }
  });
  const canSmoothLocally = $derived(smoothRunsOn === 'local' && !!smoothLocal && !submitting);
  const canSmoothOnCloud = $derived(smoothRunsOn === 'cloud' && !!cloudDestinationId && !!options);
  const previewEstimate = $derived(selected ? formatEstimateSeconds(selected.estimate.previewSeconds, $locale) : null);
  const fullEstimate = $derived(selected ? formatEstimateSeconds(selected.estimate.fullSeconds, $locale) : null);

  const region = $derived.by((): RestorationRegion => {
    const base = regionChoice === 'crop' && crop && cropUsable ? regionFromCrop(crop) : { ...CENTRE_REGION };
    if (isVideo && startSeconds !== null) {
      return { ...base, startSeconds };
    }
    return base;
  });

  const maxStart = $derived(
    options?.durationSeconds && options.previewSeconds
      ? Math.max(0, options.durationSeconds - options.previewSeconds)
      : 0,
  );

  /* Loading --------------------------------------------------------------- */
  const loadList = async () => {
    list = await getAssetRestorations({ id: asset.id });
    if (anyRestorationBusy(list.items)) {
      schedulePoll();
    }
  };

  const loadOptions = async (nextMode: AssetRestorationMode, nextUpscale: RestorationUpscale) => {
    optionsPending = true;
    try {
      const next = await getAssetRestorationOptions({ id: asset.id, mode: nextMode, upscale: nextUpscale });
      options = next;
      destinationId = defaultDestinationId(
        next.destinations,
        untrack(() => destinationId),
      );
    } finally {
      optionsPending = false;
    }
  };

  const schedulePoll = () => {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(
      () =>
        void (async () => {
          try {
            await loadList();
          } catch (error) {
            handleError(error, $t('frameleaf_restoration_load_error'));
          }
        })(),
      RESTORATION_POLL_MS,
    );
  };

  const loadSmoothOptions = async () => {
    if (isVideo) {
      smoothOptions = await getAssetRestorationOptions({ id: asset.id, mode: AssetRestorationMode.SmoothMotion });
    }
  };

  onMount(async () => {
    stopActivity = activitySession.watch();
    try {
      await Promise.all([
        loadList(),
        loadOptions(
          untrack(() => mode),
          untrack(() => upscale),
        ),
        loadSmoothOptions(),
      ]);
    } catch (error) {
      loadError = $t('frameleaf_restoration_load_error');
      handleError(error, loadError);
    }
  });

  onDestroy(() => {
    clearTimeout(pollTimer);
    stopActivity?.();
    onCompare(null);
  });

  // The output size and each destination's admission depend on the mode's workload and the upscale.
  let optionsKey = `${mode}:${upscale}`;
  $effect(() => {
    const key = `${mode}:${upscale}`;
    if (key === optionsKey || !options) {
      return;
    }
    optionsKey = key;
    void loadOptions(mode, upscale).catch((error) => handleError(error, $t('frameleaf_restoration_load_error')));
  });

  /* Actions --------------------------------------------------------------- */
  const replace = (updated: AssetRestorationResponseDto) => {
    if (!list) {
      return;
    }
    list = { ...list, items: list.items.map((item) => (item.id === updated.id ? updated : item)) };
  };

  const openCloudJob = (next: CloudJobRequest) => {
    cloudJob = next;
    cloudJobOpen = true;
  };

  const cloudJobSubmitted = () => {
    announce = $t('frameleaf_cloud_job_sent');
    toastManager.primary(announce);
    void loadList().catch((error) => handleError(error, $t('frameleaf_restoration_load_error')));
    schedulePoll();
  };

  const requestPreview = async () => {
    if (!canRequest || !destinationId) {
      return;
    }
    if (onCloud && cloudUpscale) {
      openCloudJob({
        title: $t('frameleaf_cloud_job_title_restoration_preview'),
        summary: [$t(restorationModeKey(mode)), upscaleLabel(cloudUpscale), $t('frameleaf_cloud_job_preview')].join(
          ' · ',
        ),
        request: {
          assetId: asset.id,
          destinationId,
          purpose: CloudMlJobPurpose.Restoration,
          stage: CloudMlJobStage.Preview,
          mode,
          upscale: cloudUpscale,
          keepGrain,
          region,
        },
      });
      return;
    }
    submitting = true;
    try {
      const created = await requestAssetRestoration({
        id: asset.id,
        assetRestorationRequestDto: { mode, upscale, keepGrain, destinationId, region },
      });
      list = {
        assetId: asset.id,
        currentRestorationId: list?.currentRestorationId ?? null,
        items: [created, ...items],
      };
      announce = $t('frameleaf_restoration_preview_queued', { values: { revision: created.revision } });
      toastManager.primary(announce);
      void activitySession.refresh();
      schedulePoll();
    } catch (error) {
      handleError(error, $t('frameleaf_restoration_request_error'));
    } finally {
      submitting = false;
    }
  };

  const run = async (item: AssetRestorationResponseDto, action: () => Promise<unknown>, failure: string) => {
    busyId = item.id;
    try {
      await action();
    } catch (error) {
      handleError(error, failure);
    } finally {
      busyId = null;
    }
  };

  /** Smooth motion preview on this server or a home-network worker (FL-162), saved as a new version. */
  const requestLocalSmoothMotion = async () => {
    if (!canSmoothLocally || !smoothLocal) {
      return;
    }
    submitting = true;
    try {
      const created = await requestAssetRestoration({
        id: asset.id,
        assetRestorationRequestDto: {
          mode: AssetRestorationMode.SmoothMotion,
          upscale: 1,
          smoothMotionFactor: smoothFactor,
          keepGrain: false,
          destinationId: smoothLocal.id,
          region,
        },
      });
      list = {
        assetId: asset.id,
        currentRestorationId: list?.currentRestorationId ?? null,
        items: [created, ...items],
      };
      announce = $t('frameleaf_restoration_preview_queued', { values: { revision: created.revision } });
      toastManager.primary(announce);
      void activitySession.refresh();
      schedulePoll();
    } catch (error) {
      handleError(error, $t('frameleaf_restoration_request_error'));
    } finally {
      submitting = false;
    }
  };

  /** Smooth motion preview on Frameleaf Cloud: the same clip a restoration preview would use. */
  const requestSmoothMotion = () => {
    if (!cloudDestinationId) {
      return;
    }
    openCloudJob({
      title: $t('frameleaf_cloud_job_title_smooth_motion_preview'),
      summary: [
        $t('frameleaf_restoration_smooth_motion_factor', { values: { factor: smoothFactor } }),
        $t('frameleaf_cloud_job_preview'),
      ].join(' · '),
      request: {
        assetId: asset.id,
        destinationId: cloudDestinationId,
        purpose: CloudMlJobPurpose.SmoothMotion,
        stage: CloudMlJobStage.Preview,
        factor: smoothFactor,
        region,
      },
    });
  };

  const isCloudItem = (item: AssetRestorationResponseDto) => item.destinationKind === MlDestinationKind.FrameleafCloud;

  const accept = async (item: AssetRestorationResponseDto) => {
    // A reviewed Frameleaf Cloud preview renders in full only as its own confirmed job.
    if (isCloudItem(item) && item.destinationId) {
      const smooth = item.mode === AssetRestorationMode.SmoothMotion;
      openCloudJob({
        title: $t(
          smooth ? 'frameleaf_cloud_job_title_smooth_motion_full' : 'frameleaf_cloud_job_title_restoration_full',
        ),
        summary: itemTitle(item),
        request: {
          assetId: asset.id,
          destinationId: item.destinationId,
          purpose: smooth ? CloudMlJobPurpose.SmoothMotion : CloudMlJobPurpose.Restoration,
          stage: CloudMlJobStage.Full,
          restorationId: item.id,
        },
      });
      return;
    }
    await acceptLocal(item);
  };

  const acceptLocal = (item: AssetRestorationResponseDto) =>
    run(
      item,
      async () => {
        replace(await acceptAssetRestoration({ id: asset.id, restorationId: item.id }));
        announce = $t('frameleaf_restoration_accepted', { values: { revision: item.revision } });
        toastManager.primary(announce);
        void activitySession.refresh();
        schedulePoll();
      },
      $t('frameleaf_restoration_accept_error'),
    );

  const reject = (item: AssetRestorationResponseDto) =>
    run(
      item,
      async () => {
        replace(await rejectAssetRestoration({ id: asset.id, restorationId: item.id }));
        if (compareId === item.id) {
          clearCompare();
        }
        announce = $t('frameleaf_restoration_rejected', { values: { revision: item.revision } });
      },
      $t('frameleaf_restoration_reject_error'),
    );

  const discard = async (item: AssetRestorationResponseDto) => {
    const confirmed = await modalManager.showDialog({
      title: $t('frameleaf_restoration_discard_title'),
      prompt: $t('frameleaf_restoration_discard_prompt', { values: { revision: item.revision } }),
      confirmText: $t('frameleaf_restoration_discard_confirm'),
    });
    if (!confirmed) {
      return;
    }
    await run(
      item,
      async () => {
        await discardAssetRestoration({ id: asset.id, restorationId: item.id });
        if (compareId === item.id) {
          clearCompare();
        }
        if (item.isCurrent) {
          onCurrentChanged?.();
        }
        await loadList();
        void activitySession.refresh();
      },
      $t('frameleaf_restoration_discard_error'),
    );
  };

  const cancel = (item: AssetRestorationResponseDto) =>
    run(
      item,
      async () => {
        if (!item.activeOperationId) {
          return;
        }

        await activitySession.cancel(item.activeOperationId);
        schedulePoll();
      },
      $t('frameleaf_restoration_cancel_error'),
    );

  const retry = (item: AssetRestorationResponseDto) =>
    run(
      item,
      async () => {
        const operationId = retryOperationIdFor(item);
        if (operationId) {
          await activitySession.retry(operationId);
          announce = $t('frameleaf_restoration_retry_queued', { values: { revision: item.revision } });
          schedulePoll();
        }
      },
      $t('frameleaf_restoration_retry_error'),
    );

  const useAsCurrent = (item: AssetRestorationResponseDto | null) =>
    run(
      item ?? items[0],
      async () => {
        list = await setCurrentAssetRestoration({
          id: asset.id,
          assetRestorationSelectDto: item ? { restorationId: item.id } : {},
        });
        onCurrentChanged?.();
        announce = item
          ? $t('frameleaf_restoration_now_current', { values: { revision: item.revision } })
          : $t('frameleaf_restoration_original_current');
        toastManager.primary(announce);
      },
      $t('frameleaf_restoration_select_error'),
    );

  /* Comparison ------------------------------------------------------------ */
  const clearCompare = () => {
    compareId = null;
    onCompare(null);
  };

  const compare = (item: AssetRestorationResponseDto) => {
    const kind = compareKindFor(item);
    if (!kind || compareId === item.id) {
      clearCompare();
      return;
    }
    compareId = item.id;
    const cacheKey = item.updatedAt;
    if (kind === 'preview') {
      onCompare({
        before: restorationFileUrl(asset.id, item.id, AssetRestorationFileKind.Before, cacheKey),
        after: restorationFileUrl(asset.id, item.id, AssetRestorationFileKind.After, cacheKey),
        isVideo,
        beforeLabel: $t('frameleaf_editor_before'),
        afterLabel: $t('frameleaf_restoration_after_preview'),
      });
      return;
    }
    onCompare({
      before: isVideo
        ? getAssetPlaybackUrl({ id: asset.id, cacheKey: asset.thumbhash })
        : getAssetMediaUrl({ id: asset.id, size: AssetMediaSize.Preview, cacheKey: asset.thumbhash, edited: false }),
      after: restorationFileUrl(
        asset.id,
        item.id,
        isVideo ? AssetRestorationFileKind.Result : AssetRestorationFileKind.ResultPreview,
        cacheKey,
      ),
      isVideo,
      beforeLabel: $t('frameleaf_editor_version_original'),
      afterLabel: $t('frameleaf_restoration_after_result'),
    });
  };

  /* Presentation ---------------------------------------------------------- */
  const progressFor = (item: AssetRestorationResponseDto): number | null => {
    if (!item.activeOperationId) {
      return null;
    }
    const operation = activitySession.operations.find((candidate) => candidate.id === item.activeOperationId);
    if (!operation || (Number(operation.totalUnits ?? 0) <= 0 && operation.progress <= 0)) {
      return null;
    }
    return Math.max(0, Math.min(100, Math.round(operation.progress)));
  };

  /** "Use current frame": the preview clip starts at the stage's playhead, kept inside the video. */
  const useCurrentFrame = () => {
    const seconds = currentFrameSeconds?.();
    if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) {
      announce = $t('frameleaf_restoration_no_current_frame');
      return;
    }
    startSeconds = Math.max(0, Math.min(maxStart, Math.round(seconds * 2) / 2));
    announce = $t('frameleaf_restoration_clip_from_frame', { values: { seconds: startSeconds } });
  };

  const upscaleLabel = (factor: RestorationUpscale) =>
    factor === 1
      ? $t('frameleaf_restoration_upscale_same')
      : $t('frameleaf_restoration_upscale_times', { values: { factor } });

  const itemTitle = (item: AssetRestorationResponseDto) =>
    item.mode === AssetRestorationMode.SmoothMotion
      ? $t('frameleaf_restoration_item_title_smooth_motion', {
          values: { revision: item.revision, factor: item.smoothMotionFactor ?? item.upscale },
        })
      : $t('frameleaf_restoration_item_title', {
          values: {
            revision: item.revision,
            mode: $t(restorationModeKey(item.mode)),
            upscale: upscaleLabel(item.upscale as RestorationUpscale),
          },
        });

  const formatDate = (value: string | null) => (value ? new Date(value).toLocaleString($locale ?? undefined) : '');
</script>

<div class={subsection ? 'rs-subsection' : 'ed-panel-body'} data-testid="restoration-panel">
  {#if subsection}
    <h3 class="rs-subsection-title">{title ?? $t('frameleaf_restoration_title')}</h3>
  {:else}
    <div class="ed-panel-head">
      <h2>{title ?? $t('frameleaf_restoration_title')}</h2>
    </div>
  {/if}
  <p class="rs-lead">{$t('frameleaf_restoration_lead')}</p>

  <h3>{$t('frameleaf_restoration_mode')}</h3>
  <div class="ed-row" role="radiogroup" use:rovingFocus aria-label={$t('frameleaf_restoration_mode')}>
    {#each RESTORATION_MODES as candidate (candidate)}
      <button
        type="button"
        role="radio"
        class="ed-chip"
        aria-checked={mode === candidate}
        onclick={() => (mode = candidate)}
      >
        {$t(restorationModeKey(candidate))}
      </button>
    {/each}
  </div>
  <p class="rs-help">{$t(restorationModeHelpKey(mode))}</p>

  <h3>{$t('frameleaf_restoration_upscale')}</h3>
  <div class="ed-row" role="radiogroup" use:rovingFocus aria-label={$t('frameleaf_restoration_upscale')}>
    {#each RESTORATION_UPSCALES as factor (factor)}
      <button
        type="button"
        role="radio"
        class="ed-chip"
        aria-checked={upscale === factor}
        onclick={() => (upscale = factor)}
      >
        {upscaleLabel(factor)}
      </button>
    {/each}
  </div>
  {#if options}
    <p class="rs-help">
      {$t('frameleaf_restoration_output_size', {
        values: { width: options.outputWidth, height: options.outputHeight },
      })}
      {#if capped}
        · {$t('frameleaf_restoration_output_capped')}
      {/if}
    </p>
  {/if}
  <label class="rs-check">
    <input type="checkbox" bind:checked={keepGrain} />
    <span>{$t('frameleaf_restoration_keep_grain')}</span>
    <small>{$t('frameleaf_restoration_keep_grain_help')}</small>
  </label>

  <h3>{$t('frameleaf_restoration_preview_area')}</h3>
  <div class="ed-row" role="radiogroup" use:rovingFocus aria-label={$t('frameleaf_restoration_preview_area')}>
    <button
      type="button"
      role="radio"
      class="ed-chip"
      aria-checked={regionChoice === 'centre'}
      onclick={() => (regionChoice = 'centre')}
    >
      {$t('frameleaf_restoration_area_centre')}
    </button>
    <button
      type="button"
      role="radio"
      class="ed-chip"
      aria-checked={regionChoice === 'crop'}
      disabled={!cropUsable}
      title={cropUsable ? undefined : $t('frameleaf_restoration_area_crop_hint')}
      onclick={() => (regionChoice = 'crop')}
    >
      {$t('frameleaf_restoration_area_crop')}
    </button>
  </div>
  {#if isVideo && options}
    <label class="rs-field">
      <span>{$t('frameleaf_restoration_clip_start')}</span>
      <input
        type="number"
        min="0"
        max={maxStart}
        step="0.5"
        value={startSeconds ?? Math.round((maxStart / 2) * 2) / 2}
        oninput={(event) => {
          const value = Number(event.currentTarget.value);
          startSeconds = Number.isFinite(value) ? Math.max(0, Math.min(maxStart, value)) : null;
        }}
      />
    </label>
    <p class="rs-help">{$t('frameleaf_restoration_clip_help', { values: { seconds: options.previewSeconds ?? 5 } })}</p>
  {/if}

  <h3>{$t('frameleaf_restoration_destination')}</h3>
  {#if loadError}
    <p class="ed-empty">{loadError}</p>
  {:else if !options}
    <p class="rs-help" aria-busy="true">{$t('loading')}</p>
  {:else if destinations.length === 0}
    <p class="ed-empty">{$t('frameleaf_restoration_no_destinations')}</p>
  {:else}
    <label class="rs-field">
      <span>{$t('frameleaf_restoration_process_on')}</span>
      <select
        value={destinationId ?? ''}
        disabled={optionsPending}
        onchange={(event) => (destinationId = event.currentTarget.value || null)}
      >
        <option value="" disabled>{$t('frameleaf_restoration_choose_destination')}</option>
        {#each destinations as candidate (candidate.id)}
          <option value={candidate.id} disabled={!candidate.available}>
            {candidate.name} · {$t(destinationKindKey(candidate.kind))}{candidate.available
              ? ''
              : ` · ${$t('frameleaf_restoration_unavailable')}`}
          </option>
        {/each}
      </select>
    </label>
    {#if selected}
      {#if !selected.available && selected.refusal}
        <p class="rs-warning" role="status">
          {$t(mlRefusalLabelKey(selected.refusal))}{selected.refusalDetail ? ` ${selected.refusalDetail}` : ''}
        </p>
      {:else if selected.leavesNetwork}
        <p class="rs-warning" role="status">
          <Icon icon={mdiCloudOutline} size="14" />
          {$t('frameleaf_restoration_leaves_network')}
        </p>
        <!-- FL-72: a cloud job's cost is only known once Frameleaf Cloud settles it. -->
        <p class="rs-help">{$t('frameleaf_restoration_cloud_cost_uncertain')}</p>
      {:else}
        <p class="rs-help">{$t('frameleaf_restoration_stays_on_network')}</p>
      {/if}
    {:else}
      <p class="rs-warning" role="status">{$t('frameleaf_restoration_pick_destination')}</p>
    {/if}
    {#each destinations.filter((candidate) => !candidate.available && candidate.id !== destinationId) as refused (refused.id)}
      <p class="rs-help">
        {refused.name}: {refused.refusal
          ? $t(mlRefusalLabelKey(refused.refusal))
          : $t('frameleaf_restoration_unavailable')}
      </p>
    {/each}

    <h3>{$t('frameleaf_restoration_estimate')}</h3>
    {#if selected}
      <dl class="rs-facts">
        <dt>{$t('frameleaf_restoration_estimate_preview')}</dt>
        <dd>
          {previewEstimate
            ? $t('frameleaf_restoration_about', { values: { time: previewEstimate } })
            : $t('frameleaf_restoration_estimate_unmeasured')}
        </dd>
        <dt>{$t('frameleaf_restoration_estimate_full')}</dt>
        <dd>
          {fullEstimate
            ? $t('frameleaf_restoration_about', { values: { time: fullEstimate } })
            : $t('frameleaf_restoration_estimate_unmeasured')}
        </dd>
        <!-- Prototype Estimate (Studio.jsx:1619-1629): Output and Cloud cost. The output is the capped
             size the server will render; no charge is invented for a destination that leaves the network. -->
        {#if options}
          <dt>{$t('frameleaf_restoration_estimate_output')}</dt>
          <dd>
            {$t('frameleaf_restoration_output_dimensions', {
              values: { width: options.outputWidth, height: options.outputHeight },
            })}
          </dd>
        {/if}
        <dt>{$t('frameleaf_restoration_estimate_cloud_cost')}</dt>
        <dd>
          {onCloud
            ? $t('frameleaf_restoration_estimate_cost_on_confirm')
            : selected.leavesNetwork
              ? $t('frameleaf_restoration_estimate_unmeasured')
              : $t('frameleaf_restoration_estimate_cost_none')}
        </dd>
      </dl>
      <p class="rs-help">
        {selected.estimate.sampleCount > 0
          ? $t('frameleaf_restoration_estimate_basis', {
              values: { count: selected.estimate.sampleCount, days: selected.estimate.windowDays },
            })
          : $t('frameleaf_restoration_estimate_none_help')}
      </p>
    {:else}
      <p class="rs-help">{$t('frameleaf_restoration_estimate_pick')}</p>
    {/if}
  {/if}

  <!-- Prototype RestorePanel tools row (Studio.jsx:1632-1640): Loupe and, for video, Use current frame. -->
  <div class="ed-row">
    <button
      type="button"
      class="ed-chip"
      aria-pressed={loupe}
      data-testid="restoration-loupe-toggle"
      onclick={() => onLoupeChange?.(!loupe)}
    >
      <Icon icon={mdiMagnify} size="16" />
      {$t('frameleaf_restoration_loupe')}
    </button>
    {#if isVideo && currentFrameSeconds}
      <button type="button" class="ed-chip" disabled={!options} onclick={useCurrentFrame}>
        <Icon icon={mdiRefresh} size="16" />
        {$t('frameleaf_restoration_use_current_frame')}
      </button>
    {/if}
  </div>
  <div class="rs-actions">
    <button type="button" class="ed-button primary" disabled={!canRequest} onclick={requestPreview}>
      <Icon icon={onCloud ? mdiCloudOutline : isVideo ? mdiPlayCircleOutline : mdiAutoFix} size="18" />
      {#if submitting}
        {$t('frameleaf_restoration_requesting')}
      {:else if onCloud}
        {$t('frameleaf_restoration_estimate_on_cloud')}
      {:else if isVideo}
        {$t('frameleaf_restoration_preview_seconds', { values: { seconds: options?.previewSeconds ?? 5 } })}
      {:else}
        {$t('frameleaf_restoration_request_preview')}
      {/if}
    </button>
    {#if onCloud && !cloudUpscale}
      <p class="rs-warning" role="status">{$t('frameleaf_restoration_cloud_needs_upscale')}</p>
    {/if}
    <p class="rs-help">{$t('frameleaf_restoration_request_help')}</p>
  </div>

  {#if isVideo}
    <!--
      FL-162 Smooth motion (prototype FrameMethod): in-between frames, preview first, saved as a new
      version. The model slider (FL-159) shows where each model runs here: this server or your GPU runs
      RIFE locally, a blue stop is its own Frameleaf Cloud job confirmed with its estimate.
    -->
    <h3>{$t('frameleaf_restoration_mode_smooth_motion')}</h3>
    <p class="rs-help">{$t('frameleaf_restoration_mode_smooth_motion_help')}</p>
    <div
      class="ed-row"
      role="radiogroup"
      use:rovingFocus
      aria-label={$t('frameleaf_restoration_smooth_motion_factor_label')}
    >
      {#each SMOOTH_MOTION_FACTORS as factor (factor)}
        <button
          type="button"
          role="radio"
          class="ed-chip"
          aria-checked={smoothFactor === factor}
          onclick={() => (smoothFactor = factor)}
        >
          {$t('frameleaf_restoration_smooth_motion_factor', { values: { factor } })}
        </button>
      {/each}
    </div>
    {#if smoothOptions}
      <ModelSlider
        workload="interpolation"
        value={smoothModelId}
        gpu={smoothGpu}
        route={smoothRoute}
        label={$t('frameleaf_restoration_smooth_motion_model')}
        hideLegend
        localDisabledReason={smoothLocal ? '' : $t('frameleaf_restoration_smooth_motion_no_local')}
        onChange={(id, state) => {
          smoothModelId = id;
          smoothRunsOn = state.runsOn;
        }}
      />
    {/if}
    <div class="rs-actions" data-testid="restoration-smooth-motion">
      {#if smoothRunsOn === 'cloud'}
        <button type="button" class="ed-button" disabled={!canSmoothOnCloud} onclick={requestSmoothMotion}>
          <Icon icon={mdiCloudOutline} size="18" />
          {$t('frameleaf_restoration_smooth_motion_estimate')}
        </button>
        <p class="rs-help">
          {cloudDestinationId
            ? $t('frameleaf_restoration_smooth_motion_cloud_only')
            : $t('frameleaf_restoration_smooth_motion_needs_cloud')}
        </p>
      {:else}
        <button type="button" class="ed-button" disabled={!canSmoothLocally} onclick={requestLocalSmoothMotion}>
          <Icon icon={mdiPlayCircleOutline} size="18" />
          {$t('frameleaf_restoration_smooth_motion_preview', {
            values: { seconds: smoothOptions?.previewSeconds ?? 5 },
          })}
        </button>
        <p class="rs-help">
          {smoothLocal
            ? $t('frameleaf_restoration_smooth_motion_on', { values: { name: smoothLocal.name } })
            : $t('frameleaf_restoration_smooth_motion_no_local')}
        </p>
      {/if}
    </div>
  {/if}

  <h3>{$t('frameleaf_restoration_versions')}</h3>
  {#if list && list.currentRestorationId}
    <div class="ed-row">
      <button type="button" class="ed-chip" disabled={busyId !== null} onclick={() => useAsCurrent(null)}>
        {$t('frameleaf_restoration_use_original')}
      </button>
    </div>
  {/if}
  {#if items.length === 0 && list}
    <p class="ed-empty">{$t('frameleaf_restoration_none')}</p>
  {/if}
  {#each items as item (item.id)}
    {@const tone = restorationStatusTone(item.status)}
    {@const progress = progressFor(item)}
    {@const partialKeptUntil = abandonedResultKeptUntil(item)}
    <div class={['ed-version', item.isCurrent && 'current']}>
      <strong>{itemTitle(item)}</strong>
      <span
        class={['ed-status', tone === 'busy' && 'busy', tone === 'failed' && 'failed', tone === 'neutral' && 'muted']}
      >
        {item.isCurrent ? $t('frameleaf_restoration_playing_this') : $t(restorationStatusKey(item.status))}
      </span>
      <small>
        {item.destinationName}{item.modelName ? ` · ${item.modelName}` : ''}{item.outputWidth && item.outputHeight
          ? ` · ${item.outputWidth} × ${item.outputHeight}`
          : ''} · {formatDate(item.createdAt)}
      </small>
      {#if isRestorationBusy(item.status)}
        <progress
          class="rs-progress"
          max="100"
          value={progress ?? undefined}
          aria-label={$t('frameleaf_restoration_progress_for', { values: { revision: item.revision } })}
        ></progress>
      {/if}
      {#if item.error}
        <small class="rs-error">{item.error}</small>
      {/if}
      {#if item.status === 'preview_ready' && item.previewExpiresAt}
        <small
          >{$t('frameleaf_restoration_preview_kept_until', {
            values: { date: formatDate(item.previewExpiresAt) },
          })}</small
        >
      {/if}
      {#if partialKeptUntil}
        <!-- FL-115 result retention: a stopped full render keeps its finished chunks for a while. -->
        <small data-testid="restoration-result-kept-until"
          >{$t('frameleaf_restoration_partial_kept_until', {
            values: { date: formatDate(partialKeptUntil) },
          })}</small
        >
      {/if}
      <div class="ed-row">
        {#if compareKindFor(item)}
          <button type="button" class="ed-chip" aria-pressed={compareId === item.id} onclick={() => compare(item)}>
            <Icon icon={mdiCompare} size="16" />
            {$t('frameleaf_restoration_compare')}
          </button>
        {/if}
        {#if canDecideRestoration(item.status)}
          <button type="button" class="ed-chip accent" disabled={busyId === item.id} onclick={() => accept(item)}>
            <Icon icon={mdiCheck} size="16" />
            {isVideo ? $t('frameleaf_restoration_restore_full_video') : $t('frameleaf_restoration_accept')}
          </button>
          <button type="button" class="ed-chip" disabled={busyId === item.id} onclick={() => reject(item)}>
            {$t('frameleaf_restoration_reject')}
          </button>
        {/if}
        {#if isRestorationBusy(item.status) && item.activeOperationId}
          <button type="button" class="ed-chip" disabled={busyId === item.id} onclick={() => cancel(item)}>
            <Icon icon={mdiStop} size="16" />
            {$t('cancel')}
          </button>
        {/if}
        {#if retryOperationIdFor(item) && !isCloudItem(item)}
          <button type="button" class="ed-chip" disabled={busyId === item.id} onclick={() => retry(item)}>
            <Icon icon={mdiRefresh} size="16" />
            {$t('retry')}
          </button>
        {/if}
        {#if canSelectRestoration(item) && !item.isCurrent}
          <button type="button" class="ed-chip accent" disabled={busyId !== null} onclick={() => useAsCurrent(item)}>
            <Icon icon={mdiCheck} size="16" />
            {$t('frameleaf_restoration_use_as_current')}
          </button>
        {/if}
        {#if item.hasResult}
          <!-- FL-115: an explicit choice; the playback version never becomes a Studio source by itself. -->
          {#if onUseInStudio}
            <button
              type="button"
              class="ed-chip"
              data-testid="restoration-use-in-studio"
              disabled={busyId !== null}
              onclick={() => onUseInStudio(item)}
            >
              <Icon icon={mdiMovieOpenOutline} size="16" />
              {$t('frameleaf_restoration_use_in_studio')}
            </button>
          {:else}
            <a
              class="ed-chip"
              data-testid="restoration-use-in-studio"
              href={Route.studio({ restorationIds: [item.id], returnTo: asset.id })}
            >
              <Icon icon={mdiMovieOpenOutline} size="16" />
              {$t('frameleaf_restoration_use_in_studio')}
            </a>
          {/if}
          <a
            class="ed-chip"
            href={restorationFileUrl(asset.id, item.id, AssetRestorationFileKind.Result, item.restoredAt)}
            download
          >
            <Icon icon={mdiDownload} size="16" />
            {$t('frameleaf_restoration_download_result')}
          </a>
        {/if}
        {#if canDiscardRestoration(item.status)}
          <button type="button" class="ed-chip" disabled={busyId === item.id} onclick={() => discard(item)}>
            <Icon icon={mdiDeleteOutline} size="16" />
            {$t('frameleaf_restoration_discard')}
          </button>
        {/if}
      </div>
    </div>
  {/each}
  <p class="ed-note">{$t('frameleaf_restoration_footnote')}</p>
  <div class="ed-live" role="status" aria-live="polite">{announce}</div>
</div>

{#if cloudJob}
  <!-- a new request is a new dialog: nothing of the previous job or estimate carries over -->
  {#key cloudJob}
    <CloudJobDialog
      bind:open={cloudJobOpen}
      title={cloudJob.title}
      summary={cloudJob.summary}
      request={cloudJob.request}
      onSubmitted={cloudJobSubmitted}
    />
  {/key}
{/if}
