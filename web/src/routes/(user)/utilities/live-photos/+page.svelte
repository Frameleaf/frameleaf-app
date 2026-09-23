<script lang="ts">
  /**
   * Live Photo candidate review (FL-70).
   *
   * Ported from the September 22, 2026 prototype's `UtilitiesManager` "live-photos" tool
   * (`design/frameleaf/template/src/UtilitiesManager.jsx`): a candidate list with a playable
   * evidence inspector, a fixed-set review dialog before anything is applied, and a batch action
   * for every high-confidence pair. Small selections relink immediately; a selection above the
   * durable threshold (`BulkController`, FL-32) is queued as a `media_operation` bulk job with the
   * standard retry-once and per-tile processing loader, so a large batch survives the tab closing.
   * Either way, a pair the server refuses — already changed, deleted, claimed by another pair —
   * is reported and stays in the list rather than silently disappearing.
   */
  import BulkFormDialog from '$lib/components/frameleaf/BulkFormDialog.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import TileJobState from '$lib/components/frameleaf/TileJobState.svelte';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import { BulkController } from '$lib/frameleaf/bulk-controller.svelte';
  import { durableBulkTracker } from '$lib/frameleaf/durable-bulk-tracker.svelte';
  import { getAssetMediaUrl, getAssetPlaybackUrl } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import { AssetMediaSize, LivePhotoMatchConfidence, type LivePhotoCandidateDto } from '@immich/sdk';
  import { Button, Icon, Text } from '@immich/ui';
  import { mdiInformationOutline, mdiMotionPlayOutline, mdiPlayCircleOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  let candidates = $state<LivePhotoCandidateDto[]>(data.candidates.candidates);
  /** Photo ids reported by the server for the last completed attempt on each pair, if it failed. */
  let failureReasons = $state(new Map<string, string>());
  /** Photo ids of a durable job this tab is following, so tiles keep their loader across polls. */
  let pendingPhotoIds = $state(new Set<string>());

  let inspect = $state<LivePhotoCandidateDto | null>(null);
  let inspectOpen = $state(false);
  let review = $state<LivePhotoCandidateDto[] | null>(null);
  let reviewOpen = $state(false);

  const bulk = new BulkController({ dispatch: () => {} });

  const pairKey = (candidate: LivePhotoCandidateDto) => `${candidate.photo.id}:${candidate.video.id}`;
  const highConfidence = $derived(
    candidates.filter((candidate) => candidate.confidence === LivePhotoMatchConfidence.High),
  );

  // Reconcile a durable job's answers into the page's own state: a pair that settled successfully
  // leaves the list, a refusal is reported and kept, and a pending pair keeps its tile loader. This
  // mirrors `DurableBulkTracker.apply`, scoped to this page's own candidates rather than a generic
  // asset grid, because a candidate pair is not a tile the tracker's `removesFromView` knows about.
  $effect(() => {
    if (pendingPhotoIds.size === 0) {
      return;
    }

    // Reading `stateOf` per id below (it reads the tracker's reactive `SvelteMap`) is what makes
    // this effect re-run as the tracker's poll answers for each id, the same way `AssetTile` reads
    // it for a library tile's own loader.
    const settled: string[] = [];
    for (const photoId of pendingPhotoIds) {
      const state = durableBulkTracker.stateOf(photoId);
      if (!state) {
        // No longer tracked: the job answered for it and it was not a failure, so it relinked.
        settled.push(photoId);
        candidates = candidates.filter((candidate) => candidate.photo.id !== photoId);
      } else if (state.state === 'failed') {
        settled.push(photoId);
        failureReasons = new Map(failureReasons).set(photoId, state.reasonKey);
      }
    }
    if (settled.length > 0) {
      const next = new Set(pendingPhotoIds);
      for (const id of settled) {
        next.delete(id);
      }
      pendingPhotoIds = next;
    }
  });

  const openReview = (pairs: LivePhotoCandidateDto[]) => {
    if (pairs.length === 0 || bulk.busy) {
      return;
    }
    review = pairs;
    reviewOpen = true;
  };

  const applyReview = async () => {
    const pairs = review;
    if (!pairs || pairs.length === 0) {
      return;
    }
    const photoIds = pairs.map((candidate) => candidate.photo.id);
    const cleared = new Map(failureReasons);
    for (const id of photoIds) {
      cleared.delete(id);
    }
    failureReasons = cleared;

    try {
      const result = await bulk.run('relink-live-photo', photoIds, {
        pairs: pairs.map(({ photo, video }) => ({ photoId: photo.id, videoId: video.id })),
      });
      if (result === null) {
        // Handed to the server as a durable job; the effect above follows it from here.
        pendingPhotoIds = new Set([...pendingPhotoIds, ...photoIds]);
        return;
      }
      const succeeded = new Set(result.succeeded);
      candidates = candidates.filter((candidate) => !succeeded.has(candidate.photo.id));
      if (result.failed.length > 0) {
        const next = new Map(failureReasons);
        for (const outcome of result.failed) {
          next.set(outcome.id, outcome.reasonKey ?? 'frameleaf_bulk_reason_failed');
        }
        failureReasons = next;
      }
    } catch (error) {
      handleError(error, $t('errors.something_went_wrong'));
    }
  };
</script>

<UserPageLayout title={data.meta.title}>
  <div class="m-auto mt-5 flex w-full max-w-4xl flex-col gap-4 px-2">
    <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <div class="flex flex-col gap-1">
        <Text size="large" fontWeight="bold">{$t('relink_live_photos')}</Text>
        <Text size="small" color="muted">{$t('relink_live_photos_description')}</Text>
      </div>

      {#if highConfidence.length > 0}
        <Button size="small" loading={bulk.busy} onclick={() => openReview(highConfidence)}>
          <Icon icon={mdiMotionPlayOutline} size="20" />
          {$t('live_photos_relink_all', { values: { count: highConfidence.length } })}
        </Button>
      {/if}
    </div>

    {#if candidates.length === 0}
      <div class="rounded-3xl border border-gray-300 p-8 text-center dark:border-immich-dark-gray">
        <Text color="muted">{$t('live_photos_no_candidates')}</Text>
      </div>
    {:else}
      <div class="flex flex-col gap-3">
        {#each candidates as candidate (pairKey(candidate))}
          {@const isHigh = candidate.confidence === LivePhotoMatchConfidence.High}
          {@const pending = pendingPhotoIds.has(candidate.photo.id)}
          {@const failure = failureReasons.get(candidate.photo.id)}
          <div class="flex items-center gap-4 rounded-2xl border border-gray-300 p-3 dark:border-immich-dark-gray">
            <div class="relative flex shrink-0 gap-2">
              <img
                src={getAssetMediaUrl({ id: candidate.photo.id, size: AssetMediaSize.Preview })}
                alt={candidate.photo.originalFileName}
                class="size-20 rounded-lg object-cover"
                draggable="false"
              />
              <div class="relative">
                <img
                  src={getAssetMediaUrl({ id: candidate.video.id, size: AssetMediaSize.Preview })}
                  alt={candidate.video.originalFileName}
                  class="size-20 rounded-lg object-cover"
                  draggable="false"
                />
                <div class="absolute inset-0 flex items-center justify-center">
                  <Icon icon={mdiPlayCircleOutline} size="28" class="text-white drop-shadow-sm" />
                </div>
              </div>
              {#if pending}
                <div class="absolute top-1 right-1">
                  <TileJobState job={{ state: 'pending' }} label={$t('frameleaf_bulk_tile_processing')} />
                </div>
              {/if}
            </div>

            <div class="flex min-w-0 flex-1 flex-col gap-1">
              <Text size="small" class="truncate" title={candidate.photo.originalFileName}>
                {candidate.photo.originalFileName}
              </Text>
              <Text size="small" color="muted" class="truncate" title={candidate.video.originalFileName}>
                {candidate.video.originalFileName}
              </Text>
              <span
                class="mt-1 w-fit rounded-full px-2 py-0.5 text-xs {isHigh
                  ? 'bg-success/15 text-success'
                  : 'bg-warning/15 text-warning'}"
              >
                {isHigh ? $t('live_photos_confidence_high') : $t('live_photos_confidence_low')}
              </span>
              {#if failure}
                <Text size="small" color="danger">
                  {$t('frameleaf_bulk_tile_failed', { values: { reason: $t(failure) } })}
                </Text>
              {/if}
            </div>

            <div class="flex shrink-0 flex-col gap-2">
              <Button
                size="small"
                variant="outline"
                disabled={pending}
                onclick={() => {
                  inspect = candidate;
                  inspectOpen = true;
                }}
              >
                {$t('live_photos_inspect_button')}
              </Button>
              <Button
                size="small"
                variant={isHigh ? 'filled' : 'outline'}
                disabled={pending}
                loading={bulk.busy}
                onclick={() => openReview([candidate])}
              >
                {$t('live_photos_review_pair')}
              </Button>
            </div>
          </div>
        {/each}
      </div>

      {#if candidates.some((candidate) => candidate.confidence === LivePhotoMatchConfidence.Low)}
        <div class="flex items-start gap-2 px-1">
          <Icon icon={mdiInformationOutline} size="18" class="mt-0.5 shrink-0 text-warning" />
          <Text size="small" color="muted">{$t('live_photos_low_confidence_hint')}</Text>
        </div>
      {/if}
    {/if}
  </div>
</UserPageLayout>

{#if inspect}
  {@const candidate = inspect}
  <Dialog title={candidate.photo.originalFileName} closeLabel={$t('done')} bind:open={inspectOpen}>
    <div class="fl-live-photo-inspect">
      <figure>
        <img
          src={getAssetMediaUrl({ id: candidate.photo.id, size: AssetMediaSize.Preview })}
          alt={candidate.photo.originalFileName}
        />
        <figcaption>{$t('live_photos_inspect_still')}</figcaption>
      </figure>
      <figure>
        <!-- svelte-ignore a11y_media_has_caption -->
        <video
          controls
          playsinline
          disablepictureinpicture
          poster={getAssetMediaUrl({ id: candidate.video.id, size: AssetMediaSize.Preview })}
          src={getAssetPlaybackUrl({ id: candidate.video.id })}
        ></video>
        <figcaption>{$t('live_photos_inspect_motion')}</figcaption>
      </figure>
      <dl>
        <dt>{$t('live_photos_inspect_confidence')}</dt>
        <dd>
          {candidate.confidence === LivePhotoMatchConfidence.High
            ? $t('live_photos_confidence_high')
            : $t('live_photos_confidence_low')}
        </dd>
        <dt>{$t('live_photos_inspect_evidence')}</dt>
        <dd>{candidate.matchReason}</dd>
      </dl>
    </div>
    <footer class="fl-live-photo-inspect-footer">
      <Button size="small" onclick={() => (inspectOpen = false)}>{$t('done')}</Button>
    </footer>
  </Dialog>
{/if}

{#if review}
  {@const pairs = review}
  <BulkFormDialog
    title={$t('live_photos_review_title')}
    submitLabel={$t('live_photos_review_confirm', { values: { count: pairs.length } })}
    bind:open={reviewOpen}
    onSubmit={applyReview}
  >
    <p>{$t('live_photos_review_scope_note')}</p>
    <div class="fl-live-photo-review-rows">
      {#each pairs as candidate (pairKey(candidate))}
        <div class="fl-live-photo-review-row">
          <strong>{candidate.photo.originalFileName}</strong>
          <span>{candidate.video.originalFileName}</span>
          {#if candidate.confidence === LivePhotoMatchConfidence.Low}
            <small>{$t('live_photos_review_low_confidence_warning')}</small>
          {/if}
        </div>
      {/each}
    </div>
    <p>{$t('live_photos_review_note')}</p>
  </BulkFormDialog>
{/if}

<style>
  .fl-live-photo-inspect {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.75rem;
    margin-top: 0.75rem;
    min-width: min(32rem, 100%);
  }
  .fl-live-photo-inspect figure {
    margin: 0;
    display: grid;
    gap: 0.375rem;
  }
  .fl-live-photo-inspect img,
  .fl-live-photo-inspect video {
    width: 100%;
    aspect-ratio: 1;
    object-fit: cover;
    border-radius: var(--fl-radius);
    background: var(--fl-raised);
  }
  .fl-live-photo-inspect figcaption {
    font-size: 0.75rem;
    color: var(--fl-muted);
  }
  .fl-live-photo-inspect dl {
    grid-column: 1 / -1;
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.25rem 0.75rem;
    margin: 0;
    font-size: 0.875rem;
  }
  .fl-live-photo-inspect dt {
    color: var(--fl-muted);
  }
  .fl-live-photo-inspect dd {
    margin: 0;
    color: var(--fl-text);
  }
  .fl-live-photo-inspect-footer {
    display: flex;
    justify-content: flex-end;
    margin-top: 1rem;
  }
  .fl-live-photo-review-rows {
    display: grid;
    gap: 0.5rem;
    max-height: 14rem;
    overflow-y: auto;
  }
  .fl-live-photo-review-row {
    display: grid;
    gap: 0.125rem;
    padding: 0.5rem 0.625rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    font-size: 0.8125rem;
  }
  .fl-live-photo-review-row span {
    color: var(--fl-muted);
  }
  .fl-live-photo-review-row small {
    color: var(--fl-warning);
  }
</style>
