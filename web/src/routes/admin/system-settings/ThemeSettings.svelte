<script lang="ts">
  /**
   * Server & updates › Custom styling (FL-368, after the approved prototype
   * `settings-v2/server/server-updates.jsx`): named for what it is, with a switch so styling can be
   * turned off without deleting the text (`theme.customCssEnabled`), and who it is for and the risk
   * said in one notice.
   */
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Notice from '$lib/components/frameleaf/settings/kit/Notice.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import Switch from '$lib/components/frameleaf/settings/kit/Switch.svelte';
  import TextArea from '$lib/components/frameleaf/settings/kit/TextArea.svelte';
  import SettingActions from '$lib/components/frameleaf/settings/SettingActions.svelte';
  import { requireSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { t } from 'svelte-i18n';

  const disabled = $derived(featureFlagsManager.value.configFile);
  const settingsDraft = requireSystemConfigDraft();
  const theme = $derived(settingsDraft.draft.theme);
  // A server from before the switch does not send it: styling is in use, as it always was.
  const enabled = $derived(theme.customCssEnabled ?? true);
</script>

<KitPage>
  <Notice title={$t('frameleaf_srvadv_styling_who')}>{$t('frameleaf_srvadv_styling_risk')}</Notice>

  <Section title={$t('frameleaf_srvadv_styling_section')}>
    <Row
      label={$t('frameleaf_srvadv_styling_use')}
      help={enabled ? $t('frameleaf_srvadv_styling_use_on') : $t('frameleaf_srvadv_styling_use_off')}
    >
      <Switch
        label={$t('frameleaf_srvadv_styling_use')}
        checked={enabled}
        held={disabled}
        onChange={(value) => (settingsDraft.draft.theme.customCssEnabled = value)}
      />
    </Row>
    <Row label={$t('frameleaf_srvadv_styling_sheet')} help={$t('frameleaf_srvadv_styling_sheet_help')} />
    <TextArea
      code
      rows={12}
      label={$t('frameleaf_srvadv_styling_sheet')}
      value={theme.customCss}
      {disabled}
      onChange={(value) => (settingsDraft.draft.theme.customCss = value)}
    />
  </Section>

  <SettingActions keys={['theme']} {disabled} />
</KitPage>
