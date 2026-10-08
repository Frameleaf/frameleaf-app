<script lang="ts">
  import SettingActions from '$lib/components/frameleaf/settings/SettingActions.svelte';
  import SettingField from '$lib/components/frameleaf/settings/SettingField.svelte';
  import SettingToggle from '$lib/components/frameleaf/settings/SettingToggle.svelte';
  import { SettingInputFieldType } from '$lib/constants';
  import { requireSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { t } from 'svelte-i18n';
  import { reveal } from '$lib/frameleaf/motion';

  const disabled = $derived(featureFlagsManager.value.configFile);
  const settingsDraft = requireSystemConfigDraft();
  const configToEdit = $derived(settingsDraft.draft);
  const config = $derived(settingsDraft.baseline);
</script>

<div>
  <div in:reveal>
    <form autocomplete="off" onsubmit={(event) => event.preventDefault()}>
      <!-- CC-4: the template's "Server name" (settings-catalog.mjs identity). -->
      <SettingField
        inputType={SettingInputFieldType.TEXT}
        label={$t('frameleaf_cc_server_name')}
        description={$t('frameleaf_cc_server_name_description')}
        {disabled}
        bind:value={configToEdit.server.name}
        isEdited={configToEdit.server.name !== config.server.name}
      />

      <!-- FL-168: the Public server URL is edited in Frameleaf Cloud › Remote access, as in the prototype. -->
      <SettingField
        inputType={SettingInputFieldType.TEXT}
        label={$t('admin.server_welcome_message')}
        description={$t('admin.server_welcome_message_description')}
        bind:value={configToEdit.server.loginPageMessage}
        isEdited={configToEdit.server.loginPageMessage !== config.server.loginPageMessage}
      />

      <SettingToggle
        title={$t('admin.server_public_users')}
        subtitle={$t('admin.server_public_users_description')}
        {disabled}
        bind:checked={configToEdit.server.publicUsers}
      />

      <SettingToggle
        title={$t('admin.server_lan_discovery')}
        subtitle={$t('admin.server_lan_discovery_description')}
        {disabled}
        bind:checked={configToEdit.server.lanDiscovery}
        isEdited={configToEdit.server.lanDiscovery !== config.server.lanDiscovery}
      />

      <SettingActions keys={['server']} {disabled} />
    </form>
  </div>
</div>
