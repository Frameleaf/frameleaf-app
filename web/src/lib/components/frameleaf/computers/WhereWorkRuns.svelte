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
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Pill from '$lib/components/frameleaf/settings/kit/Pill.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import SegmentedControl from '$lib/components/frameleaf/SegmentedControl.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import { OpenQueryParam } from '$lib/constants';
  import { isIndexWork } from '$lib/frameleaf/cloud-ml';
  import { aiState, canRunStudioWork, computersFrom, entryState } from '$lib/frameleaf/computers';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { getSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { runsHere, staysHome, WORK_KINDS, workKindNameKey, type WorkKind } from '$lib/frameleaf/work-places';
  import {
    moveSource,
    sameOrder,
    SOURCE_HELP_KEY,
    SOURCE_NAME_KEY,
    STATE_KEY,
    STATE_TONE,
    statusOf,
  } from '$lib/frameleaf/processing-order';
  import {
    ASK,
    choicesFor,
    CLOUD,
    currentChoice,
    FOLLOW,
    followerChoice,
    followerChoices,
    FOLLOWERS,
    hasWrites,
    NONE,
    ROW_WORKLOAD,
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
    getMlProcessingOrder,
    getMlWorkloadRoutes,
    getRenderWorkerCompatibility,
    getWorkerInventory,
    listMlDestinations,
    MlDestinationKind,
    setMlProcessingOrder,
    MlWhenUnavailable,
    setMlWorkloadProcessingOrder,
    setMlWorkloadRoute,
    StartWith,
    WorkerInventorySource,
    type CloudMlStatusResponseDto,
    type HardwareCheckResponseDto,
    type MlDestinationResponseDto,
    type MlProcessingOrderResponseDto,
    type MlProcessingSource,
    type MlWorkloadRouteDto,
    type RenderWorkerCompatibilityResponseDto,
    type WorkerInventoryResponseDto,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import {
    mdiArrowDown,
    mdiArrowUp,
    mdiCloudOutline,
    mdiDesktopTowerMonitor,
    mdiLanDisconnect,
    mdiPlus,
    mdiServerOutline,
    mdiTransitConnectionVariant,
  } from '@mdi/js';
  import { onMount, type Snippet } from 'svelte';
  import { t, type Translations } from 'svelte-i18n';

  type Routed = Exclude<WorkKind, 'render'>;
  const ROUTED = WORK_KINDS.filter((kind): kind is Routed => kind !== 'render');

  let destinations = $state<MlDestinationResponseDto[]>();
  let routes = $state<MlWorkloadRouteDto[]>([]);
  let inventory = $state<WorkerInventoryResponseDto | null>(null);
  let compatibility = $state<RenderWorkerCompatibilityResponseDto | null>(null);
  let hardware = $state<HardwareCheckResponseDto | null>(null);
  let cloud = $state<CloudMlStatusResponseDto | null>(null);
  /** FL-456: the processing order; null on a server without one, which then shows no order. */
  let processing = $state<MlProcessingOrderResponseDto | null>(null);
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
      [inventory, compatibility, hardware, cloud, processing] = await Promise.all([
        read(getWorkerInventory),
        read(getRenderWorkerCompatibility),
        read(getHardwareCheck),
        read(getCloudMlStatus),
        read(getMlProcessingOrder),
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

  // FL-456: the order is part of the same draft and the same Save.
  let pickedOrder = $state<MlProcessingSource[]>();
  const order = $derived(pickedOrder ?? processing?.order ?? []);
  const orderChanged = $derived(!!processing && !!pickedOrder && !sameOrder(pickedOrder, processing.order));
  const move = (index: number, step: -1 | 1) => (pickedOrder = moveSource(order, index, step));
  const sourceName = (source: MlProcessingSource) => $t(SOURCE_NAME_KEY[source]);

  // Approved design (2026-11-04): what work set to run on a computer at home does while it isn't answering.
  let pickedWhen = $state<MlWhenUnavailable>();
  const whenUnavailable = $derived(pickedWhen ?? processing?.whenUnavailable ?? MlWhenUnavailable.Wait);
  const whenChanged = $derived(!!processing && pickedWhen !== undefined && pickedWhen !== processing.whenUnavailable);

  const dirty = $derived(hasWrites(writes) || suggestChanged || orderChanged || whenChanged);

  const undo = () => {
    picked = {};
    pickedFollowers = {};
    pickedOrder = undefined;
    pickedWhen = undefined;
    suggest = undefined;
    failed = '';
  };

  const save = async () => {
    saving = true;
    said = '';
    failed = '';
    try {
      if ((orderChanged && pickedOrder) || whenChanged) {
        processing = await setMlProcessingOrder({
          mlProcessingOrderUpdateDto: {
            order: pickedOrder ?? processing!.order,
            ...(whenChanged && { whenUnavailable }),
          },
        });
      }
      for (const { workload, destinationId } of writes.routes) {
        ({ routes } = await setMlWorkloadRoute({ workload, mlWorkloadRouteUpdateDto: { destinationId } }));
      }
      for (const workload of writes.follow) {
        processing = await setMlWorkloadProcessingOrder({
          workload,
          mlWorkloadProcessingOrderUpdateDto: { sources: null },
        });
      }
      if (orderChanged || writes.follow.length > 0) {
        // where each row runs now depends on the order: read it back
        ({ routes } = await getMlWorkloadRoutes());
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
      processing = (await read(getMlProcessingOrder)) ?? processing;
    } finally {
      saving = false;
    }
  };

  // ---- names and states -----------------------------------------------------------------------------

  const list = (names: string[]) => new Intl.ListFormat($locale, { style: 'long', type: 'conjunction' }).format(names);
  /** Feature names can hold a comma, so a list of three or more of them uses semicolons. */
  const named = (names: string[]) =>
    names.length < 3 || names.every((name) => !name.includes(',')) ? list(names) : names.join('; ');
  const workName = (kind: WorkKind) => $t(workKindNameKey(kind));
  /**
   * The approved who-does-what grid (2026-11-04): every place any row can choose, in one order, so each
   * row's choices line up as columns; a place a row cannot use is shown and switched off.
   */
  const columnOrder = (id: RouteChoice) =>
    id === FOLLOW ? 0 : isServer(id) ? 1 : id === CLOUD ? 3 : id === ASK ? 4 : id === NONE ? 5 : 2;
  // Frameleaf Cloud is always a column, switched off until it is set up, so the choice is never hidden.
  const columns = $derived(
    [...new Set([...ROUTED.flatMap((kind) => choicesFor(kind, facts)), CLOUD])].sort(
      (a, b) => columnOrder(a) - columnOrder(b),
    ),
  );
  const columnIcon = (id: RouteChoice) =>
    id === CLOUD
      ? mdiCloudOutline
      : [FOLLOW, ASK, NONE].includes(id)
        ? undefined
        : isServer(id)
          ? mdiServerOutline
          : mdiDesktopTowerMonitor;
  const SHORT: Partial<Record<RouteChoice, Translations>> = {
    [NONE]: 'frameleaf_workruns_choice_none_short',
    [ASK]: 'frameleaf_workruns_choice_ask_short',
    [FOLLOW]: 'frameleaf_workruns_choice_order_short',
  };
  /** The full name behind a short column name, for its tooltip. */
  const fullName = (id: RouteChoice) => ([FOLLOW, ASK, NONE].includes(id) ? choiceLabel(id) : undefined);
  /** A column's short name; the full one is its tooltip. */
  const columnLabel = (id: RouteChoice) => {
    const short = SHORT[id];
    return short ? $t(short) : id === CLOUD ? choiceLabel(id) : placeName(id);
  };
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
      : id === FOLLOW
        ? $t('frameleaf_workruns_choice_order')
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
    if (current === FOLLOW) {
      return $t('frameleaf_workruns_why_order');
    }
    if (current === CLOUD) {
      return $t(isIndexWork(kind) ? 'frameleaf_workruns_why_index_cloud' : 'frameleaf_workruns_why_cloud');
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
  /** Where a row's work goes now: for a row that follows the order, the place the server picked from it. */
  const where = (kind: Routed): RouteChoice => {
    const at = currentChoice(kind, facts);
    if (at !== FOLLOW) {
      return at;
    }
    const goesTo = place(routes.find((route) => route.workload === ROW_WORKLOAD[kind])?.destinationId ?? '');
    return goesTo ? (goesTo.kind === MlDestinationKind.FrameleafCloud ? CLOUD : goesTo.id) : NONE;
  };
  const hero = $derived.by(() => {
    const now = ROUTED.map((kind) => ({ kind, at: where(kind) }));
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
        : to === FOLLOW
          ? $t('frameleaf_workruns_change_order', { values: { name } })
          : $t('frameleaf_workruns_change_place', { values: { name, place: choiceLabel(to) } });
  };
  const anyAsk = $derived(ROUTED.some((kind) => choice(kind) === ASK));

  /**
   * Which part to draw (approved design, 2026-11-04): Computers › Everyday shows the who-does-what grid
   * with its Save, Computers › Advanced the order to try and the related settings elsewhere. Without
   * one, the whole page as it was.
   */
  let {
    part = 'all',
    between,
    connections,
  }: {
    part?: 'all' | 'everyday' | 'advanced';
    /** Advanced only: what the page draws between Finer choices and Connections (Limits for each person). */
    between?: Snippet;
    /** Advanced only: the page's own rows at the top of Connections, before the order to try. */
    connections?: Snippet;
  } = $props();

  /** Finer choices (prototype `Routing.jsx` FinerChoices): the two follower rows, and the place suggested when asked. */
  const showFollowers = $derived(
    (followerChoices('pets', facts).length > 3 ||
      followerChoices('creative', facts).length > 3 ||
      follower('pets') !== SAME ||
      follower('creative') !== SAME) &&
      (Object.keys(FOLLOWERS) as Follower[]).some((id) => followerChoices(id, facts).length > 0),
  );
  const showAsk = $derived(!!(cloudOn && cloudMl && anyAsk));
</script>

{#snippet saveBar()}
  {#if locked && cloudOn}
    <p class="hint">{$t('frameleaf_workruns_locked')}</p>
  {/if}
  {#if failed}
    <p class="failed" role="alert">{failed}</p>
  {/if}
  {#if dirty}
    <div class="save-bar" role="region" aria-label={$t('frameleaf_workruns_unsaved')}>
      <p>
        <strong>{$t('frameleaf_workruns_changes', { values: { count: changedRows.length || 1 } })}</strong>
        <span>
          {[
            orderChanged
              ? $t('frameleaf_order_changed', { values: { names: list(order.map((source) => sourceName(source))) } })
              : '',
            ...changedRows.map((kind) => changeWords(kind)),
            suggestChanged ? $t('frameleaf_workruns_change_suggest') : '',
          ]
            .filter(Boolean)
            .join(' ')}
        </span>
      </p>
      <Button disabled={saving} onclick={undo}>{$t('frameleaf_workruns_undo')}</Button>
      <Button variant="primary" disabled={saving} onclick={() => void save()}>{$t('frameleaf_workruns_save')}</Button>
    </div>
  {/if}
{/snippet}

{#snippet body()}
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

    {#if part === 'all'}
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
    {/if}

    {#if part !== 'advanced'}
      <Section
        title={$t('frameleaf_workruns_who')}
        description={$t(solo ? 'frameleaf_workruns_table_description_solo' : 'frameleaf_workruns_table_description')}
      >
        <ul class="grid">
          {#each ROUTED as kind (kind)}
            {@const options = choicesFor(kind, facts)}
            {@const current = choice(kind)}
            {@const fixed = options.length === 0}
            {@const waiting = current !== ASK && current !== CLOUD && current !== NONE && silent(current)}
            <li class="work" class:is-waiting={waiting}>
              <div class="work-name">
                <strong>{workName(kind)}</strong>
                <small>{$t(`frameleaf_workruns_use_${kind}` as Translations)}</small>
                <small class="work-note">
                  {[
                    waiting ? $t('frameleaf_workruns_waiting_note', { values: { name: placeName(current) } }) : '',
                    reason(kind, current, fixed),
                    isIndexWork(kind) && current !== NONE ? $t('frameleaf_index_one_place') : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                </small>
              </div>
              {#if fixed && current === NONE}
                <a class="button" href={commandCenterUrl('processing', 'computers', { add: 'name' })}>
                  {$t('frameleaf_computers_add')}
                </a>
              {:else if fixed}
                <span class="value">{choiceLabel(current)}</span>
              {:else}
                <div
                  class="choices"
                  role="radiogroup"
                  aria-label={$t('frameleaf_workruns_where', { values: { name: workName(kind) } })}
                  style:--columns={columns.length}
                >
                  {#each columns as option (option)}
                    {@const can =
                      options.includes(option) &&
                      !(locked && (option === ASK || (option === CLOUD && !isIndexWork(kind))))}
                    {@const icon = columnIcon(option)}
                    <button
                      type="button"
                      role="radio"
                      aria-checked={current === option}
                      class:is-on={current === option}
                      disabled={!can || saving}
                      title={can
                        ? fullName(option)
                        : option === CLOUD && !cloudOn
                          ? $t('frameleaf_workruns_cloud_not_set_up')
                          : $t('frameleaf_workruns_cannot_here')}
                      onclick={() => (picked = { ...picked, [kind]: option })}
                    >
                      {#if icon}<Icon {icon} size="15" aria-hidden />{/if}
                      <span>{columnLabel(option)}</span>
                    </button>
                  {/each}
                </div>
              {/if}
            </li>
          {/each}
          <li class="work">
            <div class="work-name">
              <strong>{workName('render')}</strong>
              <small>{$t('frameleaf_workruns_use_render')}</small>
              <small class="work-note">
                {$t(
                  exportCan === undefined
                    ? 'frameleaf_workruns_why_render_unknown'
                    : exportCan
                      ? 'frameleaf_workruns_home_render'
                      : 'frameleaf_workruns_why_render_none',
                )}
              </small>
            </div>
            {#if exportCan}
              <span class="value">
                {studioComputers.length > 0 ? list(studioComputers) : $t('frameleaf_workruns_home_computer')}
              </span>
            {:else if exportCan === false}
              <Pill tone="warn">{$t('frameleaf_workruns_cannot_yet')}</Pill>
            {:else}
              <Pill tone="off">{$t('frameleaf_computers_cover_unknown')}</Pill>
            {/if}
          </li>
        </ul>

        {@render saveBar()}
      </Section>
      {#if processing && helpers.length > 0}
        <Section title={$t('frameleaf_workruns_away_title')}>
          <Row
            label={$t('frameleaf_workruns_away_label')}
            help={$t(
              whenUnavailable === MlWhenUnavailable.Wait
                ? 'frameleaf_workruns_away_wait_help'
                : 'frameleaf_workruns_away_stop_help',
            )}
          >
            <SegmentedControl
              label={$t('frameleaf_workruns_away_title')}
              options={[
                { value: MlWhenUnavailable.Wait, label: $t('frameleaf_workruns_away_wait') },
                { value: MlWhenUnavailable.Stop, label: $t('frameleaf_workruns_away_stop') },
              ]}
              value={whenUnavailable}
              disabled={locked || saving}
              onChange={(value) => (pickedWhen = value as MlWhenUnavailable)}
            />
          </Row>
        </Section>
      {/if}
    {/if}

    {#snippet followerRows()}
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
    {/snippet}
    {#snippet askRow(label: string)}
      <Row {label} help={$t('frameleaf_workruns_ask_help')}>
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
    {/snippet}
    {#snippet orderList()}
      {#if processing}
        <ol class="order" aria-label={$t('frameleaf_order_title')}>
          {#each order as source, index (source)}
            {@const status = statusOf(processing.sources, source)}
            <li>
              <Row
                label={`${index + 1}. ${sourceName(source)}`}
                help={`${$t(SOURCE_HELP_KEY[source])}${
                  status.total > 1 ? ` ${$t('frameleaf_order_count', { values: { ...status } })}` : ''
                }`}
              >
                <div class="runs">
                  <Pill tone={STATE_TONE[status.state]}>{$t(STATE_KEY[status.state])}</Pill>
                  <span class="moves">
                    <!-- Arrows, not chevrons: these move a place up or down the list, they don't open anything. -->
                    <Button
                      variant="quiet"
                      disabled={saving || index === 0}
                      label={$t('frameleaf_order_up', { values: { name: sourceName(source) } })}
                      onclick={() => move(index, -1)}
                    >
                      <Icon icon={mdiArrowUp} size="18" aria-hidden />
                    </Button>
                    <Button
                      variant="quiet"
                      disabled={saving || index === order.length - 1}
                      label={$t('frameleaf_order_down', { values: { name: sourceName(source) } })}
                      onclick={() => move(index, 1)}
                    >
                      <Icon icon={mdiArrowDown} size="18" aria-hidden />
                    </Button>
                  </span>
                </div>
              </Row>
            </li>
          {/each}
        </ol>
      {/if}
    {/snippet}

    {#if part === 'all'}
      {#if showFollowers}
        <Section title={$t('frameleaf_workruns_finer')} description={$t('frameleaf_workruns_finer_help')}>
          {@render followerRows()}
        </Section>
      {/if}
      {#if showAsk}
        <Section title={$t('frameleaf_workruns_ask_title')}>
          {@render askRow($t('frameleaf_workruns_ask_row'))}
        </Section>
      {/if}
      {#if processing}
        <Section title={$t('frameleaf_order_title')} description={$t('frameleaf_order_description')}>
          {@render orderList()}
        </Section>
      {/if}
    {:else if part === 'advanced'}
      <!-- Computers › Advanced (prototype `WorkV3.jsx` ComputersAdvanced): Finer choices, then the page's
           Limits for each person, then Connections, where the order to try is where new work starts. -->
      {#if showFollowers || showAsk}
        <Section title={$t('frameleaf_workruns_finer')} description={$t('frameleaf_workruns_finer_help_open')}>
          {#if showFollowers}{@render followerRows()}{/if}
          {#if showAsk}{@render askRow($t('frameleaf_workruns_ask_title_row'))}{/if}
        </Section>
      {/if}
      {@render between?.()}
      <Section title={$t('frameleaf_computers_connections')} description={$t('frameleaf_computers_connections_help')}>
        {@render connections?.()}
        {#if processing}
          <Row label={$t('frameleaf_order_title')} help={$t('frameleaf_order_description')} />
          {@render orderList()}
        {/if}
        {@render saveBar()}
      </Section>
    {/if}

    {#if part === 'all'}
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
  {/if}
{/snippet}

{#if part === 'all'}
  <KitPage>{@render body()}</KitPage>
{:else}
  {@render body()}
{/if}

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
  .order {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .moves {
    display: inline-flex;
    gap: var(--fl-space-2);
  }
  .hint {
    margin: 0;
    padding: var(--fl-space-2) 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
  }
  @container kit (max-width: 620px) {
    .runs {
      justify-content: flex-start;
    }
    select {
      width: 100%;
    }
  }
  /* Who does what (approved design, 2026-11-04): every row's choices line up as columns. */
  .grid {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .work {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--fl-space-4);
    padding: 14px 0;
  }
  .work + .work {
    border-top: 1px solid var(--fl-border);
  }
  .work-name strong {
    display: block;
    font-weight: 600;
  }
  .work-name small {
    display: block;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .work-name .work-note {
    margin-top: 2px;
    color: var(--fl-text);
  }
  .work.is-waiting .work-note {
    color: var(--fl-warning);
  }
  .choices {
    display: grid;
    grid-template-columns: repeat(var(--columns), minmax(96px, 148px));
    padding: 2px;
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .choices button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-height: 30px;
    padding: 0 8px;
    color: var(--fl-muted);
    font: inherit;
    font-size: var(--fl-font-small);
    white-space: nowrap;
    background: none;
    border: 0;
    border-radius: var(--fl-radius-sm);
    cursor: pointer;
  }
  .choices button span {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .choices button:hover:not(:disabled, .is-on) {
    color: var(--fl-text);
  }
  .choices button.is-on {
    color: var(--fl-text);
    font-weight: 600;
    background: var(--fl-panel);
    box-shadow: var(--fl-shadow-1);
  }
  .choices button.is-on :global(svg) {
    color: var(--fl-accent);
  }
  .choices button:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
  .save-bar {
    position: sticky;
    bottom: var(--fl-space-4);
    z-index: var(--fl-z-sticky);
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--fl-space-2);
    margin: var(--fl-space-3) 0;
    padding: 10px 12px;
    background: var(--fl-material);
    border: 1px solid var(--fl-material-edge);
    border-radius: var(--fl-radius-card);
    box-shadow: var(--fl-shadow-2);
    backdrop-filter: var(--fl-material-blur);
  }
  .save-bar p {
    display: grid;
    flex: 1;
    min-width: 12rem;
    margin: 0;
  }
  .save-bar p span {
    color: var(--fl-on-material-muted);
    font-size: var(--fl-font-small);
  }
  @media (max-width: 1100px) {
    .work {
      grid-template-columns: minmax(0, 1fr);
      gap: 10px;
    }
    .choices {
      grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
    }
  }
  @media (max-width: 700px) {
    .choices {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
</style>
