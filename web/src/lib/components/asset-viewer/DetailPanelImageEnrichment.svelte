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
   * Failures are classified by `classifyInlineEditError` and shown in place with the only
   * recovery that can work: retry for a request that never reached a verdict, reload for an
   * asset that changed underneath the panel, and neither for a rejected value or a permission
   * the signed-in user does not have.
   */
  import ViewerInlineEditError from '$lib/components/frameleaf/ViewerInlineEditError.svelte';
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
  } from '@immich/sdk';
  import { Badge, Button, LoadingSpinner, Text, toastManager } from '@immich/ui';
  import {
    mdiBroom,
    mdiCheckCircleOutline,
    mdiRefresh,
    mdiShieldAlert,
    mdiShieldCheck,
    mdiTagRemove,
  } from '@mdi/js';
  import { onDestroy } from 'svelte';
  import { t } from 'svelte-i18n';

  interface Props {
    asset: AssetResponseDto;
    isOwner: boolean;
    isAdmin: boolean;
    onAssetRefresh?: (asset: AssetResponseDto) => void;
    onAssetSuppressed?: (asset: AssetResponseDto) => void | Promise<void>;
    /**
     * Reports the description's provenance to the panel so the editor above can show the
     * Manual/Generated badge without fetching the enrichment a second time.
     */
    onDescriptionReview?: (review: DescriptionReview | null) => void;
  }

  let { asset, isOwner, isAdmin, onAssetRefresh, onAssetSuppressed, onDescriptionReview }: Props = $props();

  let enrichment = $state<AssetImageEnrichmentResponseDto>();
  let isLoading = $state(false);
  /** The enrichment action in flight, or `accept-description` for the asset write. */
  let activeAction = $state<AssetImageEnrichmentAction | 'accept-description' | null>(null);
  /** The last failure and the work that produced it, so the right recovery can be offered. */
  let failure = $state<{ kind: InlineEditFailure; run: () => Promise<void> } | null>(null);
  let canReview = $derived(isOwner && isAdmin && asset.type === AssetTypeEnum.Image);
  // Track the in-flight enrichment fetch so we can abort it when the user
  // swipes to a new asset before the previous request resolved.
  let enrichmentController: AbortController | undefined;

  const description = $derived(descriptionReview(asset, enrichment));
  const sensitivity = $derived(sensitivityReview(enrichment));

  const loadEnrichment = async (assetId: string) => {
    // Cancel any previous in-flight enrichment request — when the user
    // rapidly swipes through assets, the previous fetch should be aborted
    // rather than allowed to run to completion and consume bandwidth.
    enrichmentController?.abort();
    const controller = new AbortController();
    enrichmentController = controller;
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
  const perform = async (key: AssetImageEnrichmentAction | 'accept-description', run: () => Promise<void>) => {
    activeAction = key;
    failure = null;
    try {
      await run();
      toastManager.primary($t('image_enrichment_updated'));
    } catch (error) {
      failure = { kind: classifyInlineEditError(error), run: () => perform(key, run) };
      handleError(error, $t('errors.unable_to_update_image_enrichment'));
    } finally {
      activeAction = null;
    }
  };

  const runAction = (action: AssetImageEnrichmentAction) =>
    perform(action, async () => {
      enrichment = await updateAssetImageEnrichment({
        id: asset.id,
        assetImageEnrichmentActionRequestDto: { action },
      });

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
      await updateAsset({ id: asset.id, updateAssetDto: { description: suggestion } });
      await refreshAsset();
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

  const descriptionSourceLabel = $derived(
    description
      ? {
          manual: $t('frameleaf_info_description_manual'),
          generated: $t('frameleaf_info_description_generated'),
          none: $t('frameleaf_info_description_none'),
        }[description.source]
      : '',
  );

  $effect(() => {
    if (canReview) {
      handlePromiseError(loadEnrichment(asset.id));
    }
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

{#if canReview}
  <section class="mt-4 px-4" data-testid="frameleaf-enrichment-card">
    <div class="flex h-10 w-full items-center justify-between text-sm">
      <Text color="muted">{$t('frameleaf_info_enrichment')}</Text>
      {#if isLoading}
        <LoadingSpinner />
      {/if}
    </div>

    {#if enrichment}
      <div class="space-y-4 text-sm">
        {#if description}
          <div class="space-y-2 rounded-md border border-gray-200 p-3 dark:border-gray-700">
            <div class="flex items-start justify-between gap-2">
              <div class="min-w-0">
                <p class="font-medium">{$t('image_description')}</p>
                <p class="text-xs text-gray-500 dark:text-gray-400">
                  {[descriptionSourceLabel, description.modelName].filter(Boolean).join(' · ')}
                </p>
              </div>
              {#if description.source === 'generated'}
                <Badge size="small" shape="round" color="secondary">{$t('frameleaf_info_description_generated')}</Badge>
              {/if}
            </div>

            {#if description.suggestion}
              <p class="rounded bg-gray-100 p-2 text-xs break-words dark:bg-gray-800" data-testid="frameleaf-description-suggestion">
                {description.suggestion}
              </p>
            {/if}

            {#if description.error}
              <p class="text-xs text-red-600 dark:text-red-400">{description.error}</p>
            {/if}

            <div class="flex flex-wrap gap-2">
              {#if description.canAccept}
                <Button
                  size="small"
                  color="secondary"
                  variant="ghost"
                  leadingIcon={mdiCheckCircleOutline}
                  loading={activeAction === 'accept-description'}
                  onclick={acceptDescription}
                >
                  {$t('frameleaf_info_accept_description')}
                </Button>
              {/if}
              <Button
                size="small"
                color="secondary"
                variant="ghost"
                leadingIcon={mdiRefresh}
                loading={activeAction === AssetImageEnrichmentAction.RerunImageDescription}
                onclick={() => runAction(AssetImageEnrichmentAction.RerunImageDescription)}
              >
                {$t('rerun')}
              </Button>
              <Button
                size="small"
                color="secondary"
                variant="ghost"
                leadingIcon={mdiBroom}
                disabled={!description.canClear}
                loading={activeAction === AssetImageEnrichmentAction.ClearGeneratedDescription}
                onclick={() => runAction(AssetImageEnrichmentAction.ClearGeneratedDescription)}
              >
                {$t('clear_description')}
              </Button>
              <Button
                size="small"
                color="secondary"
                variant="ghost"
                leadingIcon={mdiTagRemove}
                disabled={!enrichment.description.appliedTags && !enrichment.nsfwDetection.appliedTags}
                loading={activeAction === AssetImageEnrichmentAction.ClearGeneratedTags}
                onclick={() => runAction(AssetImageEnrichmentAction.ClearGeneratedTags)}
              >
                {$t('clear_tags')}
              </Button>
            </div>
          </div>
        {/if}

        {#if sensitivity}
          <div class="space-y-2 rounded-md border border-gray-200 p-3 dark:border-gray-700">
            <div class="flex items-start justify-between gap-2">
              <div class="min-w-0">
                <p class="font-medium">{$t('frameleaf_info_sensitivity')}</p>
                <p class="text-xs text-gray-500 dark:text-gray-400" data-testid="frameleaf-sensitivity-state">
                  {[
                    sensitivity.scorePercent === null
                      ? null
                      : $t('frameleaf_info_sensitivity_score', { values: { score: sensitivity.scorePercent } }),
                    stateLabel,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              </div>
              <Badge size="small" shape="round" color={sensitivity.marked ? 'warning' : 'secondary'}>
                {sensitivity.marked ? $t('frameleaf_info_marked_sensitive') : $t('frameleaf_info_marked_safe')}
              </Badge>
            </div>

            {#if sensitivity.error}
              <p class="text-xs text-red-600 dark:text-red-400">{sensitivity.error}</p>
            {/if}

            {#if enrichment.nsfwDetection.labels}
              <div class="flex flex-wrap gap-1">
                {#each Object.entries(enrichment.nsfwDetection.labels).slice(0, 5) as [label, score] (label)}
                  <span class="rounded-full bg-gray-100 px-2 py-0.5 text-xs dark:bg-gray-700">
                    {label}
                    {Math.round(score * 100)}%
                  </span>
                {/each}
              </div>
            {/if}

            <div class="flex flex-wrap gap-2">
              <Button
                size="small"
                color="secondary"
                variant="ghost"
                leadingIcon={mdiRefresh}
                loading={activeAction === AssetImageEnrichmentAction.RerunNsfwDetection}
                onclick={() => runAction(AssetImageEnrichmentAction.RerunNsfwDetection)}
              >
                {$t('rerun')}
              </Button>
              <Button
                size="small"
                color="secondary"
                variant="ghost"
                leadingIcon={mdiCheckCircleOutline}
                disabled={sensitivity.state === 'missing'}
                loading={activeAction === AssetImageEnrichmentAction.AcceptNsfwResult}
                onclick={() => runAction(AssetImageEnrichmentAction.AcceptNsfwResult)}
              >
                {$t('accept')}
              </Button>
              {#if sensitivity.marked}
                <Button
                  size="small"
                  color="secondary"
                  variant="ghost"
                  leadingIcon={mdiShieldCheck}
                  loading={activeAction === AssetImageEnrichmentAction.MarkSafe}
                  onclick={() => runAction(AssetImageEnrichmentAction.MarkSafe)}
                >
                  {$t('frameleaf_info_unmark_sensitive')}
                </Button>
              {:else}
                <Button
                  size="small"
                  color="secondary"
                  variant="ghost"
                  leadingIcon={mdiShieldAlert}
                  loading={activeAction === AssetImageEnrichmentAction.MarkNsfw}
                  onclick={() => runAction(AssetImageEnrichmentAction.MarkNsfw)}
                >
                  {$t('frameleaf_info_mark_sensitive')}
                </Button>
              {/if}
            </div>
          </div>
        {/if}

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
      </div>
    {/if}
  </section>
{/if}
