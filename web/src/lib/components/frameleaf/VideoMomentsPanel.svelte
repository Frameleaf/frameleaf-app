<script lang="ts">
  /**
   * A video's moments in the information panel (FL-59, `REC-101`).
   *
   * Shows the reusable frames ranked best first, the cover, the timestamped moments — generated
   * ones and the owner's own — and what they were made from. Choosing a frame or a moment starts
   * the video there. The owner can choose the cover, add, edit and remove their own moments, and
   * queue a refresh (frames and the search index) or optional captions as a durable plan that
   * shows up in Activity and survives closing the page.
   *
   * Any indexed frame can start a frame-to-moment search: the moments nearest that frame across the
   * person's own videos, and at other times in this one, found from the embedding already stored
   * (nothing is sent to a model). Choosing a result opens that video at that moment.
   *
   * Everything goes through the enrichment endpoints; a Locked video's moments are only ever
   * returned to its owner's unlocked session, so the panel simply shows nothing otherwise.
   */
  import IconButton from '$lib/components/frameleaf/IconButton.svelte';
  import VideoMomentHits from '$lib/components/frameleaf/VideoMomentHits.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import {
    captionRequestCount,
    formatMomentTime,
    frameImagePath,
    isPlanActive,
    newRequestKey,
    parseMomentTime,
    planPollDelay,
    staleReasonKey,
  } from '$lib/frameleaf/enrichment';
  import { videoSeek } from '$lib/frameleaf/video-seek.svelte';
  import { handleError } from '$lib/utils/handle-error';
  import { navigate } from '$lib/utils/navigation';
  import {
    AssetTypeEnum,
    createEnrichmentPlan,
    createVideoMoment,
    deleteVideoMoment,
    EnrichmentStage,
    getBaseUrl,
    getEnrichmentPlan,
    getVideoMoments,
    searchSimilarVideoMoments,
    setVideoMomentCover,
    updateVideoMoment,
    VideoMomentIndexState,
    VideoMomentSource,
    type AssetResponseDto,
    type EnrichmentPlanResponseDto,
    type VideoMomentDto,
    type VideoMomentFrameDto,
    type VideoMomentSearchHitDto,
    type VideoMomentsResponseDto,
  } from '@immich/sdk';
  import { Button, Icon, LoadingSpinner, Text } from '@immich/ui';
  import { mdiClose, mdiImageCheckOutline, mdiPlus, mdiRefresh, mdiTextBoxPlusOutline } from '@mdi/js';
  import { onDestroy } from 'svelte';
  import { locale, t } from 'svelte-i18n';

  type Props = {
    asset: AssetResponseDto;
    isOwner: boolean;
  };

  let { asset, isOwner }: Props = $props();

  let moments = $state<VideoMomentsResponseDto | null>(null);
  let loading = $state(false);
  let busy = $state<string | null>(null);
  let plan = $state<EnrichmentPlanResponseDto | null>(null);
  let pollTimer: ReturnType<typeof setTimeout> | undefined;

  /** A frame-to-moment search: `hits` is null while it runs. */
  let similar = $state<{
    frameId: string;
    timestampMs: number;
    hits: VideoMomentSearchHitDto[] | null;
    failed: boolean;
  } | null>(null);

  let editing = $state<{ id: string | null; time: string; caption: string; transcript: string } | null>(null);
  let editError = $state<string | null>(null);

  const isVideo = $derived(asset.type === AssetTypeEnum.Video);
  const cover = $derived(moments?.frames.find((frame) => frame.isCover) ?? null);
  const framesPerVideo = $derived(moments?.frames.length || 6);

  const frameUrl = (frameId: string) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(authManager.params)) {
      if (value) {
        query.set(key, value);
      }
    }
    const search = query.toString();
    return `${getBaseUrl()}${frameImagePath(frameId)}${search ? `?${search}` : ''}`;
  };

  const load = async (assetId: string) => {
    loading = true;
    try {
      const result = await getVideoMoments({ id: assetId });
      if (asset.id === assetId) {
        moments = result;
      }
    } catch {
      // Not a video this session may read (for example a Locked one): the panel stays empty.
      if (asset.id === assetId) {
        moments = null;
      }
    } finally {
      loading = false;
    }
  };

  const stopPolling = () => {
    if (!pollTimer) {
      return;
    }

    clearTimeout(pollTimer);
    pollTimer = undefined;
  };

  const follow = (next: EnrichmentPlanResponseDto) => {
    plan = next;
    stopPolling();
    const delay = planPollDelay(next.operation.status);
    if (delay === null) {
      void load(asset.id);
      return;
    }
    pollTimer = setTimeout(
      () =>
        void (async () => {
          try {
            follow(await getEnrichmentPlan({ id: next.operation.id }));
          } catch (error) {
            handleError(error, $t('frameleaf_enrichment_plan_error'));
          }
        })(),
      delay,
    );
  };

  const queue = async (stages: EnrichmentStage[], key: string) => {
    busy = key;
    try {
      follow(
        await createEnrichmentPlan({
          enrichmentPlanCreateDto: { assetIds: [asset.id], stages, requestKey: newRequestKey() },
        }),
      );
    } catch (error) {
      handleError(error, $t('frameleaf_enrichment_plan_error'));
    } finally {
      busy = null;
    }
  };

  const refresh = () => queue([EnrichmentStage.Frames, EnrichmentStage.MomentIndex], 'refresh');
  const addCaptions = () => queue([EnrichmentStage.MomentCaptions], 'captions');

  const chooseCover = async (timestampMs: number | null) => {
    busy = 'cover';
    try {
      moments = await setVideoMomentCover({ id: asset.id, videoMomentCoverDto: { timestampMs } });
    } catch (error) {
      handleError(error, $t('frameleaf_moments_cover_error'));
    } finally {
      busy = null;
    }
  };

  const seek = (timestampMs: number) => videoSeek.request(asset.id, timestampMs);

  const findSimilar = async (frame: Pick<VideoMomentFrameDto, 'id' | 'timestampMs'>) => {
    const assetId = asset.id;
    similar = { frameId: frame.id, timestampMs: frame.timestampMs, hits: null, failed: false };
    const current = () => asset.id === assetId && similar?.frameId === frame.id;
    try {
      const { hits } = await searchSimilarVideoMoments({ id: frame.id, limit: 12 });
      if (current()) {
        similar = { frameId: frame.id, timestampMs: frame.timestampMs, hits, failed: false };
      }
    } catch (error) {
      // Shown in place of the results with a retry, not as a toast.
      handleError(error, $t('frameleaf_moments_similar_error'), { notify: false });
      if (current()) {
        similar = { frameId: frame.id, timestampMs: frame.timestampMs, hits: [], failed: true };
      }
    }
  };

  /** A hit in this video seeks it; a hit in another opens that video at the moment. */
  const openSimilar = async (hit: VideoMomentSearchHitDto) => {
    if (hit.assetId === asset.id) {
      seek(hit.timestampMs);
      return;
    }
    videoSeek.request(hit.assetId, hit.timestampMs);
    await navigate({ targetRoute: 'current', assetId: hit.assetId });
  };

  const startAdd = () => {
    editError = null;
    editing = { id: null, time: '', caption: '', transcript: '' };
  };

  const startEdit = (moment: VideoMomentDto) => {
    editError = null;
    editing = {
      id: moment.id,
      time: formatMomentTime(moment.timestampMs),
      caption: moment.caption ?? '',
      transcript: moment.transcript ?? '',
    };
  };

  const save = async () => {
    if (!editing) {
      return;
    }
    const timestampMs = parseMomentTime(editing.time);
    if (timestampMs === null) {
      editError = $t('frameleaf_moments_time_invalid');
      return;
    }
    busy = 'save';
    try {
      const body = {
        timestampMs,
        caption: editing.caption.trim() || null,
        transcript: editing.transcript.trim() || null,
      };
      await (editing.id
        ? updateVideoMoment({ id: asset.id, momentId: editing.id, videoMomentUpdateDto: body })
        : createVideoMoment({ id: asset.id, videoMomentCreateDto: body }));
      editing = null;
      await load(asset.id);
    } catch (error) {
      handleError(error, $t('frameleaf_moments_save_error'));
    } finally {
      busy = null;
    }
  };

  const remove = async (moment: VideoMomentDto) => {
    busy = moment.id;
    try {
      await deleteVideoMoment({ id: asset.id, momentId: moment.id });
      await load(asset.id);
    } catch (error) {
      handleError(error, $t('frameleaf_moments_delete_error'));
    } finally {
      busy = null;
    }
  };

  const untitledKey = (moment: VideoMomentDto) =>
    moment.source === VideoMomentSource.Manual ? 'frameleaf_moments_untitled' : 'frameleaf_moments_uncaptioned';

  const sourceKey = (moment: VideoMomentDto) =>
    moment.source === VideoMomentSource.Manual
      ? 'frameleaf_moments_source_manual'
      : 'frameleaf_moments_source_generated';

  const formatDate = (value: string | null) =>
    value ? new Date(value).toLocaleString($locale ?? undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';

  $effect(() => {
    const id = asset.id;
    stopPolling();
    plan = null;
    editing = null;
    similar = null;
    moments = null;
    if (isVideo) {
      void load(id);
    }
  });

  onDestroy(stopPolling);
</script>

{#if isVideo && (moments || loading)}
  <section class="mt-4 px-4" data-testid="frameleaf-video-moments" aria-label={$t('frameleaf_moments_title')}>
    <div class="flex h-10 w-full items-center justify-between text-sm">
      <Text color="muted">{$t('frameleaf_moments_title')}</Text>
      {#if loading}
        <LoadingSpinner />
      {/if}
    </div>

    {#if moments}
      <div class="space-y-3 text-sm">
        {#if moments.state === VideoMomentIndexState.None}
          <p class="text-xs text-gray-500 dark:text-gray-400">{$t('frameleaf_moments_none')}</p>
        {:else if moments.staleReason}
          <p class="text-xs text-amber-700 dark:text-amber-300" role="status">
            {$t(staleReasonKey[moments.staleReason])}
          </p>
        {/if}

        {#if moments.frames.length > 0}
          <ol class="moments-frames" aria-label={$t('frameleaf_moments_frames')}>
            {#each [...moments.frames].sort((a, b) => a.rank - b.rank) as frame (frame.id)}
              <li>
                <button
                  type="button"
                  class="frame"
                  class:cover={frame.isCover}
                  onclick={() => seek(frame.timestampMs)}
                  aria-label={$t('frameleaf_moments_play_from', {
                    values: { time: formatMomentTime(frame.timestampMs) },
                  })}
                >
                  <img src={frameUrl(frame.id)} alt="" loading="lazy" />
                  <span class="time">{formatMomentTime(frame.timestampMs)}</span>
                  {#if frame.rank === 1}
                    <span class="best">{$t('frameleaf_moments_best')}</span>
                  {/if}
                </button>
                {#if isOwner}
                  <button
                    type="button"
                    class="cover-toggle"
                    aria-pressed={frame.isCover}
                    disabled={busy !== null}
                    onclick={() => chooseCover(frame.timestampMs)}
                  >
                    {frame.isCover ? $t('frameleaf_moments_cover') : $t('frameleaf_moments_use_as_cover')}
                  </button>
                {/if}
                {#if frame.indexed}
                  <button
                    type="button"
                    class="similar-toggle"
                    aria-pressed={similar?.frameId === frame.id}
                    aria-label={$t('frameleaf_moments_find_similar_at', {
                      values: { time: formatMomentTime(frame.timestampMs) },
                    })}
                    onclick={() => findSimilar(frame)}
                  >
                    {$t('frameleaf_moments_find_similar')}
                  </button>
                {/if}
              </li>
            {/each}
          </ol>
          {#if similar}
            {@const search = similar}
            <div class="similar" data-testid="frameleaf-similar-moments">
              <VideoMomentHits
                hits={search.hits ?? []}
                title={$t('frameleaf_moments_similar_title', {
                  values: { time: formatMomentTime(search.timestampMs) },
                })}
                onopen={openSimilar}
              >
                {#snippet actions()}
                  <IconButton label={$t('close')} onclick={() => (similar = null)}>
                    <Icon icon={mdiClose} size="1rem" />
                  </IconButton>
                {/snippet}
                {#if search.hits === null}
                  <p class="text-xs text-gray-500 dark:text-gray-400" role="status">
                    {$t('frameleaf_moments_similar_loading')}
                  </p>
                {:else if search.failed}
                  <p class="text-xs text-red-600 dark:text-red-400" role="alert">
                    {$t('frameleaf_moments_similar_error')}
                  </p>
                  <button
                    type="button"
                    class="similar-toggle"
                    onclick={() => findSimilar({ id: search.frameId, timestampMs: search.timestampMs })}
                  >
                    {$t('retry')}
                  </button>
                {:else}
                  <p class="text-xs text-gray-500 dark:text-gray-400" role="status">
                    {$t('frameleaf_moments_similar_none')}
                  </p>
                {/if}
              </VideoMomentHits>
            </div>
          {/if}
          {#if isOwner && moments.coverTimestampMs !== null}
            <Button
              size="small"
              color="secondary"
              variant="ghost"
              leadingIcon={mdiImageCheckOutline}
              onclick={() => chooseCover(null)}
              disabled={busy !== null}
            >
              {$t('frameleaf_moments_cover_reset')}
            </Button>
          {/if}
          {#if cover}
            <p class="sr-only">
              {$t('frameleaf_moments_cover_at', { values: { time: formatMomentTime(cover.timestampMs) } })}
            </p>
          {/if}
        {/if}

        {#if moments.moments.length > 0}
          <ul class="space-y-2" aria-label={$t('frameleaf_moments_list')}>
            {#each moments.moments as moment (moment.id)}
              <li class="rounded-md border border-gray-200 p-2 dark:border-gray-700">
                <div class="flex items-start gap-2">
                  <button
                    type="button"
                    class="shrink-0 font-mono text-xs text-immich-primary underline dark:text-immich-dark-primary"
                    onclick={() => seek(moment.timestampMs)}
                    aria-label={$t('frameleaf_moments_play_from', {
                      values: { time: formatMomentTime(moment.timestampMs) },
                    })}
                  >
                    {formatMomentTime(moment.timestampMs)}
                  </button>
                  <div class="min-w-0 flex-1">
                    <p class="wrap-break-word">
                      {moment.caption ?? $t(untitledKey(moment))}
                    </p>
                    {#if moment.transcript}
                      <p class="mt-1 text-xs wrap-break-word whitespace-pre-line text-gray-600 dark:text-gray-300">
                        {moment.transcript}
                      </p>
                    {/if}
                    <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
                      {$t(sourceKey(moment))}
                      {#if moment.staleReason}
                        ·
                        <span class="text-amber-700 dark:text-amber-300">
                          {$t(staleReasonKey[moment.staleReason])}
                        </span>
                      {/if}
                    </p>
                  </div>
                  {#if isOwner && moment.source === VideoMomentSource.Manual}
                    <div class="flex shrink-0 gap-1">
                      <Button
                        size="small"
                        color="secondary"
                        variant="ghost"
                        onclick={() => startEdit(moment)}
                        disabled={busy !== null}
                      >
                        {$t('edit')}
                      </Button>
                      <Button
                        size="small"
                        color="danger"
                        variant="ghost"
                        onclick={() => remove(moment)}
                        loading={busy === moment.id}
                        disabled={busy !== null && busy !== moment.id}
                      >
                        {$t('remove')}
                      </Button>
                    </div>
                  {/if}
                </div>
              </li>
            {/each}
          </ul>
        {/if}

        {#if isOwner && editing}
          <form
            class="space-y-2 rounded-md border border-gray-200 p-3 dark:border-gray-700"
            onsubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <label class="block text-xs">
              <span class="text-gray-500 dark:text-gray-400">{$t('frameleaf_moments_time')}</span>
              <input
                class="mt-1 w-full rounded-sm border border-gray-300 bg-transparent px-2 py-1 font-mono dark:border-gray-600"
                bind:value={editing.time}
                placeholder="0:42"
                inputmode="numeric"
                required
                aria-invalid={editError ? 'true' : undefined}
              />
            </label>
            <label class="block text-xs">
              <span class="text-gray-500 dark:text-gray-400">{$t('frameleaf_moments_caption')}</span>
              <input
                class="mt-1 w-full rounded-sm border border-gray-300 bg-transparent px-2 py-1 dark:border-gray-600"
                bind:value={editing.caption}
                maxlength="500"
              />
            </label>
            <label class="block text-xs">
              <span class="text-gray-500 dark:text-gray-400">{$t('frameleaf_moments_transcript')}</span>
              <textarea
                class="mt-1 w-full rounded-sm border border-gray-300 bg-transparent px-2 py-1 dark:border-gray-600"
                rows="3"
                bind:value={editing.transcript}
                maxlength="20000"></textarea>
              <span class="text-gray-500 dark:text-gray-400">{$t('frameleaf_moments_transcript_help')}</span>
            </label>
            {#if editError}
              <p class="text-xs text-red-600 dark:text-red-400" role="alert">{editError}</p>
            {/if}
            <div class="flex justify-end gap-2">
              <Button size="small" color="secondary" variant="ghost" onclick={() => (editing = null)}>
                {$t('cancel')}
              </Button>
              <Button size="small" type="submit" loading={busy === 'save'} disabled={busy !== null}>
                {$t('save')}
              </Button>
            </div>
          </form>
        {/if}

        {#if isOwner}
          <div class="flex flex-wrap gap-2">
            {#if !editing}
              <Button
                size="small"
                color="secondary"
                variant="ghost"
                leadingIcon={mdiPlus}
                onclick={startAdd}
                disabled={busy !== null}
              >
                {$t('frameleaf_moments_add')}
              </Button>
            {/if}
            <Button
              size="small"
              color="secondary"
              variant="ghost"
              leadingIcon={mdiRefresh}
              loading={busy === 'refresh'}
              disabled={busy !== null || (plan !== null && isPlanActive(plan.operation.status))}
              onclick={refresh}
            >
              {$t(
                moments.state === VideoMomentIndexState.Ready ? 'frameleaf_moments_refresh' : 'frameleaf_moments_find',
              )}
            </Button>
            <Button
              size="small"
              color="secondary"
              variant="ghost"
              leadingIcon={mdiTextBoxPlusOutline}
              loading={busy === 'captions'}
              disabled={busy !== null || (plan !== null && isPlanActive(plan.operation.status))}
              onclick={addCaptions}
            >
              {$t('frameleaf_moments_add_captions')}
            </Button>
          </div>
          <p class="text-xs text-gray-500 dark:text-gray-400">
            {$t('frameleaf_moments_captions_cost', { values: { count: captionRequestCount(1, framesPerVideo) } })}
          </p>
        {/if}

        {#if plan}
          <p class="text-xs text-gray-600 dark:text-gray-300" role="status" aria-live="polite">
            {isPlanActive(plan.operation.status)
              ? $t('frameleaf_moments_plan_running')
              : plan.counts.failed > 0
                ? $t('frameleaf_moments_plan_failed')
                : $t('frameleaf_moments_plan_done')}
          </p>
        {/if}

        {#if moments.indexedAt || moments.captionedAt || moments.framesExtractedAt}
          <p class="text-xs text-gray-500 dark:text-gray-400">
            {#if moments.framesExtractedAt}
              {$t('frameleaf_moments_frames_cut', { values: { date: formatDate(moments.framesExtractedAt) } })}
            {/if}
            {#if moments.embeddingModel && moments.indexedAt}
              · {$t('frameleaf_moments_indexed_with', {
                values: { model: moments.embeddingModel, date: formatDate(moments.indexedAt) },
              })}
            {/if}
            {#if moments.captionModel && moments.captionedAt}
              · {$t('frameleaf_moments_captioned_with', {
                values: { model: moments.captionModel, date: formatDate(moments.captionedAt) },
              })}
            {/if}
          </p>
        {/if}
      </div>
    {/if}
  </section>
{/if}

<style>
  .moments-frames {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0.5rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .moments-frames li {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .frame {
    position: relative;
    display: block;
    width: 100%;
    aspect-ratio: 16 / 9;
    overflow: hidden;
    border: 2px solid transparent;
    border-radius: 6px;
    background: rgb(0 0 0 / 20%);
  }
  .frame.cover {
    border-color: var(--fl-accent, #3fb68b);
  }
  .frame:focus-visible {
    outline: 2px solid var(--fl-accent, #3fb68b);
    outline-offset: 2px;
  }
  .frame img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .time,
  .best {
    position: absolute;
    bottom: 0.25rem;
    padding: 0 0.25rem;
    font-size: 11px;
    line-height: 1.4;
    color: #fff;
    background: rgb(0 0 0 / 60%);
    border-radius: 4px;
  }
  .time {
    left: 0.25rem;
  }
  .best {
    right: 0.25rem;
  }
  .cover-toggle {
    font-size: 11px;
    text-align: start;
    opacity: 0.8;
  }
  .cover-toggle[aria-pressed='true'] {
    font-weight: 600;
    opacity: 1;
  }
  .similar-toggle {
    font-size: 11px;
    text-align: start;
    opacity: 0.8;
  }
  .similar-toggle[aria-pressed='true'] {
    font-weight: 600;
    opacity: 1;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
</style>
