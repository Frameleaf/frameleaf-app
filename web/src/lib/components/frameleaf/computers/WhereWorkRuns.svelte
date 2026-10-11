<script lang="ts">
  /**
   * Computers & background work → Where work runs (FL-364), after the approved prototype
   * (`settings-v2/computers/Routing.jsx`): one table, one row for each kind of heavy work, one
   * picker that lists real places only. It replaces the two tables of Workload destinations, which
   * used different names and could disagree.
   *
   * The server still keeps two records (see `work-routes.ts`). The page reads one choice per row
   * from both and one Save writes both. Studio export is not routed here: a computer connected for
   * Studio takes it, so the row says what the server reports (`work-places.ts`).
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import Skeleton from '$lib/components/frameleaf/Skeleton.svelte';
  import Advanced from '$lib/components/frameleaf/settings/kit/Advanced.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Notice from '$lib/components/frameleaf/settings/kit/Notice.svelte';
  import Pill from '$lib/components/frameleaf/settings/kit/Pill.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import { OpenQueryParam } from '$lib/constants';
  import { aiState, canRunStudioWork, computersFrom, entryState } from '$lib/frameleaf/computers';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { getSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { runsHere, staysHome, WORK_KINDS, workKindNameKey, type WorkKind } from '$lib/frameleaf/work-places';
  import {
    ASK,
    choicesFor,
    CLOUD,
    currentChoice,
    followerChoice,
    followerChoices,
    FOLLOWERS,
    hasWrites,
    NONE,
    routeWrites,
    SAME,
    type Follower,
    type RouteChoice,
    type RouteFacts,
  } from '$lib/frameleaf/work-routes';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { Route } from '$lib/route';
  import { locale } from '$lib/stores/preferences.store';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import {
    CloudMlConnection,
    getCloudMlStatus,
    getHardwareCheck,
    getMlWorkloadRoutes,
    getRenderWorkerCompatibility,
    getWorkerInventory,
    listMlDestinations,
    MlDestinationKind,
    setMlWorkloadRoute,
    StartWith,
    WorkerInventorySource,
    type CloudMlStatusResponseDto,
    type HardwareCheckResponseDto,
    type MlDestinationResponseDto,
    type MlWorkloadRouteDto,
    type RenderWorkerCompatibilityResponseDto,
    type WorkerInventoryResponseDto,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiLanDisconnect, mdiPlus, mdiServerOutline, mdiTransitConnectionVariant } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t, type Translations } from 'svelte-i18n';

  type Routed = Exclude<WorkKind, 'render'>;
  const ROUTED = WORK_KINDS.filter((kind): kind is Routed => kind !== 'render');

  let destinations = $state<MlDestinationResponseDto[]>();
  let routes = $state<MlWorkloadRouteDto[]>([]);
  let inventory = $state<WorkerInventoryResponseDto | null>(null);
  let compatibility = $state<RenderWorkerCompatibilityResponseDto | null>(null);
  let hardware = $state<HardwareCheckResponseDto | null>(null);
  let cloud = $state<CloudMlStatusResponseDto | null>(null);
  let loadError = $state(false);
  let unread = $state(false);

  /** A reading the page can do without: unreadable is null, and the page says so. */
  const read = async <T,>(request: () => Promise<T>) => {
    try {
      return (await request()) ?? null;
    } catch {
      unread = true;
      return null;
    }
  };
  const load = async () => {
    loadError = false;
    unread = false;
    try {
      const [places, saved] = await Promise.all([listMlDestinations(), getMlWorkloadRoutes()]);
      [inventory, compatibility, hardware, cloud] = await Promise.all([
        read(getWorkerInventory),
        read(getRenderWorkerCompatibility),
        read(getHardwareCheck),
        read(getCloudMlStatus),
      ]);
      routes = saved.routes;
      destinations = places;
    } catch {
      loadError = true;
    }
  };
  onMount(() => void load());

  const settingsDraft = getSystemConfigDraft();
  const cloudMl = $derived(settingsDraft?.draft.frameleafCloud?.cloudMl);
  const savedCloudMl = $derived(settingsDraft?.baseline.frameleafCloud?.cloudMl);
  const locked = $derived(featureFlagsManager.value.configFile);
  const linked = $derived(
    !!cloud && cloud.connection !== CloudMlConnection.NotLinked && cloud.connection !== CloudMlConnection.NotConfigured,
  );
  const cloudOn = $derived(linked && !!savedCloudMl?.enabled);

  /** The records as saved: what the page compares its choices with. */
  const facts = $derived<RouteFacts>({
    destinations: destinations ?? [],
    routes,
    cloudRouting: savedCloudMl?.routing,
    cloudOn,
  });

  // ---- the page's own draft: one Save for the whole table -------------------------------------------

  let picked = $state<Partial<Record<Routed, RouteChoice>>>({});
  let pickedFollowers = $state<Partial<Record<Follower, RouteChoice>>>({});
  let suggest = $state<StartWith>();
  let saving = $state(false);
  let said = $state('');
  let failed = $state('');

  const choice = (kind: Routed) => picked[kind] ?? currentChoice(kind, facts);
  const follower = (id: Follower) => pickedFollowers[id] ?? followerChoice(id, facts);
  const writes = $derived(routeWrites(picked, pickedFollowers, facts));
  const suggestChanged = $derived(suggest !== undefined && suggest !== savedCloudMl?.startWith);
  const changedRows = $derived(ROUTED.filter((kind) => choice(kind) !== currentChoice(kind, facts)));
  const dirty = $derived(hasWrites(writes) || suggestChanged);

  const undo = () => {
    picked = {};
    pickedFollowers = {};
    suggest = undefined;
    failed = '';
  };

  const save = async () => {
    saving = true;
    said = '';
    failed = '';
    try {
      for (const { workload, destinationId } of writes.routes) {
        ({ routes } = await setMlWorkloadRoute({ workload, mlWorkloadRouteUpdateDto: { destinationId } }));
      }
      const cloudChanges = Object.entries(writes.cloud);
      if (settingsDraft && cloudMl && (cloudChanges.length > 0 || suggestChanged)) {
        for (const [kind, mode] of cloudChanges) {
          cloudMl.routing[kind as keyof typeof cloudMl.routing] = mode;
        }
        if (suggest !== undefined) {
          cloudMl.startWith = suggest;
        }
        if (!(await settingsDraft.saveKeys(['frameleafCloud']))) {
          throw new Error('settings');
        }
      }
      undo();
      said = $t('frameleaf_workruns_saved');
    } catch (error) {
      const reason = getServerErrorMessage(error);
      failed = reason
        ? $t('frameleaf_workruns_save_failed', { values: { reason } })
        : $t('frameleaf_workruns_save_failed_unknown');
      // What was saved before the failure stays saved; read it back so the rows are true.
      routes = (await read(getMlWorkloadRoutes))?.routes ?? routes;
    } finally {
      saving = false;
    }
  };

  // ---- names and states -----------------------------------------------------------------------------

  const list = (names: string[]) => new Intl.ListFormat($locale, { style: 'long', type: 'conjunction' }).format(names);
  /** Feature names can hold a comma, so a list of three or more of them uses semicolons. */
  const named = (names: string[]) =>
    names.length < 3 || !names.some((name) => name.includes(',')) ? list(names) : names.join('; ');
  const workName = (kind: WorkKind) => $t(workKindNameKey(kind));
  const place = (id: string) => destinations?.find((destination) => destination.id === id);
  const isServer = (id: string) => place(id)?.kind === MlDestinationKind.Local;
  const placeName = (id: string) =>
    isServer(id) ? $t('frameleaf_computers_this_server') : (place(id)?.name ?? $t('frameleaf_workruns_home_computer'));
  /** A helper that is switched on and did not answer when it was last asked. */
  const silent = (id: string) => {
    const entry = inventory?.entries.find((item) => item.id === id);
    return !!entry && !isServer(id) && entryState(entry) === 'not-answering';
  };
  const choiceLabel = (id: RouteChoice, leader?: string) =>
    id === ASK
      ? $t('frameleaf_workruns_choice_ask')
      : id === CLOUD
        ? $t('frameleaf_workruns_choice_cloud')
        : id === NONE
          ? $t('frameleaf_workruns_choice_none')
          : id === SAME
            ? $t('frameleaf_workruns_choice_same', { values: { name: leader ?? '' } })
            : silent(id)
              ? $t('frameleaf_workruns_choice_silent', { values: { name: placeName(id) } })
              : placeName(id);

  const ai = $derived(aiState(inventory));
  const here = (kind: WorkKind) => runsHere(kind, { check: hardware, compatibility });
  /** The plain reason beside a row: why it is fixed, or what the choice means. */
  const reason = (kind: Routed, current: RouteChoice, fixed: boolean) => {
    if (current === NONE) {
      return fixed
        ? $t(staysHome(kind) ? 'frameleaf_workruns_why_none_fixed_home' : 'frameleaf_workruns_why_none_fixed')
        : $t('frameleaf_workruns_why_none');
    }
    if (current === ASK) {
      return $t('frameleaf_workruns_why_ask');
    }
    if (current === CLOUD) {
      return $t('frameleaf_workruns_why_cloud');
    }
    if (silent(current)) {
      return $t('frameleaf_workruns_why_silent', { values: { name: placeName(current) } });
    }
    const home = staysHome(kind) ? ` ${$t(`frameleaf_workruns_home_${kind}` as Translations)}` : '';
    if (!isServer(current)) {
      return `${$t('frameleaf_workruns_why_helper', { values: { name: placeName(current) } })}${home}`;
    }
    if (ai === 'off') {
      return $t('frameleaf_workruns_why_ai_off');
    }
    const answer = here(kind);
    const words =
      answer === 'unknown'
        ? $t('frameleaf_workruns_why_ai_silent')
        : $t(`frameleaf_workruns_why_${answer}` as Translations);
    return `${words}${answer === 'no' || answer === 'unknown' ? '' : home}`;
  };

  // Studio export: not a choice here, so the row says what is connected.
  const studioComputers = $derived(
    (inventory?.entries ?? [])
      .filter((entry) => entry.source === WorkerInventorySource.RenderWorker && entryState(entry) === 'ready')
      .map((entry) => entry.name),
  );
  const exportCan = $derived(canRunStudioWork(compatibility, 'export'));

  // ---- the answer the page opens on -----------------------------------------------------------------

  const computers = $derived(computersFrom(inventory));
  const helpers = $derived(computers.filter((computer) => computer.place === 'home'));
  const solo = $derived(helpers.length === 0 && !cloudOn);
  const hero = $derived.by(() => {
    const now = ROUTED.map((kind) => ({ kind, at: currentChoice(kind, facts) }));
    const stuck = now.filter(({ at }) => at !== ASK && at !== CLOUD && at !== NONE && silent(at));
    if (stuck.length > 0) {
      return {
        kind: 'silent' as const,
        tone: 'warn' as const,
        icon: mdiLanDisconnect,
        title: $t('frameleaf_workruns_silent', { values: { name: placeName(stuck[0].at) } }),
        body: $t('frameleaf_workruns_silent_body', {
          values: { count: stuck.length, names: named(stuck.map(({ kind }) => workName(kind))) },
        }),
      };
    }
    const onServer = now.filter(({ at }) => isServer(at)).length;
    const onHelpers = now.filter(({ at }) => at !== ASK && at !== CLOUD && at !== NONE && !isServer(at)).length;
    const onCloud = now.filter(({ at }) => at === CLOUD).map(({ kind }) => workName(kind));
    const asked = now.filter(({ at }) => at === ASK).map(({ kind }) => workName(kind));
    if (solo || (onHelpers === 0 && onCloud.length === 0 && asked.length === 0)) {
      return {
        kind: 'solo' as const,
        tone: 'good' as const,
        icon: mdiServerOutline,
        title: $t('frameleaf_workruns_solo'),
        body: [
          solo ? $t('frameleaf_workruns_solo_body') : $t('frameleaf_workruns_nothing_to_cloud'),
          exportCan === false ? $t('frameleaf_computers_studio_cannot') : '',
        ]
          .filter(Boolean)
          .join(' '),
      };
    }
    return {
      kind: 'shared' as const,
      tone: 'good' as const,
      icon: mdiTransitConnectionVariant,
      title: $t('frameleaf_workruns_shared', { values: { count: helpers.length, name: helpers[0]?.name ?? '' } }),
      body: [
        $t('frameleaf_workruns_shared_body', { values: { server: onServer, helpers: onHelpers } }),
        onCloud.length > 0
          ? $t('frameleaf_workruns_on_cloud', { values: { count: onCloud.length, names: named(onCloud) } })
          : $t('frameleaf_workruns_nothing_to_cloud'),
        asked.length > 0
          ? $t('frameleaf_workruns_asked', { values: { count: asked.length, names: named(asked) } })
          : '',
      ]
        .filter(Boolean)
        .join(' '),
    };
  });

  const changeWords = (kind: Routed) => {
    const to = choice(kind);
    const name = workName(kind);
    return to === NONE
      ? $t('frameleaf_workruns_change_off', { values: { name } })
      : to === ASK
        ? $t('frameleaf_workruns_change_ask', { values: { name } })
        : $t('frameleaf_workruns_change_place', { values: { name, place: choiceLabel(to) } });
  };
  const anyAsk = $derived(ROUTED.some((kind) => choice(kind) === ASK));
</script>

<KitPage>
  {#if loadError}
    <InlineError message={$t('frameleaf_workruns_unread')} onRetry={load} />
  {:else if !destinations}
    <div class="loading" role="status" aria-busy="true">
      <span class="sr-only">{$t('loading')}</span>
      <Skeleton variant="block" height="140px" />
      <Skeleton variant="block" height="420px" />
    </div>
  {:else}
    {#if unread}
      <InlineError compact message={$t('frameleaf_workruns_unread')} onRetry={load} />
    {/if}
    {#if said}
      <p class="said" role="status">{said}</p>
    {/if}

    <Hero
      tone={hero.tone}
      icon={hero.icon}
      title={hero.title}
      body={hero.body}
      label={$t('frameleaf_workruns_status_label')}
    >
      {#snippet actions()}
        {#if hero.kind === 'silent'}
          <a class="button primary" href={Route.computers()}>{$t('frameleaf_workruns_see_computers')}</a>
        {:else if solo}
          <a class="button primary" href={commandCenterUrl('processing', 'computers', { add: 'name' })}>
            <Icon icon={mdiPlus} size="16" aria-hidden />{$t('frameleaf_computers_add')}
          </a>
          {#if !cloudOn}
            <a class="button" href={commandCenterUrl('cloud')}>{$t('frameleaf_workruns_link_cloud')}</a>
          {/if}
        {/if}
      {/snippet}
    </Hero>

    <Section
      title={$t('frameleaf_workruns_table')}
      description={$t(solo ? 'frameleaf_workruns_table_description_solo' : 'frameleaf_workruns_table_description')}
    >
      <div class="rule">
        <Notice tone="info" title={$t('frameleaf_workruns_rule_title')}>{$t('frameleaf_workruns_rule')}</Notice>
      </div>
      {#each ROUTED as kind (kind)}
        {@const options = choicesFor(kind, facts)}
        {@const current = choice(kind)}
        {@const fixed = options.length === 0}
        <Row
          label={workName(kind)}
          help={`${$t(`frameleaf_workruns_use_${kind}` as Translations)} ${reason(kind, current, fixed)}`}
        >
          <div class="runs">
            {#if current !== ASK && current !== CLOUD && current !== NONE && silent(current)}
              <Pill tone="warn">{$t('frameleaf_workruns_waiting')}</Pill>
            {/if}
            {#if fixed && current === NONE}
              <Pill tone="warn">{$t('frameleaf_workruns_cannot_yet')}</Pill>
            {:else if fixed}
              <span class="value">{choiceLabel(current)}</span>
            {:else}
              <select
                class="fl-control"
                aria-label={$t('frameleaf_workruns_where', { values: { name: workName(kind) } })}
                value={current}
                disabled={saving}
                onchange={(event) => (picked = { ...picked, [kind]: event.currentTarget.value })}
              >
                {#each options as option (option)}
                  <!-- The cloud record is part of the settings file when one manages them. -->
                  <option value={option} disabled={locked && (option === ASK || option === CLOUD)}>
                    {choiceLabel(option)}
                  </option>
                {/each}
              </select>
            {/if}
          </div>
        </Row>
      {/each}
      <Row
        label={workName('render')}
        help={`${$t('frameleaf_workruns_use_render')} ${$t(
          exportCan === undefined
            ? 'frameleaf_workruns_why_render_unknown'
            : exportCan
              ? 'frameleaf_workruns_home_render'
              : 'frameleaf_workruns_why_render_none',
        )}`}
      >
        <div class="runs">
          {#if exportCan}
            <span class="value">
              {studioComputers.length > 0 ? list(studioComputers) : $t('frameleaf_workruns_home_computer')}
            </span>
          {:else if exportCan === false}
            <Pill tone="warn">{$t('frameleaf_workruns_cannot_yet')}</Pill>
          {:else}
            <Pill tone="off">{$t('frameleaf_computers_cover_unknown')}</Pill>
          {/if}
        </div>
      </Row>

      <!-- A follower with one possible place has nothing to choose: it stays with its row. -->
      {#if followerChoices('pets', facts).length > 3 || followerChoices('creative', facts).length > 3 || follower('pets') !== SAME || follower('creative') !== SAME}
        <Advanced summary={$t('frameleaf_workruns_finer')}>
          <p class="hint">{$t('frameleaf_workruns_finer_help')}</p>
          {#each Object.keys(FOLLOWERS) as Follower[] as id (id)}
            {@const options = followerChoices(id, facts)}
            {#if options.length > 0}
              <Row
                label={$t(`frameleaf_workruns_finer_${id}` as Translations)}
                help={$t(`frameleaf_workruns_finer_${id}_help` as Translations)}
              >
                <select
                  class="fl-control"
                  aria-label={$t('frameleaf_workruns_where', {
                    values: { name: $t(`frameleaf_workruns_finer_${id}` as Translations) },
                  })}
                  value={follower(id)}
                  disabled={saving}
                  onchange={(event) => (pickedFollowers = { ...pickedFollowers, [id]: event.currentTarget.value })}
                >
                  {#each options as option (option)}
                    <option value={option}>{choiceLabel(option, workName(FOLLOWERS[id].follows))}</option>
                  {/each}
                </select>
              </Row>
            {/if}
          {/each}
        </Advanced>
      {/if}

      {#if locked && cloudOn}
        <p class="hint">{$t('frameleaf_workruns_locked')}</p>
      {/if}
      {#if failed}
        <p class="failed" role="alert">{failed}</p>
      {/if}
      {#if dirty}
        <Notice tone="info" title={$t('frameleaf_workruns_changes', { values: { count: changedRows.length || 1 } })}>
          {[
            ...changedRows.map((kind) => changeWords(kind)),
            suggestChanged ? $t('frameleaf_workruns_change_suggest') : '',
          ]
            .filter(Boolean)
            .join(' ')}
        </Notice>
      {/if}
      {#if facts.destinations.length > 1 || cloudOn || dirty}
        <div class="actions">
          <Button variant="primary" disabled={!dirty || saving} onclick={() => void save()}>
            {$t('frameleaf_workruns_save')}
          </Button>
          <Button disabled={!dirty || saving} onclick={undo}>{$t('frameleaf_workruns_undo')}</Button>
        </div>
      {/if}
    </Section>

    {#if cloudOn && cloudMl && anyAsk}
      <Section title={$t('frameleaf_workruns_ask_title')}>
        <Row label={$t('frameleaf_workruns_ask_row')} help={$t('frameleaf_workruns_ask_help')}>
          <select
            class="fl-control"
            aria-label={$t('frameleaf_workruns_ask_label')}
            value={suggest ?? savedCloudMl?.startWith}
            disabled={saving || locked}
            onchange={(event) => (suggest = event.currentTarget.value as StartWith)}
          >
            <option value={StartWith.Local}>{$t('frameleaf_workruns_ask_home')}</option>
            <option value={StartWith.Cloud}>{$t('frameleaf_workruns_choice_cloud')}</option>
          </select>
        </Row>
      </Section>
    {/if}

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
  .loading {
    display: grid;
    gap: var(--fl-space-6);
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  a.button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--fl-space-1);
    text-decoration: none;
    white-space: nowrap;
  }
  a.button:focus-visible,
  select:focus-visible {
    outline: var(--fl-focus-ring);
    outline-offset: var(--fl-focus-offset);
  }
  .said,
  .failed {
    margin: 0;
    padding: var(--fl-space-3) var(--fl-space-4);
    font-size: var(--fl-font-callout);
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  .failed {
    margin-top: var(--fl-space-3);
    color: var(--fl-danger);
    border-color: color-mix(in srgb, var(--fl-danger) 45%, var(--fl-border));
  }
  .rule {
    padding-bottom: var(--fl-space-3);
  }
  .runs {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: var(--fl-space-3);
  }
  /* Pickers of one width, so the column of choices lines up down the table. */
  select {
    width: 220px;
    max-width: 100%;
    min-height: var(--fl-control-height);
    padding-inline: var(--fl-space-3);
    font: inherit;
    font-size: var(--fl-font-callout);
    color: var(--fl-text);
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .value {
    font-size: var(--fl-font-callout);
    font-weight: 600;
  }
  .hint {
    margin: 0;
    padding: var(--fl-space-2) 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fl-space-2);
    padding: var(--fl-space-4) 0 var(--fl-space-6);
  }
  @container kit (max-width: 620px) {
    .runs {
      justify-content: flex-start;
    }
    select {
      width: 100%;
    }
  }
</style>
