<script lang="ts">
  /**
   * Backup › Schedule (FL-362): one schedule for every backup, in plain words. How often, on which
   * days and at what time are chosen with ordinary controls and said back as a sentence; the server
   * keeps the result as its schedule expression, which this page never shows as one. Backups run one
   * after another in the order on the right, so the schedule has a start and no end.
   *
   * It is an ordinary setting: a change is kept in the settings draft and saved with the settings bar.
   * A schedule the controls cannot express (set in the configuration file or through the API) is
   * "Custom": it keeps running untouched until a choice here replaces it.
   */
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import SegmentedControl from '$lib/components/frameleaf/SegmentedControl.svelte';
  import { BACKUP_PLACE_COPY } from '$lib/components/frameleaf/backup/backup-places';
  import Notice from '$lib/components/frameleaf/settings/kit/Notice.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import Steps from '$lib/components/frameleaf/settings/kit/Steps.svelte';
  import {
    clockTime,
    cronToSchedule,
    dayName,
    HOUR_STEPS,
    sameSchedule,
    scheduleToCron,
    scheduleWords,
    viewerTime,
    WEEK_DAYS,
    type BackupSchedule,
  } from '$lib/frameleaf/backup-schedule';
  import { getSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import { getBackupSchedule, type BackupScheduleResponseDto } from '@frameleaf/sdk';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  let server = $state<BackupScheduleResponseDto | null>(null);
  let failed = $state(false);
  const load = () => {
    failed = false;
    getBackupSchedule()
      .then((result) => (server = result))
      .catch(() => (failed = true));
  };
  onMount(load);

  const settingsDraft = getSystemConfigDraft();
  const backup = $derived(settingsDraft?.draft.backup);
  const disabled = $derived(featureFlagsManager.value.configFile || !backup);

  /** The schedule on the page: the one being edited, else the one in force on the server. */
  const cron = $derived(backup?.schedule.cronExpression.trim() || server?.cronExpression || '');
  const schedule = $derived(cronToSchedule(cron));
  const custom = $derived(schedule.every === 'custom');
  const time = $derived('time' in schedule ? schedule.time : '02:00');

  /**
   * Keeps a choice. The library data copy's and Cloud Backup's own schedule fields are kept in step
   * with it: they no longer start anything, but Cloud Backup still reads its field to keep its weekly
   * check clear of the backup.
   */
  const choose = (next: BackupSchedule) => {
    if (!backup || !settingsDraft) {
      return;
    }
    const expression = scheduleToCron(next);
    if (sameSchedule(expression, cron)) {
      return;
    }
    backup.schedule.cronExpression = expression;
    backup.database.cronExpression = expression;
    const cloud = settingsDraft.draft.frameleafCloud?.cloudBackup;
    if (cloud) {
      cloud.schedule.cronExpression = expression;
    }
  };

  const FREQUENCIES = ['day', 'days', 'hours'] as const;
  const setEvery = (every: string) => {
    switch (every) {
      case 'day': {
        choose({ every, time });
        break;
      }
      case 'days': {
        choose({ every, days: schedule.every === 'days' ? schedule.days : [0], time });
        break;
      }
      case 'hours': {
        choose({ every, hours: schedule.every === 'hours' ? schedule.hours : 6 });
        break;
      }
    }
  };
  const toggleDay = (day: number) => {
    if (schedule.every !== 'days') {
      return;
    }
    const days = schedule.days.includes(day) ? schedule.days.filter((item) => item !== day) : [...schedule.days, day];
    // At least one day stays chosen; all seven is simply every day.
    if (days.length > 0) {
      choose(days.length === 7 ? { every: 'day', time } : { every: 'days', days: days.sort((a, b) => a - b), time });
    }
  };

  const zone = $derived(server?.timezone ?? '');
  const yourTime = $derived(
    zone && 'time' in schedule
      ? viewerTime(schedule.time, zone, new Intl.DateTimeFormat().resolvedOptions().timeZone)
      : undefined,
  );
  const sentence = $derived.by(() => {
    const { key, values } = scheduleWords(schedule, $locale);
    return $t(key, { values });
  });

  // The order of a run: the places that are on, each starting when the one before it has finished.
  const order = $derived((server?.places ?? []).filter((place) => place.on));
  const steps = $derived(
    order.map((place, index) => ({
      title: $t(BACKUP_PLACE_COPY[place.id].name),
      detail:
        index === 0
          ? 'time' in schedule
            ? $t('frameleaf_backup_schedule_step_starts', { values: { time: clockTime(schedule.time, $locale) } })
            : $t('frameleaf_backup_schedule_step_first')
          : $t('frameleaf_backup_schedule_step_then'),
    })),
  );
</script>

<div class="columns">
  <Section title={$t('frameleaf_backup_schedule_title')} description={$t('frameleaf_backup_schedule_description')}>
    {#if failed}
      <div class="pad"><InlineError compact message={$t('frameleaf_backup_schedule_failed')} onRetry={load} /></div>
    {/if}
    {#if custom && cron}
      <div class="pad">
        <Notice title={$t('frameleaf_backup_schedule_custom_title')}>
          {$t('frameleaf_backup_schedule_custom_body')}
        </Notice>
      </div>
    {/if}
    <Row label={$t('frameleaf_backup_schedule_every')}>
      <SegmentedControl
        label={$t('frameleaf_backup_schedule_every_label')}
        options={FREQUENCIES.map((value) => ({ value, label: $t(`frameleaf_backup_schedule_option_${value}`) }))}
        value={custom ? undefined : schedule.every}
        {disabled}
        onChange={setEvery}
      />
    </Row>
    {#if schedule.every === 'days'}
      <Row label={$t('frameleaf_backup_schedule_days')} help={$t('frameleaf_backup_schedule_days_help')}>
        <div class="days" role="group" aria-label={$t('frameleaf_backup_schedule_days_label')}>
          {#each WEEK_DAYS as day (day)}
            <button
              type="button"
              class="fl-control"
              aria-pressed={schedule.days.includes(day)}
              aria-label={dayName(day, $locale)}
              title={dayName(day, $locale)}
              {disabled}
              onclick={() => toggleDay(day)}>{dayName(day, $locale, 'short')}</button
            >
          {/each}
        </div>
      </Row>
    {/if}
    {#if schedule.every === 'hours'}
      <Row label={$t('frameleaf_backup_schedule_gap')} help={$t('frameleaf_backup_schedule_gap_help')}>
        <select
          aria-label={$t('frameleaf_backup_schedule_gap_label')}
          value={String(schedule.hours)}
          {disabled}
          onchange={(event) => choose({ every: 'hours', hours: Number(event.currentTarget.value) })}
        >
          {#each HOUR_STEPS as hours (hours)}
            <option value={String(hours)}>{$t('frameleaf_backup_schedule_every_hours', { values: { hours } })}</option>
          {/each}
        </select>
      </Row>
    {:else if !custom}
      <Row
        label={$t('frameleaf_backup_schedule_start')}
        help={[
          zone ? $t('frameleaf_backup_schedule_start_zone', { values: { zone } }) : '',
          yourTime
            ? $t('frameleaf_backup_schedule_start_yours', { values: { time: clockTime(yourTime, $locale) } })
            : '',
          $t('frameleaf_backup_schedule_start_help'),
        ]
          .filter(Boolean)
          .join(' ')}
      >
        <input
          type="time"
          aria-label={$t('frameleaf_backup_schedule_start_label')}
          value={time}
          {disabled}
          onchange={(event) => {
            const value = event.currentTarget.value;
            if (/^\d{2}:\d{2}/.test(value) && 'time' in schedule) {
              choose({ ...schedule, time: value.slice(0, 5) });
            }
          }}
        />
      </Row>
    {/if}
    <p class="note">{$t('frameleaf_backup_schedule_no_stop')}</p>
  </Section>

  <aside class="preview fl-continuous-corners" aria-label={$t('frameleaf_backup_schedule_preview_label')}>
    <h2>{$t('frameleaf_backup_schedule_preview')}</h2>
    <p class="sentence" aria-live="polite">{sentence}.</p>
    {#if steps.length > 0}
      <Steps {steps} stacked label={$t('frameleaf_backup_schedule_order')} />
      <p class="hint">{$t('frameleaf_backup_schedule_one_after')}</p>
    {:else if server}
      <p class="hint">{$t('frameleaf_backup_schedule_nothing_on')}</p>
    {/if}
    <p class="hint">{$t('frameleaf_backup_schedule_first_longer')}</p>
  </aside>
</div>

<style>
  .columns {
    display: grid;
    grid-template-columns: minmax(0, 1.35fr) minmax(280px, 0.65fr);
    align-items: start;
    gap: var(--fl-space-6);
  }
  .pad {
    padding: 0 0 var(--fl-space-4);
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
  .note {
    margin: 0;
    padding: var(--fl-space-4) 0 var(--fl-space-5);
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.5;
    border-top: 1px solid var(--fl-border);
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
  .hint {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.5;
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
