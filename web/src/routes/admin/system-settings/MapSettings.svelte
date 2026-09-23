<script lang="ts">
  import SettingGroup from '$lib/components/frameleaf/settings/SettingGroup.svelte';
  import SettingField from '$lib/components/frameleaf/settings/SettingField.svelte';
  import SettingToggle from '$lib/components/frameleaf/settings/SettingToggle.svelte';
  import SettingActions from '$lib/components/frameleaf/settings/SettingActions.svelte';
  import { SettingInputFieldType } from '$lib/constants';
  import FormatMessage from '$lib/elements/FormatMessage.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { systemConfigManager } from '$lib/managers/system-config-manager.svelte';
  import { Link } from '@immich/ui';
  import { t } from 'svelte-i18n';
  import { fade } from 'svelte/transition';

  const disabled = $derived(featureFlagsManager.value.configFile);
  const config = $derived(systemConfigManager.value);
  let configToEdit = $state(systemConfigManager.cloneValue());
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
            <p class="text-sm dark:text-immich-dark-fg">
              <FormatMessage key="admin.map_manage_reverse_geocoding_settings">
                {#snippet children({ message })}
                  <Link href="https://docs.immich.app/features/reverse-geocoding">{message}</Link>
                {/snippet}
              </FormatMessage>
            </p>
          {/snippet}
          <div class="flex flex-col gap-4">
            <SettingToggle
              title={$t('admin.map_reverse_geocoding_enable_description')}
              {disabled}
              bind:checked={configToEdit.reverseGeocoding.enabled}
            />
          </div></SettingGroup
        >

        <SettingActions bind:configToEdit keys={['map', 'reverseGeocoding']} {disabled} />
      </div>
    </form>
  </div>
</div>
