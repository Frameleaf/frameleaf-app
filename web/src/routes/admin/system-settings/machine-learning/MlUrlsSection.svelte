<script lang="ts">
  import SettingField from '$lib/components/frameleaf/settings/SettingField.svelte';
  import SettingToggle from '$lib/components/frameleaf/settings/SettingToggle.svelte';
  import { SettingInputFieldType } from '$lib/constants';
  import type { AdminConfigMachineLearningDto } from '@immich/sdk';
  import { Button, IconButton } from '@immich/ui';
  import { mdiPlus, mdiTrashCanOutline } from '@mdi/js';
  import { isEqual } from 'lodash-es';
  import { t } from 'svelte-i18n';

  interface Props {
    workingConfig: AdminConfigMachineLearningDto;
    savedConfig: AdminConfigMachineLearningDto;
    disabled: boolean;
  }

  let { workingConfig = $bindable(), savedConfig, disabled }: Props = $props();
</script>

<div class="flex flex-col gap-4">
  <SettingToggle
    title={$t('admin.machine_learning_enabled')}
    subtitle={$t('admin.machine_learning_enabled_description')}
    {disabled}
    bind:checked={workingConfig.enabled}
  />

  <hr />

  <div>
    {#each workingConfig.urls as _, i (i)}
      <SettingField
        inputType={SettingInputFieldType.TEXT}
        label={i === 0 ? $t('url') : undefined}
        description={i === 0 ? $t('admin.machine_learning_url_description') : undefined}
        bind:value={workingConfig.urls[i]}
        required={i === 0}
        disabled={disabled || !workingConfig.enabled}
        isEdited={i === 0 && !isEqual(workingConfig.urls, savedConfig.urls)}
      >
        {#snippet trailingSnippet()}
          {#if workingConfig.urls.length > 1}
            <IconButton
              aria-label=""
              onclick={() => workingConfig.urls.splice(i, 1)}
              icon={mdiTrashCanOutline}
              color="danger"
            />
          {/if}
        {/snippet}
      </SettingField>
    {/each}
  </div>

  <div class="flex justify-end">
    <Button
      class="mb-2"
      size="small"
      shape="round"
      leadingIcon={mdiPlus}
      onclick={() => {
        workingConfig.urls.push('');
      }}
      disabled={disabled || !workingConfig.enabled}>{$t('add_url')}</Button
    >
  </div>
</div>
