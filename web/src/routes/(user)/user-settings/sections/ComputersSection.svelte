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
  import { replaceState } from '$app/navigation';
  import { page } from '$app/state';
  import SegmentedControl from '$lib/components/frameleaf/SegmentedControl.svelte';
  import WhereWorkRuns from '$lib/components/frameleaf/computers/WhereWorkRuns.svelte';
  import { WorkRunsDraft } from '$lib/components/frameleaf/computers/work-runs-draft.svelte';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import MlDestinationsPanel from '$lib/components/frameleaf/MlDestinationsPanel.svelte';
  import Figure from '$lib/components/frameleaf/settings/intelligence/Figure.svelte';
  import Advanced from '$lib/components/frameleaf/settings/kit/Advanced.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Notice from '$lib/components/frameleaf/settings/kit/Notice.svelte';
  import Pill, { type KitTone } from '$lib/components/frameleaf/settings/kit/Pill.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import Switch from '$lib/components/frameleaf/settings/kit/Switch.svelte';
  import WorkerInventoryPanel from '$lib/components/frameleaf/WorkerInventoryPanel.svelte';
  import { aiState, computersFrom, notAnswering, whereOf, type Computer } from '$lib/frameleaf/computers';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { getSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { Route } from '$lib/route';
  import { OpenQueryParam } from '$lib/constants';
  import { locale } from '$lib/stores/preferences.store';
  import { getWorkerInventory, WorkerInventorySource } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import {
    mdiAlertCircleOutline,
    mdiCheckCircleOutline,
    mdiChevronRight,
    mdiCloudOutline,
    mdiPlus,
    mdiDesktopTowerMonitor,
    mdiServerOutline,
  } from '@mdi/js';
  import { onMount, tick } from 'svelte';
  import { t, type Translations } from 'svelte-i18n';
  import type { ComputersData } from './loaders';
  import RenderWorkersSection from './RenderWorkersSection.svelte';
  import { RenderWorkersState } from './render-workers-state.svelte';

  const { data }: { data: ComputersData } = $props();

  let inventory = $state(data.processing.inventory);
  // svelte-ignore state_referenced_locally (the page's Studio helper state starts from the data it loaded with)
  const renderState = new RenderWorkersState(data.render, () => $t('frameleaf_render_workers_unable_to_load'));
  /** The server settings draft, for the checks under Connections; absent when the page is drawn on its own. */
  const settingsDraft = getSystemConfigDraft();
  const configFile = $derived(featureFlagsManager.value.configFile);
  const seconds = (milliseconds: number) => Math.round(milliseconds / 100) / 10;
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
    inventory = await read(getWorkerInventory);
    inventoryKey += 1;
    retrying = false;
  };

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

  /**
   * The Everyday cards. A Studio worker bundled with this server is part of it there, as the approved
   * design draws it (one "This server" card); Advanced still lists it on its own (FL-589).
   */
  const bundled = (computer: Computer) => computer.place === 'home' && whereOf(computer) === 'server';
  const cards = $derived(
    computers
      .filter((computer) => !bundled(computer))
      .map((computer) =>
        computer.place === 'server'
          ? {
              ...computer,
              entries: [
                ...computer.entries,
                ...computers.filter((other) => bundled(other)).flatMap(({ entries }) => entries),
              ],
            }
          : computer,
      ),
  );
  /** Computers, as a household counts them: this server and the ones at home. Frameleaf Cloud is a place, not a computer. */
  const atHome = $derived(cards.filter((computer) => computer.place !== 'cloud'));
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
  /** A computer known only through its Frameleaf Desktop app: the app is managed on the computer itself. */
  const desktopOnly = (computer: Computer) => computer.entries.length === 0 && computer.desktops.length > 0;
  /** The platform a Frameleaf Desktop helper runs on, as people call it. */
  const platform = (computer: Computer) => {
    const desktop = computer.desktops[0];
    return desktop ? $t(`frameleaf_computers_platform_${desktop.platform}` as Translations) : undefined;
  };
  /** The note under a computer's status. */
  const note = (computer: Computer) =>
    desktopOnly(computer)
      ? $t(
          computer.state === 'ready'
            ? 'frameleaf_computers_desktop_ready_note'
            : 'frameleaf_computers_desktop_closed_note',
        )
      : (status(computer).note ?? $t('frameleaf_computers_doing', { values: { count: doing(computer) } }));
  /** What a computer helps with, and how many kinds of work are set to run on it. */
  const helps = (computer: Computer) => {
    const sources = new Set(computer.entries.map((entry) => entry.source));
    return [
      // With AI features off, the status already says so; "AI features" again would read as on.
      (sources.has(WorkerInventorySource.MlDestination) ||
        computer.desktops.length > 0 ||
        computer.place === 'server') &&
      !(computer.place === 'server' && ai === 'off')
        ? $t('frameleaf_computers_helps_ai')
        : '',
      sources.has(WorkerInventorySource.RenderWorker) ? $t('frameleaf_computers_helps_studio') : '',
    ].filter(Boolean);
  };
  const doing = (computer: Computer) =>
    computer.entries.reduce((total, entry) => total + entry.routedWorkloads.length + entry.renderKinds.length, 0);

  // ---- Everyday | Advanced (approved design, 2026-11-04) ----------------------------------------------
  // Everyday: the computers, adding one, and who does what. Advanced: each computer's details (addresses,
  // checks, Studio helpers with their limits and history), the order to try and the settings elsewhere.
  let view = $state<'everyday' | 'advanced'>(
    page.url.searchParams.get('view') === 'advanced' ? 'advanced' : 'everyday',
  );
  const showView = async (next: 'everyday' | 'advanced') => {
    view = next;
    const url = new URL(page.url.href);
    if (next === 'advanced') {
      url.searchParams.set('view', 'advanced');
    } else {
      url.searchParams.delete('view');
    }
    try {
      await replaceState(url, page.state);
    } catch {
      // Before the router's first navigation the address stays as it was; the view still changes.
    }
    await tick();
  };
  /**
   * Who does what's unsaved choices, one for each view, kept here so switching views or opening a
   * computer's details (which draw that part afresh) does not drop them (FL-1252).
   */
  const everydayDraft = new WorkRunsDraft();
  const advancedDraft = new WorkRunsDraft();
  /** With only this server, Frameleaf Cloud is the other way to get heavy work done faster. */
  const offerCloud = $derived(atHome.length === 1 && computers.every((computer) => computer.place !== 'cloud'));

  // ---- add a computer, and the managers under Details ----------------------------------------------

  let addRequest = $state(0);
  let enrolRequest = $state(0);
  let aiDetails = $state<HTMLElement>();
  let studioDetails = $state<HTMLElement>();
  let addSection = $state<HTMLElement>();
  /** The closed technical details under Each computer, opened by Manage and the ways to add a computer. */
  let technical = $state<HTMLElement>();
  /** The tile's two ways to connect a computer; links that say `?add=` open them. */
  let addOpen = $state(page.url.searchParams.has('add'));
  const open = async (target: () => HTMLElement | undefined) => {
    if (view !== 'advanced') {
      await showView('advanced');
    }
    await tick();
    const disclosure = technical?.querySelector('details');
    if (disclosure) {
      disclosure.open = true;
    }
    const details = target();
    if (!details) {
      return;
    }
    await tick();
    details.scrollIntoView({ block: 'start' });
  };
  const connectByAddress = async () => {
    await open(() => aiDetails);
    addRequest += 1;
  };
  const connectStudio = async () => {
    await open(() => studioDetails);
    enrolRequest += 1;
  };
  const manage = (computer: Computer) =>
    open(() =>
      computer.entries.some((entry) => entry.source === WorkerInventorySource.MlDestination) ||
      computer.place === 'server'
        ? aiDetails
        : studioDetails,
    );
  /** Who does what's "Add a computer" opens the two ways here; its link to this page would not (FL-1245). */
  const addComputer = async () => {
    addOpen = true;
    await tick();
    addSection?.scrollIntoView({ block: 'start' });
  };
  // "Add a computer" links from the other pages (`?add=`) land on the two ways to connect one.
  onMount(() => {
    if (page.url.searchParams.has('add')) {
      addSection?.scrollIntoView({ block: 'start' });
    }
  });
</script>

<KitPage>
  <div class="views">
    <SegmentedControl
      label={$t('frameleaf_computers_view_label')}
      options={[
        { value: 'everyday', label: $t('frameleaf_bgwork_view_everyday') },
        { value: 'advanced', label: $t('frameleaf_bgwork_view_advanced') },
      ]}
      value={view}
      onChange={(next) => void showView(next as 'everyday' | 'advanced')}
    />
    <span
      >{view === 'advanced'
        ? $t('frameleaf_computers_view_advanced_hint')
        : $t('frameleaf_computers_view_everyday_hint')}</span
    >
  </div>
  {#if inventory === null}
    <InlineError compact message={$t('admin.frameleaf_workers_load_failed')} onRetry={refresh} {retrying} />
  {/if}

  {#if view === 'everyday'}
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
    {#if silent.length > 0}
      <Notice tone="warn" title={hero.title}>{hero.body}</Notice>
    {/if}
    <!-- The approved cards (2026-11-04): each computer with its state, what it does and one way in. -->
    <ul class="computers" aria-label={$t('frameleaf_computers_list_title')}>
      {#each cards as computer (computer.key)}
        {@const state = status(computer)}
        <li class="computer" class:is-warn={state.tone === 'warn'} class:is-off={computer.state === 'off'}>
          <span class="computer-icon"><Icon icon={ICONS[whereOf(computer)]} size="22" aria-hidden /></span>
          <div class="computer-name">
            <strong>{name(computer)}</strong>
            <small>
              {[$t(`frameleaf_computers_where_${whereOf(computer)}` as Translations), platform(computer), computer.card]
                .filter(Boolean)
                .join(' · ')}
            </small>
          </div>
          <div class="computer-status">
            <Pill tone={state.tone}>{state.words}</Pill>
            <small>{note(computer)}</small>
          </div>
          {#if computer.place === 'server'}
            <a class="button" href={commandCenterUrl('processing', 'hardware')}>
              {$t('frameleaf_computers_page_hardware')}<Icon icon={mdiChevronRight} size="16" aria-hidden />
            </a>
          {:else if computer.place === 'cloud'}
            <a class="button" href={commandCenterUrl('cloud', 'cloud-account')}>
              {$t('frameleaf_computers_cloud_credit')}<Icon icon={mdiChevronRight} size="16" aria-hidden />
            </a>
          {:else if !desktopOnly(computer)}
            <Button
              label={$t('frameleaf_computers_manage_named', { values: { name: name(computer) } })}
              onclick={() => void manage(computer)}
            >
              {$t('frameleaf_computers_details')}<Icon icon={mdiChevronRight} size="16" aria-hidden />
            </Button>
          {/if}
        </li>
      {/each}
      {#if offerCloud}
        <li class="computer is-off">
          <span class="computer-icon"><Icon icon={mdiCloudOutline} size="22" aria-hidden /></span>
          <div class="computer-name">
            <strong>{$t('frameleaf_computers_cloud')}</strong>
            <small>{$t('frameleaf_computers_cloud_offer')}</small>
          </div>
          <div class="computer-status">
            <Pill tone="off">{$t('frameleaf_computers_cloud_not_set_up')}</Pill>
          </div>
          <a class="button" href={commandCenterUrl('cloud', 'cloud-processing')}>
            {$t('frameleaf_computers_cloud_set_up')}<Icon icon={mdiChevronRight} size="16" aria-hidden />
          </a>
        </li>
      {/if}
      <li class="add-tile">
        <button
          type="button"
          class="add"
          aria-expanded={addOpen}
          aria-controls="add-a-computer"
          onclick={() => (addOpen = !addOpen)}
        >
          <Icon icon={mdiPlus} size="20" aria-hidden />
          <span>
            <strong>{$t('frameleaf_computers_add')}</strong>
            <small>{$t('frameleaf_computers_add_tile')}</small>
          </span>
        </button>
      </li>
    </ul>
    {#if addOpen}
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
    {/if}
    <WhereWorkRuns part="everyday" draft={everydayDraft} onAdd={() => void addComputer()} />
  {:else}
    <!-- Advanced (prototype `WorkV3.jsx` ComputersAdvanced): Each computer, Finer choices, Limits for each
         person, Connections, History, then what is set somewhere else. The operator managers (addresses,
         access keys, connection codes, what each computer reported) stay reachable, closed under Each
         computer, since the app has no page for one computer yet. -->
    <Section title={$t('frameleaf_computers_each')} description={$t('frameleaf_computers_each_description')}>
      {#each computers as computer (computer.key)}
        {@const state = status(computer)}
        <Row
          label={name(computer)}
          help={[
            $t(`frameleaf_computers_where_${whereOf(computer)}` as Translations),
            platform(computer),
            computer.card,
            state.words,
            helps(computer).length > 0 ? list(helps(computer)) : '',
          ]
            .filter(Boolean)
            .join(' · ')}
        >
          {#if computer.place === 'cloud'}
            <a class="button" href={commandCenterUrl('cloud', 'cloud-processing')}>
              {$t('frameleaf_computers_manage')}<Icon icon={mdiChevronRight} size="16" aria-hidden />
            </a>
          {:else if !desktopOnly(computer)}
            <Button
              label={$t('frameleaf_computers_manage_named', { values: { name: name(computer) } })}
              onclick={() => void manage(computer)}
            >
              {$t('frameleaf_computers_manage')}<Icon icon={mdiChevronRight} size="16" aria-hidden />
            </Button>
          {/if}
        </Row>
      {/each}
      <div bind:this={technical}>
        <Advanced summary={$t('frameleaf_computers_technical')}>
          <div class="operators">
            <section
              id="studio-helpers"
              class="anchor operator"
              bind:this={studioDetails}
              aria-labelledby="studio-helpers-title"
            >
              <h3 id="studio-helpers-title">{$t('frameleaf_computers_details_studio')}</h3>
              <RenderWorkersSection
                data={data.render}
                store={renderState}
                part="helpers"
                {enrolRequest}
                onChanged={() => void refresh()}
              />
            </section>
            <section
              id="ml-destinations"
              class="anchor operator"
              bind:this={aiDetails}
              aria-labelledby="ml-destinations-title"
            >
              <h3 id="ml-destinations-title">{$t('frameleaf_computers_details_ai')}</h3>
              <p>{$t('frameleaf_computers_details_ai_help')}</p>
              <MlDestinationsPanel
                destinations={data.processing.destinations}
                routes={data.processing.routes}
                {addRequest}
                showRoutes={false}
                onChanged={() => void refresh()}
              />
            </section>
            {#if inventory}
              <section class="operator" aria-labelledby="checks-title">
                <h3 id="checks-title">{$t('frameleaf_computers_details_checks')}</h3>
                <p>{$t('frameleaf_computers_checks_description')}</p>
                <WorkerInventoryPanel
                  {inventory}
                  destinations={data.processing.destinations}
                  refreshKey={inventoryKey}
                  onInventory={(next) => (inventory = next)}
                />
              </section>
            {/if}
          </div>
        </Advanced>
      </div>
    </Section>
    <WhereWorkRuns part="advanced" draft={advancedDraft}>
      {#snippet between()}
        <RenderWorkersSection data={data.render} store={renderState} part="limits" />
      {/snippet}
      {#snippet connections()}
        {#if settingsDraft}
          {@const checks = settingsDraft.draft.machineLearning.availabilityChecks}
          <Row label={$t('frameleaf_computers_checks_keep')} help={$t('frameleaf_computers_checks_keep_help')}>
            <Switch
              label={$t('frameleaf_computers_checks_keep')}
              checked={checks.enabled}
              held={configFile}
              onChange={(value) => (checks.enabled = value)}
            />
          </Row>
          <Row label={$t('frameleaf_computers_checks_every')} help={$t('frameleaf_computers_checks_every_help')}>
            <Figure
              label={$t('frameleaf_computers_checks_every_label')}
              unit={$t('frameleaf_intel_unit_seconds')}
              min={1}
              max={3600}
              step={1}
              value={seconds(checks.interval)}
              disabled={configFile || !checks.enabled}
              onChange={(value) => (checks.interval = Math.round(value * 1000))}
            />
          </Row>
          <Row label={$t('frameleaf_computers_checks_wait')} help={$t('frameleaf_computers_checks_wait_help')}>
            <Figure
              label={$t('frameleaf_computers_checks_wait_label')}
              unit={$t('frameleaf_intel_unit_seconds')}
              min={0.1}
              max={600}
              step={0.5}
              value={seconds(checks.timeout)}
              disabled={configFile || !checks.enabled}
              onChange={(value) => (checks.timeout = Math.round(value * 1000))}
            />
          </Row>
        {/if}
      {/snippet}
    </WhereWorkRuns>
    <RenderWorkersSection data={data.render} store={renderState} part="history" />
    <Section title={$t('frameleaf_workruns_elsewhere')} description={$t('frameleaf_workruns_elsewhere_description')}>
      <Row label={$t('frameleaf_workruns_quality')} help={$t('frameleaf_workruns_quality_help')}>
        <a class="button" href={Route.systemSettings({ isOpen: OpenQueryParam.IMAGE_DESCRIPTION })}>
          {$t('frameleaf_workruns_quality_open')}
        </a>
      </Row>
      <Row label={$t('frameleaf_workruns_cloud_row')} help={$t('frameleaf_workruns_cloud_help')}>
        <a class="button" href={commandCenterUrl('cloud')}>{$t('frameleaf_workruns_cloud_open')}</a>
      </Row>
      <Row label={$t('frameleaf_workruns_speed')} help={$t('frameleaf_workruns_speed_help')}>
        <a class="button" href={Route.hardware()}>{$t('frameleaf_computers_page_hardware')}</a>
      </Row>
    </Section>
  {/if}
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
  a.button:focus-visible {
    outline: var(--fl-focus-ring);
    outline-offset: var(--fl-focus-offset);
  }
  /* A link that jumps here leaves room above the heading. */
  .anchor {
    scroll-margin-top: var(--fl-space-6);
  }
  /* The operator managers under Each computer's technical details: inside the card, never wider than it. */
  .operators {
    display: grid;
    gap: var(--fl-space-6);
    min-width: 0;
    padding-top: var(--fl-space-3);
  }
  .operator {
    display: grid;
    gap: var(--fl-space-2);
    min-width: 0;
    max-width: 100%;
    overflow-x: auto;
  }
  .operator h3 {
    margin: 0;
    font-size: var(--fl-font-callout);
    font-weight: 600;
  }
  .operator > p {
    max-width: 640px;
    margin: 0 0 var(--fl-space-2);
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.5;
  }
  .views {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--fl-space-3);
    margin-block-end: var(--fl-space-4);
  }
  .views > span {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  /* The approved computer cards (2026-11-04). */
  .computers {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: 10px;
    margin: 0 0 var(--fl-space-6);
    padding: 0;
    list-style: none;
  }
  .computer {
    display: grid;
    /* The name keeps room for a word or two; a long status note wraps in its own column. */
    grid-template-columns: auto minmax(96px, 1fr) auto;
    grid-template-rows: auto auto;
    align-items: center;
    gap: 10px 12px;
    padding: var(--fl-space-4);
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  .computer.is-warn {
    border-color: color-mix(in srgb, var(--fl-warning) 45%, var(--fl-border));
  }
  .computer-name strong {
    display: block;
    font-weight: 600;
  }
  .computer-name small,
  .computer-status small {
    display: block;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .computer-icon {
    display: grid;
    place-items: center;
    width: 40px;
    height: 40px;
    color: var(--fl-accent);
    background: var(--fl-accent-soft);
    border-radius: var(--fl-radius-sm);
  }
  .computer.is-warn .computer-icon {
    color: var(--fl-warning);
    background: color-mix(in srgb, var(--fl-warning) 14%, transparent);
  }
  .computer.is-off .computer-icon {
    color: var(--fl-muted);
    background: var(--fl-raised);
  }
  .computer-status {
    display: grid;
    justify-items: end;
    gap: 2px;
    max-width: 168px;
    text-align: end;
  }
  .computer > :global(.button),
  .computer > :global(button) {
    grid-column: 1 / -1;
    justify-self: start;
  }
  .add-tile {
    display: grid;
  }
  .add {
    display: flex;
    align-items: center;
    gap: var(--fl-space-3);
    padding: var(--fl-space-4);
    color: var(--fl-text);
    font: inherit;
    text-align: start;
    background: none;
    border: 1px dashed var(--fl-border-strong);
    border-radius: var(--fl-radius-card);
    cursor: pointer;
  }
  .add:hover,
  .add[aria-expanded='true'] {
    background: var(--fl-accent-soft);
    border-color: var(--fl-accent);
  }
  .add > :global(svg) {
    flex: none;
    color: var(--fl-accent);
  }
  .add strong {
    display: block;
    font-weight: 600;
  }
  .add small {
    display: block;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  @media (max-width: 700px) {
    .computers {
      grid-template-columns: 1fr;
    }
  }
</style>
