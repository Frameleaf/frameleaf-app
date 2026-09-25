<script lang="ts">
  /**
   * A destination's restoration models (FL-114), read-only.
   *
   * Shows what the worker itself reports: each Faithful and Creative model, its state, every
   * reason it is unavailable and the throughput measured when it was qualified. Nothing here
   * can make a model available; that takes real qualification evidence on the worker. Asking
   * sends no media, so it is safe for a cloud destination without consent.
   */
  import Badge from '$lib/components/frameleaf/Badge.svelte';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import { mlWorkloadLabelKey } from '$lib/frameleaf/ml-destinations';
  import {
    gpuValues,
    measurementValues,
    modelProfileValues,
    restorationModeLabelKey,
    restorationModelStateLabelKey,
    restorationModelStateTone,
  } from '$lib/frameleaf/restoration-models';
  import { handleError } from '$lib/utils/handle-error';
  import {
    getMlDestinationRestorationModels,
    type MlDestinationResponseDto,
    type MlRestorationModelsResponseDto,
  } from '@immich/sdk';
  import { locale, t } from 'svelte-i18n';

  type Props = {
    destination: MlDestinationResponseDto | null;
    open?: boolean;
  };

  let { destination, open = $bindable(false) }: Props = $props();

  let report = $state<MlRestorationModelsResponseDto | null>(null);
  let loading = $state(false);

  const load = async (id: string) => {
    loading = true;
    report = null;
    try {
      const next = await getMlDestinationRestorationModels({ id });
      if (destination?.id === id) {
        report = next;
      }
    } catch (error) {
      handleError(error, $t('admin.frameleaf_restoration_models_error'));
    } finally {
      loading = false;
    }
  };

  $effect(() => {
    if (open && destination) {
      void load(destination.id);
    }
  });

  const formatDate = (value: string) =>
    new Date(value).toLocaleString($locale ?? undefined, { dateStyle: 'medium', timeStyle: 'short' });
</script>

<Dialog
  title={$t('admin.frameleaf_restoration_models_dialog_title', { values: { name: destination?.name ?? '' } })}
  closeLabel={$t('close')}
  bind:open
>
  <div class="body">
    <p class="muted">{$t('admin.frameleaf_restoration_models_intro')}</p>

    {#if loading}
      <p role="status">{$t('admin.frameleaf_restoration_models_loading')}</p>
    {:else if report && !report.reachable}
      <p role="alert">
        {$t('admin.frameleaf_restoration_models_unreachable', { values: { error: report.error ?? '' } })}
      </p>
    {:else if report}
      <p>
        {#if report.workloads.length > 0}
          {$t('admin.frameleaf_restoration_models_serves', {
            values: { workloads: report.workloads.map((workload) => $t(mlWorkloadLabelKey(workload))).join(', ') },
          })}
        {:else}
          {$t('admin.frameleaf_restoration_models_serves_none')}
        {/if}
        {#if report.checkedAt}
          <span class="muted">
            · {$t('admin.frameleaf_restoration_models_checked', { values: { date: formatDate(report.checkedAt) } })}
          </span>
        {/if}
      </p>

      <!-- FL-110: the GPU memory each model is admitted against, as the worker reports it. -->
      <section aria-labelledby="restoration-gpus">
        <h4 id="restoration-gpus">{$t('admin.frameleaf_restoration_models_gpus')}</h4>
        {#if report.gpus.length === 0}
          <p class="muted">{$t('admin.frameleaf_restoration_models_no_gpus')}</p>
        {:else}
          <ul class="reasons">
            {#each report.gpus as gpu, index (index)}
              <li>{$t('admin.frameleaf_restoration_models_gpu', { values: gpuValues(gpu) })}</li>
            {/each}
          </ul>
        {/if}
      </section>

      {#if report.configurationProblems.length > 0}
        <section aria-labelledby="restoration-configuration-problems">
          <h4 id="restoration-configuration-problems">
            {$t('admin.frameleaf_restoration_models_configuration_problems')}
          </h4>
          <ul class="reasons">
            {#each report.configurationProblems as problem (problem)}
              <li>{problem}</li>
            {/each}
          </ul>
        </section>
      {/if}

      {#if report.models.length === 0}
        <p class="muted">{$t('admin.frameleaf_restoration_models_empty')}</p>
      {:else}
        <ul class="models">
          {#each report.models as model (model.id)}
            <li class="model" aria-label={model.displayName}>
              <header>
                <strong>{model.displayName}</strong>
                <span class="muted">{$t(restorationModeLabelKey(model.mode))}</span>
                <Badge
                  value={$t(restorationModelStateLabelKey(model.state))}
                  label={$t('admin.frameleaf_restoration_models_state_label', {
                    values: { model: model.displayName, state: $t(restorationModelStateLabelKey(model.state)) },
                  })}
                  tone={restorationModelStateTone(model.state)}
                />
              </header>
              <p class="muted">
                {$t('admin.frameleaf_restoration_models_revision')} <code>{model.revision}</code>
              </p>
              <p class="muted">
                {$t('admin.frameleaf_restoration_models_profile', { values: modelProfileValues(model) })}
              </p>
              {#if model.reasons.length > 0}
                <p class="label">{$t('admin.frameleaf_restoration_models_reasons')}</p>
                <ul class="reasons">
                  {#each model.reasons as reason, index (index)}
                    <li>{reason}</li>
                  {/each}
                </ul>
              {/if}
              {#if model.measured.length > 0}
                <ul class="measurements">
                  {#each model.measured as measurement, index (index)}
                    <li>
                      {$t('admin.frameleaf_restoration_models_measured', { values: measurementValues(measurement) })}
                    </li>
                  {/each}
                </ul>
              {:else}
                <p class="muted">{$t('admin.frameleaf_restoration_models_no_measurements')}</p>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    {/if}

    <div class="actions">
      <Button onclick={() => (open = false)}>{$t('close')}</Button>
    </div>
  </div>
</Dialog>

<style>
  .body {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    max-width: 40rem;
    font-variant-numeric: tabular-nums;
  }
  .body p,
  .body h4 {
    margin: 0;
  }
  .body h4 {
    font-size: var(--fl-font-small);
  }
  .muted,
  .label {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .models,
  .reasons,
  .measurements {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }
  .reasons li,
  .measurements li {
    font-size: var(--fl-font-small);
    overflow-wrap: anywhere;
  }
  /* The models are one grouped list with hairline rows (the Sept 24 settings language). */
  .models {
    gap: 0;
    overflow: hidden;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  .model {
    padding: 0.75rem 0.875rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .model + .model {
    border-top: 1px solid var(--fl-border);
  }
  .model header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  code {
    font-size: var(--fl-font-small);
    color: var(--fl-text);
    overflow-wrap: anywhere;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
  }
</style>
