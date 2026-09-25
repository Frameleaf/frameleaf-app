<script lang="ts">
  /**
   * The Job manager's "Enrichment tasks" dialog (FL-59, CC-42): the template's `EnrichmentJobDialog`
   * (`JobsManager.jsx:1213-1367`, `jobs-manager.css` `.jm-enrichment-form`). Regenerate descriptions
   * (When: queue now or remind me later) and Re-evaluate smart albums (one category or all) hand their
   * action to the Job manager's review; Apply a description hardware preset (Acceleration) writes the
   * preset into the central settings draft, where it joins the settings review.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import {
    applyDescriptionHardwarePreset,
    enrichmentTaskAction,
    presetSelectsModels,
    SMART_ALBUM_KINDS,
    type EnrichmentTask,
    type EnrichmentTaskAction,
    type EnrichmentTiming,
  } from '$lib/frameleaf/enrichment-tasks';
  import type { SystemConfigDraftStore } from '$lib/frameleaf/system-config-draft.svelte';
  import { getMachineLearningHardware, MachineLearningHardwareAcceleration, SmartAlbumBuiltInKind } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiCheckCircleOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = {
    open?: boolean;
    /** The central settings draft; without it a preset cannot join the settings review. */
    store?: SystemConfigDraftStore;
    onReview: (action: EnrichmentTaskAction) => void;
    onReviewSettings: () => void;
  };

  let { open = $bindable(false), store, onReview, onReviewSettings }: Props = $props();

  let task = $state<EnrichmentTask>('descriptions');
  let timing = $state<EnrichmentTiming>('now');
  let kind = $state<SmartAlbumBuiltInKind | 'all'>('all');
  let preset = $state<MachineLearningHardwareAcceleration>(MachineLearningHardwareAcceleration.Auto);
  let changed = $state(false);
  /** The acceleration the first local destination reports; a cloud destination is never probed. */
  let detected = $state<MachineLearningHardwareAcceleration | undefined>();

  // Each opening starts from the template's defaults.
  $effect(() => {
    if (!open) {
      return;
    }

    task = 'descriptions';
    timing = 'now';
    kind = 'all';
    preset = MachineLearningHardwareAcceleration.Auto;
    changed = false;
  });

  // The hardware is read once the preset task is chosen, so Auto can say what it will do.
  let probed = false;
  $effect(() => {
    if (!open || task !== 'hardware' || probed) {
      return;
    }

    probed = true;
    getMachineLearningHardware({})
      .then(({ preferredAcceleration }) => (detected = preferredAcceleration))
      .catch(() => (detected = undefined));
  });

  const kindLabel = (value: SmartAlbumBuiltInKind) => $t(`admin.smart_albums_kind_${value}`);
  const selectsModels = $derived(presetSelectsModels(preset, detected));

  const review = () => {
    if (task === 'hardware') {
      return;
    }

    open = false;
    onReview(enrichmentTaskAction(task, timing, kind));
  };

  const addPreset = () => {
    if (store && applyDescriptionHardwarePreset(store.draft.machineLearning, preset, detected)) {
      changed = true;
    }
  };

  const reviewSettings = () => {
    open = false;
    onReviewSettings();
  };
</script>

<Dialog title={$t('frameleaf_enrichment_tasks_title')} closeLabel={$t('close')} bind:open>
  <div class="jm-enrichment-form">
    <label>
      {$t('frameleaf_enrichment_tasks_task_label')}
      <select bind:value={task} data-initial-focus>
        <option value="descriptions">{$t('frameleaf_enrichment_tasks_task_descriptions')}</option>
        <option value="smart-albums">{$t('frameleaf_enrichment_tasks_task_smart_albums')}</option>
        <option value="hardware">{$t('frameleaf_enrichment_tasks_task_hardware')}</option>
      </select>
    </label>

    {#if task === 'descriptions'}
      <p>{$t('frameleaf_enrichment_tasks_descriptions_help')}</p>
      <label>
        {$t('frameleaf_enrichment_tasks_when_label')}
        <select bind:value={timing}>
          <option value="now">{$t('frameleaf_enrichment_tasks_when_now')}</option>
          <option value="later">{$t('frameleaf_enrichment_tasks_when_later')}</option>
        </select>
      </label>
      <p class="jm-muted">{$t('frameleaf_enrichment_tasks_descriptions_scope')}</p>
    {:else if task === 'smart-albums'}
      <label>
        {$t('frameleaf_enrichment_tasks_category_label')}
        <select bind:value={kind}>
          <option value="all">{$t('frameleaf_enrichment_tasks_category_all')}</option>
          {#each SMART_ALBUM_KINDS as value (value)}
            <option {value}>{kindLabel(value)}</option>
          {/each}
        </select>
      </label>
      <p>{$t('frameleaf_enrichment_tasks_smart_albums_help')}</p>
      <p class="jm-muted">{$t('frameleaf_enrichment_tasks_smart_albums_scope')}</p>
    {:else}
      <label>
        {$t('frameleaf_enrichment_tasks_acceleration_label')}
        <select bind:value={preset} onchange={() => (changed = false)}>
          <option value={MachineLearningHardwareAcceleration.Auto}>
            {$t('frameleaf_enrichment_tasks_acceleration_auto')}
          </option>
          <option value={MachineLearningHardwareAcceleration.Openvino}>
            {$t('frameleaf_enrichment_tasks_acceleration_openvino')}
          </option>
          <option value={MachineLearningHardwareAcceleration.Cuda}>
            {$t('frameleaf_enrichment_tasks_acceleration_cuda')}
          </option>
        </select>
      </label>
      <p>
        {selectsModels
          ? $t('frameleaf_enrichment_tasks_preset_models')
          : $t('frameleaf_enrichment_tasks_preset_auto_unknown')}
      </p>
      <p class="jm-muted">{$t('frameleaf_enrichment_tasks_preset_note')}</p>
      {#if changed}
        <div class="jm-message" role="status">
          <Icon icon={mdiCheckCircleOutline} size="16px" aria-hidden={true} />
          {$t('frameleaf_enrichment_tasks_preset_added')}
          <Button onclick={reviewSettings}>{$t('frameleaf_enrichment_tasks_review_model_settings')}</Button>
        </div>
      {/if}
    {/if}
  </div>

  {#snippet actions()}
    <Button onclick={() => (open = false)}>{$t('cancel')}</Button>
    {#if task === 'hardware'}
      <Button variant="primary" disabled={!store} onclick={addPreset}>
        {$t('frameleaf_enrichment_tasks_add_preset')}
      </Button>
    {:else}
      <Button variant="primary" onclick={review}>{$t('frameleaf_enrichment_tasks_review_task')}</Button>
    {/if}
  {/snippet}
</Dialog>

<style>
  /* The template's `jobs-manager.css` `.jm-enrichment-form` (819-825, 876-890). */
  .jm-enrichment-form {
    min-width: min(28rem, 100%);
  }
  .jm-enrichment-form label {
    font-size: 11px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    color: var(--fl-muted);
  }
  .jm-enrichment-form > label {
    margin: 12px 0;
  }
  .jm-enrichment-form > label:first-child {
    margin-top: 0;
  }
  .jm-enrichment-form select {
    color: var(--fl-text);
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: 5px;
    padding: 9px;
    font: inherit;
    font-size: 12px;
  }
  .jm-enrichment-form select:focus-visible {
    outline: 2px solid var(--fl-accent);
    outline-offset: 2px;
  }
  .jm-enrichment-form p {
    font-size: 12px;
    line-height: 1.7;
    margin: 0 0 8px;
  }
  .jm-muted {
    color: var(--fl-muted);
  }
  /* The template's `.jm-message` (441-461). */
  .jm-message {
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 11px 13px;
    margin: 10px 0 0;
    border: 1px solid var(--fl-border);
    border-radius: 6px;
    font-size: 12px;
    background: var(--fl-panel);
    color: var(--fl-muted);
  }
  .jm-message > :global(:last-child) {
    margin-left: auto;
  }
</style>
