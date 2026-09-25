<script lang="ts">
  /**
   * Logs & diagnostics (FL-71), the template's `diagnostics` section (`settings-catalog.mjs`
   * "Logs & diagnostics"): the log switch and level, the locked "External telemetry" row (this server
   * never sends telemetry to a reporting service), the local analytics collector with how long its
   * history is kept (`analytics`), and "Download diagnostics" (`lib/frameleaf/diagnostics.ts`), a
   * file built in the browser from what this administrator can read, with every credential emptied.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import SettingActions from '$lib/components/frameleaf/settings/SettingActions.svelte';
  import SettingSelect from '$lib/components/frameleaf/settings/SettingSelect.svelte';
  import SettingToggle from '$lib/components/frameleaf/settings/SettingToggle.svelte';
  import { buildDiagnostics, diagnosticsFileName } from '$lib/frameleaf/diagnostics';
  import { requireSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { downloadBlob } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import {
    getAboutInfo,
    getConfig,
    getQueues,
    getServerFeatures,
    getServerVersion,
    getStorage,
    LogLevel,
  } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiDownload } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import { fade } from 'svelte/transition';

  const disabled = $derived(featureFlagsManager.value.configFile);
  const settingsDraft = requireSystemConfigDraft();
  const configToEdit = $derived(settingsDraft.draft);
  const config = $derived(settingsDraft.baseline);
  // The server always returns `analytics`; the DTO marks it optional only because it has a default.
  const analyticsDefault = { enabled: true, historyDays: 730 };
  const analytics = $derived(configToEdit.analytics ?? analyticsDefault);
  const savedAnalytics = $derived(config.analytics ?? analyticsDefault);

  // The template's "Keep analytics history for" choices, in days.
  const historyOptions = $derived([
    { value: 90, text: $t('frameleaf_diagnostics_history_90_days') },
    { value: 365, text: $t('frameleaf_diagnostics_history_12_months') },
    { value: 730, text: $t('frameleaf_diagnostics_history_24_months') },
  ]);

  let downloading = $state(false);
  const downloadDiagnostics = async () => {
    downloading = true;
    try {
      const generatedAt = new Date();
      const [about, version, features, storage, queues, saved] = await Promise.all([
        getAboutInfo(),
        getServerVersion(),
        getServerFeatures(),
        getStorage(),
        getQueues(),
        getConfig(),
      ]);
      const diagnostics = buildDiagnostics({ generatedAt, about, version, features, storage, queues, config: saved });
      downloadBlob(
        new Blob([JSON.stringify(diagnostics, null, 2)], { type: 'application/json' }),
        diagnosticsFileName(generatedAt),
      );
    } catch (error) {
      handleError(error, $t('frameleaf_diagnostics_download_failed'));
    } finally {
      downloading = false;
    }
  };
</script>

<div>
  <div in:fade={{ duration: 500 }}>
    <form autocomplete="off" onsubmit={(event) => event.preventDefault()}>
      <div class="flex flex-col gap-4">
        <SettingToggle
          title={$t('admin.logging_enable_description')}
          {disabled}
          bind:checked={configToEdit.logging.enabled}
        />
        <SettingSelect
          label={$t('level')}
          desc={$t('admin.logging_level_description')}
          bind:value={configToEdit.logging.level}
          options={[
            { value: LogLevel.Fatal, text: 'Fatal' },
            { value: LogLevel.Error, text: 'Error' },
            { value: LogLevel.Warn, text: 'Warn' },
            { value: LogLevel.Log, text: 'Log' },
            { value: LogLevel.Debug, text: 'Debug' },
            { value: LogLevel.Verbose, text: 'Verbose' },
          ]}
          name="level"
          isEdited={configToEdit.logging.level !== config.logging.level}
          disabled={disabled || !configToEdit.logging.enabled}
        />
        <SettingToggle
          title={$t('frameleaf_diagnostics_telemetry_title')}
          subtitle={$t('frameleaf_diagnostics_telemetry_body')}
          policy={$t('frameleaf_diagnostics_telemetry_policy')}
          checked={false}
          disabled
        />
        <SettingToggle
          title={$t('frameleaf_diagnostics_local_title')}
          subtitle={$t('frameleaf_diagnostics_local_body')}
          {disabled}
          bind:checked={analytics.enabled}
          isEdited={analytics.enabled !== savedAnalytics.enabled}
        />
        <SettingSelect
          label={$t('frameleaf_diagnostics_history_title')}
          desc={$t('frameleaf_diagnostics_history_body')}
          bind:value={analytics.historyDays}
          options={historyOptions}
          name="analytics-history"
          number
          isEdited={analytics.historyDays !== savedAnalytics.historyDays}
          disabled={disabled || !analytics.enabled}
        />

        <div class="diagnostics-action">
          <div>
            <strong>{$t('frameleaf_diagnostics_download_title')}</strong>
            <p>{$t('frameleaf_diagnostics_download_body')}</p>
          </div>
          <Button disabled={downloading} onclick={downloadDiagnostics}>
            <Icon icon={mdiDownload} size="1em" aria-hidden={true} />
            {$t('frameleaf_diagnostics_download')}
          </Button>
        </div>

        <SettingActions keys={['logging', 'analytics']} {disabled} />
      </div>
    </form>
  </div>
</div>

<style>
  /* The template's section action row (`CommandCenter.jsx` `actionKind: "diagnostics"`). */
  .diagnostics-action {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 14px 0;
    border-top: 1px solid var(--fl-border);
  }
  .diagnostics-action strong {
    color: var(--fl-text);
    font-size: 14px;
    font-weight: 500;
  }
  .diagnostics-action p {
    margin: 4px 0 0;
    color: var(--fl-muted);
    font-size: 12.5px;
    line-height: 1.45;
  }
</style>
