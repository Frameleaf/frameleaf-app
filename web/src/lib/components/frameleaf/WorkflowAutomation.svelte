<script lang="ts">
  import FilterPanel from './FilterPanel.svelte';
  import Button from './Button.svelte';
  import { emptyDiscoveryQuery, type DiscoveryQuery } from '$lib/components/discovery/query';
  import { emptyFilterPanelOptions, loadFilterPanelOptions } from '$lib/frameleaf/search-options';
  import { scheduleControls, workflowSchedule, type ScheduleControls } from '$lib/frameleaf/workflow-source';
  import { cloneJson, type WorkflowDraft } from '$lib/frameleaf/workflows';
  import { onLibraryAccessChange } from '$lib/frameleaf/library-access';
  import { onMount } from 'svelte';
  import { Field } from '@frameleaf/sdk';
  import { t } from 'svelte-i18n';

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
  const controls = $derived(scheduleControls(draft.schedule ?? { cron: '0 9 * * *' }));
  const changeSchedule = (patch: Partial<ScheduleControls>) =>
    onChange({
      ...draft,
      source: draft.source ?? { filter: {} },
      schedule: workflowSchedule({ ...controls, ...patch }),
    });
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
          schedule: event.currentTarget.checked ? { cron: '0 9 * * *' } : null,
        })}
    />
    {$t('frameleaf_workflows.schedule_enabled')}
  </label>
  <p>{$t('frameleaf_workflows.timezone', { values: { timezone } })}</p>
  {#if draft.trigger === 'AssetChanged'}<p>{$t('frameleaf_workflows.every_change')}</p>{/if}
  {#if draft.schedule}
    <label
      >{$t('frameleaf_workflows.frequency')}
      <select
        value={controls.frequency}
        onchange={(event) => changeSchedule({ frequency: event.currentTarget.value as ScheduleControls['frequency'] })}
      >
        {#each ['hourly', 'daily', 'weekly', 'advanced'] as const as frequency (frequency)}
          <option value={frequency}>{$t(`frameleaf_workflows.${frequency}`)}</option>
        {/each}
      </select>
    </label>
    {#if controls.frequency === 'advanced'}
      <label
        >{$t('frameleaf_workflows.cron')}
        <input
          value={controls.cron}
          placeholder="0 9 * * 1"
          onchange={(event) => changeSchedule({ cron: event.currentTarget.value })}
        />
      </label>
    {:else}
      <label
        >{$t('frameleaf_workflows.time')}
        <input
          type="time"
          value={controls.time}
          onchange={(event) => changeSchedule({ time: event.currentTarget.value })}
        />
      </label>
      {#if controls.frequency === 'weekly'}
        <label
          >{$t('frameleaf_workflows.weekday')}
          <select value={controls.weekday} onchange={(event) => changeSchedule({ weekday: event.currentTarget.value })}>
            {#each ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const as day, index (day)}
              <option value={index}>{$t(`frameleaf_workflows.${day}`)}</option>
            {/each}
          </select>
        </label>
      {/if}
    {/if}
    <p>
      {nextRunAt
        ? $t('frameleaf_workflows.next_run', {
            values: { at: new Date(nextRunAt).toLocaleString(undefined, { timeZone: timezone }) },
          })
        : $t('frameleaf_workflows.next_run_after_save')}
    </p>
  {/if}
</section>

<style>
  .automation {
    border-block: 1px solid var(--fl-border);
    padding-block: 1rem;
    display: grid;
    gap: 0.75rem;
  }
  h3,
  p {
    margin: 0;
  }
  p {
    color: var(--fl-muted);
    font-size: 0.8rem;
  }
  label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  input:not([type='checkbox']),
  select {
    padding: 0.5rem;
    border: 1px solid var(--fl-border);
    border-radius: 0.375rem;
    background: var(--fl-surface);
    color: inherit;
  }
  pre {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-size: 0.75rem;
  }
  input:focus-visible,
  select:focus-visible,
  summary:focus-visible {
    outline: var(--fl-focus-ring);
    outline-offset: var(--fl-focus-offset);
  }
</style>
