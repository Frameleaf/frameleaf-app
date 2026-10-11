<script lang="ts">
  /**
   * Server & updates › Troubleshooting (FL-368, after the approved prototype
   * `settings-v2/server/server-updates.jsx`): the action first ("Download a report", with what it
   * includes and never includes), then how much the server records as Normal or Detailed. The six
   * exact levels stay behind Advanced. The saved values are unchanged (`logging`, `analytics`).
   *
   * The report is the file `lib/frameleaf/diagnostics.ts` builds in the browser from what this
   * administrator can read, with every credential emptied.
   *
   * The two Library analytics controls stay here in a group of their own until that page takes them.
   * Left for later (server work): what the server recorded lately inside the report, and how long
   * Detailed has been on.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import SegmentedControl from '$lib/components/frameleaf/SegmentedControl.svelte';
  import Advanced from '$lib/components/frameleaf/settings/kit/Advanced.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Points from '$lib/components/frameleaf/settings/kit/Points.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import Select from '$lib/components/frameleaf/settings/kit/Select.svelte';
  import Switch from '$lib/components/frameleaf/settings/kit/Switch.svelte';
  import SettingActions from '$lib/components/frameleaf/settings/SettingActions.svelte';
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
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiDownload } from '@mdi/js';
  import { t, type Translations } from 'svelte-i18n';

  const disabled = $derived(featureFlagsManager.value.configFile);
  const settingsDraft = requireSystemConfigDraft();
  const logging = $derived(settingsDraft.draft.logging);

  // The server always returns `analytics`; the DTO marks it optional only because it has a default.
  const analyticsDefault = { enabled: true, historyDays: 730 };
  const analytics = $derived(settingsDraft.draft.analytics ?? analyticsDefault);

  const HISTORY = [
    { value: '90', label: 'frameleaf_diagnostics_history_90_days' },
    { value: '365', label: 'frameleaf_diagnostics_history_12_months' },
    { value: '730', label: 'frameleaf_diagnostics_history_24_months' },
  ] as const;

  /** Normal is the level called "Log", Detailed is "Debug"; any other level is shown as it is. */
  const LEVELS = [LogLevel.Fatal, LogLevel.Error, LogLevel.Warn, LogLevel.Log, LogLevel.Debug, LogLevel.Verbose];
  const levelName = (level: LogLevel) => $t(`frameleaf_srvadv_trouble_level_${level}` as Translations);
  const amount = $derived(
    logging.level === LogLevel.Log ? 'normal' : logging.level === LogLevel.Debug ? 'detailed' : 'exact',
  );

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

<KitPage>
  <Section
    title={$t('frameleaf_srvadv_trouble_report')}
    description={$t('frameleaf_srvadv_trouble_report_description')}
  >
    {#snippet action()}
      <Button variant="primary" disabled={downloading} onclick={downloadDiagnostics}>
        <Icon icon={mdiDownload} size="1em" aria-hidden={true} />
        {$t('frameleaf_srvadv_trouble_download')}
      </Button>
    {/snippet}
    <Points
      label={$t('frameleaf_srvadv_trouble_includes')}
      rows={[
        { text: $t('frameleaf_srvadv_trouble_in_version') },
        { text: $t('frameleaf_srvadv_trouble_in_storage') },
        { text: $t('frameleaf_srvadv_trouble_in_work') },
        { text: $t('frameleaf_srvadv_trouble_in_settings') },
        { text: $t('frameleaf_srvadv_trouble_out_photos'), not: true },
        { text: $t('frameleaf_srvadv_trouble_out_secrets'), not: true },
      ]}
    />
  </Section>

  <Section
    title={$t('frameleaf_srvadv_trouble_records')}
    description={$t('frameleaf_srvadv_trouble_records_description')}
  >
    <Row
      label={$t('frameleaf_srvadv_trouble_keep')}
      help={logging.enabled ? $t('frameleaf_srvadv_trouble_keep_on') : $t('frameleaf_srvadv_trouble_keep_off')}
    >
      <Switch
        label={$t('frameleaf_srvadv_trouble_keep')}
        checked={logging.enabled}
        held={disabled}
        onChange={(value) => (settingsDraft.draft.logging.enabled = value)}
      />
    </Row>
    <Row
      label={$t('frameleaf_srvadv_trouble_amount')}
      help={amount === 'detailed'
        ? $t('frameleaf_srvadv_trouble_amount_detailed')
        : amount === 'normal'
          ? $t('frameleaf_srvadv_trouble_amount_normal')
          : $t('frameleaf_srvadv_trouble_amount_exact', { values: { level: levelName(logging.level) } })}
    >
      <SegmentedControl
        label={$t('frameleaf_srvadv_trouble_amount')}
        options={[
          { value: 'normal', label: $t('frameleaf_srvadv_trouble_normal') },
          { value: 'detailed', label: $t('frameleaf_srvadv_trouble_detailed') },
          ...(amount === 'exact' ? [{ value: 'exact', label: levelName(logging.level) }] : []),
        ]}
        value={amount}
        disabled={disabled || !logging.enabled}
        onChange={(value) => {
          if (value !== 'exact') {
            settingsDraft.draft.logging.level = value === 'normal' ? LogLevel.Log : LogLevel.Debug;
          }
        }}
      />
    </Row>
    <Advanced>
      <Row label={$t('frameleaf_srvadv_trouble_exact')} help={$t('frameleaf_srvadv_trouble_exact_help')}>
        <Select
          label={$t('frameleaf_srvadv_trouble_exact')}
          value={logging.level}
          options={LEVELS.map((level) => ({ value: level, label: levelName(level) }))}
          disabled={disabled || !logging.enabled}
          onChange={(value) => (settingsDraft.draft.logging.level = value as LogLevel)}
        />
      </Row>
    </Advanced>
  </Section>

  <Section
    title={$t('frameleaf_srvadv_trouble_analytics')}
    description={$t('frameleaf_srvadv_trouble_analytics_description')}
  >
    <Row
      label={$t('frameleaf_srvadv_trouble_analytics_keep')}
      help={$t('frameleaf_srvadv_trouble_analytics_keep_help')}
    >
      <Switch
        label={$t('frameleaf_srvadv_trouble_analytics_keep')}
        checked={analytics.enabled}
        held={disabled}
        onChange={(value) => (analytics.enabled = value)}
      />
    </Row>
    <Row label={$t('frameleaf_srvadv_trouble_analytics_for')}>
      <Select
        label={$t('frameleaf_srvadv_trouble_analytics_for')}
        value={String(analytics.historyDays)}
        options={[
          ...HISTORY.map((option) => ({ value: option.value, label: $t(option.label) })),
          // A length saved outside the three choices is shown as it is and kept.
          ...(HISTORY.some((option) => option.value === String(analytics.historyDays))
            ? []
            : [
                {
                  value: String(analytics.historyDays),
                  label: $t('frameleaf_srvadv_trouble_analytics_days', { values: { count: analytics.historyDays } }),
                },
              ]),
        ]}
        disabled={disabled || !analytics.enabled}
        onChange={(value) => (analytics.historyDays = Number(value))}
      />
    </Row>
  </Section>

  <SettingActions keys={['logging', 'analytics']} {disabled} />
</KitPage>
