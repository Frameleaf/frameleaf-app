<script lang="ts">
  /**
   * Versions & compatibility (FL-71), the template's `updates` section (`settings-catalog.mjs`
   * "Versions & compatibility", `CommandCenter.jsx` release panel ~2220-2250). Release
   * infrastructure belongs to the Frameleaf build and server: there is no editable release address
   * and no external fallback feed.
   *
   * - "Check for updates" is the saved `newVersionCheck.enabled`: the server asks Frameleaf's own
   *   GitHub releases every hour (FL-80 S-4 / O-8; owner decision on FL-146, 2026-09-25 — the privacy
   *   direction applied to Immich-origin calls only). The release panel shows the last check and
   *   offers "Check for updates" now (`CommandCenter.jsx:2253-2287` `ReleaseConnection`).
   * - "Update channel" is the saved `newVersionCheck.channel` (Stable or Release candidate, the
   *   server's channels), kept for when checks are allowed.
   * - "Third-party release checks" is the template's locked privacy boundary.
   * - "Installed build channel" is read from the running version.
   *
   * The template's "Check frequency" has no server setting (the server checks hourly), so it is not
   * drawn (recorded in the conformance audit; no API field is invented for it).
   */
  import SettingActions from '$lib/components/frameleaf/settings/SettingActions.svelte';
  import SettingSelect from '$lib/components/frameleaf/settings/SettingSelect.svelte';
  import SettingToggle from '$lib/components/frameleaf/settings/SettingToggle.svelte';
  import { installedReleaseChannel } from '$lib/frameleaf/release-channel';
  import { requireSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import { releaseNotesUrl } from '$lib/frameleaf/version-check';
  import { locale } from '$lib/stores/preferences.store';
  import { websocketStore } from '$lib/stores/websocket';
  import { semverToName } from '$lib/utils';
  import { checkVersionNow, getVersionCheck, ReleaseChannel, type ReleaseEventV1 } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiMagnify, mdiServerOutline, mdiShieldCheckOutline } from '@mdi/js';
  import { DateTime } from 'luxon';
  import { onMount } from 'svelte';
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

  // The last check the server recorded, and the result of "Check for updates" on this page.
  let lastCheckedAt = $state<string | null>(null);
  let checking = $state(false);
  let release = $state<ReleaseEventV1 | 'failed' | undefined>();
  onMount(async () => {
    try {
      lastCheckedAt = (await getVersionCheck()).checkedAt;
    } catch {
      lastCheckedAt = null;
    }
  });
  const checkNow = async () => {
    checking = true;
    try {
      release = await checkVersionNow();
      lastCheckedAt = release.checkedAt;
    } catch {
      release = 'failed';
    } finally {
      checking = false;
    }
  };
  const badge = $derived(
    release === 'failed'
      ? $t('frameleaf_versions_panel_unavailable')
      : release
        ? release.isAvailable
          ? $t('frameleaf_versions_panel_available')
          : $t('frameleaf_versions_panel_current')
        : configToEdit.newVersionCheck.enabled
          ? lastCheckedAt
            ? $t('frameleaf_versions_panel_checked', {
                values: { when: DateTime.fromISO(lastCheckedAt).toRelative({ locale: $locale }) ?? '' },
              })
            : $t('frameleaf_versions_panel_not_checked')
          : $t('frameleaf_versions_panel_off'),
  );

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
      <span class="release-badge">{badge}</span>
    </div>
    <div class="release-policy">
      <span
        ><Icon icon={mdiShieldCheckOutline} size="14" aria-hidden={true} />
        {$t('frameleaf_versions_panel_service')}</span
      >
      <span>{$t('frameleaf_versions_panel_install')}</span>
    </div>
    <div>
      <Button type="button" disabled={checking} onclick={checkNow}>
        <Icon icon={mdiMagnify} size="16" aria-hidden={true} />
        {release ? $t('frameleaf_versions_try_again') : $t('frameleaf_about_check_for_updates')}
      </Button>
    </div>
    {#if release === 'failed'}
      <p class="update-result" role="status">{$t('frameleaf_about_update_failed')}</p>
    {:else if release}
      <p class="update-result" role="status">
        {#if release.isAvailable}
          {$t('frameleaf_about_update_available', {
            values: { version: semverToName(release.releaseVersion), when: $t('frameleaf_about_update_just_now') },
          })}
          <a href={releaseNotesUrl(semverToName(release.releaseVersion))} target="_blank" rel="noopener noreferrer"
            >{$t('frameleaf_about_update_release_notes')}</a
          >
        {:else}
          {$t('frameleaf_about_update_current', { values: { when: $t('frameleaf_about_update_just_now') } })}
        {/if}
      </p>
    {/if}
  </div>

  <SettingToggle
    title={$t('frameleaf_versions_check_title')}
    subtitle={$t('frameleaf_versions_check_body')}
    bind:checked={configToEdit.newVersionCheck.enabled}
    isEdited={configToEdit.newVersionCheck.enabled !== config.newVersionCheck.enabled}
    {disabled}
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
  .update-result {
    margin: 0;
    color: var(--fl-muted);
    font-size: 12.5px;
  }
  .update-result a {
    color: var(--fl-text);
  }
  .release-policy span {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
</style>
