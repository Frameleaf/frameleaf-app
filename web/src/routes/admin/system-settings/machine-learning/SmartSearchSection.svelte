<script lang="ts">
  import SettingGroup from '$lib/components/frameleaf/settings/SettingGroup.svelte';
  import SettingField from '$lib/components/frameleaf/settings/SettingField.svelte';
  import SettingToggle from '$lib/components/frameleaf/settings/SettingToggle.svelte';
  import { SettingInputFieldType } from '$lib/constants';
  import FormatMessage from '$lib/elements/FormatMessage.svelte';
  import { helpLinks } from '$lib/frameleaf/help-links.svelte';
  import type { AdminConfigMachineLearningDto } from '@immich/sdk';
  import { t } from 'svelte-i18n';

  interface Props {
    workingConfig: AdminConfigMachineLearningDto;
    savedConfig: AdminConfigMachineLearningDto;
    disabled: boolean;
  }

  let { workingConfig, savedConfig, disabled }: Props = $props();

  // FL-135 / FL-192: the model list in this installation's documentation, or no link at all
  const clipModelsDocs = $derived(helpLinks.docs('features/searching#clip-models'));
</script>

<SettingGroup
  key="smart-search"
  title={$t('admin.machine_learning_smart_search')}
  subtitle={$t('admin.machine_learning_smart_search_description')}
>
  <div class="flex flex-col gap-4">
    <SettingToggle
      title={$t('admin.machine_learning_smart_search_enabled')}
      subtitle={$t('admin.machine_learning_smart_search_enabled_description')}
      bind:checked={workingConfig.clip.enabled}
      disabled={disabled || !workingConfig.enabled}
    />

    <hr />

    <SettingField
      inputType={SettingInputFieldType.TEXT}
      label={$t('admin.machine_learning_clip_model')}
      bind:value={workingConfig.clip.modelName}
      required={true}
      disabled={disabled || !workingConfig.enabled || !workingConfig.clip.enabled}
      isEdited={workingConfig.clip.modelName !== savedConfig.clip.modelName}
    >
      {#snippet descriptionSnippet()}
        <p class="pb-2 text-sm immich-form-label">
          <FormatMessage key="admin.machine_learning_clip_model_description">
            {#snippet children({ message })}
              {#if clipModelsDocs}
                <a target="_blank" rel="noreferrer" href={clipModelsDocs}><u>{message}</u></a>
              {:else}
                {message}
              {/if}
            {/snippet}
          </FormatMessage>
        </p>
      {/snippet}
    </SettingField>
  </div>
</SettingGroup>
