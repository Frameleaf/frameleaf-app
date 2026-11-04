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
  import Item from '$lib/components/frameleaf/settings/kit/Item.svelte';
  import ItemList from '$lib/components/frameleaf/settings/kit/ItemList.svelte';
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
  import type { QueueName } from '@frameleaf/sdk';
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

  const summary = $derived(summariseWork(rows));
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
  <ItemList>
    {#each WORK_FEATURES as feature (feature.id)}
      {@const own = rowsOf(feature)}
      {@const state = featureState(feature)}
      {@const remaining = left(feature)}
      {@const name = featureName(feature)}
      <Item
        icon={feature.icon}
        {name}
        detail={$t(`frameleaf_work_feature_${feature.id}_does` as Translations)}
        tone={TONES[state] ?? 'off'}
        status={own.length > 0 ? stateWords(state) : undefined}
        note={remaining > 0 ? $t('frameleaf_bgwork_left', { values: { count: remaining } }) : undefined}
      >
        {#snippet action()}
          <div class="actions">
            {#if feature.routed}
              <a class="button" href={computersHref}>{$t('frameleaf_bgwork_where')}</a>
            {/if}
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
                    <Icon icon={mdiImageSearchOutline} size="16" aria-hidden />{$t(
                      'frameleaf_bgwork_task_smart_albums',
                    )}
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
          </div>
        {/snippet}
      </Item>
    {/each}
  </ItemList>
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
  .inline,
  .actions {
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
</style>
