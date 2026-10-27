<script lang="ts">
  /**
   * Computers & background work › Overnight schedule (FL-363, the approved prototype's
   * `settings-v2/overnight/Schedule.jsx`). The server's own night work on one schedule: empty Trash
   * and tidy up, check added folders, bring in new iCloud photos, check files, one after another
   * (`OvernightService`). It opens on how last night went, then when the work runs (a start time, a
   * stop time, the days), the order of the night beside it, Backup's own schedule mirrored read-only,
   * the tidy-up's choices, recent nights and where each step is set up.
   *
   * The schedule is an ordinary setting (`nightlyTasks`): a change is kept in the settings draft and
   * saved with the settings bar. Nothing on this page is a schedule expression.
   *
   * Not built here (recorded on FL-363): "Save heavy background work for the night" (no such server
   * setting yet) and the two schedules waiting for each other when they overlap; the page warns
   * instead when they start close together.
   */
  import { goto } from '$app/navigation';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import SegmentedControl from '$lib/components/frameleaf/SegmentedControl.svelte';
  import Advanced from '$lib/components/frameleaf/settings/kit/Advanced.svelte';
  import Coverage, { type CoverageRow } from '$lib/components/frameleaf/settings/kit/Coverage.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import HistoryList from '$lib/components/frameleaf/settings/kit/HistoryList.svelte';
  import HistoryRow from '$lib/components/frameleaf/settings/kit/HistoryRow.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Links, { type LinkRow } from '$lib/components/frameleaf/settings/kit/Links.svelte';
  import Notice from '$lib/components/frameleaf/settings/kit/Notice.svelte';
  import Pill, { type KitTone } from '$lib/components/frameleaf/settings/kit/Pill.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import Said from '$lib/components/frameleaf/settings/kit/Said.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import Steps, { type Step } from '$lib/components/frameleaf/settings/kit/Steps.svelte';
  import Switch from '$lib/components/frameleaf/settings/kit/Switch.svelte';
  import {
    OVERNIGHT_STEP_IDS,
    nightOutcome,
    overnightWords,
    startsNearBackups,
    type OvernightStepId,
  } from '$lib/components/frameleaf/settings/overnight/overnight';
  import { BACKUP_PLACE_COPY } from '$lib/components/frameleaf/backup/backup-places';
  import {
    clockTime,
    cronToSchedule,
    dayName,
    scheduleWords,
    viewerTime,
    WEEK_DAYS,
  } from '$lib/frameleaf/backup-schedule';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { getSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import {
    getBackupSchedule,
    getOvernight,
    OvernightStepTiming,
    runOvernight,
    stopOvernight,
    type BackupScheduleResponseDto,
    type OvernightResponseDto,
  } from '@frameleaf/sdk';
  import {
    mdiAlertCircleOutline,
    mdiClockOutline,
    mdiCloudDownloadOutline,
    mdiFolderOutline,
    mdiHistory,
    mdiPlayOutline,
    mdiProgressClock,
    mdiShieldCheckOutline,
    mdiStop,
    mdiSync,
    mdiTrashCanOutline,
    mdiWeatherNight,
  } from '@mdi/js';
  import { Icon } from '@frameleaf/ui';
  import { onMount } from 'svelte';
  import { t, type Translations } from 'svelte-i18n';

  let status = $state<OvernightResponseDto | null>(null);
  let backup = $state<BackupScheduleResponseDto | null>(null);
  let failed = $state(false);
  let said = $state('');
  let busy = $state(false);

  const load = async () => {
    failed = false;
    try {
      [status, backup] = await Promise.all([getOvernight(), getBackupSchedule().catch(() => null)]);
    } catch {
      failed = true;
    }
  };
  onMount(() => {
    void load();
    // A run in progress moves on by itself; the page follows it while it is open.
    const timer = setInterval(() => {
      if (status?.run) {
        void load();
      }
    }, 30_000);
    return () => clearInterval(timer);
  });

  const settingsDraft = getSystemConfigDraft();
  const nightly = $derived(settingsDraft?.draft.nightlyTasks);
  const disabled = $derived(featureFlagsManager.value.configFile || !nightly);
  const trashDays = $derived(settingsDraft?.draft.trash.days ?? 30);
  const trashOn = $derived(settingsDraft?.draft.trash.enabled ?? true);

  const startTime = $derived(nightly?.startTime ?? '00:00');
  const stopTime = $derived(nightly?.stopTime ?? '');
  const days = $derived(nightly?.days ?? [...WEEK_DAYS]);
  const someDays = $derived(days.length > 0 && days.length < 7);
  const time = (value: string) => clockTime(value, $locale);
  const zone = $derived(status?.timezone ?? '');
  const viewerZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  const yours = $derived(zone ? viewerTime(startTime, zone, viewerZone) : undefined);

  const setDays = (next: number[]) => {
    if (nightly && next.length > 0) {
      nightly.days = [...new Set(next)].sort((a, b) => a - b);
    }
  };
  const setEvery = (every: string) => setDays(every === 'night' ? [...WEEK_DAYS] : [0, 3]);
  const toggleDay = (day: number) => setDays(days.includes(day) ? days.filter((item) => item !== day) : [...days, day]);
  const setTime = (key: 'startTime' | 'stopTime', value: string) => {
    if (nightly && /^\d{2}:\d{2}/.test(value)) {
      nightly[key] = value.slice(0, 5);
    }
  };

  // ---- the steps ----
  const stepName = (id: OvernightStepId) => $t(`frameleaf_overnight_step_${id}` as Translations);
  const stepWhat = (id: OvernightStepId) =>
    id === 'cleanup'
      ? nightly?.emptyTrash === false || !trashOn
        ? $t('frameleaf_overnight_step_cleanup_tidy_what')
        : $t('frameleaf_overnight_step_cleanup_what', { values: { days: trashDays } })
      : $t(`frameleaf_overnight_step_${id}_what` as Translations);
  const timingOf = (id: OvernightStepId) => nightly?.steps?.[id] ?? OvernightStepTiming.Nightly;
  /** A step that is set up: the tidy-up always is; the others once there is something for them to do. */
  const present = $derived(
    OVERNIGHT_STEP_IDS.filter((id) => id === 'cleanup' || status?.steps.find((step) => step.id === id)?.on),
  );
  const tidyOn = $derived(nightly?.databaseCleanup ?? true);
  const orderSteps = $derived<Step[]>(
    present
      .filter((id) => timingOf(id) !== OvernightStepTiming.Manual)
      .map((id, index) => {
        const off = id === 'cleanup' && !tidyOn;
        const weekly = timingOf(id) === OvernightStepTiming.Weekly;
        const runStep = status?.run;
        const result = runStep?.results[id];
        const state: Step['state'] = runStep ? (result ? 'done' : runStep.step === id ? 'now' : 'waiting') : undefined;
        const when = off
          ? $t('frameleaf_overnight_step_switched_off')
          : weekly
            ? $t('frameleaf_overnight_step_weekly', { values: { day: dayName(nightly?.weeklyDay ?? 0, $locale) } })
            : index === 0
              ? $t('frameleaf_overnight_step_starts', { values: { time: time(startTime) } })
              : $t('frameleaf_overnight_step_then');
        // FL-540: a step that uses the disk or the internet waits while a backup runs
        const waitsForBackup = state === 'now' && !!runStep?.waitingForBackupSince;
        return {
          title: stepName(id),
          detail: waitsForBackup
            ? `${$t('frameleaf_overnight_step_waits_backup')} · ${stepWhat(id)}`
            : `${when} · ${off ? $t('frameleaf_overnight_trash_kept') : stepWhat(id)}`,
          state,
        };
      }),
  );
  const manualSteps = $derived(present.filter((id) => timingOf(id) === OvernightStepTiming.Manual));

  // ---- the status at the top ----
  const lastNight = $derived(status?.nights[0]);
  const outcome = $derived(lastNight ? nightOutcome(lastNight.results) : null);
  const finishedAt = (iso: string) =>
    new Intl.DateTimeFormat($locale, { hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
  const nextStart = $derived(
    status?.nextRunAt
      ? new Intl.DateTimeFormat($locale, { weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(
          new Date(status.nextRunAt),
        )
      : time(startTime),
  );

  const hero = $derived.by((): { tone: Exclude<KitTone, 'off'>; icon: string; title: string; body: string } => {
    if (status?.run?.waitingForBackupSince) {
      return {
        tone: 'warn',
        icon: mdiSync,
        title: $t('frameleaf_overnight_hero_waiting_backup'),
        body: $t('frameleaf_overnight_hero_waiting_backup_body', { values: { step: stepName(status.run.step) } }),
      };
    }
    if (status?.run) {
      const position = OVERNIGHT_STEP_IDS.indexOf(status.run.step) + 1;
      return {
        tone: 'good',
        icon: mdiSync,
        title: $t('frameleaf_overnight_hero_running'),
        body: $t('frameleaf_overnight_hero_running_body', {
          values: { step: stepName(status.run.step), position, total: OVERNIGHT_STEP_IDS.length },
        }),
      };
    }
    if (!lastNight || !outcome) {
      return {
        tone: 'good',
        icon: mdiWeatherNight,
        title: $t('frameleaf_overnight_hero_first'),
        body: $t('frameleaf_overnight_hero_first_body', { values: { time: nextStart } }),
      };
    }
    if (outcome.problem) {
      return {
        tone: 'warn',
        icon: mdiAlertCircleOutline,
        title: $t('frameleaf_overnight_hero_attention', { values: { count: outcome.notFinished.length } }),
        body: $t('frameleaf_overnight_hero_attention_body', {
          values: { steps: list(outcome.notFinished.map((id) => stepName(id))), time: nextStart },
        }),
      };
    }
    return {
      tone: 'good',
      icon: mdiWeatherNight,
      title: $t('frameleaf_overnight_hero_ok', { values: { time: finishedAt(lastNight.finishedAt) } }),
      body: $t('frameleaf_overnight_hero_ok_body', {
        values: { count: outcome.ran.length, time: nextStart },
      }),
    };
  });
  const list = (names: string[]) => new Intl.ListFormat($locale, { style: 'long', type: 'conjunction' }).format(names);

  const coverage = $derived<CoverageRow[]>([
    lastNight && outcome
      ? {
          icon: mdiHistory,
          name: $t('frameleaf_overnight_last_night'),
          detail: $t('frameleaf_overnight_started_at', { values: { time: finishedAt(lastNight.startedAt) } }),
          tone: outcome.problem ? 'warn' : 'good',
          value: $t('frameleaf_overnight_finished_at', { values: { time: finishedAt(lastNight.finishedAt) } }),
          note: $t('frameleaf_overnight_steps_ran', { values: { count: outcome.ran.length } }),
        }
      : {
          icon: mdiHistory,
          name: $t('frameleaf_overnight_last_night'),
          detail: $t('frameleaf_overnight_nothing_yet'),
          tone: 'off',
          value: $t('frameleaf_overnight_nothing_yet_short'),
        },
    {
      icon: mdiClockOutline,
      name: $t('frameleaf_overnight_next'),
      detail: $t('frameleaf_overnight_next_steps', { values: { count: orderSteps.length } }),
      tone: 'good',
      value: $t('frameleaf_overnight_starts_at', { values: { time: nextStart } }),
      note: stopTime ? $t('frameleaf_overnight_stops_by', { values: { time: time(stopTime) } }) : undefined,
    },
  ]);

  const runNow = async () => {
    busy = true;
    try {
      status = await runOvernight();
      said = $t('frameleaf_overnight_said_started');
      setTimeout(() => void load(), 2000);
    } catch {
      said = $t('frameleaf_overnight_said_not_started');
    } finally {
      busy = false;
    }
  };
  const stopNow = async () => {
    busy = true;
    try {
      status = await stopOvernight();
      said = $t('frameleaf_overnight_said_stopped');
    } catch {
      said = $t('frameleaf_overnight_said_not_stopped');
    } finally {
      busy = false;
    }
  };

  // ---- Backup's own schedule, mirrored ----
  const backupSchedule = $derived(backup ? cronToSchedule(backup.cronExpression) : null);
  const backupSentence = $derived.by(() => {
    if (!backupSchedule) {
      return '';
    }
    const { key, values } = scheduleWords(backupSchedule, $locale);
    return `${$t(key, { values })}.`;
  });
  const backupSteps = $derived<Step[]>(
    (backup?.places ?? [])
      .filter((place) => place.on)
      .map((place) => ({ title: $t(BACKUP_PLACE_COPY[place.id].name) })),
  );
  const nearBackups = $derived(
    backupSchedule && 'time' in backupSchedule ? startsNearBackups(startTime, backupSchedule.time) : false,
  );

  // ---- the sentence on the right ----
  const sentence = $derived(
    $t(overnightWords({ someDays, stop: !!stopTime }), {
      values: {
        days: list(days.map((day) => dayName(day, $locale))),
        time: time(startTime),
        stop: stopTime ? time(stopTime) : '',
      },
    }),
  );

  const nights = $derived(
    (status?.nights ?? []).map((night) => {
      const result = nightOutcome(night.results);
      return {
        at: night.startedAt,
        when: new Intl.DateTimeFormat($locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
          new Date(night.startedAt),
        ),
        what: night.manual
          ? $t('frameleaf_overnight_night_manual')
          : $t('frameleaf_overnight_night_steps', { values: { count: result.ran.length } }),
        detail: [
          result.problem
            ? $t('frameleaf_overnight_night_not_finished', {
                values: {
                  time: finishedAt(night.finishedAt),
                  steps: list(result.notFinished.map((id) => stepName(id))),
                },
              })
            : $t('frameleaf_overnight_finished_at', { values: { time: finishedAt(night.finishedAt) } }),
          // FL-518: what the night removed and what came in, when it was measured
          typeof night.removedFromTrash === 'number' && night.removedFromTrash > 0
            ? $t('frameleaf_overnight_night_removed', { values: { count: night.removedFromTrash } })
            : null,
          typeof night.newFiles === 'number' && night.newFiles > 0
            ? $t('frameleaf_overnight_night_new_files', { values: { count: night.newFiles } })
            : null,
        ]
          .filter(Boolean)
          .join(' · '),
        tone: (result.problem ? 'warn' : 'good') as KitTone,
        pill: result.problem ? $t('frameleaf_overnight_pill_not_finished') : $t('frameleaf_overnight_pill_done'),
      };
    }),
  );

  const setUpRows = $derived<LinkRow[]>([
    {
      icon: mdiTrashCanOutline,
      title: $t('frameleaf_overnight_where_trash'),
      body: $t('frameleaf_overnight_where_trash_body'),
      href: commandCenterUrl('storage', 'trash'),
    },
    {
      icon: mdiFolderOutline,
      title: $t('frameleaf_overnight_where_folders'),
      body: $t('frameleaf_overnight_where_folders_body'),
      href: commandCenterUrl('libraries'),
    },
    {
      icon: mdiCloudDownloadOutline,
      title: $t('frameleaf_overnight_where_icloud'),
      body: $t('frameleaf_overnight_where_icloud_body'),
      href: commandCenterUrl('backup', 'takeout'),
    },
    {
      icon: mdiShieldCheckOutline,
      title: $t('frameleaf_overnight_where_care'),
      body: $t('frameleaf_overnight_where_care_body'),
      href: commandCenterUrl('care', 'integrity-checks'),
    },
    {
      icon: mdiProgressClock,
      title: $t('frameleaf_overnight_where_work'),
      body: $t('frameleaf_overnight_where_work_body'),
      href: commandCenterUrl('processing', 'queues'),
    },
  ]);

  const TIDY_CHOICES = [
    'emptyTrash',
    'missingThumbnails',
    'clusterNewFaces',
    'generateMemories',
    'syncQuotaUsage',
  ] as const;
  const TIMINGS = [OvernightStepTiming.Nightly, OvernightStepTiming.Weekly, OvernightStepTiming.Manual];
</script>

<KitPage>
  {#if said}
    <Said message={said} onDismiss={() => (said = '')} />
  {/if}

  {#if failed}
    <InlineError message={$t('frameleaf_overnight_failed')} onRetry={load} />
  {/if}

  <Hero tone={hero.tone} icon={hero.icon} title={hero.title} body={hero.body} label={$t('frameleaf_overnight_status')}>
    {#snippet actions()}
      {#if status?.run}
        <Button disabled={busy} onclick={stopNow}
          ><Icon icon={mdiStop} size="1em" aria-hidden />{$t('frameleaf_overnight_stop_now')}</Button
        >
      {:else}
        <Button disabled={busy || !status} onclick={runNow}
          ><Icon icon={mdiPlayOutline} size="1em" aria-hidden />{$t('frameleaf_overnight_run_now')}</Button
        >
      {/if}
    {/snippet}
    <Coverage rows={coverage} />
  </Hero>

  {#if nightly && !tidyOn}
    <Notice tone="warn" icon={mdiTrashCanOutline} title={$t('frameleaf_overnight_trash_off_title')}>
      {#snippet action()}
        <Button onclick={() => nightly && (nightly.databaseCleanup = true)}
          >{$t('frameleaf_overnight_switch_back_on')}</Button
        >
      {/snippet}
      {$t('frameleaf_overnight_trash_off_body')}
    </Notice>
  {:else if nightly && !nightly.emptyTrash}
    <Notice tone="warn" icon={mdiTrashCanOutline} title={$t('frameleaf_overnight_trash_off_title')}>
      {$t('frameleaf_overnight_trash_left_body')}
    </Notice>
  {/if}

  <div class="columns">
    <div class="stack">
      <Section title={$t('frameleaf_overnight_when_title')} description={$t('frameleaf_overnight_when_description')}>
        <Row label={$t('frameleaf_overnight_run')}>
          <SegmentedControl
            label={$t('frameleaf_overnight_run_label')}
            options={[
              { value: 'night', label: $t('frameleaf_overnight_every_night') },
              { value: 'days', label: $t('frameleaf_overnight_some_days') },
            ]}
            value={someDays ? 'days' : 'night'}
            {disabled}
            onChange={setEvery}
          />
        </Row>
        {#if someDays}
          <Row label={$t('frameleaf_overnight_on')} help={$t('frameleaf_overnight_on_help')}>
            <div class="days" role="group" aria-label={$t('frameleaf_overnight_days_label')}>
              {#each WEEK_DAYS as day (day)}
                <button
                  type="button"
                  class="fl-control"
                  aria-pressed={days.includes(day)}
                  aria-label={dayName(day, $locale)}
                  title={dayName(day, $locale)}
                  {disabled}
                  onclick={() => toggleDay(day)}>{dayName(day, $locale, 'short')}</button
                >
              {/each}
            </div>
          </Row>
        {/if}
        <Row
          label={$t('frameleaf_overnight_start_at')}
          help={[
            zone ? $t('frameleaf_overnight_start_zone', { values: { zone } }) : '',
            yours ? $t('frameleaf_overnight_start_yours', { values: { time: time(yours) } }) : '',
            $t('frameleaf_overnight_start_help'),
          ]
            .filter(Boolean)
            .join(' ')}
        >
          <input
            type="time"
            aria-label={$t('frameleaf_overnight_start_label')}
            value={startTime}
            {disabled}
            onchange={(event) => setTime('startTime', event.currentTarget.value)}
          />
        </Row>
        <Row label={$t('frameleaf_overnight_stop')} help={$t('frameleaf_overnight_stop_help')}>
          <div class="inline">
            {#if stopTime}
              <input
                type="time"
                aria-label={$t('frameleaf_overnight_stop_label')}
                value={stopTime}
                {disabled}
                onchange={(event) => setTime('stopTime', event.currentTarget.value)}
              />
            {/if}
            <Switch
              label={$t('frameleaf_overnight_stop_switch')}
              checked={!!stopTime}
              held={disabled}
              onChange={(on) => nightly && (nightly.stopTime = on ? '06:00' : '')}
            />
          </div>
        </Row>
        <Row
          label={$t('frameleaf_overnight_quiet')}
          help={stopTime
            ? $t('frameleaf_overnight_quiet_help', { values: { start: time(startTime), stop: time(stopTime) } })
            : $t('frameleaf_overnight_quiet_help_no_stop', { values: { start: time(startTime) } })}
        >
          <Switch
            label={$t('frameleaf_overnight_quiet')}
            checked={nightly?.quietHours ?? true}
            held={disabled}
            onChange={(on) => nightly && (nightly.quietHours = on)}
          />
        </Row>
        <Advanced summary={$t('frameleaf_overnight_timing')}>
          {#each present as id (id)}
            <Row label={stepName(id)}>
              <select
                aria-label={$t('frameleaf_overnight_timing_label', { values: { step: stepName(id) } })}
                value={timingOf(id)}
                {disabled}
                onchange={(event) => {
                  if (nightly) {
                    nightly.steps = {
                      ...Object.fromEntries(OVERNIGHT_STEP_IDS.map((step) => [step, timingOf(step)])),
                      ...nightly.steps,
                      [id]: event.currentTarget.value as OvernightStepTiming,
                    } as typeof nightly.steps;
                  }
                }}
              >
                {#each TIMINGS as timing (timing)}
                  <option value={timing}
                    >{$t(`frameleaf_overnight_timing_${timing}` as Translations, {
                      values: { day: dayName(nightly?.weeklyDay ?? 0, $locale) },
                    })}</option
                  >
                {/each}
              </select>
            </Row>
          {/each}
          <Row label={$t('frameleaf_overnight_weekly_day')}>
            <select
              aria-label={$t('frameleaf_overnight_weekly_day')}
              value={String(nightly?.weeklyDay ?? 0)}
              {disabled}
              onchange={(event) => nightly && (nightly.weeklyDay = Number(event.currentTarget.value))}
            >
              {#each WEEK_DAYS as day (day)}
                <option value={String(day)}>{dayName(day, $locale)}</option>
              {/each}
            </select>
          </Row>
          <p class="hint">{$t('frameleaf_overnight_timing_hint')}</p>
        </Advanced>
        <Advanced summary={$t('frameleaf_overnight_clock')}>
          <Row
            label={$t('frameleaf_overnight_clock_row')}
            help={$t('frameleaf_overnight_clock_help', { values: { zone } })}
          >
            <Button onclick={() => goto(commandCenterUrl('server', 'server'))}
              >{$t('frameleaf_overnight_change')}</Button
            >
          </Row>
        </Advanced>
      </Section>

      <Section
        title={$t('frameleaf_overnight_backups_title')}
        description={$t('frameleaf_overnight_backups_description')}
      >
        {#snippet action()}
          <Button onclick={() => goto(commandCenterUrl('backups', 'schedule'))}
            >{$t('frameleaf_overnight_change_in_backup')}</Button
          >
        {/snippet}
        {#if backup}
          <p class="sentence small">{backupSentence}</p>
          {#if backupSteps.length > 0}
            <Steps steps={backupSteps} label={$t('frameleaf_overnight_backups_order')} />
          {/if}
        {:else}
          <p class="hint pad">{$t('frameleaf_overnight_backups_unread')}</p>
        {/if}
      </Section>
    </div>

    <aside class="preview fl-continuous-corners" aria-label={$t('frameleaf_overnight_preview_label')}>
      <h2>{$t('frameleaf_overnight_preview')}</h2>
      <p class="sentence" aria-live="polite">{sentence}</p>
      {#if orderSteps.length > 0}
        <Steps steps={orderSteps} stacked label={$t('frameleaf_overnight_order')} />
      {/if}
      <p class="hint">{$t('frameleaf_overnight_one_after')}</p>
      <p class="hint">{$t('frameleaf_overnight_overlap_rule')}</p>
      {#if manualSteps.length > 0}
        <p class="hint">
          {$t('frameleaf_overnight_manual_steps', { values: { steps: list(manualSteps.map((id) => stepName(id))) } })}
        </p>
      {/if}
      {#if nearBackups && backupSchedule && 'time' in backupSchedule}
        <Notice tone="warn" title={$t('frameleaf_overnight_overlap_title')}>
          {$t('frameleaf_overnight_overlap_body', { values: { time: time(backupSchedule.time) } })}
        </Notice>
      {/if}
      {#if present.length < OVERNIGHT_STEP_IDS.length}
        <p class="hint">{$t('frameleaf_overnight_join_later')}</p>
      {/if}
    </aside>
  </div>

  <Section title={$t('frameleaf_overnight_tidy_title')} description={$t('frameleaf_overnight_tidy_description')}>
    <Row
      label={$t('frameleaf_overnight_tidy_switch')}
      help={$t('frameleaf_overnight_tidy_help', { values: { days: trashDays } })}
    >
      <Switch
        label={$t('frameleaf_overnight_tidy_switch')}
        checked={tidyOn}
        held={disabled}
        onChange={(on) => nightly && (nightly.databaseCleanup = on)}
      />
    </Row>
    <Row label={$t('frameleaf_overnight_trash_days')} help={$t('frameleaf_overnight_trash_days_help')}>
      <div class="inline">
        <span class="value">{$t('frameleaf_overnight_days', { values: { count: trashDays } })}</span>
        <Button onclick={() => goto(commandCenterUrl('storage', 'trash'))}>{$t('frameleaf_overnight_change')}</Button>
      </div>
    </Row>
    <Advanced summary={$t('frameleaf_overnight_tidy_choices')}>
      {#each TIDY_CHOICES as choice (choice)}
        <Row
          label={$t(`frameleaf_overnight_tidy_${choice}` as Translations)}
          help={$t(`frameleaf_overnight_tidy_${choice}_help` as Translations)}
        >
          <Switch
            label={$t(`frameleaf_overnight_tidy_${choice}` as Translations)}
            checked={nightly?.[choice] ?? true}
            held={disabled || !tidyOn}
            onChange={(on) => nightly && (nightly[choice] = on)}
          />
        </Row>
      {/each}
      <Row label={$t('frameleaf_overnight_tidy_always')} help={$t('frameleaf_overnight_tidy_always_help')}>
        <span class="value">{$t('frameleaf_overnight_always')}</span>
      </Row>
    </Advanced>
  </Section>

  <Section title={$t('frameleaf_overnight_recent_title')} description={$t('frameleaf_overnight_recent_description')}>
    {#if nights.length > 0}
      <HistoryList>
        {#each nights as night (night.at)}
          <HistoryRow when={night.when} datetime={night.at} what={night.what} detail={night.detail}>
            <Pill tone={night.tone}>{night.pill}</Pill>
          </HistoryRow>
        {/each}
      </HistoryList>
    {:else}
      <p class="hint pad">{$t('frameleaf_overnight_recent_empty')}</p>
    {/if}
  </Section>

  <Section title={$t('frameleaf_overnight_where_title')} description={$t('frameleaf_overnight_where_description')}>
    <Links rows={setUpRows} />
  </Section>
</KitPage>

<style>
  .columns {
    display: grid;
    grid-template-columns: minmax(0, 1.35fr) minmax(280px, 0.65fr);
    align-items: start;
    gap: var(--fl-space-6);
  }
  .stack {
    display: grid;
    gap: var(--fl-space-6);
    min-width: 0;
  }
  .days {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: var(--fl-space-2);
  }
  .days button {
    min-width: 48px;
    padding: 0 var(--fl-space-2);
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .days button[aria-pressed='true'] {
    color: var(--fl-accent-text);
    font-weight: 600;
    background: var(--fl-accent);
    border-color: var(--fl-accent);
  }
  .days button:focus-visible {
    outline: var(--fl-focus-ring);
    outline-offset: var(--fl-focus-offset);
  }
  .inline {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: var(--fl-space-3);
  }
  .value {
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
  }
  select,
  input[type='time'] {
    min-height: var(--fl-control-height);
    padding: 0 var(--fl-space-3);
    color: var(--fl-text);
    font-size: var(--fl-font-callout);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .preview {
    display: grid;
    gap: var(--fl-space-4);
    padding: var(--fl-space-6);
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  @supports (corner-shape: squircle) {
    .preview {
      border-radius: calc(var(--fl-radius-card) * 1.8);
    }
  }
  .preview h2 {
    color: var(--fl-muted);
    font: var(--fl-type-micro);
    letter-spacing: 0.07em;
    text-transform: uppercase;
  }
  .sentence {
    margin: 0;
    font: var(--fl-type-headline);
    letter-spacing: var(--fl-tracking-headline);
    text-wrap: balance;
  }
  .sentence.small {
    padding-bottom: var(--fl-space-4);
    font-size: var(--fl-font-size);
  }
  .hint {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.5;
  }
  .pad {
    padding: 0 0 var(--fl-space-5);
  }
  @container kit (max-width: 860px) {
    .columns {
      grid-template-columns: 1fr;
    }
  }
  @container kit (max-width: 620px) {
    .days {
      justify-content: flex-start;
    }
    .preview {
      padding: var(--fl-space-4);
    }
  }
</style>
