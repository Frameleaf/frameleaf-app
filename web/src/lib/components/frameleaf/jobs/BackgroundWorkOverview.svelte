<script lang="ts">
  /**
   * Background work, the page it opens on (FL-364), after the approved prototype
   * (`settings-v2/computers/Background.jsx`): one sentence that says how the work is going, then only
   * the kinds that are running, waiting, paused or failed. Every kind is behind "Show all kinds of
   * work". "How hard this server works" is Light, Balanced or Fast over the server's own "how many
   * at once" numbers, which stay editable under "Set each kind of work yourself". The Job manager
   * owns the data, the review of every command and the page for one kind of work; this draws its
   * first page.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import SegmentedControl from '$lib/components/frameleaf/SegmentedControl.svelte';
  import Advanced from '$lib/components/frameleaf/settings/kit/Advanced.svelte';
  import Amount from '$lib/components/frameleaf/settings/kit/Amount.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import Item from '$lib/components/frameleaf/settings/kit/Item.svelte';
  import ItemList from '$lib/components/frameleaf/settings/kit/ItemList.svelte';
  import Links, { type LinkRow } from '$lib/components/frameleaf/settings/kit/Links.svelte';
  import Notice from '$lib/components/frameleaf/settings/kit/Notice.svelte';
  import Pill, { type KitTone } from '$lib/components/frameleaf/settings/kit/Pill.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import { summariseWork, workLeft, workNow, workState, type WorkRow, type WorkState } from '$lib/frameleaf/computers';
  import { isFeatureOff, JOB_QUEUE_CATEGORIES, JOB_QUEUES, type JobTab } from '$lib/frameleaf/job-queues';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import type { SystemConfigDraftStore } from '$lib/frameleaf/system-config-draft.svelte';
  import {
    applyPreset,
    AT_ONCE_MOST,
    presetOf,
    TUNABLE_WORK,
    WORK_PRESETS,
    type WorkNumbers,
    type WorkPreset,
  } from '$lib/frameleaf/work-presets';
  import { locale } from '$lib/stores/preferences.store';
  import { QueueName, type ServerFeaturesDto } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import {
    mdiAlertCircleOutline,
    mdiChartLine,
    mdiCheckCircleOutline,
    mdiChevronRight,
    mdiImageSearchOutline,
    mdiPause,
    mdiPauseCircleOutline,
    mdiPlay,
    mdiProgressClock,
    mdiShieldCheckOutline,
    mdiTagTextOutline,
  } from '@mdi/js';
  import { t, type Translations } from 'svelte-i18n';

  export type OverviewTask = 'descriptions' | 'smart-albums' | 'damage' | 'count' | 'more';

  let {
    rows,
    unknown,
    pending = false,
    unavailable = false,
    accountName,
    flags,
    store,
    locked = false,
    href,
    onPauseAll,
    onResumeAll,
    onTask,
    onRetry,
  }: {
    /** Every kind of work the server reports, with the counts the page is filtered to. */
    rows: WorkRow[];
    /** Kinds of work whose counts could not be read (one account's, when that request failed). */
    unknown?: ReadonlySet<QueueName>;
    /** The server has not answered yet. */
    pending?: boolean;
    /** Its last answer failed; `rows` is what it said before. */
    unavailable?: boolean;
    /** Set while the counts are one account's. */
    accountName?: string;
    flags: ServerFeaturesDto;
    /** The settings draft the "how many at once" numbers are edited in. */
    store?: SystemConfigDraftStore;
    /** A configuration file sets the numbers. */
    locked?: boolean;
    /** The address of one kind of work, optionally at one of its lists. */
    href: (name: QueueName, tab?: JobTab) => string;
    onPauseAll: () => void;
    onResumeAll: () => void;
    onTask: (task: OverviewTask) => void;
    onRetry: () => void;
  } = $props();

  const number = (value: number) => value.toLocaleString($locale);
  const name = ({ definition }: Pick<WorkRow, 'definition'>) => $t(`frameleaf_work_${definition.key}` as Translations);
  const does = ({ definition }: WorkRow) => $t(`frameleaf_work_${definition.key}_does` as Translations);

  // A kind whose counts could not be read is never shown as up to date, and is left out of the totals.
  const known = $derived(rows.filter((row) => !unknown?.has(row.definition.name)));
  const summary = $derived(summariseWork(known));
  const now = $derived(workNow(known));
  const busy = $derived([...summary.running, ...summary.waiting]);

  const TONES: Record<WorkState, KitTone> = {
    running: 'good',
    waiting: 'off',
    paused: 'warn',
    failed: 'warn',
    'up-to-date': 'off',
  };
  const stateWords = (row: WorkRow) => {
    const state = workState(row);
    return state === 'failed'
      ? $t('frameleaf_bgwork_state_failed', { values: { count: row.queue.statistics.failed } })
      : $t(`frameleaf_bgwork_state_${state.replaceAll('-', '_')}` as Translations);
  };

  const hero = $derived.by(() => {
    if (summary.failedCount > 0) {
      return {
        kind: 'failed' as const,
        tone: 'warn' as const,
        icon: mdiAlertCircleOutline,
        title: $t('frameleaf_bgwork_failed', { values: { count: summary.failedCount } }),
        body: $t('frameleaf_bgwork_failed_body', {
          values: {
            work: summary.failed
              .map((row) =>
                $t('frameleaf_bgwork_failed_in', { values: { name: name(row), count: row.queue.statistics.failed } }),
              )
              .join('. '),
          },
        }),
      };
    }
    if (busy.length > 0) {
      return {
        kind: 'working' as const,
        tone: 'good' as const,
        icon: mdiProgressClock,
        title: $t('frameleaf_bgwork_working', { values: { count: summary.left } }),
        body: $t('frameleaf_bgwork_working_body', {
          values: {
            work: busy
              .slice(0, 3)
              .map((row) => $t('frameleaf_computers_work_left', { values: { name: name(row), count: workLeft(row) } }))
              .join('. '),
          },
        }),
      };
    }
    if (summary.paused.length > 0) {
      return {
        kind: 'paused' as const,
        tone: 'warn' as const,
        icon: mdiPauseCircleOutline,
        title: $t('frameleaf_bgwork_paused', {
          values: { count: summary.paused.length, name: name(summary.paused[0]) },
        }),
        body: $t('frameleaf_bgwork_paused_body', {
          values: { count: summary.paused.reduce((total, row) => total + workLeft(row), 0) },
        }),
      };
    }
    return {
      kind: 'idle' as const,
      tone: 'good' as const,
      icon: mdiCheckCircleOutline,
      title: $t('frameleaf_bgwork_idle'),
      body: $t('frameleaf_bgwork_idle_body'),
    };
  });

  const groups = $derived(
    JOB_QUEUE_CATEGORIES.map((category) => ({
      category,
      rows: rows.filter((row) => row.definition.category === category),
    })).filter((group) => group.rows.length > 0),
  );

  // ---- how hard this server works ------------------------------------------------------------------

  const numbers = $derived(store?.draft.job as unknown as WorkNumbers | undefined);
  const saved = $derived(store?.baseline.job as unknown as WorkNumbers | undefined);
  const preset = $derived(presetOf(numbers));
  const unsaved = $derived((store?.changes ?? []).some((change) => change.path.startsWith('job.')));
  const at = (queue: QueueName) => numbers?.[queue]?.concurrency ?? 1;
  const AI = JOB_QUEUES.filter(
    (definition) => definition.category === 'intelligence' && (TUNABLE_WORK as QueueName[]).includes(definition.name),
  ).map((definition) => definition.name);
  const sentence = $derived.by(() => {
    // "Up to": the most any one AI task runs. Some (reading text, pets) run fewer on every choice.
    const ai = AI.filter((queue) => numbers?.[queue] !== undefined).map((queue) => at(queue));
    const values = {
      thumbnails: at(QueueName.ThumbnailGeneration),
      videos: at(QueueName.VideoConversion),
      ai: number(Math.max(1, ...ai)),
    };
    return preset
      ? `${$t(`frameleaf_bgwork_preset_${preset}_help` as Translations)} ${$t('frameleaf_bgwork_preset_sentence', {
          values: { ...values, preset: $t(`frameleaf_bgwork_preset_${preset}` as Translations) },
        })}`
      : $t('frameleaf_bgwork_custom_sentence', { values });
  });
  const choose = (value: string) => {
    if (numbers && !locked) {
      applyPreset(numbers, value as WorkPreset);
    }
  };
  /** The kinds whose number can be set, in the catalogue's order, and the ones the server keeps at one. */
  const tunable = $derived(rows.filter(({ definition }) => numbers?.[definition.name] !== undefined));
  const single = $derived(numbers ? rows.filter(({ definition }) => numbers[definition.name] === undefined) : []);
  const list = (names: string[]) => new Intl.ListFormat($locale, { style: 'long', type: 'conjunction' }).format(names);
  const setNumber = (queue: QueueName, value: number) => {
    const entry = numbers?.[queue];
    if (entry && !locked) {
      entry.concurrency = value;
    }
  };

  const tasks = $derived.by((): LinkRow[] => [
    {
      icon: mdiTagTextOutline,
      title: $t('frameleaf_bgwork_task_descriptions'),
      body: $t('frameleaf_bgwork_task_descriptions_body'),
      onSelect: () => onTask('descriptions'),
    },
    {
      icon: mdiImageSearchOutline,
      title: $t('frameleaf_bgwork_task_smart_albums'),
      body: $t('frameleaf_bgwork_task_smart_albums_body'),
      onSelect: () => onTask('smart-albums'),
    },
    {
      icon: mdiShieldCheckOutline,
      title: $t('frameleaf_bgwork_task_damage'),
      body: $t('frameleaf_bgwork_task_damage_body'),
      onSelect: () => onTask('damage'),
    },
    {
      icon: mdiChartLine,
      title: $t('frameleaf_bgwork_task_count'),
      body: $t('frameleaf_bgwork_task_count_body'),
      onSelect: () => onTask('count'),
    },
  ]);
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
      {#if hero.kind === 'failed'}
        <a
          class="button primary"
          href={href(summary.failed[0].definition.name, 'failed')}
          aria-label={$t('frameleaf_bgwork_review_named', { values: { name: name(summary.failed[0]) } })}
        >
          {$t('frameleaf_bgwork_review')}
        </a>
      {:else if hero.kind === 'working'}
        <Button onclick={onPauseAll}>
          <Icon icon={mdiPause} size="1rem" aria-hidden />{$t('frameleaf_bgwork_pause_all')}
        </Button>
      {/if}
      {#if summary.paused.length > 0}
        <Button variant={hero.kind === 'paused' ? 'primary' : 'default'} onclick={onResumeAll}>
          <Icon icon={mdiPlay} size="1rem" aria-hidden />
          {$t('frameleaf_bgwork_resume_all', { values: { count: summary.paused.length } })}
        </Button>
      {/if}
    {/snippet}
  </Hero>
{/if}

<Section
  title={$t('frameleaf_bgwork_now')}
  description={pending ? undefined : now.length > 0 ? $t('frameleaf_bgwork_now_some') : $t('frameleaf_bgwork_now_none')}
>
  {#if now.length > 0}
    <ItemList>
      {#each now as row (row.definition.name)}
        {@const state = workState(row)}
        {@const failed = row.queue.statistics.failed}
        {@const left = workLeft(row)}
        <Item
          icon={row.definition.icon}
          name={name(row)}
          detail={does(row)}
          tone={TONES[state]}
          status={stateWords(row)}
          note={state !== 'failed' && failed > 0
            ? $t('frameleaf_bgwork_also_failed', { values: { count: failed } })
            : undefined}
        >
          {#snippet measure()}
            {#if left > 0}
              <strong class="left">{$t('frameleaf_bgwork_left', { values: { count: left } })}</strong>
            {/if}
          {/snippet}
          {#snippet action()}
            {#if state === 'failed'}
              <a
                class="button primary"
                href={href(row.definition.name, 'failed')}
                aria-label={$t('frameleaf_bgwork_review_named', { values: { name: name(row) } })}
              >
                {$t('frameleaf_bgwork_review')}
              </a>
            {:else}
              <a
                class="button"
                href={href(row.definition.name)}
                aria-label={$t('frameleaf_bgwork_manage_named', { values: { name: name(row) } })}
              >
                {$t('frameleaf_bgwork_manage')}<Icon icon={mdiChevronRight} size="16" aria-hidden />
              </a>
            {/if}
          {/snippet}
        </Item>
      {/each}
    </ItemList>
  {/if}
  {#if rows.length > 0}
    <Advanced summary={$t('frameleaf_bgwork_show_all', { values: { count: rows.length } })}>
      {#each groups as group (group.category)}
        <div class="kinds">
          <h3>{$t(`frameleaf_bgwork_group_${group.category}` as Translations)}</h3>
          <ul>
            {#each group.rows as row (row.definition.name)}
              {@const state = workState(row)}
              {@const off = isFeatureOff(row.definition, flags)}
              {@const left = workLeft(row)}
              <li>
                <div>
                  <strong>{name(row)}</strong>
                  <span>{does(row)}</span>
                </div>
                <Pill
                  tone={unknown?.has(row.definition.name) || (off && state === 'up-to-date') ? 'off' : TONES[state]}
                >
                  {#if unknown?.has(row.definition.name)}
                    {$t('frameleaf_computers_cover_unknown')}
                  {:else if off && state === 'up-to-date'}
                    {$t('frameleaf_bgwork_state_off')}
                  {:else if left > 0 && state !== 'failed'}
                    {$t('frameleaf_bgwork_state_left', { values: { state: stateWords(row), count: left } })}
                  {:else}
                    {stateWords(row)}
                  {/if}
                </Pill>
                <a
                  class="button"
                  href={href(row.definition.name)}
                  aria-label={$t('frameleaf_bgwork_manage_named', { values: { name: name(row) } })}
                >
                  {$t('frameleaf_bgwork_manage')}
                </a>
              </li>
            {/each}
          </ul>
        </div>
      {/each}
      <p class="hint">
        {accountName
          ? $t('frameleaf_bgwork_one_account', { values: { name: accountName } })
          : $t('frameleaf_bgwork_everyone')}
      </p>
    </Advanced>
  {/if}
</Section>

{#if numbers}
  <Section title={$t('frameleaf_bgwork_effort')} description={$t('frameleaf_bgwork_effort_description')}>
    {#if locked}
      <Notice tone="info">{$t('frameleaf_bgwork_effort_locked')}</Notice>
    {/if}
    <Row
      label={$t('frameleaf_bgwork_effort_row')}
      help={unsaved ? `${sentence} ${$t('frameleaf_bgwork_effort_unsaved')}` : sentence}
    >
      <div class="effort">
        {#if !preset}
          <span class="custom">{$t('frameleaf_bgwork_custom')}</span>
          <Button disabled={locked} onclick={() => choose('balanced')}>
            {$t('frameleaf_bgwork_back_to_balanced')}
          </Button>
        {/if}
        <SegmentedControl
          label={$t('frameleaf_bgwork_effort_label')}
          options={WORK_PRESETS.map((value) => ({
            value,
            label: $t(`frameleaf_bgwork_preset_${value}` as Translations),
          }))}
          value={preset}
          disabled={locked}
          onChange={choose}
        />
      </div>
    </Row>
    <Advanced summary={$t('frameleaf_bgwork_numbers')}>
      <p class="hint">{$t('frameleaf_bgwork_numbers_help', { values: { most: AT_ONCE_MOST } })}</p>
      <div class="numbers">
        {#each tunable as row (row.definition.name)}
          {@const value = at(row.definition.name)}
          <div>
            <span>{name(row)}</span>
            {#if value > AT_ONCE_MOST}
              <!-- A number saved before this page had a limit: shown, kept, and replaced only by a choice. -->
              <small>
                {$t('frameleaf_bgwork_numbers_above', { values: { name: name(row), count: number(value) } })}
              </small>
            {/if}
            <Amount
              label={$t('frameleaf_bgwork_numbers_input', { values: { name: name(row) } })}
              unit={$t('frameleaf_bgwork_numbers_unit')}
              min={1}
              max={Math.max(AT_ONCE_MOST, saved?.[row.definition.name]?.concurrency ?? 1)}
              {value}
              disabled={locked}
              onChange={(next) => setNumber(row.definition.name, next)}
            />
          </div>
        {/each}
      </div>
      {#if single.length > 0}
        <p class="hint">
          {$t('frameleaf_bgwork_numbers_single', { values: { names: list(single.map((row) => name(row))) } })}
        </p>
      {/if}
    </Advanced>
  </Section>
{/if}

<Section title={$t('frameleaf_bgwork_tasks')} description={$t('frameleaf_bgwork_tasks_description')}>
  {#snippet action()}
    <Button onclick={() => onTask('more')}>{$t('frameleaf_bgwork_tasks_more')}</Button>
  {/snippet}
  <Links rows={tasks} />
</Section>

<Section title={$t('frameleaf_bgwork_nightly')}>
  <Row label={$t('frameleaf_bgwork_nightly_row')} help={$t('frameleaf_bgwork_nightly_help')}>
    <a class="button" href={commandCenterUrl('processing', 'nightly-tasks')}>{$t('frameleaf_bgwork_nightly_open')}</a>
  </Row>
</Section>

<style>
  a.button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--fl-space-1);
    text-decoration: none;
    white-space: nowrap;
  }
  a.button:focus-visible {
    outline: var(--fl-focus-ring);
    outline-offset: var(--fl-focus-offset);
  }
  .left {
    font-size: var(--fl-font-callout);
    font-variant-numeric: tabular-nums;
  }
  .hint {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
  }
  /* The compact list of every kind of work: name and what it does, its state, one button. */
  .kinds {
    display: grid;
    gap: var(--fl-space-2);
    padding-bottom: var(--fl-space-4);
  }
  .kinds h3 {
    margin: var(--fl-space-2) 0 0;
    color: var(--fl-muted);
    font: var(--fl-type-micro);
    letter-spacing: 0.07em;
    text-transform: uppercase;
  }
  .kinds ul {
    display: grid;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .kinds li {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
    align-items: center;
    gap: var(--fl-space-4);
    padding: var(--fl-space-2) 0;
    border-top: 1px solid var(--fl-border);
  }
  .kinds li > div {
    display: grid;
    gap: var(--fl-space-1);
    min-width: 0;
  }
  .kinds li strong {
    font-size: var(--fl-font-callout);
    font-weight: 600;
  }
  .kinds li span {
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
  }
  .effort {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: var(--fl-space-3);
  }
  .custom {
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
    font-weight: 600;
  }
  .numbers {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--fl-space-2) var(--fl-space-6);
    padding: var(--fl-space-3) 0;
  }
  .numbers > div {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--fl-space-1) var(--fl-space-3);
    min-height: var(--fl-control-height);
    font-size: var(--fl-font-callout);
  }
  .numbers small {
    grid-column: 1 / -1;
    grid-row: 2;
    color: var(--fl-muted);
  }
  @container kit (max-width: 620px) {
    .numbers {
      grid-template-columns: minmax(0, 1fr);
    }
    .kinds li {
      grid-template-columns: minmax(0, 1fr) auto;
    }
    .kinds li > div {
      grid-column: 1 / -1;
    }
    .effort {
      justify-content: flex-start;
    }
  }
</style>
