<script lang="ts">
  /**
   * Computers & background work, the landing page (FL-364), after the approved prototype
   * (`settings-v2/computers/Landing.jsx`): is the server keeping up and is anything stuck, then
   * where to go. Every line is read from what the area's pages already load: the computers the
   * server lists, what Studio and restoration can run now, and the queues.
   */
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Skeleton from '$lib/components/frameleaf/Skeleton.svelte';
  import Coverage, { type CoverageRow } from '$lib/components/frameleaf/settings/kit/Coverage.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import Links, { type LinkRow } from '$lib/components/frameleaf/settings/kit/Links.svelte';
  import Notice from '$lib/components/frameleaf/settings/kit/Notice.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import {
    aiState,
    areaStatus,
    computersFrom,
    notAnswering,
    studioWorkUnavailable,
    summariseWork,
    workLeft,
    workRows,
    type WorkRow,
  } from '$lib/frameleaf/computers';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { queueManager } from '$lib/managers/queue-manager.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import {
    getRenderWorkerCompatibility,
    getWorkerInventory,
    type RenderWorkerCompatibilityResponseDto,
    type WorkerInventoryResponseDto,
  } from '@frameleaf/sdk';
  import {
    mdiAlertCircleOutline,
    mdiCheckCircleOutline,
    mdiDesktopTowerMonitor,
    mdiExpansionCard,
    mdiPauseCircleOutline,
    mdiProgressClock,
    mdiTransitConnectionVariant,
    mdiTrayFull,
    mdiWeatherNight,
  } from '@mdi/js';
  import { onMount } from 'svelte';
  import { persisted } from 'svelte-persisted-store';
  import { t, type Translations } from 'svelte-i18n';

  onMount(() => queueManager.listen());

  let inventory = $state<WorkerInventoryResponseDto | null>();
  let compatibility = $state<RenderWorkerCompatibilityResponseDto | null>();
  let retrying = $state(false);
  /** A reading the page can do without: unreadable is null, and the page says so. */
  const read = async <T,>(request: () => Promise<T>) => {
    try {
      return (await request()) ?? null;
    } catch {
      return null;
    }
  };
  const load = async () => {
    retrying = true;
    [inventory, compatibility] = await Promise.all([read(getWorkerInventory), read(getRenderWorkerCompatibility)]);
    retrying = false;
  };
  onMount(() => void load());

  const loaded = $derived(inventory !== undefined && queueManager.snapshots.length > 0);
  const unread = $derived(inventory === null || compatibility === null || queueManager.failed);

  const computers = $derived(computersFrom(inventory));
  const helpers = $derived(computers.filter((computer) => computer.place === 'home'));
  const silent = $derived(notAnswering(computers));
  const ai = $derived(aiState(inventory));
  const solo = $derived(computers.length === 1);
  const work = $derived(summariseWork(workRows(queueManager.queues)));
  const status = $derived(areaStatus(work, silent, ai));

  const list = (names: string[]) => new Intl.ListFormat($locale, { style: 'long', type: 'conjunction' }).format(names);
  const workName = ({ definition }: WorkRow) => $t(`frameleaf_work_${definition.key}` as Translations);
  const left = (row: WorkRow) =>
    $t('frameleaf_computers_work_left', { values: { name: workName(row), count: workLeft(row) } });
  const page = (section?: string) => commandCenterUrl('processing', section);

  /** How many separate things want a look: each silent computer, AI features, and failed work as one. */
  const attention = $derived(silent.length + (ai === 'not-answering' ? 1 : 0) + (work.failedCount > 0 ? 1 : 0));
  const hero = $derived.by(() => {
    switch (status) {
      case 'attention': {
        const parts = [
          ...(silent.length > 0
            ? [$t('frameleaf_computers_status_silent', { values: { count: silent.length, name: silent[0].name } })]
            : []),
          ...(ai === 'not-answering' ? [$t('frameleaf_computers_status_ai_silent')] : []),
          ...(work.failedCount > 0
            ? [
                $t('frameleaf_computers_status_failed', {
                  values: { count: work.failedCount, work: list(work.failed.map((row) => workName(row))) },
                }),
              ]
            : []),
        ];
        return {
          tone: 'warn' as const,
          icon: mdiAlertCircleOutline,
          title: $t('frameleaf_computers_status_attention', { values: { count: attention } }),
          body: parts.join(' '),
        };
      }
      case 'working': {
        return {
          tone: 'good' as const,
          icon: mdiProgressClock,
          title: $t('frameleaf_computers_status_working', { values: { count: work.left } }),
          body: $t('frameleaf_computers_status_working_body', {
            values: {
              work: [...work.running, ...work.waiting]
                .slice(0, 3)
                .map((row) => left(row))
                .join('. '),
            },
          }),
        };
      }
      case 'paused': {
        return {
          tone: 'warn' as const,
          icon: mdiPauseCircleOutline,
          title: $t('frameleaf_computers_status_paused', {
            values: { count: work.paused.length, name: workName(work.paused[0]) },
          }),
          body: $t('frameleaf_computers_status_paused_body'),
        };
      }
      default: {
        return {
          tone: 'good' as const,
          icon: mdiCheckCircleOutline,
          title: $t('frameleaf_computers_status_up_to_date'),
          body: solo
            ? $t('frameleaf_computers_status_up_to_date_solo')
            : $t('frameleaf_computers_status_up_to_date_body'),
        };
      }
    }
  });

  const coverage = $derived.by((): CoverageRow[] => {
    const ready = computers.filter((computer) => computer.state === 'ready').length;
    const computersRow: CoverageRow = {
      icon: mdiDesktopTowerMonitor,
      name: $t('frameleaf_computers_cover_computers'),
      detail: solo
        ? $t('frameleaf_computers_cover_computers_solo')
        : $t('frameleaf_computers_cover_computers_helpers', { values: { count: computers.length - 1 } }),
      ...(inventory === null
        ? { tone: 'off', value: $t('frameleaf_computers_cover_unknown') }
        : silent.length > 0
          ? {
              tone: 'warn',
              value: $t('frameleaf_computers_cover_silent', { values: { count: silent.length } }),
              note: list(silent.map((computer) => computer.name)),
            }
          : solo
            ? {
                tone: 'good',
                value: $t('frameleaf_computers_cover_this_server'),
                note: $t('frameleaf_computers_cover_no_others'),
              }
            : {
                tone: 'good',
                value: $t('frameleaf_computers_cover_ready', { values: { count: ready } }),
                note: list([$t('frameleaf_computers_this_server'), ...helpers.map((computer) => computer.name)]),
              }),
    };
    const busy = work.running.length + work.waiting.length;
    const workRow: CoverageRow = {
      icon: mdiTrayFull,
      name: $t('frameleaf_computers_cover_work'),
      detail: $t('frameleaf_computers_cover_work_detail'),
      ...(queueManager.failed
        ? { tone: 'off', value: $t('frameleaf_computers_cover_unknown') }
        : work.failedCount > 0
          ? {
              tone: 'warn',
              value: $t('frameleaf_computers_cover_work_failed', { values: { count: work.failedCount } }),
              note: busy > 0 ? $t('frameleaf_computers_cover_work_left', { values: { count: work.left } }) : undefined,
            }
          : work.running.length > 0
            ? {
                tone: 'good',
                value: $t('frameleaf_computers_cover_work_running', { values: { count: work.running.length } }),
                note: $t('frameleaf_computers_cover_work_left', { values: { count: work.left } }),
              }
            : work.waiting.length > 0
              ? {
                  tone: 'good',
                  value: $t('frameleaf_computers_cover_work_waiting', { values: { count: work.waiting.length } }),
                  note: $t('frameleaf_computers_cover_work_left', { values: { count: work.left } }),
                }
              : work.paused.length > 0
                ? {
                    tone: 'warn',
                    value: $t('frameleaf_computers_cover_work_paused', { values: { count: work.paused.length } }),
                  }
                : {
                    tone: 'good',
                    value: $t('frameleaf_computers_cover_work_up_to_date'),
                    note: $t('frameleaf_computers_cover_work_nothing_waiting'),
                  }),
    };
    return [computersRow, workRow];
  });

  // "Studio exports and AI restoration can't run yet": a calm note that can be dismissed. The
  // dismissal is kept on this device with what was missing at the time, so the note returns when
  // that changes (for example once a computer is added and later stops answering).
  const dismissedNote = persisted<string>('frameleaf-studio-note-dismissed', '', {});
  const missing = $derived(studioWorkUnavailable(compatibility));
  const missingKey = $derived(missing.join('+'));
  let said = $state('');
  const dismiss = () => {
    $dismissedNote = missingKey;
    said = $t('frameleaf_computers_studio_note_dismissed');
  };

  const links = $derived.by((): LinkRow[] => [
    {
      icon: mdiDesktopTowerMonitor,
      title: $t('frameleaf_computers_page_computers'),
      body:
        silent.length > 0
          ? $t('frameleaf_computers_link_computers_silent', { values: { count: silent.length, name: silent[0].name } })
          : helpers.length > 0
            ? $t('frameleaf_computers_link_computers_helpers', {
                values: { names: list(helpers.map((computer) => computer.name)) },
              })
            : $t('frameleaf_computers_link_computers_solo'),
      href: page('computers'),
    },
    {
      icon: mdiTransitConnectionVariant,
      title: $t('frameleaf_computers_page_routing'),
      body: solo ? $t('frameleaf_computers_link_routing_solo') : $t('frameleaf_computers_link_routing'),
      href: page('routing'),
    },
    {
      icon: mdiTrayFull,
      title: $t('frameleaf_computers_page_queues'),
      body:
        work.failedCount > 0
          ? $t('frameleaf_computers_link_work_failed', { values: { count: work.failedCount } })
          : work.running.length + work.waiting.length > 0
            ? `${[...work.running, ...work.waiting]
                .slice(0, 2)
                .map((row) => left(row))
                .join('. ')}.`
            : $t('frameleaf_computers_link_work_idle'),
      href: page('queues'),
    },
    {
      icon: mdiExpansionCard,
      title: $t('frameleaf_computers_page_hardware'),
      body: $t('frameleaf_computers_link_hardware'),
      href: page('hardware'),
    },
    {
      icon: mdiWeatherNight,
      title: $t('frameleaf_computers_page_overnight'),
      body: $t('frameleaf_computers_page_overnight_description'),
      href: page('nightly-tasks'),
    },
  ]);
</script>

{#if !loaded}
  <div class="loading" role="status" aria-busy="true">
    <span class="sr-only">{$t('loading')}</span>
    <Skeleton variant="block" height="168px" />
    <Skeleton variant="block" height="240px" />
  </div>
{:else}
  {#if unread}
    <InlineError
      compact
      message={$t('frameleaf_computers_unread')}
      onRetry={() => {
        void load();
        void queueManager.refresh();
      }}
      {retrying}
    />
  {/if}
  {#if said}
    <p class="said" role="status">{said}</p>
  {/if}

  <Hero
    tone={hero.tone}
    icon={hero.icon}
    title={hero.title}
    body={hero.body}
    label={$t('frameleaf_computers_status_label')}
  >
    {#snippet actions()}
      {#if silent.length > 0}
        <a class="button primary" href={page('computers')}>{$t('frameleaf_computers_see_computers')}</a>
      {/if}
      {#if work.failedCount > 0}
        <a class="button" class:primary={silent.length === 0} href={page('queues')}>
          {$t('frameleaf_computers_review_failed')}
        </a>
      {:else if status === 'working' || status === 'paused'}
        <a class="button" href={page('queues')}>{$t('frameleaf_computers_see_running')}</a>
      {/if}
    {/snippet}
    <Coverage rows={coverage} />
  </Hero>

  {#if missing.length > 0 && $dismissedNote !== missingKey}
    <Notice
      tone="info"
      title={$t('frameleaf_computers_studio_note_title', {
        values: { work: missing.length === 1 ? missing[0] : 'both' },
      })}
    >
      {$t('frameleaf_computers_studio_note_body')}
      {#snippet action()}
        <div class="buttons">
          <a class="button" href={commandCenterUrl('processing', 'computers', { add: 'name' })}>
            {$t('frameleaf_computers_add')}
          </a>
          <Button onclick={dismiss}>{$t('dismiss')}</Button>
        </div>
      {/snippet}
    </Notice>
  {/if}

  <Section title={$t('frameleaf_computers_go_to')}>
    <Links rows={links} />
  </Section>
{/if}

<style>
  .loading {
    display: grid;
    gap: var(--fl-space-6);
  }
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
  .buttons {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fl-space-2);
  }
  .said {
    margin: 0;
    padding: var(--fl-space-3) var(--fl-space-4);
    color: var(--fl-text);
    font-size: var(--fl-font-callout);
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
</style>
