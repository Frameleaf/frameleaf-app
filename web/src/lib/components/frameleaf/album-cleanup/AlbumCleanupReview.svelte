<script lang="ts">
  import { goto } from '$app/navigation';
  import AlbumCleanupArt from '$lib/components/frameleaf/album-cleanup/AlbumCleanupArt.svelte';
  import AlbumCleanupMoveDialog from '$lib/components/frameleaf/album-cleanup/AlbumCleanupMoveDialog.svelte';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Menu from '$lib/components/frameleaf/Menu.svelte';
  import MenuItem from '$lib/components/frameleaf/MenuItem.svelte';
  import Status from '$lib/components/frameleaf/Status.svelte';
  import {
    buildPlan,
    DEFAULT_DELIMITERS,
    DEFAULT_MIN_GROUP,
    messyAlbumNames,
    OFFERED_DELIMITERS,
    operationsFor,
    type CleanupPlan,
    type PlanAlbum,
    type PlanNode,
    type PlanOptions,
    type PlanPair,
  } from '$lib/frameleaf/album-cleanup';
  import '$lib/frameleaf/album-cleanup.css';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { Route } from '$lib/route';
  import { locale } from '$lib/stores/preferences.store';
  import { getAssetMediaUrl } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import {
    AlbumChangeRunStatus,
    AssetMediaSize,
    applyAlbumCleanup,
    getAlbumCleanupSnapshot,
    getAlbumCleanupStatus,
    undoLatestAlbumChangeRun,
    updateMyPreferences,
    type AlbumCleanupFactsDto,
  } from '@frameleaf/sdk';
  import { Icon, toastManager } from '@frameleaf/ui';
  import {
    mdiAirplane,
    mdiArrowLeft,
    mdiArrowRight,
    mdiAutoFix,
    mdiCalendarAlert,
    mdiCalendarRange,
    mdiCallMerge,
    mdiChevronDown,
    mdiChevronRight,
    mdiCloseCircleOutline,
    mdiDotsHorizontal,
    mdiFolderMoveOutline,
    mdiFolderMultipleOutline,
    mdiFormatListGroup,
    mdiImageAlbum,
    mdiLockOutline,
    mdiMagnify,
    mdiMapMarkerOutline,
    mdiPencilOutline,
    mdiUndo,
  } from '@mdi/js';
  import { onDestroy, onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  /**
   * The Magic Albums review (FL-1300, prototype `AlbumCleanupReview`): what the scan found, the rules that read it,
   * and tabs for each kind of suggestion. Every control re-runs the planner here; nothing changes until Apply.
   */
  type Phase = 'loading' | 'unready' | 'review' | 'applying' | 'done';

  const CHILD_PAGE = 40;
  const TREE_LIMIT = 80;
  const LIST_LIMIT = 60;
  const LOST_LIMIT = 40;
  const SCAN_POLL_MS = 3000;
  const APPLY_POLL_MS = 1000;

  let phase = $state<Phase>('loading');
  let facts = $state<AlbumCleanupFactsDto>();

  let delimiters = $state(DEFAULT_DELIMITERS);
  let custom = $state('');
  let dateOnly = $state<NonNullable<PlanOptions['dateOnly']>>('year');
  let mergeDuplicates = $state(true);
  let minGroup = $state(DEFAULT_MIN_GROUP);
  let combineDays = $state(true);
  let usePhotoData = $state(true);
  let homeArea = $state(0);

  let skippedDuplicates = $state(new Set<string>());
  let forcedDuplicates = $state(new Set<string>());
  let mergedSimilar = $state(new Set<string>());
  let keptDays = $state(new Set<string>());
  let keptPlaces = $state(new Set<string>());
  let keptTrips = $state(new Set<string>());
  let renamedToPhotoDate = $state(new Set<string>());
  let healedAlbums = $state(new Set<string>());
  let leftOut = $state(new Set<string>());
  let flattened = $state(new Set<string>());
  let renamed = $state(new Map<string, string>());
  let moved = $state(new Map<string, string>());

  let expanded = $state(new Set<string>());
  let more = $state(new Map<string, number>());
  let tab = $state('structure');
  let sub = $state<Record<string, string>>({ merge: 'name', days: 'trips', dates: 'lost' });
  let search = $state('');
  let editing = $state<string | null>(null);
  let moving = $state<PlanNode | null>(null);
  let moveOpen = $state(false);
  let rulesOpen = $state(true);

  let progress = $state({ done: 0, total: 0 });
  let runId = $state<string>();
  let failed = $state(false);
  let undoing = $state(false);
  /** Whether the banner had been dismissed before this cleanup, so Undo can leave that alone. */
  let dismissedBefore = false;
  let poll: ReturnType<typeof setTimeout> | undefined;

  const stop = () => {
    if (poll) {
      clearTimeout(poll);
      poll = undefined;
    }
  };
  onDestroy(stop);

  const load = async () => {
    stop();
    try {
      const snapshot = await getAlbumCleanupSnapshot();
      if (!snapshot.ready || !snapshot.facts) {
        phase = 'unready';
        poll = setTimeout(() => void load(), SCAN_POLL_MS);
        return;
      }
      facts = snapshot.facts;
      phase = 'review';
      await resumeIfApplying();
    } catch (error) {
      handleError(error, $t('frameleaf_album_cleanup_load_failed'));
    }
  };

  /** Someone left the page while a cleanup was running: pick up its progress rather than offering it again. */
  const resumeIfApplying = async () => {
    const { apply } = await getAlbumCleanupStatus();
    if (apply?.status === AlbumChangeRunStatus.Running) {
      runId = apply.runId;
      progress = { done: apply.done, total: apply.total };
      phase = 'applying';
      poll = setTimeout(() => void follow(), APPLY_POLL_MS);
    }
  };

  onMount(() => {
    rulesOpen = !matchMedia('(max-width: 1100px)').matches;
    void load();
  });

  const plan: CleanupPlan | undefined = $derived(
    facts
      ? buildPlan(facts, {
          delimiters,
          dateOnly,
          mergeDuplicates,
          minGroup,
          skippedDuplicates,
          forcedDuplicates,
          mergedSimilar,
          combineDays,
          keptDays,
          usePhotoData,
          homeArea,
          keptPlaces,
          keptTrips,
          renamedToPhotoDate,
          healedAlbums,
          leftOut,
          flattened,
          renamed,
          moved,
        })
      : undefined,
  );

  const summary = $derived(plan?.summary);
  const needle = $derived(search.trim().toLowerCase());
  const searching = $derived(needle.length > 0);
  const number = (value: number) => value.toLocaleString($locale);

  const matchTree = (nodes: PlanNode[], query: string): PlanNode[] =>
    nodes.flatMap((node) => {
      if (node.name.toLowerCase().includes(query) || node.sourceName?.toLowerCase().includes(query)) {
        return [node];
      }
      if (node.kind !== 'collection') {
        return [];
      }
      const children = matchTree(node.children, query);
      return children.length > 0 ? [{ ...node, children }] : [];
    });
  const matches = (text: string) => !searching || text.toLowerCase().includes(needle);

  const visibleStructure = $derived(plan ? (searching ? matchTree(plan.structure, needle) : plan.structure) : []);
  const visibleUntouched = $derived(
    plan
      ? searching
        ? plan.untouched.filter((item) => item.name.toLowerCase().includes(needle))
        : plan.untouched
      : [],
  );
  const dupes = $derived(plan ? plan.duplicates.filter((group) => matches(group.key)) : []);
  const similar = $derived(
    plan ? plan.similar.filter((pair) => matches(`${pair.winner.name} ${pair.loser.name}`)) : [],
  );
  const sameTrip = $derived(
    plan ? plan.sameTrip.filter((pair) => matches(`${pair.winner.name} ${pair.loser.name}`)) : [],
  );
  const trips = $derived(plan ? plan.trips.filter((trip) => matches(trip.name)) : []);
  const days = $derived(plan ? plan.dayRuns.filter((run) => matches(run.name)) : []);
  const placed = $derived(plan ? plan.placed.filter((item) => matches(`${item.album.name} ${item.city}`)) : []);
  const lost = $derived(plan ? plan.lostDates.filter((item) => matches(item.album.name)) : []);
  const names = $derived(plan ? plan.mismatches.filter((item) => matches(item.album.name)) : []);

  const allSimilarMerged = $derived(!!plan && plan.similar.length > 0 && plan.similar.every(({ merged }) => merged));
  const allHealed = $derived(!!plan && plan.lostDates.length > 0 && plan.lostDates.every(({ healed }) => healed));
  const changedByHand = $derived(
    leftOut.size +
      flattened.size +
      renamed.size +
      moved.size +
      skippedDuplicates.size +
      forcedDuplicates.size +
      mergedSimilar.size +
      keptDays.size +
      keptPlaces.size +
      keptTrips.size +
      renamedToPhotoDate.size +
      healedAlbums.size >
      0,
  );

  const toggled = (set: Set<string>, value: string) => {
    const next = new Set(set);
    if (next.has(value)) {
      next.delete(value);
    } else {
      next.add(value);
    }
    return next;
  };

  const toggleDelimiter = (token: string) =>
    (delimiters = delimiters.includes(token) ? delimiters.filter((item) => item !== token) : [...delimiters, token]);
  const addCustom = (event: SubmitEvent) => {
    event.preventDefault();
    const token = custom.trim();
    if (token && !delimiters.includes(token)) {
      delimiters = [...delimiters, token];
    }
    custom = '';
  };
  const reset = () => {
    leftOut = new Set();
    flattened = new Set();
    renamed = new Map();
    moved = new Map();
    skippedDuplicates = new Set();
    forcedDuplicates = new Set();
    mergedSimilar = new Set();
    keptDays = new Set();
    keptPlaces = new Set();
    keptTrips = new Set();
    renamedToPhotoDate = new Set();
    healedAlbums = new Set();
  };

  const toggleAllSimilar = () => {
    if (!plan) {
      return;
    }
    const next = new Set(mergedSimilar);
    for (const pair of plan.similar) {
      if (allSimilarMerged) {
        next.delete(pair.key);
      } else {
        next.add(pair.key);
      }
    }
    mergedSimilar = next;
  };
  const toggleAllHealed = () => {
    if (plan) {
      healedAlbums = allHealed ? new Set() : new Set(plan.lostDates.map(({ key }) => key));
    }
  };

  const setCustomName = (id: string, name: string) => {
    editing = null;
    if (name.trim()) {
      renamed = new Map(renamed).set(id, name.trim());
    }
  };

  /* ---- applying ---- */
  const setDismissed = async (value: boolean) => {
    const preferences = await updateMyPreferences({
      userPreferencesUpdateDto: { albums: { cleanupBannerDismissed: value } },
    });
    authManager.setPreferences(preferences);
  };

  const follow = async () => {
    if (!runId) {
      return;
    }
    try {
      const { apply } = await getAlbumCleanupStatus();
      if (apply?.runId === runId && apply.status === AlbumChangeRunStatus.Running) {
        progress = { done: apply.done, total: apply.total };
        poll = setTimeout(() => void follow(), APPLY_POLL_MS);
        return;
      }
      failed = apply?.runId === runId && apply.status === AlbumChangeRunStatus.Failed;
      phase = 'done';
      void setDismissed(true).catch(() => undefined);
    } catch {
      poll = setTimeout(() => void follow(), APPLY_POLL_MS * 3);
    }
  };

  const apply = async () => {
    if (!plan) {
      return;
    }
    dismissedBefore = authManager.preferences.albums.cleanupBannerDismissed;
    const operations = operationsFor(plan);
    if (operations.length === 0) {
      toastManager.primary($t('frameleaf_album_cleanup_nothing_to_apply'));
      return;
    }
    phase = 'applying';
    progress = { done: 0, total: operations.length };
    try {
      ({ runId } = await applyAlbumCleanup({ albumCleanupApplyDto: { operations } }));
      poll = setTimeout(() => void follow(), APPLY_POLL_MS);
    } catch (error) {
      phase = 'review';
      handleError(error, $t('frameleaf_album_cleanup_apply_failed'));
    }
  };

  const undo = async () => {
    undoing = true;
    try {
      const { skipped } = await undoLatestAlbumChangeRun({ albumChangeUndoDto: { runId } });
      toastManager.primary(
        skipped.length > 0
          ? $t('frameleaf_album_cleanup_undone_skipped', { values: { count: skipped.length } })
          : $t('frameleaf_album_cleanup_undone'),
      );
      if (!dismissedBefore) {
        await setDismissed(false).catch(() => undefined);
      }
      reset();
      failed = false;
      phase = 'loading';
      await load();
    } catch (error) {
      handleError(error, $t('frameleaf_album_cleanup_undo_failed'));
    } finally {
      undoing = false;
    }
  };

  /* ---- what the art shows ---- */
  const pileNames = $derived(facts ? messyAlbumNames(facts) : []);
  const covers = $derived(facts ? facts.albums.flatMap(({ coverAssetId }) => coverAssetId ?? []) : []);

  /* ---- tabs ---- */
  const tabs = $derived(
    plan && summary
      ? [
          { id: 'structure', label: $t('frameleaf_album_cleanup_tab_structure'), count: plan.structure.length },
          {
            id: 'merge',
            label: $t('frameleaf_album_cleanup_tab_merge'),
            count: plan.duplicates.length + plan.similar.length + plan.sameTrip.length,
          },
          {
            id: 'days',
            label: $t('frameleaf_album_cleanup_tab_days'),
            count: plan.trips.length + plan.dayRuns.length + plan.placed.length,
          },
          {
            id: 'dates',
            label: $t('frameleaf_album_cleanup_tab_dates'),
            count: summary.lostPhotos + plan.mismatches.length,
          },
          { id: 'untouched', label: $t('frameleaf_album_cleanup_tab_unchanged'), count: plan.untouched.length },
        ]
      : [],
  );
  const subTabs = $derived(
    plan && summary
      ? ({
          merge: [
            { id: 'name', label: $t('frameleaf_album_cleanup_sub_same_name'), count: plan.duplicates.length },
            { id: 'photos', label: $t('frameleaf_album_cleanup_sub_same_photos'), count: plan.similar.length },
            { id: 'trip', label: $t('frameleaf_album_cleanup_sub_same_trip'), count: plan.sameTrip.length },
          ],
          days: [
            { id: 'trips', label: $t('frameleaf_album_cleanup_sub_trips'), count: plan.trips.length },
            { id: 'days', label: $t('frameleaf_album_cleanup_sub_days'), count: plan.dayRuns.length },
            { id: 'places', label: $t('frameleaf_album_cleanup_sub_places'), count: plan.placed.length },
          ],
          dates: [
            { id: 'lost', label: $t('frameleaf_album_cleanup_sub_lost'), count: summary.lostPhotos },
            { id: 'names', label: $t('frameleaf_album_cleanup_sub_names'), count: plan.mismatches.length },
          ],
        } as Record<string, { id: string; label: string; count: number }[]>)
      : {},
  );
  const activeSub = $derived(sub[tab]);
  const photos = (count: number) => $t('frameleaf_album_cleanup_photo_count', { values: { count } });
  const homeLabel = (city: string | null | undefined) =>
    city ? $t('frameleaf_album_cleanup_home_area', { values: { city } }) : $t('frameleaf_album_cleanup_home_unknown');
  const formatDay = (day: string) =>
    new Date(`${day}T00:00:00Z`).toLocaleDateString($locale, {
      timeZone: 'UTC',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });

  const onRowMenu = {
    rename: (node: PlanNode) => (editing = node.id),
    flatten: (node: PlanNode) => (flattened = toggled(flattened, node.id)),
    leaveOut: (node: PlanNode) => (leftOut = toggled(leftOut, node.id)),
    move: (node: PlanNode) => {
      moving = node;
      moveOpen = true;
    },
  };
</script>

{#snippet rows(nodes: PlanNode[], depth: number, limit: number | undefined)}
  {#each limit ? nodes.slice(0, limit) : nodes as node (node.id)}
    {@const group = node.kind === 'collection'}
    {@const open = group && (searching || expanded.has(node.id))}
    {@const shown = more.get(node.id) ?? CHILD_PAGE}
    <li class="ac-row" class:group style={`--depth: ${depth}`}>
      {#if group}
        <button
          type="button"
          class="ac-chevron"
          aria-expanded={open}
          aria-label={$t(open ? 'frameleaf_album_cleanup_collapse' : 'frameleaf_album_cleanup_expand', {
            values: { name: node.name },
          })}
          onclick={() => (expanded = toggled(expanded, node.id))}
        >
          <Icon icon={open ? mdiChevronDown : mdiChevronRight} size="20" aria-hidden={true} />
        </button>
      {:else}
        <span class="ac-chevron"></span>
      {/if}
      <Icon icon={group ? mdiFolderMultipleOutline : mdiImageAlbum} size="18" aria-hidden={true} />
      <span class="ac-row-text">
        {#if editing === node.id}
          <!-- svelte-ignore a11y_autofocus -->
          <input
            autofocus
            value={node.name}
            aria-label={$t('frameleaf_album_cleanup_rename_named', { values: { name: node.name } })}
            onblur={(event) => setCustomName(node.id, event.currentTarget.value)}
            onkeydown={(event) => {
              if (event.key === 'Enter') {
                event.currentTarget.blur();
              } else if (event.key === 'Escape') {
                editing = null;
              }
            }}
          />
        {:else}
          <strong>{node.name}</strong>
        {/if}
        <small>
          {group
            ? $t('frameleaf_album_cleanup_group_detail', {
                values: { albums: node.albumCount, photos: number(node.photoCount) },
              })
            : node.sourceName !== node.name
              ? $t('frameleaf_album_cleanup_from', { values: { name: node.sourceName ?? '' } })
              : photos(node.photoCount)}
        </small>
      </span>
      {#if node.existing}<span class="ac-tag">{$t('frameleaf_album_cleanup_tag_existing')}</span>{/if}
      {#if (node.copies ?? 0) > 1}
        <span class="ac-tag">
          <Icon icon={mdiCallMerge} size="13" aria-hidden={true} />
          {$t('frameleaf_album_cleanup_tag_merged', { values: { count: node.copies } })}
        </span>
      {/if}
      {#if (node.days ?? 0) > 1}
        <span class="ac-tag">
          <Icon icon={node.trip ? mdiAirplane : mdiCalendarRange} size="13" aria-hidden={true} />
          {node.trip
            ? $t('frameleaf_album_cleanup_tag_trip_days', { values: { count: node.days } })
            : $t('frameleaf_album_cleanup_tag_days', { values: { count: node.days } })}
        </span>
      {/if}
      {#if node.locked}
        <span class="ac-row-lock" title={$t('frameleaf_album_cleanup_locked')}>
          <Icon icon={mdiLockOutline} size="15" aria-hidden={true} />
        </span>
      {/if}
      <span class="ac-row-menu">
        <Menu label={$t('frameleaf_album_cleanup_actions_for', { values: { name: node.name } })} align="end">
          {#snippet trigger()}<Icon icon={mdiDotsHorizontal} size="18" aria-hidden={true} />{/snippet}
          {#if group}
            <MenuItem onSelect={() => onRowMenu.rename(node)}>
              <Icon icon={mdiPencilOutline} size="18" aria-hidden={true} />{$t('rename')}
            </MenuItem>
          {/if}
          {#if group && node.flattenable}
            <MenuItem onSelect={() => onRowMenu.flatten(node)}>
              <Icon icon={mdiFormatListGroup} size="18" aria-hidden={true} />{$t(
                'frameleaf_album_cleanup_remove_level',
              )}
            </MenuItem>
          {/if}
          <MenuItem onSelect={() => onRowMenu.move(node)}>
            <Icon icon={mdiFolderMoveOutline} size="18" aria-hidden={true} />{$t('frameleaf_album_cleanup_move_into')}
          </MenuItem>
          <div class="ac-menu-separator" role="separator"></div>
          <MenuItem onSelect={() => onRowMenu.leaveOut(node)}>
            <Icon icon={mdiCloseCircleOutline} size="18" aria-hidden={true} />{$t(
              'frameleaf_album_cleanup_leave_as_is',
            )}
          </MenuItem>
        </Menu>
      </span>
    </li>
    {#if open}
      {@render rows(node.children.slice(0, shown), depth + 1, undefined)}
      {#if node.children.length > shown}
        <li class="ac-more" style={`--depth: ${depth + 1}`}>
          <Button onclick={() => (more = new Map(more).set(node.id, shown + CHILD_PAGE))}>
            {$t('frameleaf_album_cleanup_show_more', {
              values: { count: Math.min(CHILD_PAGE, node.children.length - shown) },
            })}
          </Button>
        </li>
      {/if}
    {/if}
  {/each}
{/snippet}

{#snippet copyRow(album: PlanAlbum, label: string, keeps: boolean)}
  <li>
    <Icon icon={album.locked ? mdiLockOutline : mdiImageAlbum} size="16" aria-hidden={true} />
    <span>{label}</span>
    {#if keeps}<span class="ac-tag strong">{$t('frameleaf_album_cleanup_keeps')}</span>{/if}
  </li>
{/snippet}

{#snippet pairRow(pair: PlanPair, detail: string)}
  <li class:skipped-soft={!pair.merged}>
    <div class="ac-dupe-head">
      <span>
        <strong>
          {pair.winner.name} <em>{$t('frameleaf_album_cleanup_and')}</em>
          {pair.loser.name}
        </strong>
        <small>{detail}</small>
      </span>
      <Button pressed={pair.merged} onclick={() => (mergedSimilar = toggled(mergedSimilar, pair.key))}>
        {pair.merged ? $t('frameleaf_album_cleanup_merging') : $t('frameleaf_album_cleanup_merge')}
      </Button>
    </div>
    {#if pair.shared}<p class="ac-note">{$t('frameleaf_album_cleanup_pair_shared')}</p>{/if}
    <ol class="ac-copies">
      {@render copyRow(pair.winner, photos(pair.winner.count), true)}
      {@render copyRow(pair.loser, photos(pair.loser.count), false)}
    </ol>
  </li>
{/snippet}

{#snippet moreNote(shown: number, total: number, noun: string)}
  {#if total > shown && !searching}
    <li class="ac-empty">
      {$t('frameleaf_album_cleanup_showing', { values: { shown, total: number(total), noun } })}
    </li>
  {/if}
{/snippet}

{#snippet choice(value: NonNullable<PlanOptions['dateOnly']>, title: string, detail: string)}
  <label class="ac-choice" class:on={dateOnly === value}>
    <input type="radio" name="ac-date" checked={dateOnly === value} onchange={() => (dateOnly = value)} />
    <span>
      <strong>{title}</strong>
      <small>{detail}</small>
    </span>
  </label>
{/snippet}

{#if phase === 'loading'}
  <section class="ac-page">
    <Status message={$t('frameleaf_album_cleanup_loading')} />
  </section>
{:else if phase === 'unready'}
  <section class="ac-page">
    <div class="ac-head">
      <p class="ac-eyebrow">
        <Icon icon={mdiAutoFix} size="16" aria-hidden={true} />
        {$t('frameleaf_album_cleanup_magic_albums')}
      </p>
      <h1>{$t('frameleaf_album_cleanup_title')}</h1>
      <p role="status">{$t('frameleaf_album_cleanup_scanning')}</p>
    </div>
  </section>
{:else if phase === 'done' && plan && summary}
  <section class="ac-page" aria-label={$t('frameleaf_album_cleanup_finished_label')}>
    <div class="ac-done">
      <AlbumCleanupArt {plan} names={pileNames} {covers} />
      <h1>{failed ? $t('frameleaf_album_cleanup_stopped_title') : $t('frameleaf_album_cleanup_done_title')}</h1>
      <p>
        {failed
          ? $t('frameleaf_album_cleanup_stopped_body')
          : $t('frameleaf_album_cleanup_done_body', {
              values: {
                before: number(summary.albumsBefore),
                after: number(summary.topLevelAfter),
                combined: number(summary.albumsCombined),
              },
            })}
      </p>
      <div class="ac-banner-actions">
        <Button variant="primary" onclick={() => goto(Route.albums())}>
          {$t('frameleaf_album_cleanup_back_to_albums')}
        </Button>
        <Button disabled={undoing} onclick={undo}>
          <Icon icon={mdiUndo} size="1em" aria-hidden={true} />
          {$t('frameleaf_album_cleanup_undo')}
        </Button>
      </div>
      <p class="ac-note">{$t('frameleaf_album_cleanup_run_again')}</p>
    </div>
  </section>
{:else if plan && summary}
  <section class="ac-page" aria-labelledby="ac-title">
    <button type="button" class="ac-back" onclick={() => goto(Route.albums())}>
      <Icon icon={mdiArrowLeft} size="18" aria-hidden={true} />
      {$t('albums')}
    </button>
    <header class="ac-head">
      <p class="ac-eyebrow">
        <Icon icon={mdiAutoFix} size="16" aria-hidden={true} />
        {$t('frameleaf_album_cleanup_magic_albums')}
      </p>
      <h1 id="ac-title">{$t('frameleaf_album_cleanup_title')}</h1>
      <p>{$t('frameleaf_album_cleanup_intro')}</p>
    </header>
    <dl class="ac-stats">
      <div class="ac-stat lead">
        <dt>{$t('frameleaf_album_cleanup_stat_top_level')}</dt>
        <dd>
          <s>{number(summary.albumsBefore)}</s>
          <Icon icon={mdiArrowRight} size="20" aria-hidden={true} />
          <strong>{number(summary.topLevelAfter)}</strong>
        </dd>
      </div>
      <div class="ac-stat">
        <dt>{$t('frameleaf_album_cleanup_stat_combined')}</dt>
        <dd>{number(summary.albumsCombined)}</dd>
      </div>
      <div class="ac-stat">
        <dt>{$t('frameleaf_album_cleanup_stat_collections')}</dt>
        <dd>{number(summary.collections)}</dd>
      </div>
      <div class="ac-stat">
        <dt>{$t('frameleaf_album_cleanup_stat_moved')}</dt>
        <dd>{number(summary.albumsMoved)}</dd>
      </div>
    </dl>

    <div class="ac-layout">
      <div class="ac-rules">
        <details class="ac-rules-panel" bind:open={rulesOpen}>
          <summary>{$t('frameleaf_album_cleanup_rules_title')}</summary>
          <section>
            <h2>{$t('frameleaf_album_cleanup_split_at')}</h2>
            <div class="ac-delims">
              {#each OFFERED_DELIMITERS as { token, example } (token)}
                <label class="ac-delim" class:on={delimiters.includes(token)}>
                  <input type="checkbox" checked={delimiters.includes(token)} onchange={() => toggleDelimiter(token)} />
                  <b>{token}</b>
                  <small>{example}</small>
                </label>
              {/each}
              {#each delimiters.filter( (token) => OFFERED_DELIMITERS.every((item) => item.token !== token) ) as token (token)}
                <label class="ac-delim on">
                  <input type="checkbox" checked onchange={() => toggleDelimiter(token)} />
                  <b>{token}</b>
                  <small>{$t('frameleaf_album_cleanup_your_own')}</small>
                </label>
              {/each}
            </div>
            <form class="ac-delim-add" onsubmit={addCustom}>
              <input
                bind:value={custom}
                maxlength="3"
                placeholder={$t('frameleaf_album_cleanup_add_delimiter')}
                aria-label={$t('frameleaf_album_cleanup_add_delimiter_label')}
              />
              <Button type="submit" disabled={!custom.trim()}>{$t('add')}</Button>
            </form>
            <p class="ac-note">{$t('frameleaf_album_cleanup_dates_stay_whole')}</p>
          </section>
          <section>
            <h2>{$t('frameleaf_album_cleanup_date_albums')}</h2>
            <div class="ac-choices">
              {@render choice(
                'year',
                $t('frameleaf_album_cleanup_date_year'),
                $t('frameleaf_album_cleanup_date_year_detail'),
              )}
              {@render choice(
                'year-month',
                $t('frameleaf_album_cleanup_date_month'),
                $t('frameleaf_album_cleanup_date_month_detail'),
              )}
              {@render choice(
                'leave',
                $t('frameleaf_album_cleanup_date_leave'),
                $t('frameleaf_album_cleanup_date_leave_detail'),
              )}
              {@render choice(
                'remove',
                $t('frameleaf_album_cleanup_date_remove'),
                $t('frameleaf_album_cleanup_date_remove_detail'),
              )}
            </div>
          </section>
          <section>
            <h2>{$t('frameleaf_album_cleanup_duplicates_groups')}</h2>
            <label class="ac-switch">
              <input type="checkbox" role="switch" bind:checked={mergeDuplicates} />
              <span>
                <strong>{$t('frameleaf_album_cleanup_merge_same_name')}</strong>
                <small>{$t('frameleaf_album_cleanup_merge_same_name_detail')}</small>
              </span>
            </label>
            <label class="ac-switch">
              <input type="checkbox" role="switch" bind:checked={combineDays} />
              <span>
                <strong>{$t('frameleaf_album_cleanup_combine_days')}</strong>
                <small>{$t('frameleaf_album_cleanup_combine_days_detail')}</small>
              </span>
            </label>
            <label class="ac-switch">
              <input type="checkbox" role="switch" bind:checked={usePhotoData} />
              <span>
                <strong>{$t('frameleaf_album_cleanup_use_photo_data')}</strong>
                <small>{$t('frameleaf_album_cleanup_use_photo_data_detail')}</small>
              </span>
            </label>
            {#if plan.home}
              <label class="ac-field">
                <span>{$t('frameleaf_album_cleanup_home')}</span>
                <select bind:value={homeArea} disabled={!usePhotoData}>
                  {#each facts?.homeAreas ?? [] as area, index (index)}
                    <option value={index}>{homeLabel(area.city)}</option>
                  {/each}
                </select>
              </label>
            {/if}
            <label class="ac-field">
              <span>{$t('frameleaf_album_cleanup_make_group')}</span>
              <select bind:value={minGroup}>
                {#each [2, 3, 5, 10] as value (value)}
                  <option {value}>{$t('frameleaf_album_cleanup_group_size', { values: { value } })}</option>
                {/each}
              </select>
            </label>
          </section>
        </details>
      </div>

      <div class="ac-main">
        <div class="ac-main-head">
          <div class="ac-tabs" role="tablist" aria-label={$t('frameleaf_album_cleanup_suggestions')}>
            {#each tabs as item (item.id)}
              <button type="button" role="tab" aria-selected={tab === item.id} onclick={() => (tab = item.id)}>
                {item.label} <small>{number(item.count)}</small>
              </button>
            {/each}
          </div>
          <div class="ac-main-tools">
            <label class="ac-search">
              <Icon icon={mdiMagnify} size="17" aria-hidden={true} />
              <input
                type="search"
                bind:value={search}
                placeholder={$t('frameleaf_album_cleanup_find_album')}
                aria-label={$t('frameleaf_album_cleanup_find_album')}
              />
            </label>
            {#if changedByHand}<Button onclick={reset}>{$t('frameleaf_album_cleanup_reset')}</Button>{/if}
          </div>
        </div>
        {#if subTabs[tab]}
          <div class="ac-subtabs" role="tablist" aria-label={$t('frameleaf_album_cleanup_kind_of_suggestion')}>
            {#each subTabs[tab] as item (item.id)}
              <button
                type="button"
                role="tab"
                aria-selected={activeSub === item.id}
                onclick={() => (sub = { ...sub, [tab]: item.id })}
              >
                {item.label} <small>{number(item.count)}</small>
              </button>
            {/each}
          </div>
        {/if}

        {#if tab === 'structure'}
          <ul class="ac-tree">
            {@render rows(visibleStructure, 0, TREE_LIMIT)}
            {#if visibleStructure.length === 0}
              <li class="ac-empty">{$t('frameleaf_album_cleanup_no_groups')}</li>
            {/if}
          </ul>
        {:else if tab === 'merge' && activeSub === 'name'}
          <ul class="ac-dupes">
            {#each dupes.slice(0, LIST_LIMIT) as group (group.key)}
              <li class:skipped={group.skipped}>
                <div class="ac-dupe-head">
                  <span>
                    <strong>{group.name}</strong>
                    <small>
                      {$t('frameleaf_album_cleanup_copies_detail', {
                        values: { copies: group.others.length + 1, photos: number(group.count) },
                      })}
                    </small>
                  </span>
                  {#if group.shared}
                    <Button onclick={() => (forcedDuplicates = toggled(forcedDuplicates, group.key))}>
                      {group.skipped
                        ? $t('frameleaf_album_cleanup_merge_anyway')
                        : $t('frameleaf_album_cleanup_dont_merge')}
                    </Button>
                  {:else}
                    <Button
                      disabled={!mergeDuplicates}
                      onclick={() => (skippedDuplicates = toggled(skippedDuplicates, group.key))}
                    >
                      {group.skipped
                        ? $t('frameleaf_album_cleanup_merge')
                        : $t('frameleaf_album_cleanup_keep_separate')}
                    </Button>
                  {/if}
                </div>
                {#if group.shared}<p class="ac-note">{$t('frameleaf_album_cleanup_group_shared')}</p>{/if}
                <ol class="ac-copies">
                  {@render copyRow(group.winner, photos(group.winner.count), true)}
                  {#each group.others as album (album.id)}
                    {@render copyRow(album, photos(album.count), false)}
                  {/each}
                </ol>
              </li>
            {:else}
              <li class="ac-empty">{$t('frameleaf_album_cleanup_no_duplicates')}</li>
            {/each}
            {@render moreNote(LIST_LIMIT, plan.duplicates.length, $t('frameleaf_album_cleanup_noun_album'))}
          </ul>
        {:else if tab === 'merge' && activeSub === 'photos'}
          <div class="ac-section-head">
            <p class="ac-note">{$t('frameleaf_album_cleanup_same_photos_note')}</p>
            {#if plan.similar.length > 0}
              <Button onclick={toggleAllSimilar}>
                {allSimilarMerged
                  ? $t('frameleaf_album_cleanup_keep_all_separate')
                  : $t('frameleaf_album_cleanup_merge_all', { values: { count: number(plan.similar.length) } })}
              </Button>
            {/if}
          </div>
          <ul class="ac-dupes">
            {#each similar.slice(0, LIST_LIMIT) as pair (pair.key)}
              {@render pairRow(
                pair,
                $t('frameleaf_album_cleanup_same_photos_detail', {
                  values: { share: Math.round(pair.share * 100), photos: number(pair.count) },
                }),
              )}
            {:else}
              <li class="ac-empty">{$t('frameleaf_album_cleanup_no_albums')}</li>
            {/each}
          </ul>
        {:else if tab === 'merge' && activeSub === 'trip'}
          <div class="ac-section-head">
            <p class="ac-note">{$t('frameleaf_album_cleanup_same_trip_note')}</p>
          </div>
          <ul class="ac-dupes">
            {#each sameTrip.slice(0, LIST_LIMIT) as pair (pair.key)}
              {@render pairRow(
                pair,
                $t('frameleaf_album_cleanup_same_trip_detail', { values: { photos: number(pair.count) } }),
              )}
            {:else}
              <li class="ac-empty">
                {usePhotoData
                  ? $t('frameleaf_album_cleanup_no_albums')
                  : $t('frameleaf_album_cleanup_turn_on_photo_data')}
              </li>
            {/each}
          </ul>
        {:else if tab === 'days' && activeSub === 'trips'}
          <div class="ac-section-head">
            <p class="ac-note">
              {$t('frameleaf_album_cleanup_trips_note', { values: { home: homeLabel(plan.home?.city) } })}
            </p>
          </div>
          <ul class="ac-dupes">
            {#each trips.slice(0, LIST_LIMIT) as trip (trip.key)}
              <li class:skipped={trip.skipped}>
                <div class="ac-dupe-head">
                  <span>
                    <strong>{trip.name}</strong>
                    <small>
                      {$t('frameleaf_album_cleanup_trip_detail', {
                        values: { albums: trip.albums.length, photos: number(trip.count), year: trip.year },
                      })}{trip.cities.length > 1
                        ? $t('frameleaf_album_cleanup_trip_also', {
                            values: { cities: trip.cities.slice(1).join(', ') },
                          })
                        : ''}
                    </small>
                  </span>
                  <Button onclick={() => (keptTrips = toggled(keptTrips, trip.key))}>
                    {trip.skipped ? $t('frameleaf_album_cleanup_combine') : $t('frameleaf_album_cleanup_keep_separate')}
                  </Button>
                </div>
                <ol class="ac-copies">
                  {#each trip.albums as album (album.id)}
                    {@render copyRow(album, album.name, false)}
                  {/each}
                </ol>
              </li>
            {:else}
              <li class="ac-empty">
                {usePhotoData
                  ? $t('frameleaf_album_cleanup_no_trips')
                  : $t('frameleaf_album_cleanup_turn_on_photo_data')}
              </li>
            {/each}
            {@render moreNote(LIST_LIMIT, plan.trips.length, $t('frameleaf_album_cleanup_noun_trip'))}
          </ul>
        {:else if tab === 'days' && activeSub === 'days'}
          {#if plan.keptApart > 0}
            <div class="ac-section-head">
              <p class="ac-note">{$t('frameleaf_album_cleanup_kept_apart', { values: { count: plan.keptApart } })}</p>
            </div>
          {/if}
          <ul class="ac-dupes">
            {#each days.slice(0, LIST_LIMIT) as run (run.key)}
              <li class:skipped={run.skipped}>
                <div class="ac-dupe-head">
                  <span>
                    <strong>{run.name}</strong>
                    <small>
                      {$t('frameleaf_album_cleanup_run_detail', {
                        values: { days: run.albums.length, photos: number(run.count) },
                      })}
                    </small>
                  </span>
                  <Button disabled={!combineDays} onclick={() => (keptDays = toggled(keptDays, run.key))}>
                    {run.skipped ? $t('frameleaf_album_cleanup_combine') : $t('frameleaf_album_cleanup_keep_separate')}
                  </Button>
                </div>
                <ol class="ac-copies">
                  {#each run.albums as album (album.id)}
                    {@render copyRow(album, album.name, false)}
                  {/each}
                </ol>
              </li>
            {:else}
              <li class="ac-empty">{$t('frameleaf_album_cleanup_no_days')}</li>
            {/each}
            {@render moreNote(LIST_LIMIT, plan.dayRuns.length, $t('frameleaf_album_cleanup_noun_place'))}
          </ul>
        {:else if tab === 'days' && activeSub === 'places'}
          <div class="ac-section-head">
            <p class="ac-note">{$t('frameleaf_album_cleanup_places_note')}</p>
          </div>
          <ul class="ac-tree">
            {#each placed.slice(0, TREE_LIMIT) as item (item.key)}
              <li class="ac-row" style="--depth: 0">
                <Icon icon={mdiMapMarkerOutline} size="18" aria-hidden={true} />
                <span class="ac-row-text">
                  <strong>{item.kept ? item.album.name : `${item.city} › ${item.album.name}`}</strong>
                  <small>
                    {$t('frameleaf_album_cleanup_taken_in', {
                      values: { share: Math.round(item.share * 100), city: item.city },
                    })}
                  </small>
                </span>
                <Button onclick={() => (keptPlaces = toggled(keptPlaces, item.key))}>
                  {item.kept ? $t('frameleaf_album_cleanup_use_location') : $t('frameleaf_album_cleanup_keep_date')}
                </Button>
              </li>
            {:else}
              <li class="ac-empty">
                {usePhotoData
                  ? $t('frameleaf_album_cleanup_no_albums')
                  : $t('frameleaf_album_cleanup_turn_on_photo_data')}
              </li>
            {/each}
            {@render moreNote(TREE_LIMIT, plan.placed.length, $t('frameleaf_album_cleanup_noun_album'))}
          </ul>
        {:else if tab === 'dates' && activeSub === 'lost'}
          <div class="ac-section-head">
            <p class="ac-note">
              {$t('frameleaf_album_cleanup_lost_note')}{plan.healSkipped > 0
                ? ` ${$t('frameleaf_album_cleanup_lost_skipped', { values: { count: plan.healSkipped } })}`
                : ''}
            </p>
            {#if plan.lostDates.length > 0}
              <Button variant={allHealed ? 'default' : 'primary'} onclick={toggleAllHealed}>
                {allHealed
                  ? $t('frameleaf_album_cleanup_keep_all')
                  : $t('frameleaf_album_cleanup_heal_all', { values: { count: number(summary.lostPhotos) } })}
              </Button>
            {/if}
          </div>
          <ul class="ac-dupes">
            {#each lost.slice(0, LOST_LIMIT) as item (item.key)}
              <li class:skipped-soft={!item.healed}>
                <div class="ac-dupe-head">
                  <span>
                    <strong>{item.album.name}</strong>
                    <small>
                      {$t('frameleaf_album_cleanup_lost_detail', {
                        values: {
                          count: item.suggestions.length,
                          span:
                            item.from === item.to
                              ? formatDay(item.from)
                              : $t('frameleaf_album_lost_dates_span', {
                                  values: { from: formatDay(item.from), to: formatDay(item.to) },
                                }),
                        },
                      })}
                    </small>
                  </span>
                  <Button pressed={item.healed} onclick={() => (healedAlbums = toggled(healedAlbums, item.key))}>
                    {item.healed ? $t('frameleaf_album_cleanup_healing') : $t('frameleaf_album_cleanup_heal')}
                  </Button>
                </div>
                <ul class="ac-heal">
                  {#each item.suggestions as photo (photo.assetId)}
                    <li>
                      <img
                        src={getAssetMediaUrl({ id: photo.assetId, size: AssetMediaSize.Thumbnail })}
                        alt=""
                        loading="lazy"
                      />
                      <span class="ac-heal-text">
                        <strong>{photo.fileName}</strong>
                        <small>
                          {photo.between
                            ? $t('frameleaf_album_lost_dates_between', {
                                values: { before: photo.between.before, after: photo.between.after },
                              })
                            : $t('frameleaf_album_lost_dates_from_album')}
                        </small>
                      </span>
                      <span class="ac-heal-dates">
                        <s>{formatDay(photo.shownDay)}</s>
                        <Icon icon={mdiArrowRight} size="14" aria-hidden={true} />
                        <b>
                          {photo.precision === 'exact'
                            ? formatDay(photo.day)
                            : $t('frameleaf_album_lost_dates_around', { values: { date: formatDay(photo.day) } })}
                        </b>
                      </span>
                    </li>
                  {/each}
                </ul>
              </li>
            {:else}
              <li class="ac-empty">{$t('frameleaf_album_cleanup_no_lost')}</li>
            {/each}
            {@render moreNote(LOST_LIMIT, plan.lostDates.length, $t('frameleaf_album_cleanup_noun_album'))}
          </ul>
        {:else if tab === 'dates' && activeSub === 'names'}
          <div class="ac-section-head">
            <p class="ac-note">{$t('frameleaf_album_cleanup_names_note')}</p>
          </div>
          <ul class="ac-tree">
            {#each names.slice(0, TREE_LIMIT) as item (item.key)}
              <li class="ac-row" style="--depth: 0">
                <Icon icon={mdiCalendarAlert} size="18" aria-hidden={true} />
                <span class="ac-row-text">
                  <strong>{item.renamed ? item.photoLabel : item.album.originalName}</strong>
                  <small>
                    {item.renamed
                      ? $t('frameleaf_album_cleanup_renamed_from', { values: { name: item.album.originalName } })
                      : $t('frameleaf_album_cleanup_photos_from', { values: { day: item.photoLabel } })}
                  </small>
                </span>
                <Button
                  pressed={item.renamed}
                  onclick={() => (renamedToPhotoDate = toggled(renamedToPhotoDate, item.key))}
                >
                  {item.renamed ? $t('frameleaf_album_cleanup_renaming') : $t('frameleaf_album_cleanup_use_photo_date')}
                </Button>
              </li>
            {:else}
              <li class="ac-empty">
                {usePhotoData
                  ? $t('frameleaf_album_cleanup_no_albums')
                  : $t('frameleaf_album_cleanup_turn_on_photo_data')}
              </li>
            {/each}
            {@render moreNote(TREE_LIMIT, plan.mismatches.length, $t('frameleaf_album_cleanup_noun_album'))}
          </ul>
        {:else if tab === 'untouched'}
          <ul class="ac-tree">
            {#each visibleUntouched.slice(0, TREE_LIMIT) as item (item.id)}
              <li class="ac-row" style="--depth: 0">
                <span class="ac-chevron"></span>
                <Icon icon={mdiImageAlbum} size="18" aria-hidden={true} />
                <span class="ac-row-text">
                  <strong>{item.name}</strong>
                  <small>{photos(item.photoCount)}</small>
                </span>
              </li>
            {:else}
              <li class="ac-empty">{$t('frameleaf_album_cleanup_no_albums')}</li>
            {/each}
            {@render moreNote(TREE_LIMIT, plan.untouched.length, $t('frameleaf_album_cleanup_noun_album'))}
          </ul>
        {/if}
      </div>
    </div>

    <footer class="ac-footer">
      {#if phase === 'applying'}
        <p role="status">{$t('frameleaf_album_cleanup_applying')}</p>
        <span class="ac-progress">
          <i style={`width: ${progress.total > 0 ? (progress.done / progress.total) * 100 : 0}%`}></i>
        </span>
      {:else}
        <p>
          {$t('frameleaf_album_cleanup_footer', {
            values: {
              collections: summary.collections,
              moved: number(summary.albumsMoved),
              combined: number(summary.albumsCombined),
            },
          })}{summary.datesHealed > 0
            ? $t('frameleaf_album_cleanup_footer_healed', { values: { healed: number(summary.datesHealed) } })
            : ''}{$t('frameleaf_album_cleanup_footer_undo')}
        </p>
        <Button onclick={() => goto(Route.albums())}>{$t('cancel')}</Button>
        <Button variant="primary" onclick={apply}>{$t('frameleaf_album_cleanup_apply')}</Button>
      {/if}
    </footer>
    {#if moving}
      <AlbumCleanupMoveDialog
        node={moving}
        structure={plan.structure}
        bind:open={moveOpen}
        onPick={(target) => {
          if (moving) {
            moved = new Map(moved).set(moving.id, target);
            expanded = new Set(expanded).add(target);
          }
          moveOpen = false;
          moving = null;
        }}
      />
    {/if}
  </section>
{/if}

<style>
  .ac-menu-separator {
    height: 1px;
    margin: 0.25rem 0.375rem;
    background: var(--fl-border);
  }
</style>
