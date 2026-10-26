<script lang="ts">
  /**
   * Fast duplicate review (FL-61), ported from the design template's `DuplicateReview.jsx`, as
   * duplicate triage (FL-558, the prototype's `DuplicateTriage.jsx`).
   *
   * Two lanes. "Same photo" is one moment saved as different files: the best copy is already chosen,
   * one click or Enter keeps it, and the whole lane can be accepted at once. "Look-alikes" are
   * different moments, bursts and retakes: every photo is on screen, nothing is chosen, and a burst
   * makes Stack the primary action.
   *
   * Every group gets the same fixed-height stage, and the decision bar under it has fixed-width
   * buttons, so Keep stays under the pointer from one group to the next. After a decision the bar
   * ignores clicks for a moment, so a double-click never decides the group that just arrived.
   *
   * Deciding never asks for routine confirmation: the decision runs as a durable job on the server,
   * the group keeps a loader in the queue until the job has answered for it, the next group is already
   * in front, and the decision can be undone — after a reload too — until something changes it. The
   * one exception is a decision that cannot be undone: with the trash switched off, removed copies are
   * deleted for good, and that is confirmed first.
   *
   * Groups are reviewed whole. A search narrows which groups are listed, never which photos of a group
   * are shown, and a group this session cannot see completely — or that holds another account's
   * photo — is listed but cannot be decided.
   *
   * FL-416: identical files are merged by themselves and listed under "Merged for you"
   * (`MergedForYou`), each with Undo; a group of byte-identical files that is here anyway (a merge that
   * was undone, or one the check could not carry over) says so with the "Identical file" badge.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import DuplicateCompare from '$lib/components/frameleaf/DuplicateCompare.svelte';
  import DuplicateContactSheet from '$lib/components/frameleaf/DuplicateContactSheet.svelte';
  import EmptyState from '$lib/components/frameleaf/EmptyState.svelte';
  import MergedForYou from '$lib/components/frameleaf/MergedForYou.svelte';
  import TileJobState from '$lib/components/frameleaf/TileJobState.svelte';
  import {
    buildDecisionGroups,
    canSuggest,
    DUPLICATE_DECISION_GUARD_MS,
    DUPLICATE_FRAME_PAGE_SIZE,
    DUPLICATE_QUEUE_ROW_HEIGHT,
    DuplicateDecisionError,
    filterReviewGroups,
    groupTitle,
    isActionable,
    isBurst,
    isIdenticalGroup,
    laneOf,
    matchReviewShortcut,
    nextGroupId,
    suggestedKeeper,
    toggleKeepers,
    usesContactSheet,
    type GroupProgress,
    type ReviewDecision,
    type ReviewFilter,
    type ReviewGroup,
    type ReviewLane,
  } from '$lib/frameleaf/duplicate-review';
  import { DuplicateReviewSession, type DuplicateReviewGateway } from '$lib/frameleaf/duplicate-review-session.svelte';
  import { motionFade, prefersReducedMotion, reveal } from '$lib/frameleaf/motion';
  import { DURATION } from '$lib/frameleaf/tokens';
  import { locale } from '$lib/stores/preferences.store';
  import { getAssetMediaUrl } from '$lib/utils';
  import { getByteUnitString } from '$lib/utils/byte-units';
  import {
    AssetMediaSize,
    DuplicateGroupBlock,
    MediaOperationBulkAction,
    type DuplicateDecisionHistoryDto,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import {
    mdiCameraBurst,
    mdiCheck,
    mdiCheckAll,
    mdiCheckCircleOutline,
    mdiChevronDown,
    mdiChevronLeft,
    mdiChevronRight,
    mdiContentCopy,
    mdiFilterOffOutline,
    mdiImageMultipleOutline,
    mdiLayersTripleOutline,
    mdiLightningBolt,
    mdiUndo,
  } from '@mdi/js';
  import { onDestroy, tick, untrack } from 'svelte';
  import { t } from 'svelte-i18n';

  type Asset = ReviewGroup['assets'][number];

  /** The stage's bounds, and the room the decision bar takes under it, in pixels. */
  const STAGE_MIN = 540;
  const STAGE_MAX = 720;
  const DOCK_ROOM = 84;

  type Props = {
    /** The review and its decision history as the page loaded them; the session keeps them current. */
    groups: ReviewGroup[];
    history: DuplicateDecisionHistoryDto;
    /** For tests: the endpoints the session calls. */
    gateway?: DuplicateReviewGateway;
    /** With the trash off, removed copies are deleted for good, so that decision is confirmed. */
    trashEnabled: boolean;
    /** Open one photo in the viewer, with the group's other photos to step through. */
    onOpen: (asset: Asset, group: ReviewGroup) => void;
    onOpenTrash: () => void;
    /** True while something else (the viewer) owns the keyboard. */
    keyboardPaused?: boolean;
    /** Opens where duplicate detection is run, for an account that may run it. */
    onRunDetection?: () => void;
  };

  let {
    groups: initialGroups,
    history,
    gateway,
    trashEnabled,
    onOpen,
    onOpenTrash,
    keyboardPaused = false,
    onRunDetection,
  }: Props = $props();

  // the lane with work in it first: copies are quick, so they lead when there are any
  // svelte-ignore state_referenced_locally
  let lane = $state<ReviewLane>(
    initialGroups.some((group) => laneOf(group) === 'same') || initialGroups.length === 0 ? 'same' : 'alike',
  );
  let query = $state('');
  let filter = $state<ReviewFilter>('open');
  let activeId = $state('');
  let keeperIds = $state<string[]>([]);
  let focusedId = $state('');
  let framePage = $state(0);
  let lastChoice: number | null = null;
  let queueOpen = $state(false);
  let shortcutsOpen = $state(false);
  let notice = $state<{ message: string; trash?: boolean } | null>(null);
  let error = $state('');
  let scrollTop = $state(0);
  let viewportHeight = $state(540);
  let list = $state<HTMLDivElement>();
  let heading = $state<HTMLHeadingElement>();
  let focusAfter = false;
  let pendingIrreversible = $state<{ decision: ReviewDecision; targets: ReviewGroup[]; keeperId?: string } | null>(
    null,
  );
  let confirmOpen = $state(false);
  let bulkOpen = $state(false);
  /** True for a moment after a decision brings the next group in: the decision bar ignores clicks. */
  let guarded = $state(false);
  let guardTimer: ReturnType<typeof setTimeout> | undefined;
  let comparison = $state<HTMLElement>();
  /** The stage's height in pixels: what the window leaves below where it starts, above the decision bar. */
  let stageHeight = $state(560);

  // the page's data is the starting point; from here on the session reads the server itself
  // svelte-ignore state_referenced_locally
  const session = new DuplicateReviewSession(
    { groups: initialGroups, history },
    {
      ...(gateway && { gateway }),
      onSettled: ({ action, failed }) => {
        if (action === MediaOperationBulkAction.UndoDuplicates) {
          notice = { message: $t('frameleaf_duplicates_notice_undone') };
        } else if (failed > 0) {
          error = $t('frameleaf_duplicates_error_groups_failed', { values: { count: failed } });
        }
      },
    },
  );
  onDestroy(() => {
    session.destroy();
    clearTimeout(guardTimer);
  });

  /** Each group's state on the page: a running or failed job, or decided in this visit. */
  const progressView = $derived(
    new Map<string, GroupProgress>([
      ...[...session.reviewed.keys()].map((id): [string, GroupProgress] => [id, { state: 'done' }]),
      ...session.progress,
    ]),
  );
  const groups = $derived(filterReviewGroups(session.allGroups, { query, filter, lane, progress: progressView }));
  const active = $derived(groups.find((group) => group.duplicateId === activeId) ?? groups[0]);
  /** The group in front, by id only: a refresh that re-reads the same group must not reset the choice. */
  const activeKey = $derived(active?.duplicateId ?? '');
  const activeProgress = $derived(active ? progressView.get(active.duplicateId) : undefined);
  const actionable = $derived(!!active && isActionable(active, activeProgress));
  const burst = $derived(isBurst(active));
  const contactSheet = $derived(usesContactSheet(active));
  const suggestedId = $derived(active ? suggestedKeeper(active) : null);
  const focused = $derived(active?.assets.find((asset) => asset.id === focusedId) ?? active?.assets[0]);
  const actionableOf = (group: ReviewGroup) => isActionable(group, progressView.get(group.duplicateId));
  const eligible = $derived(groups.filter((group) => actionableOf(group)));
  /** What is left to decide in each lane, for the lane switch. */
  const laneCounts = $derived(
    Object.fromEntries(
      (['same', 'alike'] as const).map((id) => [
        id,
        filterReviewGroups(session.allGroups, { lane: id, progress: progressView }).filter((group) =>
          actionableOf(group),
        ).length,
      ]),
    ) as Record<ReviewLane, number>,
  );
  /** "Keep best copy in all": every same-photo group that has a suggestion and needs no closer look. */
  const bestTargets = $derived(
    lane === 'same' ? eligible.filter((group) => canSuggest(group, progressView.get(group.duplicateId))) : [],
  );
  const bestSummary = $derived.by(() => {
    let removed = 0;
    let bytes = 0;
    for (const group of bestTargets) {
      const keep = suggestedKeeper(group);
      for (const asset of group.assets) {
        if (asset.id !== keep) {
          removed++;
          bytes += asset.exifInfo?.fileSizeInByte ?? 0;
        }
      }
    }
    return { removed, bytes, left: eligible.length - bestTargets.length };
  });
  const reviewed = $derived(session.reviewed.size);
  const currentIndex = $derived(active ? groups.findIndex((group) => group.duplicateId === active.duplicateId) : -1);
  const visibleStart = $derived(Math.max(0, Math.floor(scrollTop / DUPLICATE_QUEUE_ROW_HEIGHT) - 3));
  const visibleEnd = $derived(
    Math.min(groups.length, visibleStart + Math.ceil(viewportHeight / DUPLICATE_QUEUE_ROW_HEIGHT) + 7),
  );
  const undoCount = $derived(session.undoable.length);

  /**
   * What this visit's decisions came to, for the "All reviewed" summary. It counts decisions made
   * here; an undo clears it rather than guessing what the undone job had covered.
   */
  let tally = $state({ kept: 0, removed: 0, bytes: 0 });

  const progressShare = $derived(
    reviewed + eligible.length > 0 ? Math.round((reviewed / (reviewed + eligible.length)) * 100) : 0,
  );

  /**
   * Why nothing is in front (design review finding 75): the search matched no group, every group
   * has been reviewed, or the library has no duplicates at all. Each says what to do next.
   */
  const emptyReason = $derived.by((): 'filtered' | 'reviewed' | 'none' => {
    if (
      query.trim() &&
      filterReviewGroups(session.allGroups, { query: '', filter, lane, progress: progressView }).length > 0
    ) {
      return 'filtered';
    }
    return session.allGroups.length > 0 || reviewed > 0 ? 'reviewed' : 'none';
  });

  let groupElement = $state<HTMLElement>();

  /**
   * Shows, on the group that is leaving, which copies were kept and which were removed. The block
   * is frozen while it leaves, so the marks are put on its cards directly.
   */
  const markDecision = (keptIds: Set<string>) => {
    if (prefersReducedMotion()) {
      return;
    }
    for (const card of groupElement?.querySelectorAll<HTMLElement>('[data-asset-id]') ?? []) {
      card.classList.add(keptIds.has(card.dataset.assetId ?? '') ? 'fl-dr-kept' : 'fl-dr-removed');
    }
  };

  // The fading group is visual only; assistive technology follows the new group immediately.
  const leaveGroup = (node: HTMLElement) => {
    node.setAttribute('aria-hidden', 'true');
    return motionFade(node, { duration: DURATION.slow });
  };

  // a new filter or lane starts at the top of the queue
  $effect(() => {
    void query;
    void filter;
    void lane;
    scrollTop = 0;
    if (list) {
      list.scrollTop = 0;
    }
  });

  $effect(() => {
    if (groups.every((group) => group.duplicateId !== activeId)) {
      activeId = groups[0]?.duplicateId ?? '';
    }
  });

  // A new group in front starts from its suggestion (copies) or from nothing chosen (look-alikes),
  // and takes focus when a decision moved to it.
  $effect(() => {
    void activeKey;
    keeperIds = untrack(() => (suggestedId && actionable ? [suggestedId] : []));
    focusedId = '';
    framePage = 0;
    lastChoice = null;
    if (focusAfter) {
      focusAfter = false;
      void tick().then(() => heading?.focus({ preventScroll: true }));
    }
  });

  // keep the group in front visible in the queue
  $effect(() => {
    const viewport = list;
    if (!viewport || currentIndex < 0 || !viewport.clientHeight) {
      return;
    }
    const top = currentIndex * DUPLICATE_QUEUE_ROW_HEIGHT;
    if (top < viewport.scrollTop) {
      viewport.scrollTop = top;
    } else if (top + DUPLICATE_QUEUE_ROW_HEIGHT > viewport.scrollTop + viewport.clientHeight) {
      viewport.scrollTop = top + DUPLICATE_QUEUE_ROW_HEIGHT - viewport.clientHeight;
    }
    scrollTop = viewport.scrollTop;
  });

  /**
   * Fit the stage to the window from where it starts on the page, so the decision bar sits right under
   * it without scrolling. Measured when the review opens and when the window changes size, never per
   * group, so nothing moves from one group to the next.
   */
  const fitStage = () => {
    if (!comparison) {
      return;
    }
    const top = comparison.getBoundingClientRect().top + window.scrollY;
    stageHeight = Math.round(Math.min(STAGE_MAX, Math.max(STAGE_MIN, window.innerHeight - top - DOCK_ROOM)));
  };

  $effect(() => {
    if (comparison) {
      untrack(fitStage);
      // the page above can settle once web fonts load
      void document.fonts?.ready.then(fitStage);
    }
  });

  /** Hold the decision bar for a moment while the next group arrives under the pointer. */
  const guard = () => {
    guarded = true;
    clearTimeout(guardTimer);
    guardTimer = setTimeout(() => (guarded = false), DUPLICATE_DECISION_GUARD_MS);
  };

  const move = (direction: 1 | -1) => {
    if (!active) {
      return;
    }
    const ids = groups.map((group) => group.duplicateId);
    focusAfter = ids.length > 1;
    activeId = nextGroupId(ids, active.duplicateId, { direction, wrap: true }) ?? active.duplicateId;
  };

  const skip = () => {
    move(1);
    guard();
  };

  const switchLane = (next: ReviewLane) => {
    if (lane !== next) {
      lane = next;
      activeId = '';
      notice = null;
      error = '';
    }
  };

  /** Copies keep exactly one, chosen by click or number; look-alikes toggle any number of keepers. */
  const choose = (index: number, shift = false) => {
    if (!active || !actionable) {
      return;
    }
    if (contactSheet) {
      const ids = active.assets.map((asset) => asset.id);
      keeperIds = toggleKeepers(ids, keeperIds, index, { lastIndex: lastChoice, shift });
      lastChoice = index;
    } else {
      const asset = active.assets.at(index);
      if (asset) {
        keeperIds = [asset.id];
      }
    }
  };

  const removesCopies = (decision: ReviewDecision, targets: ReviewGroup[]) =>
    decision === 'suggested' ||
    decision === 'keeper' ||
    (decision === 'keepers' && targets.some((group) => group.assets.length > keeperIds.length));

  /**
   * Decide now, without a routine confirmation. Only a decision that cannot be undone — copies deleted
   * for good because the trash is off — is confirmed first.
   */
  const decide = (decision: ReviewDecision, targets: ReviewGroup[], keeperId?: string, confirmed = false) => {
    if (targets.length === 0) {
      return;
    }
    if (!trashEnabled && !confirmed && removesCopies(decision, targets)) {
      pendingIrreversible = { decision, targets, keeperId };
      confirmOpen = true;
      return;
    }
    let decisions;
    try {
      decisions = buildDecisionGroups(targets, decision, { keeperId, keeperIds });
    } catch (error_) {
      error = error_ instanceof DuplicateDecisionError ? $t(error_.key) : $t('frameleaf_duplicates_error_submit');
      return;
    }

    const decidedIds = targets.map((group) => group.duplicateId);
    const photos = targets.reduce((count, group) => count + group.assets.length, 0);
    const kept = decisions.reduce((count, group) => count + group.keepAssetIds.length, 0);
    const message =
      decision === 'stack'
        ? $t('frameleaf_duplicates_notice_stacked', { values: { count: targets.length } })
        : decision === 'keep-all'
          ? $t('frameleaf_duplicates_notice_kept_all', { values: { count: targets.length } })
          : trashEnabled
            ? $t('frameleaf_duplicates_notice_kept', { values: { kept, removed: photos - kept } })
            : $t('frameleaf_duplicates_notice_kept_deleted', { values: { kept, removed: photos - kept } });

    const removes = decision !== 'stack' && decision !== 'keep-all';
    if (removes) {
      const keptIds = new Set(decisions.flatMap((group) => group.keepAssetIds));
      const removedBytes = targets
        .flatMap((group) => group.assets)
        .filter((asset) => !keptIds.has(asset.id))
        .reduce((sum, asset) => sum + (asset.exifInfo?.fileSizeInByte ?? 0), 0);
      tally = { kept: tally.kept + kept, removed: tally.removed + photos - kept, bytes: tally.bytes + removedBytes };
      if (active && targets.some((group) => group.duplicateId === active.duplicateId)) {
        markDecision(keptIds);
      }
    }

    // move on at once; the group keeps its loader in the queue until the job has answered for it
    const previous = active?.duplicateId;
    const decided = new Set(decidedIds);
    const ready = groups.filter((group) => actionableOf(group) && !decided.has(group.duplicateId));
    const candidates =
      ready.length > 0 ? groups.filter((group) => actionableOf(group) || group.duplicateId === previous) : groups;
    const order = candidates.map((group) => group.duplicateId);
    activeId =
      nextGroupId(order, previous, { direction: 1, excludeIds: decidedIds, wrap: true }) ??
      ready[0]?.duplicateId ??
      previous ??
      '';
    keeperIds = [];
    focusAfter = true;
    error = '';
    notice = { message, trash: trashEnabled && decision !== 'stack' && decision !== 'keep-all' };
    guard();

    session.decide(decisions).catch(() => {
      notice = null;
      error = $t('frameleaf_duplicates_error_submit');
      if (previous) {
        activeId = previous;
      }
    });
  };

  const undo = async () => {
    try {
      if (await session.undo()) {
        notice = { message: $t('frameleaf_duplicates_notice_undoing') };
        error = '';
        tally = { kept: 0, removed: 0, bytes: 0 };
      }
    } catch {
      error = $t('frameleaf_duplicates_error_undo');
    }
  };

  const confirmIrreversible = () => {
    const pending = pendingIrreversible;
    confirmOpen = false;
    pendingIrreversible = null;
    if (pending) {
      decide(pending.decision, pending.targets, pending.keeperId, true);
    }
  };

  const keepBestEverywhere = () => {
    bulkOpen = false;
    decide('suggested', bestTargets);
  };

  /** The decision bar's actions. While it is held, a click is ignored rather than queued. */
  const dock = (action: () => void) => () => {
    if (!guarded) {
      action();
    }
  };

  const onKeydown = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null;
    if (
      keyboardPaused ||
      event.defaultPrevented ||
      target?.closest?.('input,textarea,select,[contenteditable="true"]') ||
      // DuplicateReview.jsx:223: any open modal, native or ARIA (a menu sheet, a viewer overlay).
      document.querySelector('dialog[open],[role="dialog"]')
    ) {
      return;
    }
    const shortcut = matchReviewShortcut(event);
    if (!shortcut) {
      return;
    }
    // Enter on a focused control is that control's own click, never a second decision.
    if (event.key === 'Enter' && target?.closest?.('button,a,[role="button"],[role="radio"],[role="tab"]')) {
      return;
    }
    switch (shortcut.id) {
      case 'undo': {
        event.preventDefault();
        void undo();
        return;
      }
      case 'help': {
        event.preventDefault();
        shortcutsOpen = !shortcutsOpen;
        return;
      }
      case 'next':
      case 'previous': {
        event.preventDefault();
        move(shortcut.id === 'next' ? 1 : -1);
        return;
      }
      default: {
        // Every other shortcut acts on the active group, below.
        break;
      }
    }
    if (!active || !actionable) {
      return;
    }
    switch (shortcut.id) {
      case 'suggested': {
        if (suggestedId) {
          event.preventDefault();
          decide('suggested', [active]);
        }
        return;
      }
      case 'keep-all': {
        event.preventDefault();
        decide('keep-all', [active]);
        return;
      }
      case 'stack': {
        event.preventDefault();
        decide('stack', [active]);
        return;
      }
      case 'keepers': {
        if (keeperIds.length > 0) {
          event.preventDefault();
          decide('keepers', [active]);
        }
        return;
      }
      case 'digit': {
        const index = (contactSheet ? framePage * DUPLICATE_FRAME_PAGE_SIZE : 0) + shortcut.digit - 1;
        if (index < active.assets.length) {
          event.preventDefault();
          choose(index);
        }
        return;
      }
    }
  };

  const rowStatus = (group: ReviewGroup) => {
    const progress = progressView.get(group.duplicateId);
    if (progress?.state === 'pending') {
      return $t('frameleaf_duplicates_status_processing');
    }
    if (progress?.state === 'done') {
      return $t('frameleaf_duplicates_status_reviewed');
    }
    if (progress?.state === 'failed') {
      return $t(progress.reasonKey);
    }
    if (!group.editable) {
      return group.blockedReason === DuplicateGroupBlock.OtherOwner
        ? $t('frameleaf_duplicates_status_other_owner')
        : $t('frameleaf_duplicates_status_hidden');
    }
    return $t('frameleaf_duplicates_status_ready');
  };

  const countLabel = (group: ReviewGroup) =>
    laneOf(group) === 'same'
      ? $t('frameleaf_duplicates_copies', { values: { count: group.assets.length } })
      : isBurst(group)
        ? $t('frameleaf_duplicates_frames', { values: { count: group.assets.length } })
        : $t('frameleaf_duplicates_photos', { values: { count: group.assets.length } });

  const removedCount = $derived(active ? active.assets.length - keeperIds.length : 0);
  const keepLabel = $derived.by(() => {
    if (keeperIds.length === 0) {
      return contactSheet ? $t('frameleaf_duplicates_dock_choose_photos') : $t('frameleaf_duplicates_dock_choose_copy');
    }
    if (removedCount === 0) {
      return $t('frameleaf_duplicates_dock_keep_every', { values: { count: keeperIds.length } });
    }
    return $t(trashEnabled ? 'frameleaf_duplicates_dock_keep_trash' : 'frameleaf_duplicates_dock_keep_delete', {
      values: { kept: keeperIds.length, removed: removedCount },
    });
  });

  const thumb = (asset: Asset | undefined) =>
    asset ? getAssetMediaUrl({ id: asset.id, size: AssetMediaSize.Thumbnail, cacheKey: asset.thumbhash }) : '';
</script>

<svelte:window onkeydown={onKeydown} onresize={fitStage} />

<section
  class="fl-duplicate-review"
  aria-label={$t('frameleaf_duplicates_region')}
  data-testid="frameleaf-duplicate-review"
>
  <div class="fl-dr-top">
    <div class="fl-dr-lanes" role="tablist" aria-label={$t('frameleaf_duplicates_lanes_label')}>
      {#each [{ id: 'same', icon: mdiContentCopy }, { id: 'alike', icon: mdiImageMultipleOutline }] as const as item (item.id)}
        <button
          type="button"
          role="tab"
          aria-selected={lane === item.id}
          data-testid="frameleaf-duplicate-lane-{item.id}"
          onclick={() => switchLane(item.id)}
        >
          <Icon icon={item.icon} size="16" aria-hidden={true} />
          {item.id === 'same' ? $t('frameleaf_duplicates_lane_same') : $t('frameleaf_duplicates_lane_alike')}
          <span>{laneCounts[item.id].toLocaleString($locale)}</span>
        </button>
      {/each}
    </div>
    <div class="fl-dr-progress-block">
      <div
        class="fl-dr-progress"
        role="progressbar"
        aria-label={$t('frameleaf_duplicates_progress_label')}
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow={progressShare}
      >
        <span style:width="{progressShare}%"></span>
      </div>
      <small>{$t('frameleaf_duplicates_progress', { values: { reviewed, ready: eligible.length } })}</small>
    </div>
    <input
      type="search"
      bind:value={query}
      aria-label={$t('frameleaf_duplicates_find')}
      placeholder={$t('frameleaf_duplicates_find_placeholder')}
    />
    <select bind:value={filter} aria-label={$t('frameleaf_duplicates_show')}>
      <option value="open">{$t('frameleaf_duplicates_show_open')}</option>
      <option value="all">{$t('frameleaf_duplicates_show_all')}</option>
    </select>
  </div>
  <div class="fl-dr-intro">
    <p>
      {lane === 'same' ? $t('frameleaf_duplicates_lane_same_intro') : $t('frameleaf_duplicates_lane_alike_intro')}
    </p>
    {#if bestTargets.length > 0}
      <Button onclick={() => (bulkOpen = true)}>
        <Icon icon={mdiLightningBolt} size="16" aria-hidden={true} />
        {$t('frameleaf_duplicates_keep_best_all', { values: { count: bestTargets.length } })}
      </Button>
    {/if}
  </div>

  <div class="fl-dr-workspace" style:--fl-dr-stage="{stageHeight}px">
    <aside class="fl-dr-queue" class:open={queueOpen} aria-label={$t('frameleaf_duplicates_queue')}>
      <button
        type="button"
        class="fl-dr-queue-toggle"
        aria-expanded={queueOpen}
        onclick={() => (queueOpen = !queueOpen)}
      >
        {$t('frameleaf_duplicates_queue_toggle', { values: { count: groups.length } })}
        <Icon icon={mdiChevronDown} size="16" aria-hidden={true} />
      </button>
      <header>
        <strong>{$t('frameleaf_duplicates_queue')}</strong>
        <span>{groups.length.toLocaleString($locale)}</span>
      </header>
      <div
        class="fl-dr-queue-scroll"
        bind:this={list}
        bind:clientHeight={viewportHeight}
        onscroll={(event) => (scrollTop = event.currentTarget.scrollTop)}
      >
        <div style:height="{groups.length * DUPLICATE_QUEUE_ROW_HEIGHT}px" style:position="relative">
          {#each groups.slice(visibleStart, visibleEnd) as group, offset (group.duplicateId)}
            {@const progress = progressView.get(group.duplicateId)}
            <div
              class="fl-dr-queue-row"
              class:active={active?.duplicateId === group.duplicateId}
              style:top="{(visibleStart + offset) * DUPLICATE_QUEUE_ROW_HEIGHT}px"
            >
              <button
                type="button"
                aria-current={active?.duplicateId === group.duplicateId ? 'true' : undefined}
                onclick={() => (activeId = group.duplicateId)}
              >
                <span class="fl-dr-queue-thumb">
                  <img src={thumb(group.assets[0])} alt="" loading="lazy" />
                  {#if progress && progress.state !== 'done'}
                    <span class="fl-dr-queue-job"><TileJobState job={progress} label={rowStatus(group)} /></span>
                  {/if}
                </span>
                <span class="fl-dr-queue-text">
                  <strong>{groupTitle(group)}</strong>
                  <small>{countLabel(group)} · {rowStatus(group)}</small>
                </span>
              </button>
            </div>
          {/each}
        </div>
        {#if groups.length === 0}
          <p>{$t('frameleaf_duplicates_no_matching')}</p>
        {/if}
      </div>
    </aside>

    <div class="fl-dr-main">
      <!--
        The stage has one fixed height for every group, so the decision bar under it never moves. A
        decision moves the resolved group away and brings the next one in as a short crossfade, so a
        fast session can see each decision register; a crossfade only under Reduce Motion.
      -->
      <div class="fl-dr-comparison" bind:this={comparison}>
        {#key activeKey}
          <div class="fl-dr-group" bind:this={groupElement} in:reveal={{ delay: DURATION.fast / 2 }} out:leaveGroup>
            {#if active && focused}
              <div class="fl-dr-heading">
                <div>
                  <h2 bind:this={heading} tabindex="-1">{groupTitle(active)}</h2>
                  <p>
                    {$t('frameleaf_duplicates_group_position', {
                      values: { index: currentIndex + 1, total: groups.length },
                    })} ·
                    {countLabel(active)} ·
                    {$t('frameleaf_duplicates_in_originals', {
                      values: { size: getByteUnitString(active.totalBytes, $locale) },
                    })}
                  </p>
                </div>
                {#if burst}
                  <span class="fl-dr-burst-chip">
                    <Icon icon={mdiCameraBurst} size="16" aria-hidden={true} />
                    {$t('frameleaf_duplicates_burst_detected')}
                  </span>
                {/if}
                <div class="fl-dr-heading-nav">
                  <Button
                    label={$t('frameleaf_duplicates_previous_group')}
                    disabled={groups.length < 2}
                    onclick={() => move(-1)}
                  >
                    <Icon icon={mdiChevronLeft} size="18" aria-hidden={true} />
                  </Button>
                  <Button
                    label={$t('frameleaf_duplicates_next_group')}
                    disabled={groups.length < 2}
                    onclick={() => move(1)}
                  >
                    <Icon icon={mdiChevronRight} size="18" aria-hidden={true} />
                  </Button>
                </div>
              </div>

              {#if !active.editable}
                <p class="fl-dr-access">
                  {active.blockedReason === DuplicateGroupBlock.OtherOwner
                    ? active.otherOwnerNames?.length
                      ? // DuplicateReview.jsx:493-497: "Only A and B can decide what to keep in this group."
                        $t('frameleaf_duplicates_blocked_owners', {
                          values: {
                            owners: new Intl.ListFormat($locale, { type: 'conjunction' }).format(
                              active.otherOwnerNames,
                            ),
                          },
                        })
                      : $t('frameleaf_duplicates_blocked_other_owner')
                    : $t('frameleaf_duplicates_blocked_hidden', { values: { count: active.hiddenMemberCount } })}
                </p>
              {:else if activeProgress?.state === 'pending'}
                <p class="fl-dr-access" role="status">{$t('frameleaf_duplicates_processing_group')}</p>
              {:else if activeProgress?.state === 'failed'}
                <p class="fl-dr-access error" role="alert">{$t(activeProgress.reasonKey)}</p>
              {:else if isIdenticalGroup(active)}
                <p class="fl-dr-access" role="note">
                  <strong class="fl-dr-identical-badge">{$t('frameleaf_duplicates_identical_badge')}</strong>
                  {$t('frameleaf_duplicates_identical_body')}
                </p>
              {:else if active.reviewRequiredReasons?.length}
                <p class="fl-dr-access" role="status">{$t('frameleaf_duplicates_protected_content')}</p>
              {/if}

              <div class="fl-dr-body">
                {#if contactSheet}
                  <DuplicateContactSheet
                    group={active}
                    {actionable}
                    {keeperIds}
                    {focused}
                    {framePage}
                    onToggle={choose}
                    onFocus={(asset) => (focusedId = asset.id)}
                    onSelectAll={() => (keeperIds = active.assets.map((asset) => asset.id))}
                    onClear={() => (keeperIds = [])}
                    onOpen={(asset) => onOpen(asset, active)}
                    onPage={(page) => (framePage = page)}
                  />
                {:else}
                  <DuplicateCompare
                    group={active}
                    {actionable}
                    {suggestedId}
                    {keeperIds}
                    {trashEnabled}
                    onChoose={(index) => choose(index)}
                    onOpen={(asset) => onOpen(asset, active)}
                  />
                {/if}
              </div>
            {:else if emptyReason === 'filtered'}
              <EmptyState
                icon={mdiFilterOffOutline}
                title={$t('frameleaf_duplicates_empty_filtered')}
                message={$t('frameleaf_duplicates_empty_filtered_body')}
                action={{ label: $t('frameleaf_duplicates_clear_filters'), onClick: () => (query = '') }}
              />
            {:else if emptyReason === 'none'}
              <EmptyState
                icon={mdiImageMultipleOutline}
                title={$t('frameleaf_duplicates_empty_none')}
                message={$t('frameleaf_duplicates_empty_none_body')}
                action={onRunDetection
                  ? { label: $t('frameleaf_duplicates_run_detection'), onClick: onRunDetection }
                  : undefined}
              />
            {:else}
              <div class="fl-dr-done">
                <Icon icon={mdiCheckCircleOutline} size="36" aria-hidden={true} />
                <h2 bind:this={heading} tabindex="-1">
                  {lane === 'same'
                    ? $t('frameleaf_duplicates_lane_same_done')
                    : $t('frameleaf_duplicates_all_reviewed')}
                </h2>
                <p>
                  {#if tally.kept + tally.removed > 0}
                    {$t(
                      trashEnabled
                        ? 'frameleaf_duplicates_all_reviewed_tally'
                        : 'frameleaf_duplicates_all_reviewed_tally_deleted',
                      {
                        values: { kept: tally.kept, removed: tally.removed },
                      },
                    )}
                    {#if tally.bytes > 0}
                      {$t('frameleaf_duplicates_all_reviewed_space', {
                        values: { size: getByteUnitString(tally.bytes, $locale) },
                      })}
                    {/if}
                  {:else}
                    {$t('frameleaf_duplicates_all_reviewed_body')}
                  {/if}
                </p>
                <div class="fl-dr-done-actions">
                  {#if lane === 'same' && laneCounts.alike > 0}
                    <Button variant="primary" onclick={() => switchLane('alike')}>
                      {$t('frameleaf_duplicates_review_alike', { values: { count: laneCounts.alike } })}
                    </Button>
                  {/if}
                  {#if filter === 'open' && reviewed > 0}
                    <Button variant="quiet" onclick={() => (filter = 'all')}
                      >{$t('frameleaf_duplicates_show_all')}</Button
                    >
                  {/if}
                </div>
              </div>
            {/if}
          </div>
        {/key}
      </div>

      <div class="fl-dr-dock" class:guarded aria-label={$t('frameleaf_duplicates_decision_bar')} role="group">
        <div class="fl-dr-dock-status" role={error ? 'alert' : 'status'} class:error={!!error}>
          {#if error || notice}
            <span title={error || notice?.message}>{error || notice?.message}</span>
            {#if !error && undoCount > 0}
              <button type="button" disabled={session.undoing} onclick={() => void undo()}>
                {session.undoing ? $t('frameleaf_duplicates_undoing') : $t('frameleaf_duplicates_undo')}
              </button>
            {/if}
            {#if !error && notice?.trash}
              <button type="button" onclick={onOpenTrash}>{$t('frameleaf_duplicates_view_trash')}</button>
            {/if}
          {:else if undoCount > 0}
            <button type="button" disabled={session.undoing} onclick={() => void undo()}>
              <Icon icon={mdiUndo} size="14" aria-hidden={true} />
              {$t('frameleaf_duplicates_undo_count', { values: { count: undoCount } })}
            </button>
          {/if}
        </div>
        <div class="fl-dr-dock-actions">
          <button
            type="button"
            class="fl-dr-act keep"
            class:primary={!burst}
            data-testid="frameleaf-duplicate-keep"
            disabled={!actionable || keeperIds.length === 0}
            onclick={dock(() => active && decide('keepers', [active]))}
          >
            <Icon icon={mdiCheck} size="18" aria-hidden={true} />
            <span>{keepLabel}</span>
            <kbd>↵</kbd>
          </button>
          <button
            type="button"
            class="fl-dr-act"
            class:primary={burst}
            disabled={!actionable}
            onclick={dock(() => active && decide('stack', [active]))}
          >
            <Icon icon={mdiLayersTripleOutline} size="18" aria-hidden={true} />
            <span>{burst ? $t('frameleaf_duplicates_dock_stack_burst') : $t('frameleaf_duplicates_stack')}</span>
            <kbd>S</kbd>
          </button>
          <button
            type="button"
            class="fl-dr-act"
            disabled={!actionable}
            onclick={dock(() => active && decide('keep-all', [active]))}
          >
            <Icon icon={mdiCheckAll} size="18" aria-hidden={true} />
            <span>{$t('frameleaf_duplicates_not_duplicates')}</span>
            <kbd>A</kbd>
          </button>
          <button type="button" class="fl-dr-act quiet" disabled={groups.length < 2} onclick={dock(skip)}>
            <span>{$t('frameleaf_duplicates_skip')}</span>
            <kbd>→</kbd>
          </button>
        </div>
      </div>

      <div class="fl-dr-footer">
        <p>
          {lane === 'same' ? $t('frameleaf_duplicates_footnote_copies') : $t('frameleaf_duplicates_footnote_burst')}
          {trashEnabled ? $t('frameleaf_duplicates_footnote_storage') : $t('frameleaf_duplicates_footnote_no_trash')}
        </p>
        <Button variant="quiet" pressed={shortcutsOpen} onclick={() => (shortcutsOpen = !shortcutsOpen)}>
          {$t('frameleaf_duplicates_shortcuts')} <kbd>?</kbd>
        </Button>
      </div>
      {#if shortcutsOpen}
        <div class="fl-dr-shortcuts" aria-label={$t('frameleaf_duplicates_shortcuts')}>
          <span>
            <kbd>1–9</kbd>
            {$t(
              contactSheet
                ? 'frameleaf_duplicates_shortcut_select_keepers'
                : 'frameleaf_duplicates_shortcut_choose_copy',
            )}
          </span>
          <span><kbd>↵</kbd> {$t('frameleaf_duplicates_shortcut_keep_chosen')}</span>
          <span><kbd>K</kbd> {$t('frameleaf_duplicates_keep_suggested')}</span>
          <span><kbd>A</kbd> {$t('frameleaf_duplicates_not_duplicates')}</span>
          <span><kbd>S</kbd> {$t('frameleaf_duplicates_stack')}</span>
          <span><kbd>← →</kbd> {$t('frameleaf_duplicates_shortcut_move')}</span>
          <span><kbd>⌘ / Ctrl Z</kbd> {$t('frameleaf_duplicates_undo')}</span>
        </div>
      {/if}
    </div>
  </div>
</section>

<MergedForYou
  recent={session.history.recent}
  undoing={session.undoing}
  onUndoMerge={(batch, duplicateId) => session.undoGroup(batch, duplicateId)}
/>

<Dialog
  bind:open={bulkOpen}
  title={$t('frameleaf_duplicates_keep_best_all_title', { values: { count: bestTargets.length } })}
  closeLabel={$t('frameleaf_duplicates_cancel')}
>
  <p class="fl-dr-confirm">
    {$t(
      trashEnabled ? 'frameleaf_duplicates_keep_best_all_body_trash' : 'frameleaf_duplicates_keep_best_all_body_delete',
      {
        values: { removed: bestSummary.removed, size: getByteUnitString(bestSummary.bytes, $locale) },
      },
    )}
    {#if bestSummary.left > 0}
      {$t('frameleaf_duplicates_keep_best_all_left', { values: { count: bestSummary.left } })}
    {/if}
  </p>
  <div class="fl-dr-confirm-actions">
    <Button onclick={() => (bulkOpen = false)}>{$t('frameleaf_duplicates_cancel')}</Button>
    <Button variant="primary" initialFocus onclick={keepBestEverywhere}>
      {$t('frameleaf_duplicates_keep_best_all_confirm', { values: { count: bestTargets.length } })}
    </Button>
  </div>
</Dialog>

<Dialog
  bind:open={confirmOpen}
  title={$t('frameleaf_duplicates_confirm_delete_title')}
  closeLabel={$t('frameleaf_duplicates_cancel')}
>
  <p class="fl-dr-confirm">{$t('frameleaf_duplicates_confirm_delete_body')}</p>
  <div class="fl-dr-confirm-actions">
    <Button onclick={() => (confirmOpen = false)}>{$t('frameleaf_duplicates_cancel')}</Button>
    <!-- A bounded, irreversible action: a clear summary and a danger button, as in Trash (finding 74). -->
    <Button variant="danger" onclick={confirmIrreversible}>{$t('frameleaf_duplicates_confirm_delete')}</Button>
  </div>
</Dialog>

<style>
  .fl-duplicate-review {
    display: grid;
    gap: 14px;
    min-width: 0;
    color: var(--fl-text);
  }
  .fl-dr-top {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px 24px;
  }
  .fl-dr-lanes {
    display: inline-flex;
    padding: 3px;
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .fl-dr-lanes button {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 7px 14px;
    font: inherit;
    font-weight: 600;
    color: var(--fl-muted);
    background: none;
    border: 0;
    border-radius: calc(var(--fl-radius-control) - 2px);
  }
  .fl-dr-lanes button[aria-selected='true'] {
    color: var(--fl-text);
    background: var(--fl-panel);
    box-shadow: 0 1px 3px rgb(0 0 0 / 0.2);
  }
  .fl-dr-lanes button span {
    padding: 1px 8px;
    font-size: var(--fl-font-micro);
    font-variant-numeric: tabular-nums;
    background: color-mix(in srgb, var(--fl-text) 10%, transparent);
    border-radius: var(--fl-radius-pill);
  }
  .fl-dr-progress-block {
    display: grid;
    flex: 1;
    gap: 5px;
    min-width: 200px;
    max-width: 360px;
  }
  .fl-dr-progress-block small {
    font-size: var(--fl-font-micro);
    color: var(--fl-muted);
  }
  .fl-dr-top input,
  .fl-dr-top select {
    min-width: 160px;
    padding: 7px var(--fl-space-3);
    font-size: var(--fl-font-size);
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .fl-dr-top input {
    margin-inline-start: auto;
  }
  /* One line whatever the lane, so switching lanes never moves the stage. */
  .fl-dr-intro {
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 44px;
  }
  .fl-dr-intro p {
    flex: 1;
    margin: 0;
    overflow: hidden;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  kbd {
    margin-inline-start: 5px;
    font-size: var(--fl-font-micro);
    opacity: 0.65;
  }
  .fl-dr-workspace {
    display: grid;
    grid-template-columns: 220px minmax(0, 1fr);
    gap: 22px;
  }
  .fl-dr-queue {
    position: sticky;
    top: 16px;
    align-self: start;
    min-width: 0;
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .fl-dr-queue > header {
    display: flex;
    justify-content: space-between;
    padding: 13px;
    font-size: var(--fl-font-micro);
    color: var(--fl-muted);
    border-bottom: 1px solid var(--fl-border);
  }
  .fl-dr-queue > header strong {
    font-weight: 500;
  }
  .fl-dr-queue-toggle {
    display: none;
  }
  .fl-dr-queue-scroll {
    height: var(--fl-dr-stage);
    overflow: auto;
    scrollbar-width: thin;
  }
  .fl-dr-queue-scroll > p {
    padding: 16px;
    color: var(--fl-muted);
  }
  .fl-dr-queue-row {
    position: absolute;
    right: 0;
    left: 0;
    display: flex;
    align-items: center;
    height: 68px;
    padding: 0 var(--fl-space-3);
    border-bottom: 1px solid var(--fl-border);
  }
  .fl-dr-queue-row.active {
    background: color-mix(in srgb, var(--fl-accent) 9%, var(--fl-panel));
    box-shadow: inset 2px 0 var(--fl-accent);
  }
  .fl-dr-queue-row button {
    display: flex;
    flex: 1;
    align-items: center;
    gap: 8px;
    min-width: 0;
    padding: 6px 0;
    color: var(--fl-text);
    text-align: start;
    background: none;
    border: 0;
  }
  .fl-dr-queue-thumb {
    position: relative;
    flex-shrink: 0;
  }
  .fl-dr-queue-thumb img {
    width: 40px;
    height: 42px;
    object-fit: cover;
    border-radius: var(--fl-radius);
  }
  .fl-dr-queue-job {
    position: absolute;
    top: -6px;
    right: -6px;
  }
  .fl-dr-queue-text {
    min-width: 0;
  }
  .fl-dr-queue-text strong {
    display: block;
    overflow: hidden;
    font-size: var(--fl-font-micro);
    font-weight: 500;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .fl-dr-queue-text small {
    display: block;
    margin-top: 5px;
    font-size: var(--fl-font-micro);
    color: var(--fl-muted);
  }
  /*
   * One stage height for every group (FL-558): the decision bar under it stays put from group to
   * group. It follows the window, so the bar is on screen without scrolling.
   */
  .fl-dr-main {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 12px;
    min-width: 0;
    container-type: inline-size;
  }
  /* The leaving group and the arriving one share one cell while they cross. */
  .fl-dr-comparison {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    min-width: 0;
  }
  .fl-dr-group {
    grid-area: 1 / 1;
    display: grid;
    grid-template-rows: auto auto minmax(0, 1fr);
    grid-template-columns: minmax(0, 1fr);
    height: var(--fl-dr-stage);
    min-width: 0;
    overflow: hidden;
  }
  .fl-dr-body {
    display: grid;
    grid-row: 3;
    min-height: 0;
  }
  /* Marks put on the leaving group's cards by `markDecision`. */
  .fl-dr-group :global(.fl-dr-removed) {
    opacity: 0;
    transform: scale(0.96);
    transition:
      opacity var(--fl-motion) var(--fl-ease),
      transform var(--fl-motion) var(--fl-ease);
  }
  .fl-dr-group :global(.fl-dr-kept) {
    outline: var(--fl-focus-ring);
    outline-offset: var(--fl-focus-offset);
  }
  .fl-dr-progress {
    height: 4px;
    overflow: hidden;
    background: var(--fl-raised);
    border-radius: var(--fl-radius-pill);
  }
  .fl-dr-progress span {
    display: block;
    height: 100%;
    background: var(--fl-accent);
    border-radius: inherit;
    transition: width var(--fl-duration) var(--fl-snappy);
  }
  .fl-dr-heading {
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 44px;
    margin-bottom: 10px;
  }
  .fl-dr-heading > div:first-child {
    flex: 1;
    min-width: 0;
  }
  .fl-dr-heading h2 {
    margin: 0 0 4px;
    overflow: hidden;
    font-size: 17px;
    font-weight: 600;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .fl-dr-heading p {
    margin: 0;
    font-size: var(--fl-font-micro);
    color: var(--fl-muted);
  }
  .fl-dr-heading-nav {
    display: flex;
    gap: var(--fl-space-2);
  }
  .fl-dr-burst-chip {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    font-size: var(--fl-font-small);
    font-weight: 600;
    background: color-mix(in srgb, var(--fl-accent) 18%, transparent);
    border-radius: var(--fl-radius-pill);
  }
  .fl-dr-access {
    padding: 8px 12px;
    margin: 0 0 10px;
    font-size: var(--fl-font-small);
    background: var(--fl-panel);
    border-inline-start: 2px solid var(--fl-muted);
  }
  .fl-dr-access.error {
    border-color: var(--fl-warning);
  }
  .fl-dr-identical-badge {
    margin-inline-end: 6px;
    font-weight: 600;
  }
  /*
   * The decision bar: fixed-width buttons, right-aligned, status text in what is left. It sticks to
   * the bottom of the window, so it is on screen without scrolling; the stage never changes height,
   * so the bar is in the same place for every group at any scroll position.
   */
  .fl-dr-dock {
    position: sticky;
    bottom: 0;
    z-index: 2;
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 760px);
    align-items: center;
    gap: 16px;
    padding: 12px 0;
    background: var(--fl-canvas);
    border-top: 1px solid var(--fl-border);
  }
  .fl-dr-dock-status {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
    min-height: 32px;
    font-size: var(--fl-font-small);
  }
  .fl-dr-dock-status > span {
    overflow: hidden;
    color: var(--fl-muted);
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .fl-dr-dock-status.error > span {
    color: var(--fl-warning);
  }
  .fl-dr-dock-status button {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    gap: 4px;
    padding: 4px 10px;
    font: inherit;
    color: var(--fl-text);
    background: color-mix(in srgb, var(--fl-text) 10%, transparent);
    border: 0;
    border-radius: var(--fl-radius-pill);
  }
  /* Each button is a fixed share of the bar: its place depends on the window, never on the group. */
  .fl-dr-dock-actions {
    display: grid;
    grid-template-columns: 1.32fr 1fr 1fr 0.6fr;
    gap: 8px;
  }
  .fl-dr-act {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    min-width: 0;
    height: 46px;
    padding: 0 10px;
    font: inherit;
    font-weight: 600;
    color: var(--fl-text);
    white-space: nowrap;
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .fl-dr-act span {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .fl-dr-act.quiet {
    background: none;
  }
  .fl-dr-act.primary {
    color: var(--fl-canvas);
    background: var(--fl-accent);
    border-color: var(--fl-accent);
  }
  .fl-dr-act:disabled {
    cursor: default;
    opacity: 0.45;
  }
  .fl-dr-act kbd {
    padding: 0 6px;
    margin: 0;
    background: color-mix(in srgb, currentColor 14%, transparent);
    border-radius: var(--fl-radius);
    opacity: 1;
  }
  .fl-dr-dock.guarded .fl-dr-act {
    pointer-events: none;
  }
  /* A narrow column puts the status line above the buttons, so the two never overlap. */
  @container (max-width: 980px) {
    .fl-dr-dock {
      grid-template-columns: minmax(0, 1fr);
      gap: 8px;
    }
  }
  @container (max-width: 640px) {
    .fl-dr-act kbd {
      display: none;
    }
  }
  .fl-dr-footer {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .fl-dr-footer p {
    flex: 1;
    margin: 0;
    font-size: var(--fl-font-micro);
    color: var(--fl-muted);
  }
  .fl-dr-shortcuts {
    display: flex;
    flex-wrap: wrap;
    gap: 12px 20px;
    padding: 13px;
    font-size: var(--fl-font-micro);
    color: var(--fl-muted);
    border-top: 1px solid var(--fl-border);
  }
  .fl-dr-shortcuts kbd {
    display: inline-block;
    min-width: 22px;
    padding: 3px;
    margin-inline: 0 5px;
    color: var(--fl-text);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    opacity: 1;
  }
  .fl-dr-done {
    align-self: center;
    padding: 40px 25px;
    color: var(--fl-muted);
    text-align: center;
  }
  .fl-dr-done :global(svg) {
    color: var(--fl-accent);
  }
  .fl-dr-done h2 {
    margin-top: 18px;
    color: var(--fl-text);
  }
  .fl-dr-done-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: var(--fl-space-2);
    margin-top: var(--fl-space-4);
  }
  .fl-dr-confirm {
    margin: 0 0 16px;
  }
  .fl-dr-confirm-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  @media (max-width: 1100px) {
    .fl-dr-workspace {
      grid-template-columns: 1fr;
    }
    .fl-dr-queue {
      position: static;
    }
    .fl-dr-queue > header {
      display: none;
    }
    .fl-dr-queue-toggle {
      display: flex;
      justify-content: space-between;
      width: 100%;
      padding: 12px 13px;
      color: var(--fl-text);
      background: none;
      border: 0;
    }
    .fl-dr-queue:not(.open) .fl-dr-queue-scroll {
      display: none;
    }
    .fl-dr-queue-scroll {
      height: 240px;
    }
  }
  @media (max-width: 700px) {
    .fl-dr-top input,
    .fl-dr-top select {
      flex: 1;
      min-width: 0;
      margin: 0;
    }
    .fl-dr-group {
      height: auto;
      min-height: 420px;
    }
    .fl-dr-shortcuts,
    kbd {
      display: none;
    }
  }
</style>
