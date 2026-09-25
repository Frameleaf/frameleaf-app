<script lang="ts">
  /**
   * Versions & compatibility (FL-71), the template's `updates` section (`settings-catalog.mjs`
   * "Versions & compatibility", `CommandCenter.jsx` release panel ~2220-2250). Release
   * infrastructure belongs to the Frameleaf build and server: there is no editable release address
   * and no external fallback feed.
   *
   * - "Check for updates" stays off: version checks are off by this server's privacy policy (owner
   *   decision FL-146, 2026-09-25), so the row is locked and the release panel says so instead of
   *   offering a check that would contact nothing.
   * - "Update channel" is the saved `newVersionCheck.channel` (Stable or Release candidate, the
   *   server's channels), kept for when checks are allowed.
   * - "Third-party release checks" is the template's locked privacy boundary.
   * - "Installed build channel" is read from the running version.
   *
   * The template's "Check frequency" has no server setting and no effect while checks are off, so it
   * is not drawn (recorded in the conformance audit; no API field is invented for it).
   */
  import SettingActions from '$lib/components/frameleaf/settings/SettingActions.svelte';
  import SettingSelect from '$lib/components/frameleaf/settings/SettingSelect.svelte';
  import SettingToggle from '$lib/components/frameleaf/settings/SettingToggle.svelte';
  import { installedReleaseChannel } from '$lib/frameleaf/release-channel';
  import { requireSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { websocketStore } from '$lib/stores/websocket';
  import { ReleaseChannel } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiServerOutline, mdiShieldCheckOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  const { serverVersion } = websocketStore;

  const disabled = $derived(featureFlagsManager.value.configFile);
  const settingsDraft = requireSystemConfigDraft();
  const configToEdit = $derived(settingsDraft.draft);
  const config = $derived(settingsDraft.baseline);

  const channelOptions = $derived([
    { value: ReleaseChannel.Stable, text: $t('admin.release_channel_stable') },
    { value: ReleaseChannel.ReleaseCandidate, text: $t('admin.release_channel_release_candidate') },
  ]);

  const installed = $derived(installedReleaseChannel($serverVersion));
  const installedOptions = $derived([
    {
      value: installed ?? 'unknown',
      text:
        installed === ReleaseChannel.ReleaseCandidate
          ? $t('admin.release_channel_release_candidate')
          : installed === ReleaseChannel.Stable
            ? $t('admin.release_channel_stable')
            : $t('unknown'),
    },
  ]);
</script>

<form autocomplete="off" onsubmit={(event) => event.preventDefault()}>
  <div class="release-connection">
    <div class="release-status">
      <Icon icon={mdiServerOutline} size="22" aria-hidden={true} />
      <div>
        <strong>{$t('frameleaf_versions_panel_title')}</strong>
        <p>{$t('frameleaf_versions_panel_body')}</p>
      </div>
      <span class="release-badge">{$t('frameleaf_versions_panel_off')}</span>
    </div>
    <div class="release-policy">
      <span
        ><Icon icon={mdiShieldCheckOutline} size="14" aria-hidden={true} />
        {$t('frameleaf_versions_panel_service')}</span
      >
      <span>{$t('frameleaf_versions_panel_install')}</span>
    </div>
  </div>

  <SettingToggle
    title={$t('frameleaf_versions_check_title')}
    subtitle={$t('frameleaf_versions_check_body')}
    policy={$t('admin.version_check_disabled_by_privacy_policy')}
    checked={false}
    disabled
  />
  <SettingSelect
    label={$t('frameleaf_versions_channel_title')}
    desc={$t('frameleaf_versions_channel_body')}
    bind:value={configToEdit.newVersionCheck.channel}
    options={channelOptions}
    name="release-channel"
    isEdited={configToEdit.newVersionCheck.channel !== config.newVersionCheck.channel}
    {disabled}
  />
  <SettingToggle
    title={$t('frameleaf_versions_external_title')}
    subtitle={$t('frameleaf_versions_external_body')}
    policy={$t('frameleaf_versions_external_policy')}
    checked={false}
    disabled
  />
  <SettingSelect
    label={$t('frameleaf_versions_installed_title')}
    desc={$t('frameleaf_versions_installed_body')}
    value={installedOptions[0].value}
    options={installedOptions}
    name="installed-channel"
    policy={$t('frameleaf_versions_installed_policy')}
    disabled
  />

  <SettingActions keys={['newVersionCheck']} {disabled} />
</form>

<style>
  /* command-center.css `.cc-release-connection` / `.cc-release-status` / `.cc-release-policy` */
  .release-connection {
    display: grid;
    gap: 10px;
    margin-bottom: 8px;
    padding: 14px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    background: var(--fl-raised);
  }
  .release-status {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    color: var(--fl-text);
  }
  .release-status > div {
    flex: 1;
    min-width: 0;
  }
  .release-status p {
    margin: 4px 0 0;
    color: var(--fl-muted);
    font-size: 12.5px;
  }
  .release-badge {
    padding: 2px 8px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--fl-text), transparent 90%);
    color: var(--fl-muted);
    font-size: 11px;
    font-weight: 600;
  }
  .release-policy {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 16px;
    color: var(--fl-muted);
    font-size: 12px;
  }
  .release-policy span {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
</style>
