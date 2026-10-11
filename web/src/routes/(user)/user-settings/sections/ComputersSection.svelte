<script lang="ts">
  /**
   * Computers & background work → Computers (FL-364), after the approved prototype
   * (`settings-v2/computers/Computers.jsx`): one page for every computer that does work for this
   * server. It replaces Workers & endpoints, Render workers and the destinations half of Workload
   * destinations, whose addresses all open here.
   *
   * The server still keeps a helper in up to two records (an address for AI features, an enrolled
   * Studio helper). The list shows each computer once, with one status. "Add a computer" offers
   * the two ways a computer can be connected today; the one-code Frameleaf helper for Mac and
   * Windows is a separate piece of work (FL-359) and is not offered until it exists. The existing
   * managers for addresses, access keys, connection codes, limits and history are kept under
   * Details, closed until needed.
   */
  import { page } from '$app/state';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import MlDestinationsPanel from '$lib/components/frameleaf/MlDestinationsPanel.svelte';
  import Coverage, { type CoverageRow } from '$lib/components/frameleaf/settings/kit/Coverage.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import Item from '$lib/components/frameleaf/settings/kit/Item.svelte';
  import ItemList from '$lib/components/frameleaf/settings/kit/ItemList.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Notice from '$lib/components/frameleaf/settings/kit/Notice.svelte';
  import type { KitTone } from '$lib/components/frameleaf/settings/kit/Pill.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import WorkerInventoryPanel from '$lib/components/frameleaf/WorkerInventoryPanel.svelte';
  import {
    aiState,
    canRunStudioWork,
    computersFrom,
    entryState,
    notAnswering,
    type Computer,
  } from '$lib/frameleaf/computers';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { locale } from '$lib/stores/preferences.store';
  import {
    getRenderWorkerCompatibility,
    getWorkerInventory,
    WorkerInventorySource,
    type RenderWorkerCompatibilityResponseDto,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import {
    mdiAlertCircleOutline,
    mdiCheckCircleOutline,
    mdiChevronRight,
    mdiCloudOutline,
    mdiCreation,
    mdiDesktopTowerMonitor,
    mdiMovieOpenOutline,
    mdiServerOutline,
  } from '@mdi/js';
  import { onMount, tick } from 'svelte';
  import { t, type Translations } from 'svelte-i18n';
  import type { ComputersData } from './loaders';
  import RenderWorkersSection from './RenderWorkersSection.svelte';

  const { data }: { data: ComputersData } = $props();

  let inventory = $state(data.processing.inventory);
  let compatibility = $state<RenderWorkerCompatibilityResponseDto | null>();
  let inventoryKey = $state(0);
  let retrying = $state(false);

  /** A reading the page can do without: unreadable is null, and the page says so. */
  const read = async <T,>(request: () => Promise<T>) => {
    try {
      return (await request()) ?? null;
    } catch {
      return null;
    }
  };
  const refresh = async () => {
    retrying = true;
    [inventory, compatibility] = await Promise.all([read(getWorkerInventory), read(getRenderWorkerCompatibility)]);
    inventoryKey += 1;
    retrying = false;
  };
  onMount(async () => {
    compatibility = await read(getRenderWorkerCompatibility);
  });

  const list = (names: string[]) => new Intl.ListFormat($locale, { style: 'long', type: 'conjunction' }).format(names);
  const computers = $derived(computersFrom(inventory));
  const silent = $derived(notAnswering(computers));
  const ai = $derived(aiState(inventory));
  const name = (computer: Computer) =>
    computer.place === 'server'
      ? $t('frameleaf_computers_this_server')
      : computer.place === 'cloud'
        ? $t('frameleaf_computers_cloud')
        : computer.name;

  /** Computers, as a household counts them: this server and the ones at home. Frameleaf Cloud is a place, not a computer. */
  const atHome = $derived(computers.filter((computer) => computer.place !== 'cloud'));
  const hero = $derived(
    silent.length > 0
      ? {
          tone: 'warn' as const,
          icon: mdiAlertCircleOutline,
          title: $t('frameleaf_computers_list_silent', { values: { count: silent.length, name: silent[0].name } }),
          body: $t('frameleaf_computers_list_silent_body'),
        }
      : atHome.length === 1
        ? {
            tone: 'good' as const,
            icon: mdiServerOutline,
            title: $t('frameleaf_computers_list_solo'),
            body: $t('frameleaf_computers_list_solo_body'),
          }
        : {
            tone: 'good' as const,
            icon: mdiCheckCircleOutline,
            title: $t('frameleaf_computers_list_ready', {
              values: { count: atHome.filter((computer) => computer.state === 'ready').length },
            }),
            body: $t('frameleaf_computers_list_ready_body'),
          },
  );

  /** The computers that are switched on, answering and set to do AI work. */
  const aiComputers = $derived(
    computers.filter(
      (computer) =>
        computer.place !== 'cloud' &&
        (computer.place === 'server' ? ai === 'ready' || ai === 'unchecked' : computer.state === 'ready') &&
        computer.entries.some(
          (entry) => entry.source === WorkerInventorySource.MlDestination && entry.routedWorkloads.length > 0,
        ),
    ),
  );
  const studioComputers = $derived(
    computers.filter((computer) =>
      computer.entries.some(
        (entry) => entry.source === WorkerInventorySource.RenderWorker && entryState(entry) === 'ready',
      ),
    ),
  );
  const exportCan = $derived(canRunStudioWork(compatibility, 'export'));
  const coverage = $derived.by((): CoverageRow[] => [
    {
      icon: mdiCreation,
      name: $t('frameleaf_computers_fact_ai'),
      detail: $t('frameleaf_computers_fact_ai_detail'),
      ...(inventory === null
        ? { tone: 'off', value: $t('frameleaf_computers_fact_ai_unread') }
        : ai === 'off'
          ? { tone: 'off', value: $t('frameleaf_computers_fact_ai_off') }
          : ai === 'not-answering' && aiComputers.length === 0
            ? { tone: 'warn', value: $t('frameleaf_computers_fact_ai_silent') }
            : {
                tone: 'good',
                value: list(aiComputers.map((computer) => name(computer))) || $t('frameleaf_computers_this_server'),
              }),
    },
    {
      icon: mdiMovieOpenOutline,
      name: $t('frameleaf_computers_fact_studio'),
      ...(exportCan
        ? {
            tone: 'good',
            detail: $t('frameleaf_computers_fact_studio_detail_ok'),
            value: list(studioComputers.map((computer) => name(computer))) || $t('frameleaf_workruns_home_computer'),
          }
        : exportCan === false
          ? {
              tone: 'warn',
              detail: $t('frameleaf_computers_fact_studio_detail'),
              value: $t('frameleaf_computers_fact_studio_none'),
            }
          : {
              tone: 'off',
              detail: $t('frameleaf_computers_fact_studio_detail'),
              value: $t('frameleaf_computers_fact_ai_unread'),
            }),
    },
  ]);

  const ICONS = { server: mdiServerOutline, home: mdiDesktopTowerMonitor, cloud: mdiCloudOutline };
  const TONES: Record<Computer['state'], KitTone> = {
    ready: 'good',
    'not-answering': 'warn',
    unchecked: 'off',
    off: 'off',
  };
  const status = (computer: Computer) => {
    if (computer.place === 'server') {
      return ai === 'off'
        ? { tone: 'good' as KitTone, words: $t('frameleaf_computers_state_ai_off') }
        : ai === 'not-answering'
          ? { tone: 'warn' as KitTone, words: $t('frameleaf_computers_state_ai_silent') }
          : { tone: 'good' as KitTone, words: $t('frameleaf_computers_state_ready') };
    }
    return {
      tone: TONES[computer.state],
      words: $t(`frameleaf_computers_state_${computer.state.replaceAll('-', '_')}` as Translations),
      note:
        computer.state === 'not-answering'
          ? $t('frameleaf_computers_state_not_answering_note')
          : computer.state === 'unchecked'
            ? $t('frameleaf_computers_state_unchecked_note')
            : undefined,
    };
  };
  /** What a computer helps with, and how many kinds of work are set to run on it. */
  const helps = (computer: Computer) => {
    const sources = new Set(computer.entries.map((entry) => entry.source));
    return [
      sources.has(WorkerInventorySource.MlDestination) || computer.place === 'server'
        ? $t('frameleaf_computers_helps_ai')
        : '',
      sources.has(WorkerInventorySource.RenderWorker) ? $t('frameleaf_computers_helps_studio') : '',
    ].filter(Boolean);
  };
  const doing = (computer: Computer) =>
    computer.entries.reduce((total, entry) => total + entry.routedWorkloads.length + entry.renderKinds.length, 0);

  // ---- add a computer, and the managers under Details ----------------------------------------------

  let addRequest = $state(0);
  let enrolRequest = $state(0);
  let aiDetails = $state<HTMLDetailsElement>();
  let studioDetails = $state<HTMLDetailsElement>();
  let addSection = $state<HTMLElement>();
  const open = async (details: HTMLDetailsElement | undefined) => {
    if (details) {
      details.open = true;
      await tick();
      details.scrollIntoView({ block: 'start' });
    }
  };
  const connectByAddress = async () => {
    await open(aiDetails);
    addRequest += 1;
  };
  const connectStudio = async () => {
    await open(studioDetails);
    enrolRequest += 1;
  };
  const manage = (computer: Computer) =>
    open(
      computer.entries.some((entry) => entry.source === WorkerInventorySource.MlDestination) ||
        computer.place === 'server'
        ? aiDetails
        : studioDetails,
    );
  // "Add a computer" links from the other pages (`?add=`) land on the two ways to connect one.
  onMount(() => {
    if (page.url.searchParams.has('add')) {
      addSection?.scrollIntoView({ block: 'start' });
    }
  });
</script>

<KitPage>
  {#if inventory === null}
    <InlineError compact message={$t('admin.frameleaf_workers_load_failed')} onRetry={refresh} {retrying} />
  {/if}

  <Hero
    tone={hero.tone}
    icon={hero.icon}
    title={hero.title}
    body={hero.body}
    label={$t('frameleaf_computers_list_status_label')}
  >
    {#snippet actions()}
      <a class="button" class:primary={computers.length === 1} href="#add-a-computer">{$t('frameleaf_computers_add')}</a
      >
    {/snippet}
    <Coverage rows={coverage} />
  </Hero>

  {#if ai === 'off'}
    <Notice tone="info" title={$t('frameleaf_computers_ai_off_title')}>
      {$t('frameleaf_computers_ai_off_body')}
      {#snippet action()}
        <a class="button" href={commandCenterUrl('intelligence', 'machine-learning')}>
          {$t('frameleaf_computers_ai_turn_on')}
        </a>
      {/snippet}
    </Notice>
  {/if}

  <Section title={$t('frameleaf_computers_list_title')} description={$t('frameleaf_computers_list_description')}>
    <ItemList>
      {#each computers as computer (computer.key)}
        {@const state = status(computer)}
        <Item
          icon={ICONS[computer.place]}
          off={computer.state === 'off'}
          name={name(computer)}
          detail={[$t(`frameleaf_computers_where_${computer.place}` as Translations), computer.card]
            .filter(Boolean)
            .join(' · ')}
          tone={state.tone}
          status={state.words}
          note={state.note}
        >
          {#snippet measure()}
            <div class="doing">
              <strong>{$t('frameleaf_computers_doing', { values: { count: doing(computer) } })}</strong>
              <span>{list(helps(computer))}</span>
            </div>
          {/snippet}
          {#snippet action()}
            {#if computer.place === 'cloud'}
              <a
                class="button"
                href={commandCenterUrl('cloud')}
                aria-label={$t('frameleaf_computers_manage_named', { values: { name: name(computer) } })}
              >
                {$t('frameleaf_computers_manage')}<Icon icon={mdiChevronRight} size="16" aria-hidden />
              </a>
            {:else}
              <Button
                label={$t('frameleaf_computers_manage_named', { values: { name: name(computer) } })}
                onclick={() => void manage(computer)}
              >
                {$t('frameleaf_computers_manage')}
              </Button>
            {/if}
          {/snippet}
        </Item>
      {/each}
    </ItemList>
  </Section>

  <div bind:this={addSection} id="add-a-computer" class="anchor">
    <Section title={$t('frameleaf_computers_add')} description={$t('frameleaf_computers_add_description')}>
      <Row label={$t('frameleaf_computers_add_address')} help={$t('frameleaf_computers_add_address_help')}>
        <Button onclick={() => void connectByAddress()}>{$t('frameleaf_computers_add_address_button')}</Button>
      </Row>
      <Row label={$t('frameleaf_computers_add_studio')} help={$t('frameleaf_computers_add_studio_help')}>
        <Button onclick={() => void connectStudio()}>{$t('frameleaf_computers_add_studio_button')}</Button>
      </Row>
    </Section>
  </div>

  <Section title={$t('frameleaf_computers_details_title')} description={$t('frameleaf_computers_details_description')}>
    <!-- Plain disclosures with ids: the managers' own buttons and the rows above open them by name. -->
    <details class="more" id="ml-destinations" bind:this={aiDetails}>
      <summary>{$t('frameleaf_computers_details_ai')}</summary>
      <div class="body">
        <p class="hint">{$t('frameleaf_computers_details_ai_help')}</p>
        <MlDestinationsPanel
          destinations={data.processing.destinations}
          routes={data.processing.routes}
          {addRequest}
          showRoutes={false}
          onChanged={() => void refresh()}
        />
        {#if inventory}
          <h3>{$t('frameleaf_computers_details_checks')}</h3>
          <WorkerInventoryPanel {inventory} destinations={data.processing.destinations} refreshKey={inventoryKey} />
        {/if}
      </div>
    </details>
    <details class="more" id="studio-helpers" bind:this={studioDetails}>
      <summary>{$t('frameleaf_computers_details_studio')}</summary>
      <div class="body">
        <RenderWorkersSection data={data.render} {enrolRequest} onChanged={() => void refresh()} />
      </div>
    </details>
  </Section>
</KitPage>

<style>
  a.button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--fl-space-1);
    text-decoration: none;
    white-space: nowrap;
  }
  a.button:focus-visible,
  summary:focus-visible {
    outline: var(--fl-focus-ring);
    outline-offset: var(--fl-focus-offset);
  }
  .doing {
    display: grid;
    gap: var(--fl-space-1);
    font-size: var(--fl-font-callout);
  }
  .doing span {
    color: var(--fl-muted);
  }
  /* A link that jumps here leaves room above the heading. */
  .anchor {
    scroll-margin-top: var(--fl-space-6);
  }
  .more {
    padding: var(--fl-space-1) 0;
    border-top: 1px solid var(--fl-border);
    scroll-margin-top: var(--fl-space-6);
  }
  .more summary {
    display: flex;
    align-items: center;
    min-height: var(--fl-control-height);
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
    font-weight: 600;
    cursor: pointer;
    gap: var(--fl-space-2);
    list-style: none;
  }
  .more summary::-webkit-details-marker {
    display: none;
  }
  /* The same disclosure mark the kit's Advanced draws. */
  .more summary::before {
    content: '';
    width: 0;
    height: 0;
    border-block: 4px solid transparent;
    border-inline-start: 6px solid currentcolor;
    transition: transform var(--fl-motion-fast) var(--fl-ease);
  }
  .more[open] > summary::before {
    transform: rotate(90deg);
  }
  .more summary:hover {
    color: var(--fl-text);
  }
  .more .body {
    display: grid;
    gap: var(--fl-space-4);
    min-width: 0;
    padding: var(--fl-space-2) 0 var(--fl-space-6);
  }
  .more h3 {
    margin: var(--fl-space-2) 0 0;
    font-size: var(--fl-font-callout);
    font-weight: 600;
  }
  .hint {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
  }
</style>
