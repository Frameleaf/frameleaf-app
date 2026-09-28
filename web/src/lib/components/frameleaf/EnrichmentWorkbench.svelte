<script lang="ts">
  /**
   * Try an enrichment change (FL-59, `REC-101`).
   *
   * Ported from the design's "Try an enrichment change" workflow (`WorkflowDialog` with the
   * `description` workflow in `design/frameleaf/template/src/CommandCenter.jsx`, opened by
   * "Preview a description" on Intelligence → Descriptions & tags): Choose sample → Compare →
   * Scope, in a wide dialog with the design's stepper and facts list.
   *
   * - **Choose sample.** Up to six of your own photos or videos, the processing destination to
   *   run on (named, never chosen for you), and the model and prompt being edited on this page.
   * - **Compare.** The draft runs on each sample, one at a time, and writes nothing: the current
   *   description and the candidate side by side. "Existing descriptions are unchanged."
   * - **Scope.** The stages a plan would run on the samples — descriptions, the Locked-content
   *   check, reusable video frames, the moment index and, only if ticked, moment captions with the
   *   extra model requests they cost — and the destinations. A plan uses the saved settings.
   *
   * Queuing makes a durable plan; the dialog then follows it asset by asset (queued, running,
   * skipped, failed, completed, cancelled) with pause, cancel and retry. Closing the page does
   * not stop it, and reopening the dialog returns to it.
   */
  import Badge from '$lib/components/frameleaf/Badge.svelte';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import SegmentedControl from '$lib/components/frameleaf/SegmentedControl.svelte';
  import {
    captionRequestCount,
    destinationChoices,
    initialStages,
    isPlanActive,
    itemStateKey,
    itemStateTone,
    lastPlan,
    neededBy,
    newRequestKey,
    planPollDelay,
    planStatusKey,
    reasonKey,
    rememberPlan,
    stageHelpKey,
    stageLabelKey,
    toggleStage,
    ENRICHMENT_STAGE_ORDER,
    VIDEO_ONLY_STAGES,
  } from '$lib/frameleaf/enrichment';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { getAssetMediaUrl } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import {
    AssetMediaSize,
    AssetOrder,
    AssetTypeEnum,
    cancelMediaOperation,
    createEnrichmentPlan,
    EnrichmentPreviewStatus,
    EnrichmentStage,
    getEnrichmentOptions,
    getEnrichmentPlan,
    MediaOperationKind,
    MediaOperationStatus,
    pauseMediaOperation,
    previewEnrichment,
    resumeMediaOperation,
    retryMediaOperation,
    searchAssets,
    searchMediaOperations,
    type AdminConfigImageDescriptionDto,
    type AssetResponseDto,
    type EnrichmentDestinationOptionDto,
    type EnrichmentOptionsResponseDto,
    type EnrichmentPlanResponseDto,
    type EnrichmentPreviewResponseDto,
    type MediaOperationDto,
  } from '@immich/sdk';
  import { onDestroy, untrack } from 'svelte';
  import { locale, t, type Translations } from 'svelte-i18n';

  type Props = {
    open?: boolean;
    /** The description settings as edited on the page, saved or not. */
    draft: AdminConfigImageDescriptionDto;
    /** The saved description settings; a plan always runs with these. */
    saved: AdminConfigImageDescriptionDto;
  };

  let { open = $bindable(false), draft, saved }: Props = $props();

  const STEPS = [
    'frameleaf_enrichment_step_sample',
    'frameleaf_enrichment_step_compare',
    'frameleaf_enrichment_step_scope',
  ] as const;

  let step = $state(0);
  let options = $state<EnrichmentOptionsResponseDto | null>(null);
  let kind = $state<'image' | 'video'>('image');
  let candidates = $state<AssetResponseDto[]>([]);
  let loadingCandidates = $state(false);
  let selected = $state<string[]>([]);
  let destinationId = $state<string | null>(null);
  let searchDestinationId = $state<string | null>(null);
  let preview = $state<EnrichmentPreviewResponseDto | null>(null);
  let previewing = $state(false);
  let stages = $state<EnrichmentStage[]>([]);
  let plan = $state<EnrichmentPlanResponseDto | null>(null);
  let recentPlans = $state<MediaOperationDto[]>([]);
  let busy = $state(false);
  let pollTimer: ReturnType<typeof setTimeout> | undefined;

  /** Every asset chosen so far, whichever filter it was chosen under. */
  let chosen = $state<Record<string, AssetResponseDto>>({});

  const maxSamples = $derived(options?.maxSamples ?? 6);
  const draftDiffers = $derived(
    draft.modelName !== saved.modelName || JSON.stringify(draft.prompt) !== JSON.stringify(saved.prompt),
  );
  const enrichmentChoices = $derived(options ? destinationChoices(options.destinations, 'enrichment') : []);
  const searchChoices = $derived(options ? destinationChoices(options.destinations, 'search') : []);
  const chosenAssets = $derived(selected.map((id) => chosen[id]).filter(Boolean));
  const videoCount = $derived(chosenAssets.filter((asset) => asset.type === AssetTypeEnum.Video).length);
  const needsSearch = $derived(
    stages.includes(EnrichmentStage.MomentIndex) ||
      (stages.includes(EnrichmentStage.Description) && (options?.searchEnabled ?? false)),
  );
  const destinationName = (id: string | null) => options?.destinations.find((item) => item.id === id)?.name ?? '';
  const isCloud = (id: string | null) => options?.destinations.find((item) => item.id === id)?.cloud ?? false;
  const thumbnail = (id: string, cacheKey?: string | null) =>
    getAssetMediaUrl({ id, size: AssetMediaSize.Thumbnail, cacheKey });

  const formatDate = (value: string) =>
    new Date(value).toLocaleString($locale ?? undefined, { dateStyle: 'medium', timeStyle: 'short' });

  /* ---------------------------------------------------------------- */
  /* Loading                                                           */
  /* ---------------------------------------------------------------- */

  const loadOptions = async () => {
    try {
      options = await getEnrichmentOptions();
      destinationId ??= options.routes.enrichment;
      searchDestinationId ??= options.routes.search;
      if (stages.length === 0) {
        stages = initialStages(options.defaultStages, {
          description: options.descriptionEnabled,
          lockedCheck: options.lockedCheckEnabled,
          search: options.searchEnabled,
        });
      }
    } catch (error) {
      handleError(error, $t('frameleaf_enrichment_options_error'));
    }
  };

  const loadCandidates = async (type: 'image' | 'video') => {
    loadingCandidates = true;
    try {
      const { assets } = await searchAssets({
        metadataSearchDto: {
          size: 24,
          order: AssetOrder.Desc,
          type: type === 'video' ? AssetTypeEnum.Video : AssetTypeEnum.Image,
        },
      });
      if (kind === type) {
        candidates = assets.items;
      }
    } catch (error) {
      handleError(error, $t('frameleaf_enrichment_samples_error'));
    } finally {
      loadingCandidates = false;
    }
  };

  const loadRecentPlans = async () => {
    try {
      const { items } = await searchMediaOperations({ kind: MediaOperationKind.EnrichmentPlan, take: 5 });
      recentPlans = items;
    } catch {
      recentPlans = [];
    }
  };

  const stopPolling = () => {
    if (!pollTimer) {
      return;
    }

    clearTimeout(pollTimer);
    pollTimer = undefined;
  };

  /** Show a plan and keep reading it while it runs. The row is the truth; this only mirrors it. */
  const follow = (next: EnrichmentPlanResponseDto) => {
    plan = next;
    step = 2;
    rememberPlan(authManager.user.id, next.operation.id);
    stopPolling();
    const delay = planPollDelay(next.operation.status);
    if (delay === null) {
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

  const openPlan = async (id: string) => {
    try {
      follow(await getEnrichmentPlan({ id }));
    } catch (error) {
      rememberPlan(authManager.user.id, null);
      handleError(error, $t('frameleaf_enrichment_plan_error'));
    }
  };

  $effect(() => {
    if (!open) {
      stopPolling();
      return;
    }
    void loadOptions();
    void loadRecentPlans();
    const previous = lastPlan(authManager.user.id);
    // Reopening returns to the plan this browser last followed; the plan itself is the server's.
    if (previous && !untrack(() => plan)) {
      void openPlan(previous);
    }
  });

  $effect(() => {
    if (open) {
      void loadCandidates(kind);
    }
  });

  onDestroy(stopPolling);

  /* ---------------------------------------------------------------- */
  /* Actions                                                           */
  /* ---------------------------------------------------------------- */

  const toggleSample = (asset: AssetResponseDto) => {
    if (selected.includes(asset.id)) {
      selected = selected.filter((id) => id !== asset.id);
      return;
    }
    if (selected.length >= maxSamples) {
      return;
    }
    chosen = { ...chosen, [asset.id]: asset };
    selected = [...selected, asset.id];
  };

  const runPreview = async () => {
    if (selected.length === 0) {
      return;
    }
    previewing = true;
    try {
      preview = await previewEnrichment({
        enrichmentPreviewRequestDto: {
          assetIds: selected,
          ...(destinationId && { destinationId }),
          modelName: draft.modelName,
          fallbackModelName: draft.fallbackModelName,
          prompt: draft.prompt,
        },
      });
      step = 1;
    } catch (error) {
      handleError(error, $t('frameleaf_enrichment_preview_error'));
    } finally {
      previewing = false;
    }
  };

  const queuePlan = async () => {
    busy = true;
    try {
      follow(
        await createEnrichmentPlan({
          enrichmentPlanCreateDto: {
            assetIds: selected,
            stages,
            requestKey: newRequestKey(),
            ...(destinationId && destinationId !== options?.routes.enrichment && { destinationId }),
            ...(searchDestinationId && searchDestinationId !== options?.routes.search && { searchDestinationId }),
          },
        }),
      );
      void loadRecentPlans();
    } catch (error) {
      handleError(error, $t('frameleaf_enrichment_plan_error'));
    } finally {
      busy = false;
    }
  };

  const control = async (action: 'pause' | 'resume' | 'cancel' | 'retry') => {
    if (!plan) {
      return;
    }
    busy = true;
    const id = plan.operation.id;
    try {
      if (action === 'retry') {
        const retried = await retryMediaOperation({ id });
        follow(await getEnrichmentPlan({ id: retried.id }));
        void loadRecentPlans();
        return;
      }
      await (action === 'pause'
        ? pauseMediaOperation({ id })
        : action === 'resume'
          ? resumeMediaOperation({ id })
          : cancelMediaOperation({ id }));
      follow(await getEnrichmentPlan({ id }));
    } catch (error) {
      handleError(error, $t('frameleaf_enrichment_plan_error'));
    } finally {
      busy = false;
    }
  };

  const startOver = () => {
    stopPolling();
    rememberPlan(authManager.user.id, null);
    plan = null;
    preview = null;
    step = 0;
  };

  const back = () => {
    if (step === 0) {
      open = false;
    } else {
      step -= 1;
    }
  };

  /** The count badges of a plan; cancelled only appears once something was cancelled. */
  const planCounts = (current: EnrichmentPlanResponseDto) =>
    [
      { key: 'frameleaf_enrichment_count_completed', tone: 'teal', value: current.counts.completed },
      {
        key: 'frameleaf_enrichment_count_waiting',
        tone: 'blue',
        value: current.counts.running + current.counts.queued,
      },
      { key: 'frameleaf_enrichment_count_skipped', tone: 'neutral', value: current.counts.skipped },
      { key: 'frameleaf_enrichment_count_failed', tone: 'danger', value: current.counts.failed },
      { key: 'frameleaf_enrichment_count_cancelled', tone: 'warning', value: current.counts.cancelled },
    ].filter((count) => count.key !== 'frameleaf_enrichment_count_cancelled' || count.value > 0) as {
      key: Translations;
      tone: 'teal' | 'blue' | 'neutral' | 'danger' | 'warning';
      value: number;
    }[];

  /** A destination as the pickers show it: name, whether it is cloud, and whether it is routed. */
  const choiceLabel = (choice: EnrichmentDestinationOptionDto, routed: string | null | undefined) =>
    [
      choice.name,
      choice.cloud ? $t('frameleaf_enrichment_cloud') : null,
      choice.id === routed ? $t('frameleaf_enrichment_routed') : null,
    ]
      .filter(Boolean)
      .join(' · ');

  const canRetry = $derived(
    !!plan &&
      !isPlanActive(plan.operation.status) &&
      (plan.counts.failed > 0 || plan.counts.cancelled > 0 || plan.operation.status === MediaOperationStatus.Failed),
  );
</script>

<Dialog bind:open title={$t('frameleaf_enrichment_title')} closeLabel={$t('close')} wide>
  <div class="workbench">
    <ol class="stepper">
      {#each STEPS as key, index (key)}
        <li aria-current={step === index ? 'step' : undefined}>
          <span>{index + 1}</span>{$t(key)}
        </li>
      {/each}
    </ol>

    {#if plan}
      <!-- A queued plan, followed from its durable record. -->
      <section class="plan" aria-live="polite">
        <div class="plan-head">
          <p>
            <strong>{$t(planStatusKey[plan.operation.status])}</strong>
            · {$t('frameleaf_enrichment_plan_summary', {
              values: { count: plan.counts.total, date: formatDate(plan.operation.createdAt) },
            })}
          </p>
          <div class="counts">
            {#each planCounts(plan) as count (count.key)}
              <Badge tone={count.tone} value={count.value} label={$t(count.key, { values: { count: count.value } })} />
            {/each}
          </div>
        </div>
        <dl class="facts">
          <dt>{$t('frameleaf_enrichment_fact_stages')}</dt>
          <dd>{plan.stages.map((stage) => $t(stageLabelKey[stage])).join(', ')}</dd>
          <dt>{$t('frameleaf_enrichment_fact_destination')}</dt>
          <dd>
            {[plan.enrichmentDestination?.name, plan.searchDestination?.name].filter(Boolean).join(' · ') ||
              $t('frameleaf_enrichment_none')}
          </dd>
          <dt>{$t('frameleaf_enrichment_fact_model')}</dt>
          <dd>{plan.modelName}</dd>
        </dl>
        {#if plan.operation.pauseRequestedAt && plan.operation.status !== MediaOperationStatus.Paused}
          <p class="note">{$t('frameleaf_enrichment_plan_pausing')}</p>
        {/if}
        {#if plan.operation.autoRetries > 0 && isPlanActive(plan.operation.status)}
          <p class="note">{$t('frameleaf_enrichment_plan_retrying')}</p>
        {/if}
        {#if plan.hiddenCount > 0}
          <p class="note">{$t('frameleaf_enrichment_plan_hidden', { values: { count: plan.hiddenCount } })}</p>
        {/if}
        <ul class="items">
          {#each plan.items as item (item.assetId)}
            <li>
              <img src={thumbnail(item.assetId)} alt="" loading="lazy" />
              <div class="item-body">
                <p class="item-state">
                  <span class="tone {itemStateTone[item.state]}">{$t(itemStateKey[item.state])}</span>
                  {#if item.retryPending}
                    · {$t('frameleaf_enrichment_retry_pending')}
                  {/if}
                </p>
                <ul class="stages">
                  {#each item.stages as outcome (outcome.stage)}
                    {@const reason = reasonKey(outcome.reasonKey)}
                    <li class="tone {itemStateTone[outcome.state]}" title={outcome.message ?? undefined}>
                      {$t(stageLabelKey[outcome.stage])}: {$t(itemStateKey[outcome.state])}
                      {#if reason}<span class="reason"> — {$t(reason)}</span>{/if}
                    </li>
                  {/each}
                </ul>
              </div>
            </li>
          {/each}
        </ul>
      </section>
    {:else if step === 0}
      <p>{$t('frameleaf_enrichment_intro')}</p>
      {#if draftDiffers}
        <p class="note">{$t('frameleaf_enrichment_draft_note')}</p>
      {/if}
      <dl class="facts">
        <dt>{$t('frameleaf_enrichment_fact_model')}</dt>
        <dd>{draft.modelName}</dd>
        <dt><label for="enrichment-destination">{$t('frameleaf_enrichment_fact_destination')}</label></dt>
        <dd>
          <select id="enrichment-destination" bind:value={destinationId}>
            {#each enrichmentChoices as choice (choice.id)}
              <option value={choice.id}>
                {choiceLabel(choice, options?.routes.enrichment)}
              </option>
            {/each}
          </select>
          {#if isCloud(destinationId)}
            <p class="hint">{$t('frameleaf_enrichment_cloud_help')}</p>
          {/if}
          {#if enrichmentChoices.length === 0 && options}
            <p class="hint">{$t('frameleaf_enrichment_no_destination')}</p>
          {/if}
        </dd>
        <dt>{$t('frameleaf_enrichment_fact_sample')}</dt>
        <dd>
          {$t('frameleaf_enrichment_samples_chosen', { values: { count: selected.length, max: maxSamples } })}
        </dd>
      </dl>
      <SegmentedControl
        label={$t('frameleaf_enrichment_sample_kind')}
        options={[
          { value: 'image', label: $t('photos') },
          { value: 'video', label: $t('videos') },
        ]}
        value={kind}
        onChange={(next) => (kind = next === 'video' ? 'video' : 'image')}
      />
      {#if loadingCandidates && candidates.length === 0}
        <p class="note" role="status">{$t('frameleaf_enrichment_samples_loading')}</p>
      {:else if candidates.length === 0}
        <p class="note">{$t('frameleaf_enrichment_samples_empty')}</p>
      {:else}
        <ul class="samples" aria-label={$t('frameleaf_enrichment_fact_sample')}>
          {#each candidates as asset (asset.id)}
            <li>
              <button
                type="button"
                aria-pressed={selected.includes(asset.id)}
                disabled={!selected.includes(asset.id) && selected.length >= maxSamples}
                aria-label={asset.originalFileName}
                onclick={() => toggleSample(asset)}
              >
                <img src={thumbnail(asset.id, asset.thumbhash)} alt="" loading="lazy" />
              </button>
            </li>
          {/each}
        </ul>
      {/if}
      {#if recentPlans.length > 0}
        <details class="recent">
          <summary>{$t('frameleaf_enrichment_recent_plans')}</summary>
          <ul>
            {#each recentPlans as recent (recent.id)}
              <li>
                <span>{recent.label} · {formatDate(recent.createdAt)}</span>
                <Button variant="quiet" onclick={() => openPlan(recent.id)}>{$t('open')}</Button>
              </li>
            {/each}
          </ul>
        </details>
      {/if}
    {:else if step === 1 && preview}
      <p>
        {$t('frameleaf_enrichment_compare_intro', {
          values: { destination: preview.destinationName, model: preview.modelName },
        })}
      </p>
      {#if preview.cloud}
        <p class="note">{$t('frameleaf_enrichment_cloud_help')}</p>
      {/if}
      <ul class="compare">
        {#each preview.samples as sample (sample.assetId)}
          <li>
            <img class="sample-image" src={thumbnail(sample.assetId, chosen[sample.assetId]?.thumbhash)} alt="" />
            <dl class="facts">
              <dt>{$t('frameleaf_enrichment_fact_current')}</dt>
              <dd>{sample.current ?? $t('frameleaf_enrichment_none')}</dd>
              {#if sample.status === EnrichmentPreviewStatus.Success}
                <dt>{$t('frameleaf_enrichment_fact_candidate')}</dt>
                <dd>{sample.candidate}</dd>
                {#if sample.tags.length > 0}
                  <dt>{$t('tags')}</dt>
                  <dd>{sample.tags.join(', ')}</dd>
                {/if}
                {#if sample.frameCount > 0}
                  <dt>{$t('frameleaf_enrichment_fact_frames')}</dt>
                  <dd>{$t('frameleaf_enrichment_frames_seen', { values: { count: sample.frameCount } })}</dd>
                {/if}
                {#if sample.hallucinatedNames.length > 0}
                  <dt>{$t('frameleaf_enrichment_fact_names')}</dt>
                  <dd>
                    {$t('frameleaf_enrichment_names_removed', {
                      values: { names: sample.hallucinatedNames.join(', ') },
                    })}
                  </dd>
                {/if}
              {:else}
                <dt>{$t('frameleaf_enrichment_fact_candidate')}</dt>
                <dd class="error">
                  {sample.message ?? $t(reasonKey(sample.reasonKey) ?? 'frameleaf_enrichment_reason_other')}
                </dd>
              {/if}
              {#each sample.warnings as warning (warning)}
                <dt>{$t('frameleaf_enrichment_fact_warning')}</dt>
                <dd>{warning}</dd>
              {/each}
            </dl>
          </li>
        {/each}
      </ul>
      <p class="notice">{$t('frameleaf_enrichment_compare_done')}</p>
    {:else if step === 2}
      <p>{$t('frameleaf_enrichment_scope_intro')}</p>
      {#if draftDiffers}
        <p class="note">{$t('frameleaf_enrichment_scope_saved_note')}</p>
      {/if}
      <fieldset class="stage-list">
        <legend>{$t('frameleaf_enrichment_fact_stages')}</legend>
        {#each ENRICHMENT_STAGE_ORDER as stage (stage)}
          {@const required = neededBy(stages, stage)}
          <label>
            <input
              type="checkbox"
              checked={stages.includes(stage)}
              disabled={required.length > 0 || (VIDEO_ONLY_STAGES.has(stage) && videoCount === 0)}
              onchange={(event) => (stages = toggleStage(stages, stage, event.currentTarget.checked))}
            />
            <span>
              <strong>{$t(stageLabelKey[stage])}</strong>
              <small>{$t(stageHelpKey[stage])}</small>
              {#if required.length > 0}
                <small
                  >{$t('frameleaf_enrichment_needed_by', {
                    values: { stages: required.map((item) => $t(stageLabelKey[item])).join(', ') },
                  })}</small
                >
              {/if}
              {#if stage === EnrichmentStage.MomentCaptions}
                <small
                  >{$t('frameleaf_enrichment_captions_cost', {
                    values: { count: captionRequestCount(videoCount, options?.framesPerVideo ?? 6) },
                  })}</small
                >
              {/if}
              {#if VIDEO_ONLY_STAGES.has(stage) && videoCount === 0}
                <small>{$t('frameleaf_enrichment_videos_only')}</small>
              {/if}
            </span>
          </label>
        {/each}
      </fieldset>
      <dl class="facts">
        <dt>{$t('frameleaf_enrichment_fact_sample')}</dt>
        <dd>{$t('frameleaf_enrichment_scope_assets', { values: { count: selected.length } })}</dd>
        <dt>{$t('frameleaf_enrichment_fact_destination')}</dt>
        <dd>{destinationName(destinationId) || $t('frameleaf_enrichment_none')}</dd>
        {#if needsSearch}
          <dt>
            <label for="enrichment-search-destination">{$t('frameleaf_enrichment_fact_search_destination')}</label>
          </dt>
          <dd>
            <select id="enrichment-search-destination" bind:value={searchDestinationId}>
              {#each searchChoices as choice (choice.id)}
                <option value={choice.id}>
                  {choiceLabel(choice, options?.routes.search)}
                </option>
              {/each}
            </select>
          </dd>
        {/if}
        <dt>{$t('frameleaf_enrichment_fact_impact')}</dt>
        <dd>{$t('frameleaf_enrichment_impact')}</dd>
      </dl>
    {/if}

    <footer>
      {#if plan}
        <Button onclick={startOver}>{$t('frameleaf_enrichment_new')}</Button>
        {#if plan.operation.pausable && isPlanActive(plan.operation.status)}
          {#if plan.operation.status === MediaOperationStatus.Paused || plan.operation.pauseRequestedAt}
            <Button disabled={busy} onclick={() => control('resume')}>{$t('resume')}</Button>
          {:else if plan.operation.status !== MediaOperationStatus.Cancelling}
            <Button disabled={busy} onclick={() => control('pause')}>{$t('pause')}</Button>
          {/if}
        {/if}
        {#if isPlanActive(plan.operation.status) && plan.operation.status !== MediaOperationStatus.Cancelling}
          <Button disabled={busy} onclick={() => control('cancel')}>{$t('cancel')}</Button>
        {/if}
        {#if canRetry}
          <Button disabled={busy} onclick={() => control('retry')}>{$t('retry')}</Button>
        {/if}
        <Button variant="primary" onclick={() => (open = false)}>{$t('done')}</Button>
      {:else}
        <Button onclick={back}>{step === 0 ? $t('cancel') : $t('back')}</Button>
        {#if step === 0}
          <Button
            variant="primary"
            disabled={selected.length === 0 || previewing || !destinationId}
            onclick={runPreview}
          >
            {previewing ? $t('frameleaf_enrichment_previewing') : $t('frameleaf_enrichment_preview')}
          </Button>
        {:else if step === 1}
          <Button disabled={previewing} onclick={runPreview}>
            {previewing ? $t('frameleaf_enrichment_previewing') : $t('frameleaf_enrichment_preview_again')}
          </Button>
          <Button variant="primary" onclick={() => (step = 2)}>{$t('continue')}</Button>
        {:else}
          <Button variant="primary" disabled={busy || stages.length === 0 || selected.length === 0} onclick={queuePlan}>
            {$t('frameleaf_enrichment_queue')}
          </Button>
        {/if}
      {/if}
    </footer>
  </div>
</Dialog>

<style>
  .workbench {
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
    margin-top: 1rem;
    font-size: var(--fl-font-size);
  }
  .stepper {
    display: flex;
    flex-wrap: wrap;
    gap: 1.25rem;
    margin: 0 0 0.5rem;
    padding: 0;
    list-style: none;
  }
  .stepper li {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .stepper li > span {
    display: grid;
    place-items: center;
    width: 22px;
    height: 22px;
    font-size: var(--fl-font-micro);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: 50%;
  }
  .stepper li[aria-current] {
    color: var(--fl-text);
  }
  .stepper li[aria-current] > span {
    color: var(--fl-accent-text);
    background: var(--fl-accent);
    border-color: var(--fl-accent);
  }
  .facts {
    display: grid;
    grid-template-columns: minmax(7rem, 9rem) 1fr;
    gap: 0.625rem 1rem;
    margin: 0;
  }
  .facts dt {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .facts dd {
    margin: 0;
    font-size: var(--fl-font-small);
    line-height: 1.6;
    overflow-wrap: anywhere;
  }
  .facts .error {
    color: var(--fl-danger);
  }
  .note,
  .notice {
    margin: 0;
    padding: 0.625rem 0.875rem;
    font-size: var(--fl-font-small);
    line-height: 1.6;
    background: var(--fl-raised);
    border-left: 2px solid var(--fl-accent);
  }
  .note {
    border-left-color: var(--fl-warning);
  }
  .hint {
    margin: 0.25rem 0 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  select {
    max-width: 100%;
    padding: 0.375rem 0.5rem;
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .samples {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(5.5rem, 1fr));
    gap: 0.5rem;
    max-height: 16rem;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    list-style: none;
  }
  .samples button {
    display: block;
    width: 100%;
    aspect-ratio: 1;
    padding: 0;
    overflow: hidden;
    border: 2px solid transparent;
    border-radius: var(--fl-radius-control);
    background: var(--fl-raised);
  }
  .samples button[aria-pressed='true'] {
    border-color: var(--fl-accent);
  }
  .samples button:disabled {
    opacity: 0.4;
  }
  .samples img,
  .items img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .compare {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    max-height: 26rem;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    list-style: none;
  }
  .compare > li {
    display: grid;
    grid-template-columns: 12.5rem 1fr;
    gap: 1rem;
  }
  .sample-image {
    width: 12.5rem;
    max-height: 8.75rem;
    object-fit: cover;
    border-radius: 4px;
  }
  .stage-list {
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
    margin: 0;
    padding: 0;
    border: 0;
  }
  .stage-list legend {
    margin-bottom: 0.5rem;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .stage-list label {
    display: flex;
    align-items: flex-start;
    gap: 0.625rem;
  }
  .stage-list input {
    margin-top: 0.2rem;
    accent-color: var(--fl-accent);
  }
  .stage-list span {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }
  .stage-list small {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .plan-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .plan-head p {
    margin: 0;
  }
  .counts {
    display: flex;
    gap: 0.375rem;
  }
  .items {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    max-height: 24rem;
    margin: 0.75rem 0 0;
    padding: 0;
    overflow-y: auto;
    list-style: none;
  }
  .items > li {
    display: grid;
    grid-template-columns: 3.5rem 1fr;
    gap: 0.75rem;
    align-items: start;
  }
  .items > li > img {
    width: 3.5rem;
    height: 3.5rem;
    border-radius: 4px;
  }
  .item-state {
    margin: 0;
    font-size: var(--fl-font-small);
  }
  .stages {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 0.75rem;
    margin: 0.25rem 0 0;
    padding: 0;
    list-style: none;
    font-size: var(--fl-font-small);
  }
  .reason {
    color: var(--fl-muted);
  }
  .tone.teal {
    color: var(--fl-teal);
  }
  .tone.blue {
    color: var(--fl-blue);
  }
  .tone.danger {
    color: var(--fl-danger);
  }
  .tone.warning {
    color: var(--fl-warning);
  }
  .tone.neutral {
    color: var(--fl-muted);
  }
  .recent summary {
    cursor: pointer;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .recent ul {
    margin: 0.5rem 0 0;
    padding: 0;
    list-style: none;
  }
  .recent li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    font-size: var(--fl-font-small);
  }
  footer {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }
  @media (max-width: 640px) {
    .compare > li,
    .facts {
      grid-template-columns: 1fr;
    }
    .sample-image {
      width: 100%;
    }
  }
</style>
