<script lang="ts">
  /**
   * Background work › Everyday (approved design, 2026-11-04; prototype `WorkV3.jsx` `BackgroundV3`):
   * how the work is going with Pause all and Resume all, the pace, when heavy work runs, and the eight
   * features with each one's Pause, Catch up, Do it all again and its own tasks. Advanced is the page as
   * it was, with every task in detail; nothing here is lost there. The Job manager owns the data and
   * the review of every command; this draws the page.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import Menu from '$lib/components/frameleaf/Menu.svelte';
  import MenuItem from '$lib/components/frameleaf/MenuItem.svelte';
  import SegmentedControl from '$lib/components/frameleaf/SegmentedControl.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import Pill from '$lib/components/frameleaf/settings/kit/Pill.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import type { KitTone } from '$lib/components/frameleaf/settings/kit/Pill.svelte';
  import { summariseWork, workLeft, workState, type WorkRow } from '$lib/frameleaf/computers';
  import type { JobTab } from '$lib/frameleaf/job-queues';
  import type { SystemConfigDraftStore } from '$lib/frameleaf/system-config-draft.svelte';
  import { applyPreset, presetOf, type WorkNumbers, type WorkPreset } from '$lib/frameleaf/work-presets';
  import { WORK_FEATURES, type WorkFeature, type WorkFeatureId } from '$lib/frameleaf/work-features';
  import type { OverviewTask } from '$lib/components/frameleaf/jobs/BackgroundWorkOverview.svelte';
  import { Route } from '$lib/route';
  import {
    getMlWorkloadRoutes,
    listMlDestinations,
    MlDestinationKind,
    MlWorkload,
    type QueueName,
  } from '@frameleaf/sdk';
  import { onMount } from 'svelte';
  import { Icon } from '@frameleaf/ui';
  import {
    mdiAlertCircleOutline,
    mdiChartLine,
    mdiCheckCircleOutline,
    mdiChevronRight,
    mdiDotsHorizontal,
    mdiFormatListChecks,
    mdiImageSearchOutline,
    mdiPause,
    mdiPauseCircleOutline,
    mdiPlay,
    mdiPlaylistCheck,
    mdiProgressClock,
    mdiRefresh,
    mdiShieldCheckOutline,
  } from '@mdi/js';
  import { t, type Translations } from 'svelte-i18n';

  export type FeatureAction = 'pause' | 'resume' | 'run' | 'force';

  let {
    rows,
    unknown,
    pending = false,
    unavailable = false,
    store,
    locked = false,
    href,
    computersHref,
    overnightHref,
    onPauseAll,
    onResumeAll,
    onFeature,
    onTask,
    onAdvanced,
    onRetry,
  }: {
    rows: WorkRow[];
    /** Kinds of work whose counts could not be read: never shown as up to date. */
    unknown?: ReadonlySet<QueueName>;
    pending?: boolean;
    unavailable?: boolean;
    store?: SystemConfigDraftStore;
    locked?: boolean;
    href: (name: QueueName, tab?: JobTab) => string;
    computersHref: string;
    overnightHref: string;
    onPauseAll: () => void;
    onResumeAll: () => void;
    onFeature: (feature: WorkFeature, action: FeatureAction) => void;
    onTask: (task: OverviewTask) => void;
    /** Opens Advanced, at one feature's tasks when one is given. */
    onAdvanced: (feature?: WorkFeatureId) => void;
    onRetry: () => void;
  } = $props();

  const featureName = (feature: WorkFeature) => $t(`frameleaf_work_feature_${feature.id}` as Translations);
  const rowsOf = (feature: WorkFeature) => rows.filter((row) => feature.queues.includes(row.definition.name));

  // as in Advanced, kinds whose counts could not be read are left out of the totals
  const summary = $derived(summariseWork(rows.filter((row) => !unknown?.has(row.definition.name))));
  const unknownOf = (feature: WorkFeature) => rowsOf(feature).some((row) => unknown?.has(row.definition.name));
  const pausedRows = $derived(rows.filter((row) => row.queue.isPaused));
  const allPaused = $derived(rows.length > 0 && pausedRows.length === rows.length);

  const hero = $derived.by(() => {
    if (allPaused) {
      return {
        tone: 'warn' as const,
        icon: mdiPauseCircleOutline,
        title: $t('frameleaf_bgwork_all_paused'),
        body: $t('frameleaf_bgwork_all_paused_body'),
      };
    }
    if (summary.failedCount > 0) {
      return {
        tone: 'warn' as const,
        icon: mdiAlertCircleOutline,
        title: $t('frameleaf_bgwork_failed', { values: { count: summary.failedCount } }),
        body: $t('frameleaf_bgwork_failed_everyday_body'),
      };
    }
    if (summary.left > 0) {
      return {
        tone: 'good' as const,
        icon: mdiProgressClock,
        title: $t('frameleaf_bgwork_working', { values: { count: summary.left } }),
        body: $t('frameleaf_bgwork_working_everyday_body'),
      };
    }
    return {
      tone: 'good' as const,
      icon: mdiCheckCircleOutline,
      title: $t('frameleaf_bgwork_idle'),
      body: $t('frameleaf_bgwork_idle_body'),
    };
  });

  // ---- pace and when heavy work runs ---------------------------------------------------------------

  const numbers = $derived(store?.draft.job as unknown as WorkNumbers | undefined);
  const preset = $derived(presetOf(numbers));
  const choosePace = (value: string) => {
    if (numbers && !locked) {
      applyPreset(numbers, value as WorkPreset);
    }
  };
  const nightly = $derived(
    (store?.draft as { nightlyTasks?: { quietHours?: boolean } } | undefined)?.nightlyTasks as
      { quietHours?: boolean } | undefined,
  );
  const chooseWhen = (value: string) => {
    if (nightly && !locked) {
      nightly.quietHours = value === 'night';
    }
  };

  // ---- the features --------------------------------------------------------------------------------

  const TONES: Record<string, KitTone> = { running: 'good', failed: 'warn', paused: 'warn', waiting: 'off' };
  const featureState = (feature: WorkFeature) => {
    const own = rowsOf(feature);
    const states = new Set(own.map((row) => workState(row)));
    if (own.length > 0 && own.every((row) => row.queue.isPaused)) {
      return 'paused';
    }
    for (const state of ['failed', 'running', 'waiting'] as const) {
      if (states.has(state)) {
        return state;
      }
    }
    return 'up-to-date';
  };
  const stateWords = (state: string) =>
    state === 'failed'
      ? $t('frameleaf_bgwork_feature_failed')
      : $t(`frameleaf_bgwork_state_${state.replaceAll('-', '_')}` as Translations);
  const left = (feature: WorkFeature) => rowsOf(feature).reduce((total, row) => total + workLeft(row), 0);
  const firstFailed = $derived(summary.failed[0]?.definition.name);

  /** Where each routed feature runs now, by the place's name (the who-does-what grid in Computers). */
  const WORKLOADS: Partial<Record<WorkFeatureId, MlWorkload>> = {
    faces: MlWorkload.Face,
    search: MlWorkload.Clip,
    text: MlWorkload.Ocr,
    descriptions: MlWorkload.Enrichment,
  };
  let places = $state<Partial<Record<WorkFeatureId, string>>>({});
  onMount(async () => {
    try {
      const [destinations, { routes }] = await Promise.all([listMlDestinations(), getMlWorkloadRoutes()]);
      const named: Partial<Record<WorkFeatureId, string>> = {};
      for (const [id, workload] of Object.entries(WORKLOADS) as [WorkFeatureId, MlWorkload][]) {
        const destination = destinations.find(
          (item) => item.id === routes.find((route) => route.workload === workload)?.destinationId,
        );
        if (destination) {
          named[id] =
            destination.kind === MlDestinationKind.Local
              ? $t('frameleaf_computers_this_server')
              : destination.kind === MlDestinationKind.FrameleafCloud
                ? $t('frameleaf_computers_cloud')
                : destination.name;
        }
      }
      places = named;
    } catch {
      // Without the routes each feature still links to Computers.
    }
  });
</script>

{#if unavailable}
  <InlineError compact message={$t('frameleaf_bgwork_unavailable')} {onRetry} />
{/if}

{#if !pending}
  <Hero
    tone={hero.tone}
    icon={hero.icon}
    title={hero.title}
    body={hero.body}
    label={$t('frameleaf_bgwork_status_label')}
  >
    {#snippet actions()}
      {#if pausedRows.length > 0}
        <Button variant={allPaused ? 'primary' : 'default'} onclick={onResumeAll}>
          <Icon icon={mdiPlay} size="1rem" aria-hidden />
          {$t('frameleaf_bgwork_resume_all', { values: { count: pausedRows.length } })}
        </Button>
      {/if}
      {#if !allPaused}
        <Button onclick={onPauseAll}>
          <Icon icon={mdiPause} size="1rem" aria-hidden />{$t('frameleaf_bgwork_pause_all')}
        </Button>
      {/if}
      {#if firstFailed && !allPaused}
        <a class="button" href={href(firstFailed, 'failed')}>{$t('frameleaf_bgwork_see_failed')}</a>
      {/if}
      <a class="button" class:primary={!!firstFailed && !allPaused} href={Route.activity()}>
        {firstFailed && !allPaused ? $t('frameleaf_bgwork_fix_in_activity') : $t('frameleaf_bgwork_open_activity')}
        <Icon icon={mdiChevronRight} size="16" aria-hidden />
      </a>
    {/snippet}
  </Hero>
{/if}

<Section title={$t('frameleaf_bgwork_pace')}>
  <Row
    label={$t('frameleaf_bgwork_effort')}
    help={preset
      ? $t(`frameleaf_bgwork_preset_${preset}_help` as Translations)
      : $t('frameleaf_bgwork_pace_custom_help')}
  >
    <SegmentedControl
      label={$t('frameleaf_bgwork_effort')}
      options={(['light', 'balanced', 'fast'] as const).map((value) => ({
        value,
        label: $t(`frameleaf_bgwork_preset_${value}` as Translations),
      }))}
      value={preset ?? ''}
      disabled={locked || !numbers}
      onChange={choosePace}
    />
  </Row>
  <Row
    label={$t('frameleaf_bgwork_when')}
    help={nightly?.quietHours === false ? $t('frameleaf_bgwork_when_any_help') : $t('frameleaf_bgwork_when_night_help')}
  >
    <div class="inline">
      <a class="button" href={overnightHref}>{$t('frameleaf_bgwork_overnight_schedule')}</a>
      <SegmentedControl
        label={$t('frameleaf_bgwork_when')}
        options={[
          { value: 'any', label: $t('frameleaf_bgwork_when_any') },
          { value: 'night', label: $t('frameleaf_bgwork_when_night') },
        ]}
        value={nightly?.quietHours === false ? 'any' : 'night'}
        disabled={locked || !nightly}
        onChange={chooseWhen}
      />
    </div>
  </Row>
</Section>

<Section title={$t('frameleaf_bgwork_features')} description={$t('frameleaf_bgwork_features_description')}>
  <ul class="features">
    {#each WORK_FEATURES as feature (feature.id)}
      {@const own = rowsOf(feature)}
      {@const state = featureState(feature)}
      {@const remaining = left(feature)}
      {@const name = featureName(feature)}
      <li class="feature">
        <span class="feature-icon"><Icon icon={feature.icon} size="20" aria-hidden /></span>
        <div class="feature-name">
          <strong>{name}</strong>
          <small>{$t(`frameleaf_work_feature_${feature.id}_does` as Translations)}</small>
        </div>
        {#if feature.routed}
          <a class="where" href={computersHref}>{places[feature.id] ?? $t('frameleaf_bgwork_where')}</a>
        {:else}
          <span class="where is-fixed">{$t('frameleaf_computers_this_server')}</span>
        {/if}
        <div class="feature-state">
          {#if unknownOf(feature)}
            <Pill tone="off">{$t('frameleaf_computers_cover_unknown')}</Pill>
          {:else if own.length > 0}
            <Pill tone={TONES[state] ?? 'off'}>{stateWords(state)}</Pill>
          {/if}
          {#if remaining > 0 && !unknownOf(feature)}
            <small>{$t('frameleaf_bgwork_left', { values: { count: remaining } })}</small>
          {/if}
        </div>
        <Menu label={$t('frameleaf_bgwork_feature_more', { values: { name } })} align="end">
          {#snippet trigger()}<Icon icon={mdiDotsHorizontal} size="18" aria-hidden />{/snippet}
          {#if own.length === 0}
            <p class="menu-note">{$t(`frameleaf_work_feature_${feature.id}_started` as Translations)}</p>
          {:else}
            <MenuItem onSelect={() => onFeature(feature, state === 'paused' ? 'resume' : 'pause')}>
              <Icon icon={state === 'paused' ? mdiPlay : mdiPause} size="16" aria-hidden />
              {state === 'paused' ? $t('frameleaf_bgwork_resume') : $t('frameleaf_bgwork_pause')}
            </MenuItem>
            {#if own.some((row) => row.definition.run)}
              <MenuItem onSelect={() => onFeature(feature, 'run')}>
                <Icon icon={mdiPlaylistCheck} size="16" aria-hidden />{$t('frameleaf_bgwork_catch_up_missing')}
              </MenuItem>
            {/if}
            {#if feature.id === 'descriptions'}
              <!-- Redo descriptions is this feature's "Do it all again…" (audit 2026-11-03). -->
              <MenuItem onSelect={() => onTask('descriptions')}>
                <Icon icon={mdiRefresh} size="16" aria-hidden />{$t('frameleaf_bgwork_redo_all_ask')}
              </MenuItem>
              <MenuItem onSelect={() => onTask('smart-albums')}>
                <Icon icon={mdiImageSearchOutline} size="16" aria-hidden />{$t('frameleaf_bgwork_task_smart_albums')}
              </MenuItem>
            {:else if own.some((row) => row.definition.force)}
              <MenuItem onSelect={() => onFeature(feature, 'force')}>
                <Icon icon={mdiRefresh} size="16" aria-hidden />{$t('frameleaf_bgwork_redo_all_ask')}
              </MenuItem>
            {/if}
            {#if feature.id === 'upkeep'}
              <MenuItem onSelect={() => onTask('damage')}>
                <Icon icon={mdiShieldCheckOutline} size="16" aria-hidden />{$t('frameleaf_bgwork_task_damage')}
              </MenuItem>
              <MenuItem onSelect={() => onTask('count')}>
                <Icon icon={mdiChartLine} size="16" aria-hidden />{$t('frameleaf_bgwork_task_count')}
              </MenuItem>
            {/if}
            <MenuItem onSelect={() => onAdvanced(feature.id)}>
              <Icon icon={mdiFormatListChecks} size="16" aria-hidden />
              {$t('frameleaf_bgwork_feature_tasks', { values: { count: own.length } })}
            </MenuItem>
          {/if}
        </Menu>
      </li>
    {/each}
  </ul>
  <p class="hint">{$t('frameleaf_bgwork_everyone')}</p>
</Section>

<Section title={$t('frameleaf_bgwork_at_once')}>
  <Row label={$t('frameleaf_bgwork_at_once_label')} help={$t('frameleaf_bgwork_at_once_help')}>
    <Button onclick={() => onAdvanced()}>
      {$t('frameleaf_bgwork_open_advanced')}<Icon icon={mdiChevronRight} size="16" aria-hidden />
    </Button>
  </Row>
</Section>

<style>
  .inline {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: var(--fl-space-2);
  }
  .hint,
  .menu-note {
    margin: var(--fl-space-3) 0 var(--fl-space-4);
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .menu-note {
    max-width: 16rem;
    margin: var(--fl-space-2);
  }
  /* One row per feature (approved design, 2026-11-04): icon, name, where it runs, state, menu. */
  .features {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .feature {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) 140px 150px auto;
    align-items: center;
    gap: 14px;
    padding: 12px 0;
  }
  .feature + .feature {
    border-top: 1px solid var(--fl-border);
  }
  .feature-icon {
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    color: var(--fl-muted);
    background: var(--fl-raised);
    border-radius: var(--fl-radius-sm);
  }
  .feature-name strong {
    display: block;
    font-weight: 600;
  }
  .feature-name small,
  .feature-state small {
    display: block;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .feature-state {
    display: grid;
    justify-items: start;
    gap: 2px;
  }
  .where {
    justify-self: start;
    color: var(--fl-accent);
    font-size: var(--fl-font-small);
    text-decoration: none;
  }
  a.where:hover {
    text-decoration: underline;
  }
  .where.is-fixed {
    color: var(--fl-muted);
  }
  @media (max-width: 700px) {
    .feature {
      grid-template-columns: auto minmax(0, 1fr) auto;
    }
    .feature > .where,
    .feature > .feature-state {
      grid-column: 2;
    }
    .feature > :global(.menu-root) {
      grid-column: 3;
      grid-row: 1;
    }
  }
</style>
