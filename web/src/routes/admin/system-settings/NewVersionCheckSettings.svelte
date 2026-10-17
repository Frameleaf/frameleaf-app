<script lang="ts">
  /**
   * Server & updates › Updates (FL-368, after the approved prototype
   * `settings-v2/server/server-updates.jsx`): the installed version and the answer first (up to
   * date, a newer version, not looking, couldn't check), one "Check now", and the switch and the
   * frequency as one choice: "Look for updates: Never / Every day / Every week".
   *
   * The saved values are unchanged: `newVersionCheck.enabled`, `.frequency` and `.channel`. The
   * server asks only Frameleaf's own release list (FL-80 S-4 / O-8), so the two controls that could
   * never be changed are sentences.
   *
   * Left for later (server work): how to install for this kind of installation, and a line on what
   * is new in a release. The release notes link is offered instead.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import SegmentedControl from '$lib/components/frameleaf/SegmentedControl.svelte';
  import Advanced from '$lib/components/frameleaf/settings/kit/Advanced.svelte';
  import Facts from '$lib/components/frameleaf/settings/kit/Facts.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Links from '$lib/components/frameleaf/settings/kit/Links.svelte';
  import Promises from '$lib/components/frameleaf/settings/kit/Promises.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import { askInstalledVersion, updateState } from '$lib/components/frameleaf/settings/server-settings/update-status';
  import SettingActions from '$lib/components/frameleaf/settings/SettingActions.svelte';
  import { installedReleaseChannel } from '$lib/frameleaf/release-channel';
  import { backupPageUrl, commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { requireSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { releaseNotesUrl } from '$lib/frameleaf/version-check';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import { websocketStore } from '$lib/stores/websocket';
  import { semverToName } from '$lib/utils';
  import { checkVersionNow, getVersionCheck, ReleaseChannel, VersionCheckFrequency } from '@frameleaf/sdk';
  import {
    mdiAlertCircleOutline,
    mdiBackupRestore,
    mdiCheckDecagramOutline,
    mdiHandBackRightOutline,
    mdiLifebuoy,
    mdiShieldCheckOutline,
    mdiUpdate,
  } from '@mdi/js';
  import { DateTime } from 'luxon';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  const { serverVersion } = websocketStore;

  const disabled = $derived(featureFlagsManager.value.configFile);
  const settingsDraft = requireSystemConfigDraft();
  const check = $derived(settingsDraft.draft.newVersionCheck);

  // What the server last recorded, and the result of "Check now" on this page.
  let checkedAt = $state<string | null>(null);
  let newest = $state<string | null>(null);
  let checking = $state(false);
  let failed = $state(false);
  let justChecked = $state(false);

  onMount(async () => {
    try {
      const recorded = await getVersionCheck();
      checkedAt = recorded.checkedAt;
      newest = recorded.releaseVersion;
    } catch {
      // The page still says what is installed; "Check now" asks again.
    }
  });

  const checkNow = async () => {
    checking = true;
    failed = false;
    try {
      const release = await checkVersionNow();
      checkedAt = release.checkedAt;
      newest = semverToName(release.releaseVersion);
      justChecked = true;
    } catch {
      failed = true;
    } finally {
      checking = false;
    }
  };

  let asked = $state<string>();
  onMount(() => void askInstalledVersion().then((name) => (asked = name)));
  const installed = $derived($serverVersion ? semverToName($serverVersion) : asked);
  const version = (name?: string | null) => (name ?? '').replace(/^v/, '');
  const answer = $derived(
    updateState({
      looking: settingsDraft.baseline.newVersionCheck.enabled,
      installed,
      newest,
      checkedAt,
      failed,
      justChecked,
    }),
  );
  const when = $derived(checkedAt ? (DateTime.fromISO(checkedAt).toRelative({ locale: $locale }) ?? '') : '');

  const hero = $derived.by(() => {
    const values = { installed: version(installed), newest: version(newest), when };
    switch (answer) {
      case 'available': {
        return {
          tone: 'warn' as const,
          icon: mdiUpdate,
          title: $t('frameleaf_server_updates_available', { values }),
          body: $t('frameleaf_server_updates_available_body', { values }),
        };
      }
      case 'current': {
        return {
          tone: 'good' as const,
          icon: mdiCheckDecagramOutline,
          title: $t('frameleaf_server_updates_current', { values }),
          body: $t('frameleaf_server_updates_current_body', { values }),
        };
      }
      case 'failed': {
        return {
          tone: 'warn' as const,
          icon: mdiAlertCircleOutline,
          title: $t('frameleaf_server_updates_failed'),
          body: $t('frameleaf_server_updates_failed_body'),
        };
      }
      default: {
        return {
          tone: 'quiet' as const,
          icon: mdiUpdate,
          title: installed
            ? $t('frameleaf_server_updates_running', { values })
            : $t('frameleaf_server_updates_running_unknown'),
          body:
            answer === 'off' ? $t('frameleaf_server_updates_off_body') : $t('frameleaf_server_updates_waiting_body'),
        };
      }
    }
  });

  const facts = $derived([
    { label: $t('frameleaf_server_updates_fact_installed'), value: version(installed) || $t('unknown') },
    ...(newest
      ? [
          {
            label: $t('frameleaf_server_updates_fact_newest'),
            value: version(newest),
            detail: when ? $t('frameleaf_server_updates_fact_checked', { values: { when } }) : undefined,
          },
        ]
      : []),
  ]);

  const look = $derived(check.enabled ? check.frequency : 'never');
  const setLook = (value: string) => {
    if (value === 'never') {
      check.enabled = false;
      return;
    }
    check.enabled = true;
    check.frequency = value as VersionCheckFrequency;
  };
  const lookHelp = $derived(
    look === 'never'
      ? $t('frameleaf_server_updates_look_never_help')
      : look === VersionCheckFrequency.Weekly
        ? $t('frameleaf_server_updates_look_weekly_help')
        : $t('frameleaf_server_updates_look_daily_help'),
  );

  const build = $derived(installedReleaseChannel($serverVersion));
</script>

<KitPage>
  <Hero
    tone={hero.tone}
    icon={hero.icon}
    title={hero.title}
    body={hero.body}
    label={$t('frameleaf_server_updates_label')}
  >
    {#snippet actions()}
      <Button disabled={checking} onclick={checkNow}>
        {checking ? $t('frameleaf_server_updates_checking') : $t('frameleaf_server_updates_check')}
      </Button>
    {/snippet}
  </Hero>

  <Section title={$t('frameleaf_server_updates_versions')}>
    <Facts rows={facts} />
    {#if answer === 'available' && newest}
      <Links
        rows={[
          {
            icon: mdiUpdate,
            title: $t('frameleaf_server_updates_notes'),
            body: $t('frameleaf_server_updates_notes_body', { values: { newest: version(newest) } }),
            href: releaseNotesUrl(newest),
          },
          {
            icon: mdiBackupRestore,
            title: $t('frameleaf_server_updates_before'),
            body: $t('frameleaf_server_updates_before_body'),
            href: backupPageUrl(),
          },
        ]}
      />
    {/if}
  </Section>

  <Section title={$t('frameleaf_server_updates_looking')}>
    <Row label={$t('frameleaf_server_updates_look')} help={lookHelp}>
      <SegmentedControl
        label={$t('frameleaf_server_updates_look')}
        options={[
          { value: 'never', label: $t('frameleaf_server_updates_look_never') },
          { value: VersionCheckFrequency.Daily, label: $t('frameleaf_server_updates_look_daily') },
          { value: VersionCheckFrequency.Weekly, label: $t('frameleaf_server_updates_look_weekly') },
        ]}
        value={look}
        {disabled}
        onChange={setLook}
      />
    </Row>
    <Promises
      rows={[
        {
          icon: mdiShieldCheckOutline,
          text: $t('frameleaf_server_updates_promise_source'),
          detail: $t('frameleaf_server_updates_promise_source_detail'),
        },
        {
          icon: mdiHandBackRightOutline,
          text: $t('frameleaf_server_updates_promise_install'),
          detail: $t('frameleaf_server_updates_promise_install_detail'),
        },
      ]}
    />
    <Advanced>
      <Row label={$t('frameleaf_server_updates_early')} help={$t('frameleaf_server_updates_early_help')}>
        <SegmentedControl
          label={$t('frameleaf_server_updates_early')}
          options={[
            { value: ReleaseChannel.Stable, label: $t('frameleaf_server_updates_early_off') },
            { value: ReleaseChannel.ReleaseCandidate, label: $t('frameleaf_kit_on') },
          ]}
          value={check.channel}
          {disabled}
          onChange={(value) => (settingsDraft.draft.newVersionCheck.channel = value as ReleaseChannel)}
        />
      </Row>
      <Row label={$t('frameleaf_server_updates_build')}>
        <span class="value">
          {build === ReleaseChannel.ReleaseCandidate
            ? $t('frameleaf_server_updates_build_early')
            : build === ReleaseChannel.Stable
              ? $t('frameleaf_server_updates_build_stable')
              : $t('unknown')}
        </span>
      </Row>
    </Advanced>
  </Section>

  <Section title={$t('frameleaf_server_updates_help')}>
    <Links
      stacked
      rows={[
        {
          icon: mdiLifebuoy,
          title: $t('frameleaf_server_updates_problem'),
          body: $t('frameleaf_server_updates_problem_body'),
          href: commandCenterUrl('server', 'logging'),
        },
      ]}
    />
  </Section>

  <SettingActions keys={['newVersionCheck']} {disabled} />
</KitPage>

<style>
  .value {
    font-size: var(--fl-font-callout);
    font-weight: 600;
  }
</style>
