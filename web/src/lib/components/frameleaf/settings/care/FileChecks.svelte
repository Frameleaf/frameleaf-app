<script lang="ts">
  /**
   * File checks (FL-366, after the approved prototype `settings-v2/care/file-checks.jsx`): the one
   * place for "are my original files all there and undamaged?". It replaces Library care → Media
   * health & integrity (with its schedules) and Maintenance → Integrity checks.
   *
   * Three checks named for what they find, one switch each. A switch writes every setting that
   * check is made of today: Missing files is `integrityChecks.missingFiles.enabled` with
   * `libraryCare.healthScan`, Damaged files is `integrityChecks.checksumFiles.enabled` with
   * `libraryCare.checksumScan`, Stray files is `integrityChecks.untrackedFiles.enabled`, and
   * `libraryCare.integrityAudit` follows Missing or Stray. A switch reads on only when all of its
   * settings are on.
   *
   * What was found is listed with its fixes in order of safety: finding the file again or restoring
   * it, then "Clear this list" (forgets the findings, touches nothing), then the destructive action
   * named for what it does, whose confirmation carries the count.
   *
   * FL-520: the counts and the "drive unplugged" signal come from the server's one source of findings
   * (`getIntegrityOverview`): a folder of originals whose drive or share cannot be reached is said as such,
   * instead of being guessed from many missing files in one folder. A running check shows its progress
   * and can be stopped; "Recent checks" lists what each past check found; "Restore from a backup" opens
   * Backup › Restore with the photos behind the missing or damaged findings.
   *
   * When the checks run is the overnight schedule's "Check files" step (FL-363): the start times the
   * server still keeps (`missingFiles.cronExpression`, `checksumFiles.cronExpression`,
   * `untrackedFiles.cronExpression`, `libraryCare.healthScanCronExpression`) no longer start
   * anything, so they are not shown. `?report=<type>` opens one check's
   * path-by-path list (Details for support).
   */
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import OnEvents from '$lib/components/OnEvents.svelte';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import SegmentedControl from '$lib/components/frameleaf/SegmentedControl.svelte';
  import {
    checkSteps,
    restoreUrl,
    shareOf,
    SHARES,
    splitPath,
    STOP_AFTER_MINUTES,
    stopAfterMinutes,
    stopAfterMs,
    unreachableFolder,
    type Share,
  } from '$lib/components/frameleaf/settings/care/file-checks';
  import Advanced from '$lib/components/frameleaf/settings/kit/Advanced.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import Item from '$lib/components/frameleaf/settings/kit/Item.svelte';
  import ItemList from '$lib/components/frameleaf/settings/kit/ItemList.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import HistoryList from '$lib/components/frameleaf/settings/kit/HistoryList.svelte';
  import HistoryRow from '$lib/components/frameleaf/settings/kit/HistoryRow.svelte';
  import Notice from '$lib/components/frameleaf/settings/kit/Notice.svelte';
  import Pill, { type KitTone } from '$lib/components/frameleaf/settings/kit/Pill.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import Select from '$lib/components/frameleaf/settings/kit/Select.svelte';
  import Steps, { type Step } from '$lib/components/frameleaf/settings/kit/Steps.svelte';
  import Switch from '$lib/components/frameleaf/settings/kit/Switch.svelte';
  import TextLink from '$lib/components/frameleaf/settings/kit/TextLink.svelte';
  import { backupWhen } from '$lib/frameleaf/backup-overview';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { requireSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { utilitiesUrl } from '$lib/frameleaf/utilities';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { Route } from '$lib/route';
  import {
    handleClearIntegrityReports,
    handleDismissIntegrityReport,
    handleRemoveAllIntegrityReportItems,
  } from '$lib/services/integrity.service';
  import { handleCreateJob } from '$lib/services/job.service';
  import { handleError } from '$lib/utils/handle-error';
  import { locale } from '$lib/stores/preferences.store';
  import {
    getIntegrityCheckRuns,
    getIntegrityOverview,
    getIntegrityReport,
    getIntegrityReportSummary,
    getQueue,
    QueueName,
    getSummary,
    IntegrityCheckOutcome,
    IntegrityReport,
    ManualJobName,
    stopIntegrityChecks,
    type IntegrityCheckRunsResponseDto,
    type IntegrityOverviewResponseDto,
    type IntegrityReportResponseDto,
    type IntegrityReportSummaryResponseDto,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import {
    mdiChevronRight,
    mdiClockOutline,
    mdiDownload,
    mdiFileAlertOutline,
    mdiFileHidden,
    mdiFileQuestionOutline,
    mdiFolderAlertOutline,
    mdiHarddiskRemove,
    mdiPlayOutline,
    mdiShieldAlertOutline,
    mdiShieldCheckOutline,
    mdiStop,
    mdiSync,
  } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t, type Translations } from 'svelte-i18n';
  import IntegrityReportSection from '../../../../../routes/(user)/user-settings/sections/IntegrityReportSection.svelte';

  type Props = {
    /** How often a running check is followed; tests shorten it. */
    pollMs?: number;
  };
  let { pollMs = 3000 }: Props = $props();

  type CheckId = 'missing' | 'damaged' | 'stray';
  type Check = { id: CheckId; type: IntegrityReport; icon: string; job: ManualJobName };

  /** In the order they run. */
  const CHECKS: readonly Check[] = [
    {
      id: 'missing',
      type: IntegrityReport.MissingFile,
      icon: mdiFileQuestionOutline,
      job: ManualJobName.IntegrityMissingFiles,
    },
    {
      id: 'damaged',
      type: IntegrityReport.ChecksumMismatch,
      icon: mdiFileAlertOutline,
      job: ManualJobName.IntegrityChecksumMismatch,
    },
    {
      id: 'stray',
      type: IntegrityReport.UntrackedFile,
      icon: mdiFileHidden,
      job: ManualJobName.IntegrityUntrackedFiles,
    },
  ];
  const words = (id: CheckId, part: string) => $t(`frameleaf_care_fc_${id}_${part}` as Translations);

  /** How many findings of each list are shown here; the rest are in Details for support. */
  const SHOWN = 3;

  // ---- the settings ----
  const settingsDraft = requireSystemConfigDraft();
  const held = $derived(featureFlagsManager.value.configFile);
  const checks = $derived(settingsDraft.draft.integrityChecks);
  const care = $derived(settingsDraft.draft.libraryCare);

  const isOn = (id: CheckId) => {
    switch (id) {
      case 'missing': {
        return checks.missingFiles.enabled && (care?.healthScan ?? true);
      }
      case 'damaged': {
        return checks.checksumFiles.enabled && (care?.checksumScan ?? true);
      }
      case 'stray': {
        return checks.untrackedFiles.enabled;
      }
    }
  };

  const setOn = (id: CheckId, value: boolean) => {
    const draft = settingsDraft.draft;
    switch (id) {
      case 'missing': {
        draft.integrityChecks.missingFiles.enabled = value;
        if (draft.libraryCare) {
          draft.libraryCare.healthScan = value;
        }
        break;
      }
      case 'damaged': {
        draft.integrityChecks.checksumFiles.enabled = value;
        if (draft.libraryCare) {
          draft.libraryCare.checksumScan = value;
        }
        break;
      }
      case 'stray': {
        draft.integrityChecks.untrackedFiles.enabled = value;
        break;
      }
    }
    if (draft.libraryCare) {
      draft.libraryCare.integrityAudit = isOn('missing') || isOn('stray');
    }
  };
  const allOff = $derived(CHECKS.every((check) => !isOn(check.id)));

  // ---- what the checks found ----
  let summary = $state<IntegrityReportSummaryResponseDto>();
  let runs = $state<IntegrityCheckRunsResponseDto>();
  let overview = $state<IntegrityOverviewResponseDto>();
  let stopping = $state(false);
  let found = $state<Partial<Record<IntegrityReport, IntegrityReportResponseDto>>>({});
  let recoveryAvailable = $state(false);
  let loaded = $state(false);
  let running = $state(false);

  /** An answer, or nothing when the server could not give one. */
  const quietly = async <T,>(call: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await call();
    } catch {
      return undefined;
    }
  };

  const load = async () => {
    const [counts, times, lists, findings] = await Promise.all([
      getIntegrityReportSummary().catch(() => undefined),
      getIntegrityCheckRuns().catch(() => undefined),
      Promise.all(
        CHECKS.map((check) => getIntegrityReport({ $type: check.type, limit: SHOWN }).catch(() => undefined)),
      ),
      quietly(getIntegrityOverview),
    ]);
    summary = counts;
    runs = times;
    overview = findings;
    found = Object.fromEntries(CHECKS.map((check, index) => [check.type, lists[index]]));
    loaded = true;
  };

  onMount(() => {
    void load();
    // Only whether a backup copy can be searched for is needed: the damaged list offers "Restore" then.
    void getSummary({ allAccounts: true })
      .then((care) => (recoveryAvailable = care.recoveryAvailable))
      .catch(() => {});
  });

  // A check that is queued but not picked up yet is running too, or its results would be read early.
  $effect(() => {
    const interval = setInterval(() => {
      void getQueue({ name: QueueName.IntegrityCheck })
        .then(({ statistics: { active, waiting, delayed } }) => {
          const busy = active + waiting + delayed > 0;
          if (!busy && running) {
            void load();
          } else if (busy) {
            // FL-520: how far the running check has got.
            void quietly(getIntegrityOverview).then((value) => (overview = value ?? overview));
          }
          running = busy;
        })
        .catch(() => {});
    }, pollMs);
    return () => clearInterval(interval);
  });

  const count = (type: IntegrityReport) => summary?.[type] ?? 0;
  const missing = $derived(count(IntegrityReport.MissingFile));
  const damaged = $derived(count(IntegrityReport.ChecksumMismatch));
  const stray = $derived(count(IntegrityReport.UntrackedFile));
  const problems = $derived(missing + damaged);
  /** FL-520: a folder of originals the server cannot reach (a drive unplugged, a share not mounted). */
  const unreachable = $derived(unreachableFolder(overview?.unreachable ?? []));
  const unplugged = $derived(unreachable ? unreachable.name || unreachable.path : undefined);
  const rawToMatch = $derived(overview?.rawToMatch ?? 0);

  const lastRun = (type: IntegrityReport) => runs?.[type] ?? null;
  const lastChecked = $derived.by(() => {
    const times = Object.values(runs ?? {})
      .filter((value): value is string => typeof value === 'string')
      .map((value) => new Date(value).getTime())
      .filter((value) => Number.isFinite(value));
    return times.length > 0 ? new Date(Math.max(...times)) : undefined;
  });
  const neverChecked = $derived(!lastChecked && missing + damaged + stray === 0);

  const when = (value: Date | string, sentence = false) => {
    const said = backupWhen(new Date(value), { locale: $locale, sentence });
    return $t(said.key, { values: said.values });
  };

  // ---- the answer ----
  const hero = $derived.by(
    (): { tone: Exclude<KitTone, 'off'> | 'quiet'; icon: string; title: string; body: string } => {
      if (running) {
        return {
          tone: 'good',
          icon: mdiSync,
          title: $t('frameleaf_care_fc_hero_running'),
          body: $t('frameleaf_care_fc_hero_running_body'),
        };
      }
      if (allOff) {
        return {
          tone: 'warn',
          icon: mdiShieldAlertOutline,
          title: $t('frameleaf_care_fc_hero_off'),
          body: $t('frameleaf_care_fc_hero_off_body'),
        };
      }
      if (unplugged) {
        return {
          tone: 'bad',
          icon: mdiHarddiskRemove,
          title: $t('frameleaf_care_fc_hero_unplugged', { values: { count: unreachable?.missing ?? missing } }),
          body: $t('frameleaf_care_fc_hero_unplugged_body', { values: { folder: unplugged } }),
        };
      }
      if (problems > 0) {
        return {
          tone: 'warn',
          icon: mdiShieldAlertOutline,
          title: $t('frameleaf_care_fc_hero_attention', { values: { count: problems } }),
          body: [
            $t('frameleaf_care_fc_hero_attention_body', { values: { missing, damaged } }),
            stray > 0 ? $t('frameleaf_care_fc_hero_attention_stray', { values: { count: stray } }) : '',
            $t('frameleaf_care_fc_hero_nothing_removed'),
          ]
            .filter(Boolean)
            .join(' '),
        };
      }
      if (neverChecked) {
        return {
          tone: 'good',
          icon: mdiClockOutline,
          title: $t('frameleaf_care_fc_hero_new'),
          body: $t('frameleaf_care_fc_hero_new_body'),
        };
      }
      return {
        tone: 'good',
        icon: mdiShieldCheckOutline,
        title: stray > 0 ? $t('frameleaf_care_fc_hero_ok_photos') : $t('frameleaf_care_fc_hero_ok'),
        body: lastChecked
          ? $t('frameleaf_care_fc_hero_ok_body', { values: { when: when(lastChecked, true) } })
          : $t('frameleaf_care_fc_hero_ok_body_unknown'),
      };
    },
  );

  // ---- doing ----
  const checkNow = async (check?: Check) => {
    const chosen = check ? [check] : CHECKS.filter((item) => isOn(item.id));
    for (const item of chosen) {
      if (await handleCreateJob({ name: item.job })) {
        running = true;
      }
    }
  };

  /** FL-520: Stop. Findings so far stay; the damage check carries on next night. */
  const stop = async () => {
    stopping = true;
    try {
      overview = await stopIntegrityChecks();
      running = false;
      await load();
    } catch (error) {
      handleError(error, $t('frameleaf_care_fc_stop_failed'));
    } finally {
      stopping = false;
    }
  };

  /** The three checks as a run: done, now, waiting (in the order the page lists them). */
  const steps = $derived.by((): Step[] =>
    checkSteps(
      CHECKS.filter((check) => isOn(check.id)).map((check) => check.type),
      overview?.running ?? [],
      overview?.history ?? [],
    ).map(({ type, state, percent }) => {
      const check = CHECKS.find((item) => item.type === type)!;
      return {
        title: words(check.id, 'name'),
        state,
        detail:
          state === 'done'
            ? $t('frameleaf_care_fc_step_done')
            : state === 'now'
              ? percent === undefined
                ? $t('frameleaf_care_fc_step_now')
                : $t('frameleaf_care_fc_step_now_percent', { values: { percent } })
              : $t('frameleaf_care_fc_step_waiting'),
      };
    }),
  );

  // ---- Recent checks (FL-520) ----
  type HistoryEntry = IntegrityOverviewResponseDto['history'][number];
  const historyTone = (entry: HistoryEntry): KitTone =>
    entry.outcome === IntegrityCheckOutcome.Stopped ? 'off' : entry.found > 0 ? 'warn' : 'good';
  const historyDetail = (entry: HistoryEntry) => {
    const ms = new Date(entry.finishedAt).getTime() - new Date(entry.startedAt).getTime();
    // a check of a few seconds reads in seconds, never rounded up to a minute
    const took =
      ms < 60_000
        ? $t('frameleaf_care_fc_history_took_seconds', {
            values: { seconds: Math.min(59, Math.max(1, Math.round(ms / 1000))) },
          })
        : $t('frameleaf_care_fc_history_took', { values: { minutes: Math.round(ms / 60_000) } });
    switch (entry.outcome) {
      case IntegrityCheckOutcome.Stopped: {
        return $t('frameleaf_care_fc_history_stopped');
      }
      case IntegrityCheckOutcome.Paused: {
        return $t('frameleaf_care_fc_history_paused', { values: { count: entry.checked ?? 0, took } });
      }
      default: {
        return entry.checked === null
          ? took
          : $t('frameleaf_care_fc_history_read', { values: { count: entry.checked, took } });
      }
    }
  };
  const historyStatus = (entry: HistoryEntry) =>
    entry.outcome === IntegrityCheckOutcome.Stopped
      ? $t('frameleaf_care_fc_history_stopped_status')
      : entry.found > 0
        ? $t('frameleaf_care_fc_found', { values: { count: entry.found } })
        : $t('frameleaf_care_fc_history_nothing');
  const checkName = (type: IntegrityReport) => {
    const check = CHECKS.find((item) => item.type === type);
    return check ? words(check.id, 'name') : type;
  };

  const clearList = async (type: IntegrityReport) => {
    if ((await handleClearIntegrityReports(type)) !== undefined) {
      await load();
    }
  };
  const removeOne = async (id: string) => {
    if (await handleDismissIntegrityReport(id)) {
      await load();
    }
  };
  const actOnAll = (type: IntegrityReport) => handleRemoveAllIntegrityReportItems(type, count(type));
  const onIntegrityReportDeleted = () => void load();

  // ---- the check rows ----
  const checkStatus = (check: Check): { tone: KitTone; status: string; note: string } => {
    const listed = count(check.type);
    const ran = lastRun(check.type);
    if (!isOn(check.id)) {
      return { tone: 'off', status: $t('frameleaf_care_fc_off'), note: words(check.id, 'off') };
    }
    if (listed > 0) {
      return {
        tone: unplugged && check.type === IntegrityReport.MissingFile ? 'bad' : 'warn',
        status: $t('frameleaf_care_fc_found', { values: { count: listed } }),
        note: ran ? $t('frameleaf_care_fc_checked', { values: { when: when(ran) } }) : '',
      };
    }
    if (!ran) {
      return {
        tone: 'off',
        status: $t('frameleaf_care_fc_not_checked'),
        note: $t('frameleaf_care_fc_first_tonight'),
      };
    }
    return {
      tone: 'good',
      status: words(check.id, 'none'),
      note: $t('frameleaf_care_fc_checked', { values: { when: when(ran) } }),
    };
  };

  const shown = (type: IntegrityReport) => (found[type]?.items ?? []).slice(0, SHOWN);
  const more = (type: IntegrityReport) => Math.max(0, count(type) - shown(type).length);

  // ---- Advanced: stop after, how much each night (FL-363: the overnight schedule decides when) ----
  const stopAfter = $derived(stopAfterMinutes(checks.checksumFiles.timeLimit));
  const stopLabel = (minutes: number) =>
    minutes % 60 === 0
      ? $t('frameleaf_care_fc_hours', { values: { count: minutes / 60 } })
      : $t('frameleaf_care_fc_minutes', { values: { count: minutes } });
  const stopOptions = $derived(
    [...new Set([...STOP_AFTER_MINUTES, stopAfter])]
      .sort((a, b) => a - b)
      .map((minutes) => ({ value: String(minutes), label: stopLabel(minutes) })),
  );
  const setStopAfter = (value: string) => {
    settingsDraft.draft.integrityChecks.checksumFiles.timeLimit = stopAfterMs(Number(value));
  };

  const share = $derived(shareOf(checks.checksumFiles.percentageLimit));
  const percent = $derived(Math.round(checks.checksumFiles.percentageLimit * 100));
  const shareOptions = $derived([
    { value: 'whole', label: $t('frameleaf_care_fc_share_whole') },
    { value: 'half', label: $t('frameleaf_care_fc_share_half') },
    { value: 'quarter', label: $t('frameleaf_care_fc_share_quarter') },
    ...(share === 'other'
      ? [{ value: 'other', label: $t('frameleaf_care_fc_share_other', { values: { percent } }) }]
      : []),
  ]);
  const setShare = (value: string) => {
    const chosen = (Object.keys(SHARES) as Share[]).find((key) => key === value);
    if (chosen) {
      settingsDraft.draft.integrityChecks.checksumFiles.percentageLimit = SHARES[chosen];
    }
  };

  const report = $derived(Object.values(IntegrityReport).find((type) => type === page.url.searchParams.get('report')));
  // A list opens on the page it was asked for from (Library care, or Maintenance's address for the
  // same page), so its "‹ File checks" goes back to where the person came from (ADMIN-P9).
  const reportUrl = (type: IntegrityReport) =>
    page.url.searchParams.get('area') === 'maintenance'
      ? commandCenterUrl('maintenance', 'integrity', { report: type })
      : commandCenterUrl('care', 'integrity-checks', { report: type });
</script>

<OnEvents {onIntegrityReportDeleted} />

{#if report}
  <IntegrityReportSection type={report} />
{:else}
  <KitPage>
    <Hero
      tone={loaded ? hero.tone : 'quiet'}
      icon={hero.icon}
      title={loaded ? hero.title : $t('frameleaf_care_fc_loading')}
      body={loaded ? hero.body : undefined}
      label={$t('frameleaf_care_fc_hero_label')}
    >
      {#snippet actions()}
        {#if running}
          <Button disabled={stopping} onclick={stop}>
            <Icon icon={mdiStop} size="1em" aria-hidden />
            {$t('frameleaf_care_fc_stop')}
          </Button>
        {:else if loaded && !allOff}
          <Button variant={problems === 0 || unplugged ? 'primary' : 'default'} onclick={() => checkNow()}>
            <Icon icon={mdiPlayOutline} size="1em" aria-hidden />
            {problems > 0 ? $t('frameleaf_care_fc_check_again') : $t('frameleaf_care_fc_check_now')}
          </Button>
        {/if}
      {/snippet}
      {#if running && steps.length > 0}
        <div class="steps">
          <Steps {steps} label={$t('frameleaf_care_fc_steps_label')} />
        </div>
      {/if}
    </Hero>

    {#if missing > 0}
      <Section
        title={$t('frameleaf_care_fc_missing_title', { values: { count: missing } })}
        description={unplugged
          ? $t('frameleaf_care_fc_missing_unplugged_description')
          : $t('frameleaf_care_fc_missing_description', { values: { count: missing } })}
      >
        {#if unplugged}
          <Notice tone="warn" title={$t('frameleaf_care_fc_unplugged_notice')}>
            {$t('frameleaf_care_fc_unplugged_notice_body')}
            {#snippet action()}
              <Button onclick={() => checkNow(CHECKS[0])}>{$t('frameleaf_care_fc_check_again')}</Button>
            {/snippet}
          </Notice>
          <ItemList>
            <Item
              icon={mdiFolderAlertOutline}
              name={unplugged}
              detail={$t('frameleaf_care_fc_folder_count', { values: { count: missing } })}
              tone="bad"
              status={$t('frameleaf_care_fc_folder_unreachable')}
            />
          </ItemList>
        {:else}
          {@render findings(IntegrityReport.MissingFile, mdiFileQuestionOutline, $t('frameleaf_care_fc_not_on_drive'))}
        {/if}
        {#if rawToMatch > 0}
          <p class="hint raw">{$t('frameleaf_care_fc_raw_to_match', { values: { count: rawToMatch } })}</p>
        {/if}
        <div class="actions">
          <Button variant="primary" onclick={() => goto(utilitiesUrl('missing-media', { from: 'care' }))}>
            {$t('frameleaf_care_fc_find_again', { values: { count: missing } })}
          </Button>
          <Button onclick={() => goto(restoreUrl('missing'))}>{$t('frameleaf_care_fc_restore')}</Button>
          <Button onclick={() => clearList(IntegrityReport.MissingFile)}>{$t('frameleaf_care_fc_clear')}</Button>
          <Button variant="danger" onclick={() => actOnAll(IntegrityReport.MissingFile)}>
            {$t('frameleaf_care_fc_trash', { values: { count: missing } })}
          </Button>
        </div>
      </Section>
    {/if}

    {#if damaged > 0}
      <Section
        title={$t('frameleaf_care_fc_damaged_title', { values: { count: damaged } })}
        description={$t('frameleaf_care_fc_damaged_description', { values: { count: damaged } })}
      >
        {@render findings(IntegrityReport.ChecksumMismatch, mdiFileAlertOutline, $t('frameleaf_care_fc_changed'))}
        <div class="actions">
          <Button variant="primary" onclick={() => goto(restoreUrl('damaged'))}
            >{$t('frameleaf_care_fc_restore')}</Button
          >
          <Button onclick={() => goto(utilitiesUrl('corrupt-media', { from: 'care' }))}>
            {recoveryAvailable ? $t('frameleaf_care_fc_look_copies') : $t('frameleaf_care_fc_look')}
          </Button>
          <Button onclick={() => clearList(IntegrityReport.ChecksumMismatch)}>{$t('frameleaf_care_fc_clear')}</Button>
          <Button variant="danger" onclick={() => actOnAll(IntegrityReport.ChecksumMismatch)}>
            {$t('frameleaf_care_fc_trash', { values: { count: damaged } })}
          </Button>
        </div>
      </Section>
    {/if}

    {#if stray > 0}
      <Section
        title={$t('frameleaf_care_fc_stray_title', { values: { count: stray } })}
        description={$t('frameleaf_care_fc_stray_description')}
      >
        {@render findings(IntegrityReport.UntrackedFile, mdiFileHidden, $t('frameleaf_care_fc_not_in_library'))}
        <div class="actions">
          <Button onclick={() => clearList(IntegrityReport.UntrackedFile)}>{$t('frameleaf_care_fc_clear')}</Button>
          <Button variant="danger" onclick={() => actOnAll(IntegrityReport.UntrackedFile)}>
            {$t('frameleaf_care_fc_delete', { values: { count: stray } })}
          </Button>
        </div>
      </Section>
    {/if}

    <Section title={$t('frameleaf_care_fc_checks_title')} description={$t('frameleaf_care_fc_checks_description')}>
      <ItemList>
        {#each CHECKS as check (check.id)}
          {@const state = checkStatus(check)}
          {@const name = words(check.id, 'name')}
          <Item
            icon={check.icon}
            off={!isOn(check.id)}
            {name}
            detail={words(check.id, 'detail')}
            tone={loaded ? state.tone : 'off'}
            status={loaded ? state.status : undefined}
            note={loaded ? state.note : undefined}
          >
            {#snippet measure()}
              <Switch
                label={$t('frameleaf_care_fc_look_for', { values: { name } })}
                checked={isOn(check.id)}
                {held}
                onChange={(value) => setOn(check.id, value)}
              />
            {/snippet}
            {#snippet action()}
              {#if isOn(check.id)}
                <Button
                  label={$t('frameleaf_care_fc_check_named', { values: { name } })}
                  disabled={running}
                  onclick={() => checkNow(check)}
                >
                  {$t('frameleaf_care_fc_check_now')}
                </Button>
              {/if}
            {/snippet}
          </Item>
        {/each}
      </ItemList>
    </Section>

    <Section title={$t('frameleaf_care_fc_when_title')}>
      <Row label={$t('frameleaf_care_overnight')} help={$t('frameleaf_care_fc_overnight_help')}>
        <Button onclick={() => goto(commandCenterUrl('processing', 'nightly-tasks'))}>
          {$t('frameleaf_care_overnight_open')}<Icon icon={mdiChevronRight} size="1em" aria-hidden />
        </Button>
      </Row>
      <Advanced summary={$t('frameleaf_care_fc_advanced')}>
        <p class="hint">{$t('frameleaf_care_fc_advanced_hint')}</p>
        <Row label={$t('frameleaf_care_fc_stop_after')} help={$t('frameleaf_care_fc_stop_after_help')}>
          <Select
            label={$t('frameleaf_care_fc_stop_after')}
            value={String(stopAfter)}
            options={stopOptions}
            disabled={held}
            onChange={setStopAfter}
          />
        </Row>
        <Row
          label={$t('frameleaf_care_fc_share')}
          help={share === 'other'
            ? $t('frameleaf_care_fc_share_other_help', { values: { percent } })
            : $t(`frameleaf_care_fc_share_${share}_help` as Translations)}
        >
          <SegmentedControl
            label={$t('frameleaf_care_fc_share_label')}
            options={shareOptions}
            value={share}
            disabled={held}
            onChange={setShare}
          />
        </Row>
      </Advanced>
      <Advanced summary={$t('frameleaf_care_fc_support')}>
        <p class="hint">{$t('frameleaf_care_fc_support_hint')}</p>
        {#if missing + damaged + stray === 0}
          <p class="hint">{$t('frameleaf_care_fc_support_empty')}</p>
        {:else}
          <ul class="support">
            {#each CHECKS.filter((check) => count(check.type) > 0) as check (check.id)}
              {@const name = words(check.id, 'name')}
              <li>
                <strong>{name}</strong>
                <span>{$t('frameleaf_care_fc_found', { values: { count: count(check.type) } })}</span>
                <TextLink href={reportUrl(check.type)}>{$t('frameleaf_care_fc_support_paths')}</TextLink>
                <a class="download" href={Route.integrityReportCsv(check.type)} download>
                  <Icon icon={mdiDownload} size="1em" aria-hidden />
                  {$t('frameleaf_care_fc_support_csv', { values: { name } })}
                </a>
              </li>
            {/each}
          </ul>
        {/if}
      </Advanced>
    </Section>

    <Section title={$t('frameleaf_care_fc_history_title')}>
      {#if (overview?.history ?? []).length === 0}
        <Notice tone="info" title={$t('frameleaf_care_fc_history_none')}>
          {$t('frameleaf_care_fc_history_none_body')}
        </Notice>
      {:else}
        <HistoryList>
          {#each overview?.history ?? [] as entry (entry.type + entry.finishedAt)}
            <HistoryRow
              when={when(entry.finishedAt)}
              datetime={entry.finishedAt}
              what={checkName(entry.type)}
              detail={historyDetail(entry)}
            >
              <Pill tone={historyTone(entry)}>{historyStatus(entry)}</Pill>
            </HistoryRow>
          {/each}
        </HistoryList>
      {/if}
    </Section>
  </KitPage>
{/if}

{#snippet findings(type: IntegrityReport, icon: string, status: string)}
  <ItemList>
    {#each shown(type) as finding (finding.id)}
      {@const where = splitPath(finding.path)}
      <Item {icon} name={where.name} detail={where.folder} tone="warn" {status}>
        {#snippet action()}
          <Button
            variant="quiet"
            label={$t('frameleaf_care_fc_remove_named', { values: { name: where.name } })}
            onclick={() => removeOne(finding.id)}
          >
            {$t('frameleaf_care_fc_remove')}
          </Button>
        {/snippet}
      </Item>
    {/each}
  </ItemList>
  {#if more(type) > 0}
    <p class="hint">
      <TextLink href={reportUrl(type)}>{$t('frameleaf_care_fc_more', { values: { count: more(type) } })}</TextLink>
    </p>
  {/if}
{/snippet}

<style>
  .steps {
    padding: 0 var(--fl-space-6) var(--fl-space-6);
  }
  @container kit (max-width: 620px) {
    .steps {
      padding: 0 var(--fl-space-4) var(--fl-space-4);
    }
  }
  .raw {
    margin-top: var(--fl-space-3);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fl-space-2);
    margin-top: var(--fl-space-3);
  }
  .hint {
    margin: 0 0 var(--fl-space-3);
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.5;
  }
  .support {
    display: grid;
    gap: var(--fl-space-3);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .support li {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--fl-space-2) var(--fl-space-3);
    font-size: var(--fl-font-small);
  }
  .support span {
    color: var(--fl-muted);
  }
  .download {
    display: inline-flex;
    align-items: center;
    gap: var(--fl-space-1);
    color: var(--fl-accent);
  }
</style>
