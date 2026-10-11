<script lang="ts">
  /**
   * Server & updates › Server name & welcome (FL-368, after the approved prototype
   * `settings-v2/server/server-updates.jsx`): the name with where it is shown, a bigger box for the
   * welcome message with what the sign-in page will show beside it, and local network discovery
   * in plain words. "People can find each other when sharing" has moved to People & sharing.
   *
   * Left for later (server work): a welcome message that is plain text unless formatting is asked
   * for, and a server time zone. The message is shown exactly as today.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import { goto } from '$app/navigation';
  import Field from '$lib/components/frameleaf/settings/kit/Field.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import Switch from '$lib/components/frameleaf/settings/kit/Switch.svelte';
  import TextArea from '$lib/components/frameleaf/settings/kit/TextArea.svelte';
  import SettingActions from '$lib/components/frameleaf/settings/SettingActions.svelte';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { requireSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { t } from 'svelte-i18n';

  const disabled = $derived(featureFlagsManager.value.configFile);
  const settingsDraft = requireSystemConfigDraft();
  const server = $derived(settingsDraft.draft.server);
</script>

<KitPage>
  <Section title={$t('frameleaf_server_identity_name_section')}>
    <Row
      label={$t('frameleaf_server_identity_name')}
      help={server.name.trim() ? $t('frameleaf_server_identity_name_help') : $t('frameleaf_server_identity_name_empty')}
    >
      <Field
        wide
        label={$t('frameleaf_server_identity_name')}
        value={server.name}
        placeholder={$t('frameleaf_server_identity_name_placeholder')}
        {disabled}
        onChange={(value) => (settingsDraft.draft.server.name = value)}
      />
    </Row>
  </Section>

  <Section
    title={$t('frameleaf_server_identity_welcome')}
    description={$t('frameleaf_server_identity_welcome_description')}
  >
    <TextArea
      label={$t('frameleaf_server_identity_welcome')}
      value={server.loginPageMessage}
      placeholder={$t('frameleaf_server_identity_welcome_placeholder')}
      {disabled}
      onChange={(value) => (settingsDraft.draft.server.loginPageMessage = value)}
    />
  </Section>

  <Section title={$t('frameleaf_server_identity_finding')}>
    <Row
      label={$t('frameleaf_server_identity_lan')}
      help={server.lanDiscovery ? $t('frameleaf_server_identity_lan_on') : $t('frameleaf_server_identity_lan_off')}
    >
      <Switch
        label={$t('frameleaf_server_identity_lan')}
        checked={server.lanDiscovery}
        held={disabled}
        onChange={(value) => (settingsDraft.draft.server.lanDiscovery = value)}
      />
    </Row>
    <Row label={$t('frameleaf_sharing_find_label')} help={$t('frameleaf_server_identity_find_moved')}>
      <Button onclick={() => goto(commandCenterUrl('sharing'))}>{$t('frameleaf_server_identity_find_open')}</Button>
    </Row>
  </Section>

  <SettingActions keys={['server']} {disabled} />
</KitPage>
