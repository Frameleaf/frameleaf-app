<script lang="ts">
  /**
   * Search models & suggested tags (FL-71), the template's `advanced-search-labels` section
   * (`settings-advanced.mjs` intelligence): zero-shot tag suggestions from the CLIP search model
   * (`machineLearning.clip.zeroShotTagging`) and Ask Search (`localFeatures.askSearch`), with the
   * locked note that a model change needs compatible indexes. Bounds are the server's (similarity
   * 0–1, 1–20 tags, 1–1,000 results).
   */
  import SettingField from '$lib/components/frameleaf/settings/SettingField.svelte';
  import SettingGroup from '$lib/components/frameleaf/settings/SettingGroup.svelte';
  import SettingToggle from '$lib/components/frameleaf/settings/SettingToggle.svelte';
  import { SettingInputFieldType } from '$lib/constants';
  import { requireSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import type { AdminConfigMachineLearningDto } from '@immich/sdk';
  import { t } from 'svelte-i18n';

  interface Props {
    workingConfig: AdminConfigMachineLearningDto;
    savedConfig: AdminConfigMachineLearningDto;
    disabled: boolean;
  }

  let { workingConfig, savedConfig, disabled }: Props = $props();

  const settingsDraft = requireSystemConfigDraft();
  // The server always returns `localFeatures`; the DTO marks it optional only because it has a default.
  const askSearchDefault = { enabled: true, maxResults: 100 };
  const askSearch = $derived(settingsDraft.draft.localFeatures?.askSearch ?? askSearchDefault);
  const savedAskSearch = $derived(settingsDraft.baseline.localFeatures?.askSearch ?? askSearchDefault);

  const clipOff = $derived(disabled || !workingConfig.enabled || !workingConfig.clip.enabled);
</script>

<SettingGroup
  key="search-labels"
  title={$t('frameleaf_ml_search_labels_title')}
  subtitle={$t('frameleaf_ml_search_labels_description')}
>
  <div class="flex flex-col gap-4">
    <SettingToggle
      title={$t('frameleaf_ml_zero_shot_enabled')}
      subtitle={$t('frameleaf_ml_zero_shot_enabled_description')}
      bind:checked={workingConfig.clip.zeroShotTagging.enabled}
      isEdited={workingConfig.clip.zeroShotTagging.enabled !== savedConfig.clip.zeroShotTagging.enabled}
      disabled={clipOff}
    />
    <SettingField
      inputType={SettingInputFieldType.NUMBER}
      label={$t('frameleaf_ml_zero_shot_similarity')}
      description={$t('frameleaf_ml_zero_shot_similarity_description')}
      bind:value={workingConfig.clip.zeroShotTagging.minSimilarity}
      step="0.01"
      min={0}
      max={1}
      isEdited={workingConfig.clip.zeroShotTagging.minSimilarity !== savedConfig.clip.zeroShotTagging.minSimilarity}
      disabled={clipOff || !workingConfig.clip.zeroShotTagging.enabled}
    />
    <SettingField
      inputType={SettingInputFieldType.NUMBER}
      label={$t('frameleaf_ml_zero_shot_max_tags')}
      description={$t('frameleaf_ml_zero_shot_max_tags_description')}
      bind:value={workingConfig.clip.zeroShotTagging.maxTags}
      step="1"
      min={1}
      max={20}
      isEdited={workingConfig.clip.zeroShotTagging.maxTags !== savedConfig.clip.zeroShotTagging.maxTags}
      disabled={clipOff || !workingConfig.clip.zeroShotTagging.enabled}
    />
    <SettingToggle
      title={$t('frameleaf_ml_ask_search_enabled')}
      subtitle={$t('frameleaf_ml_ask_search_enabled_description')}
      bind:checked={askSearch.enabled}
      isEdited={askSearch.enabled !== savedAskSearch.enabled}
      {disabled}
    />
    <SettingField
      inputType={SettingInputFieldType.NUMBER}
      label={$t('frameleaf_ml_ask_search_max_results')}
      description={$t('frameleaf_ml_ask_search_max_results_description')}
      bind:value={askSearch.maxResults}
      step="1"
      min={1}
      max={1000}
      isEdited={askSearch.maxResults !== savedAskSearch.maxResults}
      disabled={disabled || !askSearch.enabled}
    />
    <SettingToggle
      title={$t('frameleaf_ml_search_reindex_title')}
      subtitle={$t('frameleaf_ml_search_reindex_description')}
      policy={$t('frameleaf_ml_search_reindex_policy')}
      checked
      disabled
    />
  </div>
</SettingGroup>
