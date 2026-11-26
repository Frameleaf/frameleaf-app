<script lang="ts">
  /**
   * FL-955: "Repair or suggest colours" for a selection. It asks the server for an estimate, shows every place
   * in the processing order with its time or cost, and starts only on Start. Each photo becomes its own
   * background job and a new version; the originals are never changed. Frameleaf Cloud shows as not
   * available until it has a price for this work: no figure is ever made up here.
   */
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import { formatEstimateSeconds } from '$lib/frameleaf/restoration';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { Route } from '$lib/route';
  import { handleError } from '$lib/utils/handle-error';
  import {
    AssetRestorationBatchOperation,
    MlDestinationKind,
    restoreAssetsBatch,
    type AssetRestorationBatchDestinationDto,
    type AssetRestorationBatchResponseDto,
  } from '@frameleaf/sdk';
  import { locale, t } from 'svelte-i18n';

  let {
    assetIds,
    open = $bindable(true),
    onStarted,
  }: {
    assetIds: string[];
    open?: boolean;
    onStarted?: () => void;
  } = $props();

  let operation = $state<AssetRestorationBatchOperation>(AssetRestorationBatchOperation.Repair);
  let estimate = $state<AssetRestorationBatchResponseDto | null>(null);
  let destinationId = $state<string | null>(null);
  let loading = $state(true);
  let starting = $state(false);
  let started = $state<{ count: number; name: string } | null>(null);
  /** Hand-tinted prints are skipped unless this small option is ticked. */
  let includeHandTinted = $state(false);
  let request = 0;

  const destinations = $derived(estimate?.destinations ?? []);
  const anyAvailable = $derived(destinations.some((row) => row.available));
  const chosen = $derived(destinations.find((row) => row.id === destinationId) ?? null);
  const inColour = $derived(estimate?.skipped.filter(({ reason }) => reason === 'already-in-colour').length ?? 0);
  const tintedSkipped = $derived(estimate?.skipped.filter(({ reason }) => reason === 'hand-tinted').length ?? 0);
  const handTinted = $derived(estimate?.handTinted ?? 0);
  const otherSkipped = $derived((estimate?.skipped.length ?? 0) - inColour - tintedSkipped);
  const suggesting = $derived(operation === AssetRestorationBatchOperation.Colourise);
  const skipLine = $derived.by(() => {
    if (tintedSkipped > 0 && inColour > 0) {
      return $t('frameleaf_repair_batch_skip_both', { values: { tinted: tintedSkipped, colour: inColour } });
    }
    if (tintedSkipped > 0) {
      return $t('frameleaf_repair_batch_skip_tinted', { values: { count: tintedSkipped } });
    }
    return inColour > 0 ? $t('frameleaf_repair_batch_skip_colour', { values: { count: inColour } }) : '';
  });
  const canStart = $derived(
    !!estimate && !loading && !starting && !!destinationId && estimate.eligible > 0 && anyAvailable,
  );

  const load = async (next: AssetRestorationBatchOperation, include: boolean) => {
    const mine = ++request;
    loading = true;
    try {
      const answer = await restoreAssetsBatch({
        assetRestorationBatchRequestDto: {
          assetIds,
          operation: next,
          confirm: false,
          ...(next === AssetRestorationBatchOperation.Colourise && include && { allowHandTinted: true }),
        },
      });
      if (mine !== request) {
        return;
      }
      estimate = answer;
      const kept = answer.destinations.find((row) => row.id === destinationId && row.available);
      destinationId = kept?.id ?? answer.destinations.find((row) => row.available)?.id ?? null;
    } catch (error) {
      if (mine === request) {
        estimate = null;
        destinationId = null;
        handleError(error, $t('frameleaf_repair_batch_error'));
      }
    } finally {
      if (mine === request) {
        loading = false;
      }
    }
  };

  $effect(() => {
    void load(operation, includeHandTinted);
  });

  const start = async () => {
    if (!canStart || !estimate || !destinationId) {
      return;
    }
    starting = true;
    try {
      const result = await restoreAssetsBatch({
        assetRestorationBatchRequestDto: {
          assetIds,
          operation,
          confirm: true,
          destinationId,
          batchId: estimate.batchId,
          ...(suggesting && includeHandTinted && { allowHandTinted: true }),
          ...(chosen?.kind === MlDestinationKind.FrameleafCloud && {
            maxCostUsd: chosen.maxCostUsd ?? undefined,
            consentVersion: chosen.consentVersion ?? undefined,
            acknowledgeDataLeaves: true,
          }),
        },
      });
      const name = destinations.find((row) => row.id === destinationId)?.name ?? '';
      started = { count: result.eligible, name };
      onStarted?.();
    } catch (error) {
      handleError(error, $t('frameleaf_repair_batch_error'));
    } finally {
      starting = false;
    }
  };

  const placeName = (row: AssetRestorationBatchDestinationDto) => {
    if (row.kind === MlDestinationKind.Local) {
      return $t('frameleaf_repair_batch_this_server');
    }
    return row.kind === MlDestinationKind.FrameleafCloud ? $t('frameleaf_repair_batch_cloud') : row.name;
  };
  const placeHelp = (row: AssetRestorationBatchDestinationDto) => {
    if (row.kind === MlDestinationKind.FrameleafCloud) {
      return row.available ? $t('frameleaf_repair_batch_cloud_help') : $t('frameleaf_repair_batch_cloud_not_yet');
    }
    if (!row.available) {
      return $t('frameleaf_repair_batch_no_model');
    }
    return row.kind === MlDestinationKind.Local
      ? $t('frameleaf_repair_batch_this_server_help')
      : $t('frameleaf_repair_batch_computer_help');
  };
  const placeCost = (row: AssetRestorationBatchDestinationDto) => {
    if (!row.available) {
      return $t('frameleaf_repair_batch_unavailable');
    }
    if (row.kind === MlDestinationKind.FrameleafCloud) {
      return row.costUsd === null
        ? $t('frameleaf_repair_batch_unavailable')
        : $t('frameleaf_repair_batch_cost', { values: { cost: row.costUsd.toFixed(2) } });
    }
    const time = formatEstimateSeconds(row.estimateSeconds, $locale);
    return time ? $t('frameleaf_repair_batch_free_time', { values: { time } }) : $t('frameleaf_repair_batch_free');
  };
</script>

<Dialog
  bind:open
  title={$t('frameleaf_repair_batch_title', { values: { count: assetIds.length } })}
  closeLabel={$t('close')}
>
  {#if started}
    <p role="status">
      {operation === AssetRestorationBatchOperation.Repair
        ? $t('frameleaf_repair_batch_started_repair', { values: { count: started.count, name: started.name } })
        : $t('frameleaf_repair_batch_started_colourise', { values: { count: started.count, name: started.name } })}
    </p>
    <a class="activity" href={Route.activity()}>{$t('frameleaf_repair_batch_show_activity')}</a>
  {:else}
    <fieldset>
      <legend>{$t('frameleaf_repair_batch_what')}</legend>
      <div class="what">
        <label class:is-on={operation === AssetRestorationBatchOperation.Repair}>
          <input
            type="radio"
            name="batch-operation"
            value={AssetRestorationBatchOperation.Repair}
            bind:group={operation}
          />
          <span><b>{$t('frameleaf_repair_repair')}</b><small>{$t('frameleaf_repair_repair_help')}</small></span>
        </label>
        <label class:is-on={operation === AssetRestorationBatchOperation.Colourise}>
          <input
            type="radio"
            name="batch-operation"
            value={AssetRestorationBatchOperation.Colourise}
            bind:group={operation}
          />
          <span>
            <b>{$t('frameleaf_repair_colourise')}</b>
            <small>{$t('frameleaf_repair_colourise_help')}</small>
          </span>
        </label>
      </div>
    </fieldset>

    {#if suggesting && estimate && (skipLine || handTinted > 0)}
      <div class="summary" data-testid="batch-colour-summary">
        <p role="status">
          {skipLine}
          {$t('frameleaf_repair_batch_will_get', { values: { count: estimate.eligible } })}
        </p>
        {#if handTinted > 0}
          <label class="include">
            <input type="checkbox" bind:checked={includeHandTinted} />
            <span>
              {$t('frameleaf_repair_batch_include', { values: { count: handTinted } })}
              <small>{$t('frameleaf_repair_batch_include_help')}</small>
            </span>
          </label>
        {/if}
      </div>
    {/if}

    <fieldset>
      <legend>{$t('frameleaf_repair_batch_where')}</legend>
      {#if loading && !estimate}
        <p class="help" aria-busy="true">{$t('loading')}</p>
      {:else}
        <div class="where">
          {#each destinations as row (row.id)}
            <label class:is-on={destinationId === row.id} class:is-off={!row.available}>
              <input
                type="radio"
                name="batch-place"
                value={row.id}
                bind:group={destinationId}
                disabled={!row.available}
              />
              <span class="place"><b>{placeName(row)}</b><small>{placeHelp(row)}</small></span>
              <span class="cost">{placeCost(row)}</span>
            </label>
          {/each}
        </div>
      {/if}
    </fieldset>

    {#if estimate && !anyAvailable}
      <div class="notice" role="status" data-testid="batch-nowhere">
        <b>{$t('frameleaf_repair_batch_nowhere')}</b>
        {$t('frameleaf_repair_nowhere_body')}
        <a href={commandCenterUrl('processing', 'computers')}>{$t('frameleaf_repair_set_up_computer')}</a>
      </div>
    {/if}
    {#if chosen?.kind === MlDestinationKind.FrameleafCloud && chosen.consentSummary}
      <p class="help" data-testid="batch-cloud-consent">{chosen.consentSummary}</p>
    {/if}
    {#if otherSkipped > 0}
      <p class="help">{$t('frameleaf_repair_batch_skipped', { values: { count: otherSkipped } })}</p>
    {/if}
    <p class="help">{suggesting ? $t('frameleaf_repair_batch_note_colourise') : $t('frameleaf_repair_batch_note')}</p>
  {/if}

  {#snippet actions()}
    {#if started}
      <button type="button" class="fl-control button" onclick={() => (open = false)}>{$t('close')}</button>
    {:else}
      <button type="button" class="fl-control button" onclick={() => (open = false)}>{$t('cancel')}</button>
      <button type="button" class="fl-control button primary" disabled={!canStart} onclick={start}>
        {$t('frameleaf_repair_batch_start')}
      </button>
    {/if}
  {/snippet}
</Dialog>

<style>
  fieldset {
    margin: 0 0 var(--fl-space-4);
    padding: 0;
    border: 0;
  }
  legend {
    margin-block-end: var(--fl-space-2);
    color: var(--fl-muted);
    font-size: 0.8125rem;
  }
  .what {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
    gap: var(--fl-space-2);
  }
  .where {
    display: grid;
    gap: var(--fl-space-2);
  }
  label {
    display: flex;
    align-items: flex-start;
    gap: var(--fl-space-3);
    padding: var(--fl-space-3);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    cursor: pointer;
  }
  label.is-on {
    border-color: var(--fl-accent);
  }
  label.is-off {
    opacity: 0.6;
    cursor: default;
  }
  label span:not(.cost) {
    display: grid;
    gap: 2px;
  }
  .place {
    flex: 1;
  }
  small,
  .help {
    color: var(--fl-muted);
  }
  .cost {
    font-size: 0.8125rem;
    text-align: end;
  }
  .notice {
    display: grid;
    gap: var(--fl-space-1);
    margin-block-end: var(--fl-space-3);
    padding: var(--fl-space-3);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  .summary {
    display: grid;
    gap: var(--fl-space-2);
    margin-block-end: var(--fl-space-4);
    padding: var(--fl-space-3);
    border-radius: var(--fl-radius-card);
    border: 1px solid var(--fl-border);
  }
  .summary p {
    margin: 0;
  }
  label.include {
    padding: 0;
    border: 0;
    gap: var(--fl-space-2);
  }
  .activity {
    color: var(--fl-accent);
  }
</style>
