<script lang="ts">
  import SettingGroup from '$lib/components/frameleaf/settings/SettingGroup.svelte';
  import SettingField from '$lib/components/frameleaf/settings/SettingField.svelte';
  import SettingToggle from '$lib/components/frameleaf/settings/SettingToggle.svelte';
  import SettingActions from '$lib/components/frameleaf/settings/SettingActions.svelte';
  import { SettingInputFieldType } from '$lib/constants';
  import FormatMessage from '$lib/elements/FormatMessage.svelte';
  import { helpLinks } from '$lib/frameleaf/help-links.svelte';
  import { requireSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { Link } from '@immich/ui';
  import { t } from 'svelte-i18n';
  import { fade } from 'svelte/transition';

  const disabled = $derived(featureFlagsManager.value.configFile);
  const settingsDraft = requireSystemConfigDraft();
  const configToEdit = $derived(settingsDraft.draft);
  const config = $derived(settingsDraft.baseline);

  // FL-135: this installation's documentation, or no link at all
  const geocodingDocs = $derived(helpLinks.docs('features/reverse-geocoding'));
</script>

<div class="mt-2">
  <div in:fade={{ duration: 500 }}>
    <form autocomplete="off" onsubmit={(event) => event.preventDefault()}>
      <div class="flex flex-col gap-4">
        <SettingGroup key="map" title={$t('admin.map_settings')} subtitle={$t('admin.map_settings_description')}>
          <div class="flex flex-col gap-4">
            <SettingToggle
              title={$t('admin.map_enable_description')}
              subtitle={$t('admin.map_implications')}
              {disabled}
              bind:checked={configToEdit.map.enabled}
            />

            <hr />

            <SettingField
              inputType={SettingInputFieldType.TEXT}
              label={$t('admin.map_light_style')}
              description={$t('admin.map_style_description')}
              bind:value={configToEdit.map.lightStyle}
              disabled={disabled || !configToEdit.map.enabled}
              isEdited={configToEdit.map.lightStyle !== config.map.lightStyle}
            />
            <SettingField
              inputType={SettingInputFieldType.TEXT}
              label={$t('admin.map_dark_style')}
              description={$t('admin.map_style_description')}
              bind:value={configToEdit.map.darkStyle}
              disabled={disabled || !configToEdit.map.enabled}
              isEdited={configToEdit.map.darkStyle !== config.map.darkStyle}
            />
          </div></SettingGroup
        >

        <SettingGroup key="reverse-geocoding" title={$t('admin.map_reverse_geocoding_settings')}>
          {#snippet subtitleSnippet()}
            {#if geocodingDocs}
              <p class="text-sm dark:text-immich-dark-fg">
                <FormatMessage key="admin.map_manage_reverse_geocoding_settings">
                  {#snippet children({ message })}
                    <Link href={geocodingDocs}>{message}</Link>
                  {/snippet}
                </FormatMessage>
              </p>
            {/if}
          {/snippet}
          <div class="flex flex-col gap-4">
            <SettingToggle
              title={$t('admin.map_reverse_geocoding_enable_description')}
              {disabled}
              bind:checked={configToEdit.reverseGeocoding.enabled}
            />
          </div></SettingGroup
        >

        <SettingActions keys={['map', 'reverseGeocoding']} {disabled} />
      </div>
    </form>
  </div>
</div>
