<script lang="ts">
  /**
   * The information panel's enrichment card (FL-36).
   *
   * Ported from `EnrichmentCard` in `design/frameleaf/template/src/MediaViewer.jsx`: one row
   * for the generated description with accept, clear and rerun, and one for the sensitivity
   * score with its review state and the mark, accept and rerun actions.
   *
   * Everything runs over endpoints that already exist. The description rows use
   * `updateAssetImageEnrichment` except for **Accept**, which writes the suggested text onto
   * the asset with the same `updateAsset` change endpoint the description editor uses — there
   * is no separate "accept description" action server side, and inventing a local mutation
   * would put the panel out of step with the stored description.
   *
   * Marking is metadata: `mark-nsfw` and `mark-safe` set the sensitive flag and never
   * relocate the asset. When marking hides the asset from the current session (the elevated
   * Locked session is closed), the refetch fails and `onAssetSuppressed` takes the viewer off
   * the asset instead of leaving a stale frame on screen.
   *
   * September 24 AI provenance (MediaViewer.jsx:2608-2743, media-viewer.css:1080-1210): a grouped
   * list under the indigo sparkle. The description row says who wrote it — "Written by AI" with the
   * model and, only when the server reported one, its confidence, or "Written by you" — and the
   * sensitive-content row says how the check was made: by AI (and which model), how likely it
   * judged the item to be sensitive, and whether a person has reviewed it.
   *
   * Failures are classified by `classifyInlineEditError` and shown in place with the only
   * recovery that can work: retry for a request that never reached a verdict, reload for an
   * asset that changed underneath the panel, and neither for a rejected value or a permission
   * the signed-in user does not have.
   */
  import ViewerInlineEditError from '$lib/components/frameleaf/ViewerInlineEditError.svelte';
  import { staleReasonKey } from '$lib/frameleaf/enrichment';
  import { descriptionReview, sensitivityReview, type DescriptionReview } from '$lib/frameleaf/info-panel';
  import { classifyInlineEditError, type InlineEditFailure } from '$lib/frameleaf/inline-edit';
  import { handlePromiseError } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import {
    AssetImageEnrichmentAction,
    AssetTypeEnum,
    getAssetImageEnrichment,
    getAssetInfo,
    isHttpError,
    updateAsset,
    updateAssetImageEnrichment,
    type AssetImageEnrichmentResponseDto,
    type AssetResponseDto,
  } from '@frameleaf/sdk';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { Icon, LoadingSpinner, toastManager } from '@frameleaf/ui';
  import {
    mdiClose,
    mdiPencilOutline,
    mdiRefresh,
    mdiShieldAlertOutline,
    mdiShieldCheckOutline,
    mdiShimmer,
    mdiTagRemove,
  } from '@mdi/js';
  import { onDestroy, untrack, type Snippet } from 'svelte';
  import { t } from 'svelte-i18n';

  interface Props {
    asset: AssetResponseDto;
    isOwner: boolean;
    onAssetRefresh?: (asset: AssetResponseDto) => void;
    onAssetSuppressed?: (asset: AssetResponseDto) => void | Promise<void>;
    /**
     * Reports the description's provenance to the panel so the editor above can show the
     * Manual/Generated badge without fetching the enrichment a second time.
     */
    onDescriptionReview?: (review: DescriptionReview | null) => void;
    /**
     * FL-707 item 13: the description editor, drawn here so the description's AI evidence (passed
     * in, undefined when there is none) sits beneath it, before the sensitive-content band.
     */
    descriptionEditor?: Snippet<[Snippet | undefined]>;
  }

  let { asset, isOwner, onAssetRefresh, onAssetSuppressed, onDescriptionReview, descriptionEditor }: Props = $props();

  let enrichment = $state<AssetImageEnrichmentResponseDto>();
  let isLoading = $state(false);
  /** The enrichment action in flight, or `accept-description` / `clear-description` for an asset write. */
  let activeAction = $state<AssetImageEnrichmentAction | 'accept-description' | 'clear-description' | null>(null);
  /** The last failure and the work that produced it, so the right recovery can be offered. */
  let failure = $state<{ kind: InlineEditFailure; run: () => Promise<void> } | null>(null);
  let canReview = $derived(isOwner && asset.type === AssetTypeEnum.Image);
  // Track the in-flight enrichment fetch so we can abort it when the user
  // swipes to a new asset before the previous request resolved.
  let enrichmentController: AbortController | undefined;

  const description = $derived(descriptionReview(asset, enrichment));
  const sensitivity = $derived(sensitivityReview(enrichment));
  /** The sensitive-content band: while the check loads, and once there is a result to show. */
  const showSensitivity = $derived(canReview && (isLoading || (!!enrichment && !!sensitivity)));

  const loadEnrichment = async (assetId: string) => {
    // Cancel any previous in-flight enrichment request — when the user
    // rapidly swipes through assets, the previous fetch should be aborted
    // rather than allowed to run to completion and consume bandwidth.
    enrichmentController?.abort();
    const controller = new AbortController();
    enrichmentController = controller;
    // Another item's review must never show against this one while its own loads.
    if (enrichment?.assetId !== assetId) {
      enrichment = undefined;
      failure = null;
    }
    isLoading = true;
    try {
      const result = await getAssetImageEnrichment({ id: assetId }, { signal: controller.signal });
      if (asset.id === assetId && !controller.signal.aborted) {
        enrichment = result;
        failure = null;
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        handleError(error, $t('errors.unable_to_load_image_enrichment'));
      }
    } finally {
      if (asset.id === assetId && enrichmentController === controller) {
        isLoading = false;
        enrichmentController = undefined;
      }
    }
  };

  const refreshAsset = async () => {
    const updatedAsset = await getAssetInfo({ id: asset.id });
    onAssetRefresh?.(updatedAsset);
  };

  const getHttpStatus = (error: unknown) => (isHttpError(error) ? (error.status ?? error.data?.statusCode) : undefined);

  const handleExpectedSuppressedAsset = async (action: AssetImageEnrichmentAction, error: unknown) => {
    if (!onAssetSuppressed || !enrichment?.nsfwDetection.effectiveIsNsfw) {
      return false;
    }

    if (
      action !== AssetImageEnrichmentAction.MarkNsfw &&
      action !== AssetImageEnrichmentAction.AcceptNsfwResult &&
      action !== AssetImageEnrichmentAction.RerunNsfwDetection
    ) {
      return false;
    }

    const status = getHttpStatus(error);
    if (status !== 400 && status !== 403 && status !== 404) {
      return false;
    }

    await onAssetSuppressed(asset);
    return true;
  };

  const refreshVisibleAsset = async (action: AssetImageEnrichmentAction) => {
    try {
      await refreshAsset();
    } catch (error) {
      if (await handleExpectedSuppressedAsset(action, error)) {
        return;
      }

      throw error;
    }
  };

  /**
   * Run one enrichment or accept action, remembering it so a retryable failure can replay
   * exactly the same work. `handleError` still reports the server's own message; the inline
   * notice states what the person can do about it.
   */
  const perform = async (
    key: AssetImageEnrichmentAction | 'accept-description' | 'clear-description',
    run: () => Promise<void>,
  ) => {
    // A result that lands after the viewer moved to another photo belongs to that earlier photo.
    const assetId = asset.id;
    activeAction = key;
    failure = null;
    try {
      await run();
      if (asset.id === assetId) {
        toastManager.primary($t('image_enrichment_updated'));
      }
    } catch (error) {
      if (asset.id !== assetId) {
        return;
      }
      failure = { kind: classifyInlineEditError(error), run: () => perform(key, run) };
      handleError(error, $t('errors.unable_to_update_image_enrichment'));
    } finally {
      activeAction = null;
    }
  };

  const runAction = (action: AssetImageEnrichmentAction) =>
    perform(action, async () => {
      const assetId = asset.id;
      const result = await updateAssetImageEnrichment({
        id: assetId,
        assetImageEnrichmentActionRequestDto: { action },
      });
      if (asset.id !== assetId) {
        return;
      }
      enrichment = result;

      const refreshActions: AssetImageEnrichmentAction[] = [
        AssetImageEnrichmentAction.ClearGeneratedDescription,
        AssetImageEnrichmentAction.ClearGeneratedTags,
        AssetImageEnrichmentAction.RerunNsfwDetection,
        AssetImageEnrichmentAction.MarkSafe,
        AssetImageEnrichmentAction.MarkNsfw,
        AssetImageEnrichmentAction.AcceptNsfwResult,
      ];
      if (refreshActions.includes(action)) {
        await refreshVisibleAsset(action);
      }
    });

  /** Accept the suggested description: the same change endpoint the editor writes through. */
  const acceptDescription = () => {
    const suggestion = description?.suggestion;
    if (!suggestion) {
      return;
    }

    return perform('accept-description', async () => {
      const assetId = asset.id;
      await updateAsset({ id: assetId, updateAssetDto: { description: suggestion } });
      if (asset.id === assetId) {
        await refreshAsset();
      }
    });
  };

  /**
   * Clear the description (the template's Clear, MediaViewer.jsx:2701-2710): a generated one the server
   * applied is undone through its enrichment action; one the owner wrote is cleared with the same
   * change endpoint the editor uses.
   */
  const clearDescription = () => {
    if (description?.canClear) {
      return runAction(AssetImageEnrichmentAction.ClearGeneratedDescription);
    }
    return perform('clear-description', async () => {
      const assetId = asset.id;
      await updateAsset({ id: assetId, updateAssetDto: { description: '' } });
      if (asset.id === assetId) {
        await refreshAsset();
      }
    });
  };

  /** A stale asset is reloaded, never rewritten: refetch both sides and drop the notice. */
  const reload = async () => {
    failure = null;
    await Promise.all([loadEnrichment(asset.id), refreshAsset().catch(() => undefined)]);
  };

  const stateLabel = $derived(
    sensitivity
      ? {
          missing: $t('frameleaf_info_sensitivity_missing'),
          'needs-review': $t('frameleaf_info_sensitivity_needs_review'),
          overridden: $t('frameleaf_info_sensitivity_overridden'),
          reviewed: $t('frameleaf_info_sensitivity_reviewed'),
        }[sensitivity.state]
      : '',
  );

  /** An AI-written description: generated, and still what is stored or waiting to be accepted. */
  const aiDescription = $derived(
    !!description &&
      (description.source === 'generated' || (description.source === 'none' && !!description.suggestion)),
  );

  /** Who wrote the description (MediaViewer.jsx:2670-2687). */
  const descriptionDetail = $derived.by(() => {
    if (!description) {
      return '';
    }
    if (aiDescription) {
      return [
        $t('frameleaf_info_written_by_ai'),
        description.modelName,
        description.confidencePercent === null
          ? null
          : $t('frameleaf_info_confidence', { values: { percent: description.confidencePercent } }),
      ]
        .filter(Boolean)
        .join(' · ');
    }
    // With no description the editor's placeholder already says so (FL-707 item 13: shown once).
    return description.source === 'manual' ? $t('frameleaf_info_written_by_you') : '';
  });

  /** How the sensitive-content check was made (MediaViewer.jsx:2729-2737). */
  const sensitivityDetail = $derived.by(() => {
    if (!sensitivity || !enrichment) {
      return '';
    }
    const review = enrichment.nsfwDetection.review;
    return [
      // One status (FL-707 item 13): the pill already says "Not checked", so nothing repeats it here.
      sensitivity.state === 'missing' && !review ? null : $t('frameleaf_info_checked_by_ai'),
      sensitivity.state === 'missing' ? null : enrichment.nsfwDetection.modelName,
      sensitivity.scorePercent === null
        ? null
        : $t('frameleaf_info_likely_sensitive', { values: { percent: sensitivity.scorePercent } }),
      review
        ? authManager.authenticated && review.reviewedBy === authManager.user.id
          ? $t('frameleaf_info_reviewed_by_you')
          : $t('frameleaf_info_reviewed_by_person')
        : null,
    ]
      .filter(Boolean)
      .join(' · ');
  });

  $effect(() => {
    if (canReview) {
      const assetId = asset.id;
      handlePromiseError(untrack(() => loadEnrichment(assetId)));
      return;
    }
    enrichmentController?.abort();
    enrichment = undefined;
  });

  $effect(() => {
    onDescriptionReview?.(description);
  });

  // Abort any in-flight enrichment fetch when the panel unmounts. Without
  // this, the request runs to completion (defeating the bandwidth-saving
  // intent of the AbortController) and writes back into a destroyed component.
  onDestroy(() => {
    enrichmentController?.abort();
    enrichmentController = undefined;
  });
</script>

<!--
  FL-707 item 13 (MediaViewer.jsx EnrichmentCard): the description is shown once, by the editor, with
  its AI evidence beneath it; the sensitive-content check is its own band with a single status.
-->
{#snippet failureNotice()}
  {#if failure}
    <ViewerInlineEditError
      failure={failure.kind}
      busy={activeAction !== null}
      onRetry={failure.kind === 'network' || failure.kind === 'unknown'
        ? () => handlePromiseError(failure!.run())
        : undefined}
      onReload={failure.kind === 'stale' ? () => handlePromiseError(reload()) : undefined}
    />
  {/if}
{/snippet}

{#snippet evidence()}
  {#if canReview && enrichment && description}
    <div class="fl-enrich-row fl-enrich-evidence" data-testid="frameleaf-enrichment-description">
      {#if descriptionDetail || description.suggestion}
        <span class={['fl-enrich-icon', aiDescription && 'ai']} aria-hidden="true">
          <Icon icon={aiDescription ? mdiShimmer : mdiPencilOutline} size="15" />
        </span>
      {/if}
      <div class="fl-enrich-text">
        {#if descriptionDetail}
          <span>{descriptionDetail}</span>
        {/if}
        {#if description.suggestion}
          <span class="fl-enrich-suggestion" data-testid="frameleaf-description-suggestion">
            {description.suggestion}
          </span>
        {/if}
        {#if description.error}
          <span class="fl-enrich-error">{description.error}</span>
        {/if}
        {#if enrichment.description.staleReason}
          <!-- FL-59: the generated text no longer matches its original, names or prompt. -->
          <span class="fl-enrich-stale" data-testid="frameleaf-description-stale">
            {$t(staleReasonKey[enrichment.description.staleReason])}
          </span>
        {/if}
      </div>
      <div class="fl-enrich-actions">
        {#if description.canAccept}
          <button
            type="button"
            disabled={activeAction !== null}
            aria-busy={activeAction === 'accept-description'}
            onclick={acceptDescription}
          >
            {$t('frameleaf_info_accept_description')}
          </button>
        {/if}
        <button
          type="button"
          class="fl-icon"
          aria-label={$t('frameleaf_info_rewrite_description')}
          title={$t('frameleaf_info_rewrite')}
          disabled={activeAction !== null}
          aria-busy={activeAction === AssetImageEnrichmentAction.RerunImageDescription}
          onclick={() => runAction(AssetImageEnrichmentAction.RerunImageDescription)}
        >
          <Icon icon={mdiRefresh} size="14" aria-hidden />
        </button>
        {#if enrichment.description.appliedTags || enrichment.nsfwDetection.appliedTags}
          <button
            type="button"
            class="fl-icon"
            aria-label={$t('clear_tags')}
            title={$t('clear_tags')}
            disabled={activeAction !== null}
            aria-busy={activeAction === AssetImageEnrichmentAction.ClearGeneratedTags}
            onclick={() => runAction(AssetImageEnrichmentAction.ClearGeneratedTags)}
          >
            <Icon icon={mdiTagRemove} size="14" aria-hidden />
          </button>
        {/if}
        {#if description.source !== 'none'}
          <button
            type="button"
            class="fl-icon"
            aria-label={$t('clear_description')}
            title={$t('clear')}
            disabled={activeAction !== null}
            aria-busy={activeAction === 'clear-description' ||
              activeAction === AssetImageEnrichmentAction.ClearGeneratedDescription}
            onclick={clearDescription}
          >
            <Icon icon={mdiClose} size="14" aria-hidden />
          </button>
        {/if}
      </div>
    </div>
  {/if}
  {#if canReview && !showSensitivity}
    {@render failureNotice()}
  {/if}
{/snippet}

{#if descriptionEditor}
  {@render descriptionEditor(evidence)}
{:else}
  <!-- Without an editor beside it (a spec, another host), the evidence stands on its own. -->
  {@render evidence()}
{/if}

{#if showSensitivity}
  <section
    class="fl-sensitivity"
    aria-label={$t('frameleaf_info_sensitive_content')}
    data-testid="frameleaf-enrichment-card"
  >
    <div class="fl-info-heading-row">
      <h3 class="fl-info-heading">{$t('frameleaf_info_sensitive_content')}</h3>
      {#if sensitivity}
        <em class={['fl-pill', sensitivity.tone]} data-testid="frameleaf-sensitivity-state">{stateLabel}</em>
      {:else if isLoading}
        <LoadingSpinner />
      {/if}
    </div>

    {#if enrichment && sensitivity}
      <div class="fl-enrich-row" data-testid="frameleaf-enrichment-sensitivity">
        {#if sensitivityDetail}
          <span class={['fl-enrich-icon', sensitivity.tone]} aria-hidden="true">
            <Icon
              icon={sensitivity.state === 'needs-review' ? mdiShieldAlertOutline : mdiShieldCheckOutline}
              size="15"
            />
          </span>
        {/if}
        <div class="fl-enrich-text">
          {#if sensitivityDetail}
            <span data-testid="frameleaf-sensitivity-detail">{sensitivityDetail}</span>
          {/if}
          {#if sensitivity.error}
            <span class="fl-enrich-error">{sensitivity.error}</span>
          {/if}
        </div>
        <div class="fl-enrich-actions">
          {#if sensitivity.state === 'needs-review'}
            <button
              type="button"
              disabled={activeAction !== null}
              aria-busy={activeAction === AssetImageEnrichmentAction.AcceptNsfwResult}
              onclick={() => runAction(AssetImageEnrichmentAction.AcceptNsfwResult)}
            >
              {$t('accept')}
            </button>
          {/if}
          <button
            type="button"
            disabled={activeAction !== null}
            aria-busy={activeAction === AssetImageEnrichmentAction.MarkSafe ||
              activeAction === AssetImageEnrichmentAction.MarkNsfw}
            onclick={() =>
              runAction(sensitivity.marked ? AssetImageEnrichmentAction.MarkSafe : AssetImageEnrichmentAction.MarkNsfw)}
          >
            {sensitivity.marked ? $t('frameleaf_info_unmark_sensitive') : $t('frameleaf_info_mark_sensitive')}
          </button>
          <button
            type="button"
            class="fl-icon"
            aria-label={$t('frameleaf_info_check_again')}
            title={$t('frameleaf_info_check_again_short')}
            disabled={activeAction !== null}
            aria-busy={activeAction === AssetImageEnrichmentAction.RerunNsfwDetection}
            onclick={() => runAction(AssetImageEnrichmentAction.RerunNsfwDetection)}
          >
            <Icon icon={mdiRefresh} size="14" aria-hidden />
          </button>
        </div>
      </div>
    {/if}
    {@render failureNotice()}
  </section>
{/if}

<style>
  /* FL-707 item 13 (review-1030-library.css): the evidence sits under the editor, the check is a band. */
  .fl-enrich-row.fl-enrich-evidence {
    min-height: 0;
    padding: var(--fl-space-2) 0 0;
  }

  /* The AI mark: a sparkle on the one reserved indigo. */
  .fl-enrich-icon {
    display: inline-grid;
    flex: none;
    place-items: center;
    color: var(--fl-viewer-text);
  }

  .fl-enrich-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    min-height: 44px;
    padding: 0;
  }

  .fl-enrich-icon {
    width: 28px;
    height: 28px;
    border-radius: 8px;
    background: color-mix(in srgb, var(--fl-viewer-text) 28%, transparent);
  }

  .fl-enrich-icon.ai {
    background: var(--fl-ai);
    color: var(--fl-ai-text);
  }

  .fl-enrich-icon.teal {
    background: var(--fl-teal);
    color: var(--fl-teal-text);
  }

  .fl-enrich-icon.warning {
    background: var(--fl-warning);
    color: var(--fl-warning-text);
  }

  .fl-enrich-icon.blue {
    background: var(--fl-blue);
    color: var(--fl-blue-text);
  }

  .fl-enrich-text {
    display: grid;
    flex: 1 1 150px;
    gap: 2px;
    min-width: 0;
  }

  .fl-enrich-text span {
    color: var(--fl-on-material-muted);
    font-size: 12px;
    line-height: 1.4;
    overflow-wrap: anywhere;
  }

  .fl-enrich-text .fl-enrich-suggestion {
    margin-top: 4px;
    padding: 6px 8px;
    border-radius: 8px;
    background: color-mix(in srgb, var(--fl-viewer-text) 6%, transparent);
    color: var(--fl-viewer-text);
  }

  .fl-enrich-text .fl-enrich-error {
    color: var(--fl-danger);
  }

  .fl-enrich-text .fl-enrich-stale {
    color: var(--fl-warning);
  }

  .fl-enrich-actions {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    gap: var(--fl-space-2);
    margin-inline-start: auto;
  }

  .fl-enrich-actions button {
    display: inline-grid;
    place-items: center;
    min-width: 30px;
    min-height: 30px;
    padding: 4px 12px;
    border: 0;
    border-radius: var(--fl-radius-pill);
    background: color-mix(in srgb, var(--fl-viewer-text) 10%, transparent);
    color: var(--fl-viewer-text);
    font: inherit;
    font-size: 11px;
    font-weight: 550;
    cursor: pointer;
    transition: background-color var(--fl-motion-fast) var(--fl-ease);
  }

  .fl-enrich-actions button.fl-icon {
    padding: 0;
  }

  .fl-enrich-actions button:hover:not(:disabled) {
    background: color-mix(in srgb, var(--fl-viewer-text) 18%, transparent);
  }

  .fl-enrich-actions button:disabled {
    cursor: default;
    opacity: 0.55;
  }

  .fl-enrich-actions button:focus-visible {
    outline: 2px solid var(--fl-viewer-focus);
    outline-offset: var(--fl-focus-offset);
  }

  .fl-pill {
    display: inline-block;
    padding: 1px 8px;
    border-radius: 999px;
    font-size: 10px;
    font-style: normal;
    font-weight: 550;
    letter-spacing: 0.03em;
    text-transform: uppercase;
  }

  .fl-pill.teal {
    background: color-mix(in srgb, var(--fl-teal) 22%, transparent);
    color: color-mix(in srgb, var(--fl-teal) 45%, var(--fl-viewer-text));
  }

  .fl-pill.blue {
    background: color-mix(in srgb, var(--fl-blue) 22%, transparent);
    color: color-mix(in srgb, var(--fl-blue) 45%, var(--fl-viewer-text));
  }

  .fl-pill.warning {
    background: color-mix(in srgb, var(--fl-warning) 22%, transparent);
    color: color-mix(in srgb, var(--fl-warning) 45%, var(--fl-viewer-text));
  }

  .fl-pill.neutral {
    background: color-mix(in srgb, var(--fl-viewer-text) 10%, transparent);
    color: var(--fl-on-material-muted);
  }

  @media (max-width: 700px) {
    .fl-enrich-actions button {
      min-width: 44px;
      min-height: 44px;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .fl-enrich-actions button {
      transition: none;
    }
  }
</style>
