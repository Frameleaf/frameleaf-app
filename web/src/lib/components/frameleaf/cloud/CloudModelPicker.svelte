<script lang="ts">
  /**
   * The Frameleaf Cloud model for one model group (FL-186; prototype WorkloadRouting.jsx
   * `DefaultModelSlider` and ModelSlider.jsx, gpu-models.css). The stops are the models Frameleaf
   * Cloud's catalogue offers for exactly this group, lightest first, on the slider's blue band:
   * restoration has a picker per mode and Studio AI one for speech to text and one for speech. A choice
   * is saved on its own, apart from the workload's route, and every cloud job of the group names it
   * whatever the route points at. With no model chosen, the model the catalogue recommends is used and
   * marked; where it recommends none, and always for Studio AI, the picker asks for a choice, because
   * those jobs are refused until one is made.
   *
   * Built on native radio buttons, so arrow keys move between the models. The group stays enabled
   * while a choice is saved, so focus never drops: the picker shows the latest choice at once, saves it
   * after a short pause, and saves only the latest one when several follow each other.
   */
  import './gpu-models.css';
  import { cloudModelChoice, takesCatalogDefault } from '$lib/frameleaf/cloud-models';
  import { formatRatePerMinute, formatUsd } from '$lib/frameleaf/cloud-ml';
  import { handleError } from '$lib/utils/handle-error';
  import {
    setCloudMlModelChoice,
    type CloudMlModelChoiceDto,
    type CloudMlModelDto,
    type CloudMlModelGroup,
  } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiAlertOutline, mdiCloudOutline, mdiStarOutline } from '@mdi/js';
  import { onDestroy, tick } from 'svelte';
  import { t } from 'svelte-i18n';

  type Props = {
    group: CloudMlModelGroup;
    /** The catalogue models for exactly this group, lightest first. */
    models: CloudMlModelDto[];
    /** The saved model, or null for the catalogue's recommendation. */
    modelId: string | null;
    /** The name of the work, as Where each job runs shows it. */
    name: string;
    onSaved: (choices: CloudMlModelChoiceDto[], message: string) => void;
  };

  let { group, models, modelId, name, onSaved }: Props = $props();

  /** How long the picker waits for the next choice before it saves. */
  const SAVE_DELAY_MS = 300;

  const id = $props.id();
  let saving = $state(false);
  /** The choice made in the picker and not saved yet; null when the picker shows the saved model. */
  let wanted = $state<{ id: string | null } | null>(null);
  let timer: ReturnType<typeof setTimeout> | undefined;

  const shownModelId = $derived(wanted ? wanted.id : modelId);
  const choice = $derived(cloudModelChoice(models, group, shownModelId));
  const selectedId = $derived(choice.kind === 'chosen' || choice.kind === 'default' ? choice.model.id : null);
  const recommended = $derived(takesCatalogDefault(group) ? models.find((model) => model.isDefault) : undefined);

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
    const model = next ? models.find((entry) => entry.id === next) : undefined;
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
    const radios = fieldset?.querySelectorAll<HTMLInputElement>(':scope input[type="radio"]') ?? [];
    for (const radio of radios) {
      if (radio.value === target) {
        radio.focus();
      }
    }
  };

  onDestroy(() => {
    // A choice made just before the picker closes is still saved.
    if (timer !== undefined) {
      clearTimeout(timer);
      void flush();
    }
  });
</script>

<fieldset class="ms" data-group={group} aria-busy={saving} bind:this={fieldset}>
  <legend class="ms-legend">{$t('admin.frameleaf_cloud_model_for', { values: { name } })}</legend>
  {#if models.length === 0}
    <p class="ms-readout is-none" role="status">
      <Icon icon={mdiAlertOutline} size="16" aria-hidden={true} />
      <span>{$t('admin.frameleaf_cloud_model_empty')}</span>
    </p>
  {:else}
    <div class="ms-track" style:--ms-count={models.length}>
      {#each models as model (model.id)}
        {@const checked = model.id === selectedId}
        <label class="ms-stop is-cloud" class:is-selected={checked} title="{model.name} · {price(model)}">
          <input
            type="radio"
            class="sr-only"
            name="{id}-model"
            value={model.id}
            {checked}
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
    <div class="ms-scale" aria-hidden="true">
      <span>{$t('frameleaf_model_scale_lighter')}</span>
      <span>{$t('frameleaf_model_scale_heavier')}</span>
    </div>
    {#if choice.kind === 'chosen' || choice.kind === 'default'}
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
    {#if recommended && shownModelId !== null && shownModelId !== recommended.id}
      <button type="button" class="fc-link" onclick={useRecommended}>
        {$t('admin.frameleaf_cloud_model_use_recommended', { values: { model: recommended.name } })}
      </button>
    {/if}
    <ul class="ms-key" aria-label={$t('frameleaf_model_key_label')}>
      <li class="is-cloud">
        <Icon icon={mdiCloudOutline} size="14" aria-hidden={true} />
        {$t('frameleaf_model_key_cloud')}
      </li>
      {#if recommended}
        <li>
          <Icon icon={mdiStarOutline} size="14" aria-hidden={true} />
          {$t('admin.frameleaf_cloud_model_recommended')}
        </li>
      {/if}
    </ul>
  {/if}
</fieldset>
