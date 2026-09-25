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
  import ToolButton from '$lib/components/frameleaf/Button.svelte';
  import BulkFormDialog from '$lib/components/frameleaf/BulkFormDialog.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import TileJobState from '$lib/components/frameleaf/TileJobState.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { BulkController } from '$lib/frameleaf/bulk-controller.svelte';
  import { durableBulkTracker } from '$lib/frameleaf/durable-bulk-tracker.svelte';
  import { getAssetMediaUrl, getAssetPlaybackUrl } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import { AssetMediaSize, getAssetInfo, LivePhotoMatchConfidence, type LivePhotoCandidateDto } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiPlayCircleOutline } from '@mdi/js';
  import { t, type Translations } from 'svelte-i18n';
  import type { UtilityData } from '$lib/frameleaf/utilities-load';
  type PageData = Extract<UtilityData, { tool: 'live-photos' }>;

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  const candidates = $state<LivePhotoCandidateDto[]>(data.candidates.candidates);
  /** Photo ids reported by the server for the last completed attempt on each pair, if it failed. */
  let failureReasons = $state(new Map<string, Translations>());
  /** Photo ids of a durable job this tab is following, so tiles keep their loader across polls. */
  let pendingPhotoIds = $state(new Set<string>());
  let linkedPhotoIds = $state(new Set<string>());
  let verifyingPhotoIds = $state(new Set<string>());

  let inspect = $state<LivePhotoCandidateDto | null>(null);
  let inspectOpen = $state(false);
  let review = $state<LivePhotoCandidateDto[] | null>(null);
  let reviewOpen = $state(false);

  const bulk = new BulkController({ dispatch: () => {} });

  let query = $state('');
  let account = $state('all');
  let show = $state('open');
  const ownerName = (candidate: LivePhotoCandidateDto) =>
    candidate.photo.ownerId === authManager.user.id
      ? authManager.user.name
      : (candidate.photo.owner?.name ?? $t('frameleaf_large_files_other_account'));
  const owners = $derived([...new Map(candidates.map((candidate) => [candidate.photo.ownerId, ownerName(candidate)]))]);
  const rows = $derived(
    candidates.filter(
      (candidate) =>
        (account === 'all' || candidate.photo.ownerId === account) &&
        (show === 'all' || !linkedPhotoIds.has(candidate.photo.id)) &&
        `${candidate.photo.originalFileName} ${candidate.video.originalFileName} ${ownerName(candidate)}`
          .toLowerCase()
          .includes(query.trim().toLowerCase()),
    ),
  );
  const pairKey = (candidate: LivePhotoCandidateDto) => `${candidate.photo.id}:${candidate.video.id}`;
  const canReview = (candidate: LivePhotoCandidateDto) =>
    candidate.photo.ownerId === authManager.user.id &&
    candidate.video.ownerId === authManager.user.id &&
    !linkedPhotoIds.has(candidate.photo.id) &&
    !pendingPhotoIds.has(candidate.photo.id) &&
    !verifyingPhotoIds.has(candidate.photo.id);
  const highConfidence = $derived(
    rows.filter((candidate) => candidate.confidence === LivePhotoMatchConfidence.High && canReview(candidate)),
  );

  const verifyLinked = async (photoId: string) => {
    verifyingPhotoIds = new Set(verifyingPhotoIds).add(photoId);
    try {
      const asset = await getAssetInfo({ ...authManager.params, id: photoId });
      if (
        candidates.some((candidate) => candidate.photo.id === photoId && candidate.video.id === asset.livePhotoVideoId)
      ) {
        linkedPhotoIds = new Set(linkedPhotoIds).add(photoId);
      }
    } catch {
      failureReasons = new Map(failureReasons).set(photoId, 'frameleaf_bulk_reason_failed');
    } finally {
      const next = new Set(verifyingPhotoIds);
      next.delete(photoId);
      verifyingPhotoIds = next;
    }
  };

  // Reconcile a durable job's answers into the page's own state: a pair that settled successfully
  // leaves Needs attention but remains in All results; failures keep their tile and reason. This
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
        // A cleared marker can also mean cancellation; read the saved link before marking Linked.
        settled.push(photoId);
        void verifyLinked(photoId);
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
    pairs = pairs.filter((candidate) => canReview(candidate));
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
      linkedPhotoIds = new Set([...linkedPhotoIds, ...result.succeeded]);
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

<div class="live-photos-tool">
  <div class="scope-controls">
    <label
      >{$t('account')}<select bind:value={account}>
        <option value="all">{$t('frameleaf_large_files_all_accounts')}</option>
        {#each owners as [id, name] (id)}<option value={id}>{name}</option>{/each}
      </select></label
    >
    <label
      >{$t('frameleaf_utilities_find_items')}<input
        type="search"
        bind:value={query}
        placeholder={$t('filename')}
      /></label
    >
    <label
      >{$t('frameleaf_large_files_show')}<select bind:value={show}>
        <option value="open">{$t('frameleaf_large_files_show_open')}</option>
        <option value="all">{$t('frameleaf_large_files_show_all')}</option>
      </select></label
    >
  </div>
  <div class="toolbar">
    <span>{$t('frameleaf_utilities_candidate_pairs', { values: { count: rows.length } })}</span>
    <ToolButton
      variant="primary"
      disabled={bulk.busy || highConfidence.length === 0}
      onclick={() => openReview(highConfidence)}>{$t('frameleaf_utilities_link_pairs')}</ToolButton
    >
  </div>
  <div class="pairs">
    {#each rows as candidate (pairKey(candidate))}
      {@const pending = pendingPhotoIds.has(candidate.photo.id) || verifyingPhotoIds.has(candidate.photo.id)}
      {@const linked = linkedPhotoIds.has(candidate.photo.id)}
      {@const failure = failureReasons.get(candidate.photo.id)}
      <article>
        <div class="pair-images">
          <img
            src={getAssetMediaUrl({ id: candidate.photo.id, size: AssetMediaSize.Preview })}
            alt={candidate.photo.originalFileName}
          />
          <span
            ><img
              src={getAssetMediaUrl({ id: candidate.video.id, size: AssetMediaSize.Preview })}
              alt={candidate.video.originalFileName}
            /><Icon icon={mdiPlayCircleOutline} size="1.5rem" aria-hidden={true} /></span
          >
          {#if pending}<TileJobState job={{ state: 'pending' }} label={$t('frameleaf_bulk_tile_processing')} />{/if}
        </div>
        <div class="evidence">
          <strong>{candidate.photo.originalFileName}</strong>
          <small>{candidate.video.originalFileName} · {ownerName(candidate)}</small>
          <p>{candidate.matchReason}</p>
          <span class="badge" class:warning={candidate.confidence === LivePhotoMatchConfidence.Low}
            >{$t(
              candidate.confidence === LivePhotoMatchConfidence.High
                ? 'live_photos_confidence_high'
                : 'live_photos_confidence_low',
            )}</span
          >
          {#if linked}<span class="badge">{$t('frameleaf_live_photos_linked')}</span>{/if}
          {#if failure}<p role="alert">{$t('frameleaf_bulk_tile_failed', { values: { reason: $t(failure) } })}</p>{/if}
        </div>
        <div class="actions">
          <ToolButton
            disabled={pending}
            onclick={() => {
              inspect = candidate;
              inspectOpen = true;
            }}>{$t('live_photos_inspect_button')}</ToolButton
          >
          <ToolButton disabled={!canReview(candidate) || bulk.busy} onclick={() => openReview([candidate])}
            >{$t('live_photos_review_pair')}</ToolButton
          >
        </div>
      </article>
    {/each}
  </div>
  {#if !data.candidates.suggestionsEnabled}
    <!-- Library care → "Suggest Live Photo relinking" is off (FL-69): nothing was looked for. -->
    <p class="empty" role="status">{$t('library_care_live_photos_off')}</p>
  {:else if rows.length === 0}<p class="empty">{$t('live_photos_no_candidates')}</p>{/if}
</div>

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
      <ToolButton onclick={() => (inspectOpen = false)}>{$t('done')}</ToolButton>
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
  .scope-controls {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    margin-bottom: 1rem;
  }
  .scope-controls label {
    display: flex;
    flex-direction: column;
    gap: 0.4375rem;
    color: var(--fl-muted);
    font-size: 0.6875rem;
  }
  .scope-controls input,
  .scope-controls select {
    min-height: 2.125rem;
    padding: 0.5rem 0.625rem;
    border: 1px solid var(--fl-border);
    border-radius: 0.1875rem;
    background: var(--fl-canvas);
    color: var(--fl-text);
  }
  .scope-controls input:focus-visible,
  .scope-controls select:focus-visible {
    outline: 2px solid var(--fl-accent);
  }

  .toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    margin-bottom: 1rem;
    color: var(--fl-muted);
    font-size: 0.75rem;
  }
  .pairs {
    display: grid;
    gap: 0.75rem;
  }
  article {
    display: flex;
    align-items: center;
    gap: 1.25rem;
    border: 1px solid var(--fl-border);
    background: var(--fl-panel);
    padding: 1.25rem;
    border-radius: 0.25rem;
  }
  .evidence {
    flex: 1;
    min-width: 0;
  }
  .evidence strong {
    display: block;
    font-size: 0.8125rem;
    font-weight: 500;
    overflow-wrap: anywhere;
  }
  .evidence small,
  .evidence p {
    display: block;
    color: var(--fl-muted);
    font-size: 0.6875rem;
    margin-top: 0.375rem;
    overflow-wrap: anywhere;
  }
  .pair-images {
    display: flex;
    gap: 0.375rem;
    position: relative;
  }
  .pair-images img {
    width: 5.625rem;
    height: 5.625rem;
    object-fit: cover;
    border-radius: 0.125rem;
  }
  .pair-images > span {
    position: relative;
  }
  .pair-images :global(svg) {
    position: absolute;
    inset: 50% auto auto 50%;
    transform: translate(-50%, -50%);
    color: white;
  }
  .badge {
    display: inline-block;
    margin-top: 0.375rem;
    padding: 0.1875rem 0.4375rem;
    color: var(--fl-accent);
    background: color-mix(in srgb, var(--fl-accent) 10%, transparent);
    border-radius: 0.1875rem;
    font-size: 0.625rem;
  }
  .badge.warning {
    color: var(--fl-warning);
  }
  .actions {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
    font-size: 0.6875rem;
  }
  .empty {
    padding: 2.8125rem 1.25rem;
    text-align: center;
    color: var(--fl-muted);
  }
  @media (max-width: 68.75rem) {
    article {
      flex-wrap: wrap;
    }
    .pair-images img {
      width: 4.375rem;
      height: 4.375rem;
    }
  }
  @media (max-width: 43.75rem) {
    article {
      padding: 0.9375rem;
      gap: 0.75rem;
    }
    .toolbar {
      flex-wrap: wrap;
    }
  }

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
