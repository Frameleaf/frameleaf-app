<script lang="ts">
  import FilterPanel from './FilterPanel.svelte';
  import Button from './Button.svelte';
  import { emptyDiscoveryQuery, type DiscoveryQuery } from '$lib/components/discovery/query';
  import { emptyFilterPanelOptions, loadFilterPanelOptions } from '$lib/frameleaf/search-options';
  import { scheduleControls, workflowSchedule, type ScheduleControls } from '$lib/frameleaf/workflow-source';
  import { cloneJson, type WorkflowDraft } from '$lib/frameleaf/workflows';
  import { onLibraryAccessChange } from '$lib/frameleaf/library-access';
  import { formatDateTime, formatTime } from '$lib/frameleaf/date-format';
  import { onMount } from 'svelte';
  import { Field } from '@frameleaf/sdk';
  import { locale, t } from 'svelte-i18n';

  let {
    draft,
    timezone,
    nextRunAt,
    onChange,
  }: {
    draft: WorkflowDraft;
    timezone: string;
    nextRunAt?: string | null;
    onChange: (draft: WorkflowDraft) => void;
  } = $props();
  let options = $state.raw(emptyFilterPanelOptions());
  let filtersOpen = $state(false);
  let loadFailed = $state(false);
  let generation = $state(0);
  onMount(() =>
    onLibraryAccessChange(() => {
      options = emptyFilterPanelOptions();
      generation++;
    }),
  );
  $effect(() => {
    void generation;
    if (!filtersOpen) {
      return;
    }
    const controller = new AbortController();
    loadFailed = false;
    loadFilterPanelOptions(controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) {
          options = value;
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          loadFailed = true;
        }
      });
    return () => controller.abort();
  });
  /**
   * "When it runs" (FL-1815, prototype WorkflowDesigner.jsx `WorkflowSchedule`): how often, a time and
   * the days, read back as a sentence. The server keeps a cron line; `workflow-source` turns the
   * choices into one and back, and a line they cannot say shows as "Custom schedule", untouched.
   */
  const DEFAULT_SCHEDULE = { cron: '0 9 * * *' };
  const controls = $derived(scheduleControls(draft.schedule ?? DEFAULT_SCHEDULE));
  const changeSchedule = (patch: Partial<ScheduleControls>) =>
    onChange({
      ...draft,
      source: draft.source ?? { filter: {} },
      schedule: workflowSchedule({ ...controls, ...patch }),
    });
  /** One chosen day is the same cron line as "every week", so the choice itself is remembered here. */
  let chosenDays = $state(false);
  const frequency = $derived(controls.frequency === 'weekly' && chosenDays ? 'days' : controls.frequency);
  const changeFrequency = (next: ScheduleControls['frequency']) => {
    chosenDays = next === 'days';
    // from "every week" the chosen days start as that one day; `weekly` takes the first chosen day
    changeSchedule({ frequency: next, weekday: String(controls.days[0]) });
  };
  const toggleDay = (day: number) => {
    const days = controls.days.includes(day) ? controls.days.filter((other) => other !== day) : [...controls.days, day];
    // ponytail: the last day cannot be switched off, so there is never a schedule with no day to save
    if (days.length > 0) {
      changeSchedule({ frequency: 'days', days });
    }
  };
  const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];
  /** 7 January 2024 was a Sunday. */
  const dayName = (day: number, weekday: 'long' | 'short') =>
    formatDateTime(Date.UTC(2024, 0, 7 + day), { weekday, timeZone: 'UTC' }, $locale ?? undefined);
  const [hour, minute] = $derived(controls.time.split(':').map(Number));
  const clock = $derived(formatTime(new Date(2024, 0, 7, hour, minute)));
  const summary = $derived(
    frequency === 'hourly'
      ? $t('frameleaf_workflows.summary_hourly', { values: { minutes: minute } })
      : frequency === 'daily'
        ? $t('frameleaf_workflows.summary_daily', { values: { time: clock } })
        : frequency === 'weekly'
          ? $t('frameleaf_workflows.summary_weekly', {
              values: { day: dayName(Number(controls.weekday), 'long'), time: clock },
            })
          : $t('frameleaf_workflows.summary_days', {
              values: {
                days: new Intl.ListFormat($locale ?? undefined, { style: 'long', type: 'conjunction' }).format(
                  controls.days.map((day) => dayName(day, 'long')),
                ),
                time: clock,
              },
            }),
  );
  /** "America/Edmonton" reads as "Edmonton". */
  const place = $derived(timezone.split('/').at(-1)?.replaceAll('_', ' ') ?? timezone);
  const query = $derived<DiscoveryQuery>({
    ...emptyDiscoveryQuery(),
    filter: draft.source?.filter ?? {},
    imageEnrichment: draft.source?.imageEnrichment,
  });
  const changeFilter = (next: DiscoveryQuery) =>
    onChange({
      ...draft,
      source: {
        ...draft.source,
        filter: cloneJson(next.filter),
        imageEnrichment: next.imageEnrichment,
      },
    });
  const rolling = $derived(draft.source?.rollingDates?.find((period) => period.field === 'takenAt'));
  const setRolling = (days?: number) => {
    const source = cloneJson(draft.source ?? { filter: {} });
    source.rollingDates = (source.rollingDates ?? []).filter((period) => period.field !== 'takenAt');
    if (days !== undefined) {
      delete source.filter.takenAt;
      source.rollingDates.push({ field: Field.TakenAt, days });
    }
    onChange({ ...draft, source });
  };
</script>

<section class="automation" aria-label={$t('frameleaf_workflows.automation')}>
  <h3>{$t('frameleaf_workflows.conditions')}</h3>
  <p>{$t('frameleaf_workflows.conditions_help')}</p>
  <Button
    onclick={() => {
      if (!draft.source) {
        onChange({ ...draft, source: { filter: {} } });
      }
      filtersOpen = !filtersOpen;
    }}
    pressed={filtersOpen}>{$t('frameleaf_workflows.edit_conditions')}</Button
  >
  {#if filtersOpen}
    {#if loadFailed}<p role="alert">{$t('errors.something_went_wrong')}</p>{/if}
    <FilterPanel embedded section="all" {query} {options} onChange={changeFilter} />
  {/if}
  {#if draft.source}
    <details>
      <summary>{$t('frameleaf_workflows.copied_conditions')}</summary>
      <pre>{JSON.stringify(draft.source.filter, null, 2)}</pre>
    </details>
    <label>
      <input
        type="checkbox"
        checked={!!rolling}
        onchange={(event) => setRolling(event.currentTarget.checked ? 30 : undefined)}
      />
      {$t('frameleaf_workflows.rolling_capture')}
    </label>
    {#if rolling}
      <label
        >{$t('frameleaf_workflows.last_days')}
        <input
          type="number"
          min="1"
          max="36500"
          value={rolling.days}
          onchange={(event) => setRolling(Number(event.currentTarget.value))}
        />
      </label>
    {/if}
    {#if draft.source.semantic}
      <p>{draft.source.semantic.query ?? $t('frameleaf_workflows.similar_photo')}</p>
      <label
        >{$t('frameleaf_workflows.distance')}
        <input
          type="number"
          min="0"
          max="2"
          step="0.01"
          value={draft.source.semantic.maxDistance}
          onchange={(event) =>
            onChange({
              ...draft,
              source: {
                ...draft.source!,
                semantic: { ...draft.source!.semantic!, maxDistance: Number(event.currentTarget.value) },
              },
            })}
        />
      </label>
      <p>{$t('frameleaf_workflows.distance_help')}</p>
    {/if}
  {/if}
  <h3>{$t('frameleaf_workflows.schedule')}</h3>
  <label>
    <input
      type="checkbox"
      checked={!!draft.schedule}
      disabled={draft.trigger === 'Schedule' && !!draft.schedule}
      onchange={(event) =>
        onChange({
          ...draft,
          source: draft.source ?? { filter: {} },
          schedule: event.currentTarget.checked ? { ...DEFAULT_SCHEDULE } : null,
        })}
    />
    {$t('frameleaf_workflows.schedule_enabled')}
  </label>
  {#if draft.trigger === 'AssetChanged'}<p>{$t('frameleaf_workflows.every_change')}</p>{/if}
  {#if draft.schedule && frequency === 'custom'}
    <div class="custom">
      <p>
        <strong>{$t('frameleaf_workflows.custom_title')}</strong>
        {$t('frameleaf_workflows.custom_body')}
      </p>
      <Button onclick={() => changeSchedule({ frequency: 'daily', time: '09:00' })}>
        {$t('frameleaf_workflows.custom_replace')}
      </Button>
    </div>
    <p>{$t('frameleaf_workflows.timezone', { values: { timezone: place } })}</p>
  {:else if draft.schedule}
    <div class="row">
      <label class="field">
        {$t('frameleaf_workflows.frequency')}
        <select
          value={frequency}
          onchange={(event) => changeFrequency(event.currentTarget.value as ScheduleControls['frequency'])}
        >
          {#each ['hourly', 'daily', 'weekly', 'days'] as const as option (option)}
            <option value={option}>{$t(`frameleaf_workflows.${option}`)}</option>
          {/each}
        </select>
      </label>
      {#if frequency === 'weekly'}
        <label class="field">
          {$t('frameleaf_workflows.weekday')}
          <select value={controls.weekday} onchange={(event) => changeSchedule({ weekday: event.currentTarget.value })}>
            {#each ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const as day, index (day)}
              <option value={String(index)}>{$t(`frameleaf_workflows.${day}`)}</option>
            {/each}
          </select>
        </label>
      {/if}
      {#if frequency === 'hourly'}
        <label class="field">
          {$t('frameleaf_workflows.minutes_past')}
          <input
            type="number"
            min="0"
            max="59"
            value={minute}
            onchange={(event) => {
              const minutes = Math.min(59, Math.max(0, Math.trunc(Number(event.currentTarget.value)) || 0));
              changeSchedule({ time: `${String(hour).padStart(2, '0')}:${String(minutes).padStart(2, '0')}` });
            }}
          />
        </label>
      {:else}
        <label class="field">
          {$t('frameleaf_workflows.time')}
          <input
            type="time"
            value={controls.time}
            onchange={(event) => event.currentTarget.value && changeSchedule({ time: event.currentTarget.value })}
          />
        </label>
      {/if}
    </div>
    {#if frequency === 'days'}
      <div class="days" role="group" aria-label={$t('frameleaf_workflows.days_group')}>
        {#each WEEKDAYS as day (day)}
          <button
            type="button"
            class="fl-control"
            aria-pressed={controls.days.includes(day)}
            aria-label={dayName(day, 'long')}
            onclick={() => toggleDay(day)}
          >
            {dayName(day, 'short')}
          </button>
        {/each}
      </div>
    {/if}
    <p>
      <strong>{summary}</strong>
      {$t('frameleaf_workflows.timezone', { values: { timezone: place } })}
      {nextRunAt
        ? $t('frameleaf_workflows.next_run', {
            values: { at: formatDateTime(nextRunAt, { dateStyle: 'medium', timeStyle: 'short', timeZone: timezone }) },
          })
        : $t('frameleaf_workflows.next_run_after_save')}
    </p>
  {/if}
</section>

<style>
  .automation {
    border-block: 1px solid var(--fl-border);
    padding-block: var(--fl-space-4);
    display: grid;
    gap: var(--fl-space-3);
  }
  h3,
  p {
    margin: 0;
  }
  /* with the 12px gap: a heading stands 44px clear of the section above and 16px from its own content */
  h3:not(:first-child) {
    margin-top: var(--fl-space-8);
  }
  h3 {
    margin-bottom: var(--fl-space-1);
  }
  p {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.5;
  }
  p strong {
    color: var(--fl-text);
  }
  label {
    display: flex;
    align-items: center;
    gap: var(--fl-space-2);
    flex-wrap: wrap;
    min-height: var(--fl-control-target);
  }
  /* a button is as wide as its words, not the section */
  .automation > :global(button) {
    justify-self: start;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: var(--fl-space-6);
  }
  .field {
    flex-direction: column;
    align-items: stretch;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  input:not([type='checkbox']),
  select {
    box-sizing: border-box;
    height: var(--fl-control-height);
    padding: 0 var(--fl-space-3);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    background: var(--fl-panel);
    color: var(--fl-text);
    font: inherit;
  }
  /* workflow-designer.css .wd-days */
  .days {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fl-space-3);
  }
  .days button {
    min-width: var(--fl-space-16);
    min-height: var(--fl-control-height);
    padding: var(--fl-space-2) var(--fl-space-3);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-pill);
    background: transparent;
    color: var(--fl-muted);
    font: inherit;
    font-size: var(--fl-font-small);
    cursor: pointer;
  }
  .days button[aria-pressed='true'] {
    border-color: var(--fl-accent);
    background: var(--fl-raised);
    color: var(--fl-text);
    font-weight: 600;
  }
  /* workflow-designer.css .wd-custom */
  .custom {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--fl-space-3);
    padding: var(--fl-space-6);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    background: var(--fl-raised);
  }
  .custom p {
    max-width: 52ch;
  }
  pre {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-size: var(--fl-font-small);
  }
  input:focus-visible,
  select:focus-visible,
  summary:focus-visible,
  .days button:focus-visible {
    outline: var(--fl-focus-ring);
    outline-offset: var(--fl-focus-offset);
  }
</style>
