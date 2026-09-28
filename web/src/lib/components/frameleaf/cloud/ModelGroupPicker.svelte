<script lang="ts">
  /**
   * The model slider for one model group (FL-186, FL-189; prototype WorkloadRouting.jsx
   * `DefaultModelSlider`, ModelSlider.jsx and gpu-models.css). One track, lightest first, banded by
   * where each model runs: white on this server's processor, green on its GPU (from the stored
   * Hardware & GPU check), blue on Frameleaf Cloud. Each stop has an icon and a text label, so colour
   * is never the only signal.
   *
   * The two sides keep their own model, and choosing on one side never changes the other; where a job
   * runs is still decided in Where each job runs:
   *
   * - A local stop writes the model setting of the work (descriptions:
   *   `machineLearning.imageDescription.modelName`) into the settings draft, saved with the settings
   *   bar like every other setting. The ML container downloads the model the first
   *   time a job uses it.
   * - A blue stop is a model from Frameleaf Cloud's catalogue for exactly this group, saved on its
   *   own at once, apart from the workload's route: every cloud job of the group names it whatever the
   *   route points at. With no model chosen, the model the catalogue recommends is used and marked;
   *   where it recommends none, and always for Studio AI, the picker asks for a choice, because those
   *   jobs are refused until one is made.
   *
   * Each side is a native radio group, so arrow keys move between its stops. The cloud side stays
   * enabled while a choice is saved, so focus never drops: it shows the latest choice at once, saves
   * it after a short pause, and saves only the latest one when several follow each other.
   */
  import './gpu-models.css';
  import { formatRatePerMinute, formatUsd } from '$lib/frameleaf/cloud-ml';
  import { cloudModelChoice, takesCatalogDefault } from '$lib/frameleaf/cloud-models';
  import type { LocalBand, LocalReason, LocalSide, LocalStop } from '$lib/frameleaf/local-models';
  import { handleError } from '$lib/utils/handle-error';
  import {
    setCloudMlModelChoice,
    type CloudMlModelChoiceDto,
    type CloudMlModelDto,
    type CloudMlModelGroup,
  } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import {
    mdiAlertOutline,
    mdiCancel,
    mdiChip,
    mdiCloudOutline,
    mdiExpansionCard,
    mdiInformationOutline,
    mdiStarOutline,
  } from '@mdi/js';
  import { onDestroy, tick } from 'svelte';
  import { t, type Translations } from 'svelte-i18n';

  type Props = {
    group: CloudMlModelGroup;
    /** The legend: "Model for …" in Where each job runs, the name of the work on the Models card. */
    legend: string;
    /** The name of the work, as Where each job runs shows it. */
    name: string;
    /** The catalogue models for exactly this group, lightest first; null when there is no cloud side. */
    models: CloudMlModelDto[] | null;
    /** Why the blue stops cannot be chosen (the work is set to Local only); empty when they can. */
    cloudReason?: string;
    /** The saved model, or null for the catalogue's recommendation. */
    modelId: string | null;
    /** This server's side, where the work has a local model setting. */
    local?: LocalSide | null;
    /** The work has no local model setting: say that its worker brings the model. */
    workerNote?: boolean;
    onSaved: (choices: CloudMlModelChoiceDto[], message: string) => void;
  };

  let {
    group,
    legend,
    name,
    models,
    cloudReason = '',
    modelId,
    local = null,
    workerNote = false,
    onSaved,
  }: Props = $props();

  /** How long the picker waits for the next choice before it saves. */
  const SAVE_DELAY_MS = 300;

  const id = $props.id();
  let saving = $state(false);
  /** The choice made in the picker and not saved yet; null when the picker shows the saved model. */
  let wanted = $state<{ id: string | null } | null>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;

  const cloudModels = $derived(models ?? []);
  const shownModelId = $derived(wanted ? wanted.id : modelId);
  const choice = $derived(cloudModelChoice(cloudModels, group, shownModelId));
  const selectedId = $derived(choice.kind === 'chosen' || choice.kind === 'default' ? choice.model.id : null);
  const recommended = $derived(takesCatalogDefault(group) ? cloudModels.find((model) => model.isDefault) : undefined);
  const cloudDisabled = $derived(cloudReason.length > 0);

  const localStops = $derived(local?.stops ?? []);
  const localSelected = $derived.by(() => {
    const value = local?.value;
    return localStops.find((stop) => stop.model.value === value) ?? null;
  });
  const stopCount = $derived(localStops.length + cloudModels.length);

  const BAND_ICONS: Record<LocalBand, string> = { cpu: mdiChip, gpu: mdiExpansionCard, none: mdiCancel };

  const localLabel = (stop: LocalStop) => {
    switch (stop.band) {
      case 'gpu': {
        return $t('admin.frameleaf_model_local_label_gpu', { values: { gb: stop.model.vramGb } });
      }
      case 'cpu': {
        return local?.hardware.known
          ? $t('admin.frameleaf_model_local_label_cpu')
          : $t('admin.frameleaf_model_local_label_unknown', { values: { gb: stop.model.vramGb } });
      }
      case 'none': {
        return $t('frameleaf_model_label_none');
      }
    }
  };

  const reasonText = (stop: LocalStop, reason: LocalReason) => {
    switch (reason.kind) {
      case 'memory': {
        return $t('frameleaf_model_reason_needs_memory', {
          values: { name: stop.model.name, needs: reason.needs, gpu: reason.gpu, has: reason.has },
        });
      }
      case 'memory-no-gpu': {
        return $t('frameleaf_model_reason_needs_memory_no_gpu', {
          values: { name: stop.model.name, needs: reason.needs },
        });
      }
      case 'cuda': {
        return $t('admin.frameleaf_model_local_reason_cuda', {
          values: { name: stop.model.name, gpu: reason.gpu, backend: reason.backend },
        });
      }
      case 'cloud-only': {
        return $t('admin.frameleaf_model_local_reason_cloud_only');
      }
    }
  };

  /** Why each stop that cannot be chosen is off, once each (the prototype's list under the key). */
  const reasons = $derived.by(() => {
    const texts: string[] = [];
    for (const stop of localStops) {
      if (stop.reason) {
        texts.push(reasonText(stop, stop.reason));
      }
    }
    if (cloudDisabled && cloudModels.length > 0) {
      texts.push(cloudReason);
    }
    return [...new Set(texts)];
  });

  const bandsPresent = $derived(new Set(localStops.map((stop) => stop.band)));

  const price = (model: CloudMlModelDto) => {
    if (model.priceUsd === null) {
      return $t('admin.frameleaf_cloud_model_price_unknown');
    }
    return model.pricingUnit === 'second'
      ? $t('admin.frameleaf_cloud_model_price_minute', { values: { rate: formatRatePerMinute(model.priceUsd) } })
      : $t('admin.frameleaf_cloud_model_price_unit', {
          values: { price: formatUsd(model.priceUsd), unit: model.pricingUnit ?? '' },
        });
  };

  const savedMessage = (next: string | null) => {
    const model = next ? cloudModels.find((entry) => entry.id === next) : undefined;
    return model
      ? $t('admin.frameleaf_cloud_model_saved', { values: { model: model.name, name } })
      : $t('admin.frameleaf_cloud_model_saved_default', { values: { name } });
  };

  /** Save the latest choice; one save at a time, and a choice made meanwhile is saved after it. */
  const flush = async () => {
    timer = undefined;
    if (saving || !wanted) {
      return;
    }
    const next = wanted.id;
    if (next === modelId) {
      wanted = null;
      return;
    }
    saving = true;
    try {
      const { choices } = await setCloudMlModelChoice({ group, cloudMlModelChoiceUpdateDto: { modelId: next } });
      onSaved(choices, savedMessage(next));
      if (wanted?.id === next) {
        wanted = null;
      }
    } catch (error) {
      // Only the choice that failed goes back to the saved model; a newer one made meanwhile is kept
      // and gets its own save next, so the latest choice is never lost to an earlier failure.
      if (wanted?.id === next) {
        wanted = null;
      }
      handleError(error, $t('admin.frameleaf_cloud_model_error_save', { values: { name } }));
    } finally {
      saving = false;
    }
    if (wanted) {
      void flush();
    }
  };

  const choose = (next: string | null) => {
    wanted = { id: next };
    clearTimeout(timer);
    timer = setTimeout(() => void flush(), SAVE_DELAY_MS);
  };

  let fieldset = $state<HTMLFieldSetElement>();

  /** Go back to the recommendation; focus moves to its radio, since the button goes away. */
  const useRecommended = async () => {
    if (!recommended) {
      return;
    }
    const target = recommended.id;
    choose(null);
    await tick();
    const radios =
      fieldset?.querySelectorAll<HTMLInputElement>(`:scope input[name="${CSS.escape(`${id}-cloud`)}"]`) ?? [];
    for (const radio of radios) {
      if (radio.value === target) {
        radio.focus();
        break;
      }
    }
  };

  onDestroy(() => {
    // A choice made just before the picker closes is still saved.
    if (timer === undefined) {
      return;
    }
    clearTimeout(timer);
    void flush();
  });
</script>

<fieldset class="ms" data-group={group} aria-busy={saving} bind:this={fieldset}>
  <legend class="ms-legend">{legend}</legend>
  {#if stopCount > 0}
    <div class="ms-track is-split">
      {#if local && localStops.length > 0}
        {@const side = local}
        <div
          class="ms-side"
          role="radiogroup"
          aria-label={$t('admin.frameleaf_model_local_for', { values: { name } })}
          style:--ms-count={localStops.length}
        >
          {#each localStops as stop (stop.model.value)}
            {@const checked = stop.model.value === side.value}
            {@const off = side.disabled || stop.reason !== null}
            <label
              class="ms-stop"
              class:is-cpu={stop.band === 'cpu'}
              class:is-gpu={stop.band === 'gpu'}
              class:is-none={stop.band === 'none'}
              class:is-selected={checked}
              class:is-disabled={off}
              title={stop.reason ? reasonText(stop, stop.reason) : `${stop.model.name} · ${localLabel(stop)}`}
            >
              <input
                type="radio"
                class="sr-only"
                name="{id}-local"
                value={stop.model.value}
                {checked}
                disabled={off}
                aria-describedby={stop.reason ? `${id}-reasons` : undefined}
                onchange={() => side.onChoose(stop.model.value)}
              />
              <span class="ms-band" aria-hidden="true"></span>
              <span class="ms-knob" aria-hidden="true"></span>
              <span class="ms-stop-name" aria-hidden="true">
                <Icon icon={BAND_ICONS[stop.band]} size="14" />
                <span>{stop.model.short}</span>
              </span>
              <span class="sr-only">
                {stop.model.name}: {localLabel(stop)}{stop.reason
                  ? `. ${$t('frameleaf_model_unavailable_prefix')} ${reasonText(stop, stop.reason)}`
                  : ''}
              </span>
            </label>
          {/each}
        </div>
      {/if}
      {#if cloudModels.length > 0}
        <div
          class="ms-side"
          role="radiogroup"
          aria-label={$t('admin.frameleaf_cloud_model_for', { values: { name } })}
          style:--ms-count={cloudModels.length}
        >
          {#each cloudModels as model (model.id)}
            {@const checked = model.id === selectedId}
            <label
              class="ms-stop is-cloud"
              class:is-selected={checked}
              class:is-disabled={cloudDisabled}
              title={cloudDisabled ? cloudReason : `${model.name} · ${price(model)}`}
            >
              <input
                type="radio"
                class="sr-only"
                name="{id}-cloud"
                value={model.id}
                {checked}
                disabled={cloudDisabled}
                aria-describedby={cloudDisabled ? `${id}-reasons` : undefined}
                onchange={() => choose(model.id)}
              />
              <span class="ms-band" aria-hidden="true"></span>
              <span class="ms-knob" aria-hidden="true"></span>
              <span class="ms-stop-name" aria-hidden="true">
                <Icon icon={model.id === recommended?.id ? mdiStarOutline : mdiCloudOutline} size="14" />
                <span>{model.name}</span>
              </span>
              <span class="sr-only">
                {model.name}: {price(model)}{model.id === recommended?.id
                  ? `. ${$t('admin.frameleaf_cloud_model_recommended')}`
                  : ''}
              </span>
            </label>
          {/each}
        </div>
      {/if}
    </div>
    <div class="ms-scale" aria-hidden="true">
      <span>{$t('frameleaf_model_scale_lighter')}</span>
      <span>{$t('frameleaf_model_scale_heavier')}</span>
    </div>
  {/if}

  {#if local}
    {#if localSelected}
      <p
        class="ms-readout"
        class:is-cpu={localSelected.band === 'cpu'}
        class:is-gpu={localSelected.band === 'gpu'}
        class:is-none={localSelected.band === 'none'}
        aria-live="polite"
      >
        <Icon icon={BAND_ICONS[localSelected.band]} size="16" aria-hidden={true} />
        <span>
          {$t('admin.frameleaf_model_local_side')} · <strong>{localSelected.model.name}</strong> · {localLabel(
            localSelected,
          )}
          <small>
            {$t(localSelected.model.noteKey as Translations)}
            {#if localSelected.reason && localSelected.reason.kind !== 'cloud-only'}
              {reasonText(localSelected, localSelected.reason)}
              {$t('admin.frameleaf_model_local_misfit')}
            {/if}
            {#if local.value !== local.saved}
              {$t('admin.frameleaf_model_local_unsaved', { values: { model: localSelected.model.name } })}
            {/if}
          </small>
        </span>
      </p>
    {:else}
      <p class="ms-readout is-none" role="status">
        <Icon icon={mdiChip} size="16" aria-hidden={true} />
        <span>{$t('admin.frameleaf_model_local_custom', { values: { model: local.value } })}</span>
      </p>
    {/if}
    <p class="ms-note">{$t('admin.frameleaf_model_local_download')}</p>
    {#if !local.hardware.known}
      <p class="ms-note">{$t('admin.frameleaf_model_local_unchecked')}</p>
    {/if}
  {:else if workerNote}
    <p class="ms-note">{$t('admin.frameleaf_model_local_worker')}</p>
  {/if}

  {#if models}
    {#if models.length === 0}
      <p class="ms-readout is-none" role="status">
        <Icon icon={mdiAlertOutline} size="16" aria-hidden={true} />
        <span>{$t('admin.frameleaf_cloud_model_empty')}</span>
      </p>
    {:else if choice.kind === 'chosen' || choice.kind === 'default'}
      <p class="ms-readout is-cloud" aria-live="polite">
        <Icon icon={mdiCloudOutline} size="16" aria-hidden={true} />
        <span>
          <strong>{choice.model.name}</strong> · {price(choice.model)}
          <small>
            {choice.model.description}.
            {#if choice.model.id === recommended?.id}
              {$t('admin.frameleaf_cloud_model_recommended_note')}
            {/if}
            {#if choice.kind === 'default'}
              {$t('admin.frameleaf_cloud_model_using_default')}
            {/if}
          </small>
        </span>
      </p>
    {:else}
      <p class="ms-readout is-none" role="status">
        <Icon icon={mdiAlertOutline} size="16" aria-hidden={true} />
        <span>
          {#if choice.kind === 'missing'}
            {$t('admin.frameleaf_cloud_model_missing', { values: { model: choice.id } })}
          {:else if takesCatalogDefault(group)}
            {$t('admin.frameleaf_cloud_model_none')}
          {:else}
            {$t('admin.frameleaf_cloud_model_none_studio')}
          {/if}
        </span>
      </p>
    {/if}
    {#if recommended && !cloudDisabled && shownModelId !== null && shownModelId !== recommended.id}
      <button type="button" class="fc-link" onclick={useRecommended}>
        {$t('admin.frameleaf_cloud_model_use_recommended', { values: { model: recommended.name } })}
      </button>
    {/if}
  {/if}

  {#if stopCount > 0}
    <ul class="ms-key" aria-label={$t('frameleaf_model_key_label')}>
      {#if bandsPresent.has('cpu')}
        <li class="is-cpu">
          <Icon icon={mdiChip} size="14" aria-hidden={true} />
          {$t('frameleaf_model_key_cpu')}
        </li>
      {/if}
      {#if bandsPresent.has('gpu')}
        <li class="is-gpu">
          <Icon icon={mdiExpansionCard} size="14" aria-hidden={true} />
          {local?.hardware.gpu
            ? $t('frameleaf_model_key_gpu_named', {
                values: { gpu: local.hardware.gpu.name, memory: local.hardware.gpu.vramGb },
              })
            : $t('frameleaf_model_key_gpu')}
        </li>
      {/if}
      {#if cloudModels.length > 0}
        <li class="is-cloud">
          <Icon icon={mdiCloudOutline} size="14" aria-hidden={true} />
          {$t('frameleaf_model_key_cloud')}
        </li>
      {/if}
      {#if recommended}
        <li>
          <Icon icon={mdiStarOutline} size="14" aria-hidden={true} />
          {$t('admin.frameleaf_cloud_model_recommended')}
        </li>
      {/if}
    </ul>
  {/if}
  {#if reasons.length > 0}
    <ul class="ms-reasons" id="{id}-reasons">
      {#each reasons as reason (reason)}
        <li>
          <Icon icon={mdiInformationOutline} size="14" aria-hidden={true} />
          {reason}
        </li>
      {/each}
    </ul>
  {/if}
</fieldset>
