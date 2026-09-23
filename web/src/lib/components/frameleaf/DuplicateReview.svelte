<script lang="ts">
  /**
   * Fast duplicate review (FL-61), ported from the design template's `DuplicateReview.jsx`.
   *
   * One queue, one group in front, one decision per keystroke. Deciding never asks for routine
   * confirmation: the decision runs as a durable job on the server, the group keeps a loader in the
   * queue until the job has answered for it, the next group is already in front, and the decision can
   * be undone — after a reload too — until something changes it. The one exception is a decision that
   * cannot be undone: with the trash switched off, removed copies are deleted for good, and that is
   * confirmed first.
   *
   * Groups are reviewed whole. A search narrows which groups are listed, never which photos of a group
   * are shown, and a group this session cannot see completely — or that holds another account's
   * photo — is listed but cannot be decided.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import DuplicateCompare from '$lib/components/frameleaf/DuplicateCompare.svelte';
  import DuplicateContactSheet from '$lib/components/frameleaf/DuplicateContactSheet.svelte';
  import TileJobState from '$lib/components/frameleaf/TileJobState.svelte';
  import {
    buildDecisionGroups,
    canSuggest,
    DUPLICATE_FRAME_PAGE_SIZE,
    DUPLICATE_QUEUE_ROW_HEIGHT,
    DuplicateDecisionError,
    filterReviewGroups,
    groupTitle,
    isActionable,
    isBurst,
    matchReviewShortcut,
    nextGroupId,
    suggestedKeeper,
    toggleKeepers,
    usesContactSheet,
    type GroupProgress,
    type ReviewDecision,
    type ReviewFilter,
    type ReviewGroup,
  } from '$lib/frameleaf/duplicate-review';
  import { DuplicateReviewSession, type DuplicateReviewGateway } from '$lib/frameleaf/duplicate-review-session.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import { getAssetMediaUrl } from '$lib/utils';
  import { getByteUnitString } from '$lib/utils/byte-units';
  import {
    AssetMediaSize,
    DuplicateGroupBlock,
    MediaOperationBulkAction,
    type DuplicateDecisionHistoryDto,
  } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import {
    mdiAlertCircleOutline,
    mdiCheckCircleOutline,
    mdiChevronDown,
    mdiChevronLeft,
    mdiChevronRight,
    mdiClose,
    mdiUndo,
  } from '@mdi/js';
  import { onDestroy, tick } from 'svelte';
  import { t } from 'svelte-i18n';

  type Asset = ReviewGroup['assets'][number];

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
  };

  let {
    groups: initialGroups,
    history,
    gateway,
    trashEnabled,
    onOpen,
    onOpenTrash,
    keyboardPaused = false,
  }: Props = $props();

  let query = $state('');
  let filter = $state<ReviewFilter>('open');
  let activeId = $state('');
  let selected = $state<string[]>([]);
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
  onDestroy(() => session.destroy());

  /** Each group's state on the page: a running or failed job, or decided in this visit. */
  const progressView = $derived(
    new Map<string, GroupProgress>([
      ...[...session.reviewed.keys()].map((id): [string, GroupProgress] => [id, { state: 'done' }]),
      ...session.progress,
    ]),
  );
  const groups = $derived(filterReviewGroups(session.allGroups, { query, filter, progress: progressView }));
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
  const selectedGroups = $derived(
    groups.filter((group) => selected.includes(group.duplicateId) && actionableOf(group)),
  );
  const recommended = $derived(
    selectedGroups.filter((group) => canSuggest(group, progressView.get(group.duplicateId))),
  );
  const reviewed = $derived(session.reviewed.size);
  const currentIndex = $derived(active ? groups.findIndex((group) => group.duplicateId === active.duplicateId) : -1);
  const visibleStart = $derived(Math.max(0, Math.floor(scrollTop / DUPLICATE_QUEUE_ROW_HEIGHT) - 3));
  const visibleEnd = $derived(
    Math.min(groups.length, visibleStart + Math.ceil(viewportHeight / DUPLICATE_QUEUE_ROW_HEIGHT) + 7),
  );
  const undoCount = $derived(session.undoable.length);
  const allEligibleSelected = $derived(
    eligible.length > 0 && eligible.every((group) => selected.includes(group.duplicateId)),
  );

  // a new filter starts a new selection at the top of the queue
  $effect(() => {
    void query;
    void filter;
    selected = [];
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

  // a new group in front starts with nothing chosen, and takes focus when a decision moved to it
  $effect(() => {
    void activeKey;
    keeperIds = [];
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

  const move = (direction: 1 | -1) => {
    if (!active) {
      return;
    }
    const ids = groups.map((group) => group.duplicateId);
    activeId = nextGroupId(ids, active.duplicateId, { direction, wrap: true }) ?? active.duplicateId;
  };

  const toggleKeeper = (index: number, shift: boolean) => {
    if (!active || !actionable) {
      return;
    }
    const ids = active.assets.map((asset) => asset.id);
    keeperIds = toggleKeepers(ids, keeperIds, index, { lastIndex: lastChoice, shift });
    lastChoice = index;
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

    // move on at once; the group keeps its loader in the queue until the job has answered for it
    const previous = active?.duplicateId;
    const ready = groups.filter((group) => actionableOf(group) && !decidedIds.includes(group.duplicateId));
    const candidates =
      ready.length > 0 ? groups.filter((group) => actionableOf(group) || group.duplicateId === previous) : groups;
    const order = candidates.map((group) => group.duplicateId);
    activeId =
      nextGroupId(order, previous, { direction: 1, excludeIds: decidedIds, wrap: true }) ??
      ready[0]?.duplicateId ??
      previous ??
      '';
    selected = selected.filter((id) => !decidedIds.includes(id));
    keeperIds = [];
    focusAfter = true;
    error = '';
    notice = { message, trash: trashEnabled && decision !== 'stack' && decision !== 'keep-all' };

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

  const onKeydown = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null;
    if (
      keyboardPaused ||
      event.defaultPrevented ||
      target?.closest?.('input,textarea,select,[contenteditable="true"]') ||
      document.querySelector('dialog[open]')
    ) {
      return;
    }
    const shortcut = matchReviewShortcut(event);
    if (!shortcut) {
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
        if (suggestedId && !burst) {
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
        if (contactSheet && keeperIds.length > 0) {
          event.preventDefault();
          decide('keepers', [active]);
        }
        return;
      }
      case 'digit': {
        const index = (contactSheet ? framePage * DUPLICATE_FRAME_PAGE_SIZE : 0) + shortcut.digit - 1;
        const asset = active.assets[index];
        if (asset) {
          event.preventDefault();
          if (contactSheet) {
            toggleKeeper(index, false);
          } else {
            decide('keeper', [active], asset.id);
          }
        }
        return;
      }
    }
  };

  const toggleSelected = (duplicateId: string) => {
    selected = selected.includes(duplicateId)
      ? selected.filter((id) => id !== duplicateId)
      : [...selected, duplicateId];
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

  const unselectedKey = $derived(
    trashEnabled ? 'frameleaf_duplicates_unselected_to_trash' : 'frameleaf_duplicates_unselected_deleted',
  );

  const thumb = (asset: Asset | undefined) =>
    asset ? getAssetMediaUrl({ id: asset.id, size: AssetMediaSize.Thumbnail, cacheKey: asset.thumbhash }) : '';
</script>

<svelte:window onkeydown={onKeydown} />

<section
  class="fl-duplicate-review"
  aria-label={$t('frameleaf_duplicates_region')}
  data-testid="frameleaf-duplicate-review"
>
  <div class="fl-dr-toolbar">
    <label>
      {$t('frameleaf_duplicates_find')}
      <input type="search" bind:value={query} placeholder={$t('frameleaf_duplicates_find_placeholder')} />
    </label>
    <label>
      {$t('frameleaf_duplicates_show')}
      <select bind:value={filter}>
        <option value="open">{$t('frameleaf_duplicates_show_open')}</option>
        <option value="all">{$t('frameleaf_duplicates_show_all')}</option>
      </select>
    </label>
  </div>

  <div class="fl-dr-session">
    <div>
      <strong>{$t('frameleaf_duplicates_group_count', { values: { count: groups.length } })}</strong>
      <span>
        {$t('frameleaf_duplicates_progress', { values: { reviewed, ready: eligible.length } })}
      </span>
    </div>
    <Button disabled={undoCount === 0 || session.undoing} onclick={() => void undo()}>
      <Icon icon={mdiUndo} size="16" aria-hidden={true} />
      {session.undoing
        ? $t('frameleaf_duplicates_undoing')
        : undoCount > 0
          ? $t('frameleaf_duplicates_undo_count', { values: { count: undoCount } })
          : $t('frameleaf_duplicates_undo')}
    </Button>
    <Button pressed={shortcutsOpen} onclick={() => (shortcutsOpen = !shortcutsOpen)}>
      {$t('frameleaf_duplicates_shortcuts')} <kbd>?</kbd>
    </Button>
  </div>

  {#if notice || error}
    <div class="fl-dr-live" class:error={!!error} role={error ? 'alert' : 'status'}>
      <Icon icon={error ? mdiAlertCircleOutline : mdiCheckCircleOutline} size="18" aria-hidden={true} />
      <span>{error || notice?.message}</span>
      {#if !error && notice?.trash}
        <Button onclick={onOpenTrash}>{$t('frameleaf_duplicates_view_trash')}</Button>
      {/if}
      <Button
        variant="quiet"
        label={$t('frameleaf_duplicates_dismiss_message')}
        onclick={() => {
          notice = null;
          error = '';
        }}
      >
        <Icon icon={mdiClose} size="16" aria-hidden={true} />
      </Button>
    </div>
  {/if}

  {#if shortcutsOpen}
    <div class="fl-dr-shortcuts" aria-label={$t('frameleaf_duplicates_shortcuts')}>
      <span>
        <kbd>1–9</kbd>
        {$t(contactSheet ? 'frameleaf_duplicates_shortcut_select_keepers' : 'frameleaf_duplicates_shortcut_keep_copy')}
      </span>
      <span><kbd>K</kbd> {$t('frameleaf_duplicates_keep_suggested')}</span>
      <span><kbd>A</kbd> {$t('frameleaf_duplicates_keep_all')}</span>
      <span><kbd>S</kbd> {$t('frameleaf_duplicates_stack')}</span>
      {#if contactSheet}
        <span><kbd>E</kbd> {$t('frameleaf_duplicates_shortcut_keep_selected')}</span>
      {/if}
      <span><kbd>← →</kbd> {$t('frameleaf_duplicates_shortcut_move')}</span>
      <span><kbd>⌘ / Ctrl Z</kbd> {$t('frameleaf_duplicates_undo')}</span>
    </div>
  {/if}

  <div class="fl-dr-bulk">
    <label>
      <input
        type="checkbox"
        aria-label={$t('frameleaf_duplicates_select_matching_label')}
        checked={allEligibleSelected}
        disabled={eligible.length === 0}
        onchange={() => (selected = allEligibleSelected ? [] : eligible.map((group) => group.duplicateId))}
      />
      {selectedGroups.length > 0
        ? $t('frameleaf_duplicates_selected_count', { values: { count: selectedGroups.length } })
        : $t('frameleaf_duplicates_select_matching')}
    </label>
    {#if selectedGroups.length > 0}
      <Button
        variant="primary"
        disabled={recommended.length !== selectedGroups.length}
        onclick={() => decide('suggested', selectedGroups)}
      >
        {$t('frameleaf_duplicates_keep_suggested_in', { values: { count: selectedGroups.length } })}
      </Button>
      <Button onclick={() => decide('keep-all', selectedGroups)}>{$t('frameleaf_duplicates_keep_all_copies')}</Button>
      <Button onclick={() => decide('stack', selectedGroups)}>{$t('frameleaf_duplicates_stack_groups')}</Button>
      <Button onclick={() => (selected = [])}>{$t('frameleaf_duplicates_clear_selection')}</Button>
    {/if}
    <span>
      {#if selectedGroups.length === 0}
        {$t('frameleaf_duplicates_bulk_hint')}
      {:else if recommended.length !== selectedGroups.length}
        {$t('frameleaf_duplicates_bulk_needs_choice', {
          values: { count: selectedGroups.length - recommended.length },
        })}
      {:else}
        {$t(trashEnabled ? 'frameleaf_duplicates_bulk_would_trash' : 'frameleaf_duplicates_bulk_would_delete', {
          values: { count: selectedGroups.reduce((count, group) => count + group.assets.length - 1, 0) },
        })}
      {/if}
    </span>
  </div>

  <div class="fl-dr-workspace">
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
              <input
                type="checkbox"
                aria-label={$t('frameleaf_duplicates_select_group', { values: { name: groupTitle(group) } })}
                disabled={!actionableOf(group)}
                checked={selected.includes(group.duplicateId)}
                onchange={() => toggleSelected(group.duplicateId)}
              />
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
                  <small>
                    {isBurst(group)
                      ? $t('frameleaf_duplicates_burst_frames', { values: { count: group.assets.length } })
                      : $t('frameleaf_duplicates_copies', { values: { count: group.assets.length } })} ·
                    {rowStatus(group)}
                  </small>
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

    <div class="fl-dr-comparison">
      {#if active && focused}
        <div class="fl-dr-heading">
          <div>
            <h2 bind:this={heading} tabindex="-1">{groupTitle(active)}</h2>
            <p>
              {$t('frameleaf_duplicates_group_position', {
                values: { index: currentIndex + 1, total: groups.length },
              })} ·
              {burst
                ? $t('frameleaf_duplicates_frames', { values: { count: active.assets.length } })
                : $t('frameleaf_duplicates_copies', { values: { count: active.assets.length } })} ·
              {$t('frameleaf_duplicates_in_originals', {
                values: { size: getByteUnitString(active.totalBytes, $locale) },
              })}
            </p>
          </div>
          <div>
            <Button
              label={$t('frameleaf_duplicates_previous_group')}
              disabled={groups.length < 2}
              onclick={() => move(-1)}
            >
              <Icon icon={mdiChevronLeft} size="18" aria-hidden={true} />
            </Button>
            <Button label={$t('frameleaf_duplicates_next_group')} disabled={groups.length < 2} onclick={() => move(1)}>
              <Icon icon={mdiChevronRight} size="18" aria-hidden={true} />
            </Button>
          </div>
        </div>

        {#if !active.editable}
          <p class="fl-dr-access">
            {active.blockedReason === DuplicateGroupBlock.OtherOwner
              ? $t('frameleaf_duplicates_blocked_other_owner')
              : $t('frameleaf_duplicates_blocked_hidden', { values: { count: active.hiddenMemberCount } })}
          </p>
        {:else if activeProgress?.state === 'pending'}
          <p class="fl-dr-access" role="status">{$t('frameleaf_duplicates_processing_group')}</p>
        {:else if activeProgress?.state === 'failed'}
          <p class="fl-dr-access error" role="alert">{$t(activeProgress.reasonKey)}</p>
        {/if}

        {#if contactSheet}
          <DuplicateContactSheet
            group={active}
            {actionable}
            {suggestedId}
            {keeperIds}
            {focused}
            {framePage}
            onToggle={toggleKeeper}
            onFocus={(asset) => (focusedId = asset.id)}
            onSelectAll={() => (keeperIds = active.assets.map((asset) => asset.id))}
            onClear={() => (keeperIds = [])}
            onStack={() => decide('stack', [active])}
            onOpen={(asset) => onOpen(asset, active)}
            onPage={(page) => (framePage = page)}
          />
        {:else}
          <DuplicateCompare
            group={active}
            {actionable}
            {suggestedId}
            onKeep={(asset) => decide('keeper', [active], asset.id)}
            onOpen={(asset) => onOpen(asset, active)}
          />
        {/if}

        <div class="fl-dr-decisions" class:sticky={contactSheet}>
          {#if contactSheet}
            <div>
              <strong>
                {keeperIds.length > 0
                  ? $t(trashEnabled ? 'frameleaf_duplicates_keep_and_trash' : 'frameleaf_duplicates_keep_and_delete', {
                      values: { kept: keeperIds.length, removed: active.assets.length - keeperIds.length },
                    })
                  : $t('frameleaf_duplicates_choose_keepers')}
              </strong>
              <small>
                {keeperIds.length > 0 ? $t(unselectedKey) : $t('frameleaf_duplicates_nothing_removed')}
              </small>
            </div>
            <Button
              variant="primary"
              disabled={!actionable || keeperIds.length === 0}
              onclick={() => decide('keepers', [active])}
            >
              {$t('frameleaf_duplicates_keep_selected', { values: { count: keeperIds.length } })} <kbd>E</kbd>
            </Button>
          {:else}
            <Button
              variant="primary"
              disabled={!actionable || !suggestedId}
              onclick={() => decide('suggested', [active])}
            >
              {$t('frameleaf_duplicates_keep_suggested')} <kbd>K</kbd>
            </Button>
          {/if}
          <Button disabled={!actionable} onclick={() => decide('keep-all', [active])}>
            {$t('frameleaf_duplicates_keep_all')} <kbd>A</kbd>
          </Button>
          <Button disabled={!actionable} onclick={() => decide('stack', [active], undefined)}>
            {$t('frameleaf_duplicates_stack_together')} <kbd>S</kbd>
          </Button>
          <Button disabled={groups.length < 2} onclick={() => move(1)}>{$t('frameleaf_duplicates_skip')}</Button>
        </div>
        <p class="fl-dr-footnote">
          {burst ? $t('frameleaf_duplicates_footnote_burst') : $t('frameleaf_duplicates_footnote_copies')}
          {trashEnabled ? $t('frameleaf_duplicates_footnote_storage') : $t('frameleaf_duplicates_footnote_no_trash')}
        </p>
      {:else}
        <div class="fl-dr-done">
          <Icon icon={mdiCheckCircleOutline} size="36" aria-hidden={true} />
          <h2 bind:this={heading} tabindex="-1">{$t('frameleaf_duplicates_complete')}</h2>
          <p>{$t('frameleaf_duplicates_complete_body')}</p>
          <Button disabled={undoCount === 0 || session.undoing} onclick={() => void undo()}>
            <Icon icon={mdiUndo} size="16" aria-hidden={true} />
            {$t('frameleaf_duplicates_undo_last')}
          </Button>
        </div>
      {/if}
    </div>
  </div>
</section>

<Dialog
  bind:open={confirmOpen}
  title={$t('frameleaf_duplicates_confirm_delete_title')}
  closeLabel={$t('frameleaf_duplicates_cancel')}
>
  <p class="fl-dr-confirm">{$t('frameleaf_duplicates_confirm_delete_body')}</p>
  <div class="fl-dr-confirm-actions">
    <Button onclick={() => (confirmOpen = false)}>{$t('frameleaf_duplicates_cancel')}</Button>
    <Button variant="primary" onclick={confirmIrreversible}>{$t('frameleaf_duplicates_confirm_delete')}</Button>
  </div>
</Dialog>

<style>
  .fl-duplicate-review {
    min-width: 0;
    color: var(--fl-text);
  }
  .fl-dr-toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    padding-bottom: 12px;
  }
  .fl-dr-toolbar label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: var(--fl-font-micro);
    color: var(--fl-muted);
  }
  .fl-dr-toolbar input,
  .fl-dr-toolbar select {
    min-width: 220px;
    padding: 7px 10px;
    font-size: var(--fl-font-size);
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .fl-dr-session {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 14px 0;
    border-block: 1px solid var(--fl-border);
  }
  .fl-dr-session > div {
    flex: 1;
  }
  .fl-dr-session strong {
    display: block;
    font-size: 18px;
    font-weight: 550;
  }
  .fl-dr-session span {
    display: block;
    margin-top: 5px;
    font-size: var(--fl-font-micro);
    color: var(--fl-muted);
  }
  kbd {
    margin-inline-start: 5px;
    font-size: var(--fl-font-micro);
    opacity: 0.65;
  }
  .fl-dr-shortcuts {
    display: flex;
    flex-wrap: wrap;
    gap: 12px 20px;
    padding: 13px;
    font-size: var(--fl-font-micro);
    color: var(--fl-muted);
    border-bottom: 1px solid var(--fl-border);
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
  .fl-dr-live {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    margin-top: 12px;
    font-size: var(--fl-font-small);
    background: var(--fl-panel);
    border-inline-start: 2px solid var(--fl-accent);
  }
  .fl-dr-live > span {
    flex: 1;
  }
  .fl-dr-live.error {
    border-color: var(--fl-warning);
  }
  .fl-dr-bulk {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    padding: 14px 0;
    border-bottom: 1px solid var(--fl-border);
  }
  .fl-dr-bulk > label {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-inline-end: 12px;
    white-space: nowrap;
  }
  .fl-dr-bulk > span {
    margin-inline-start: auto;
    font-size: var(--fl-font-micro);
    line-height: 1.5;
    color: var(--fl-muted);
  }
  .fl-dr-workspace {
    display: grid;
    grid-template-columns: 220px minmax(0, 1fr);
    gap: 22px;
    margin-top: 18px;
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
    height: min(56vh, 540px);
    min-height: 220px;
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
    gap: 8px;
    height: 68px;
    padding: 0 9px;
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
  .fl-dr-comparison {
    min-width: 0;
  }
  .fl-dr-heading {
    display: flex;
    align-items: start;
    justify-content: space-between;
    gap: 10px;
    margin-bottom: 12px;
  }
  .fl-dr-heading h2 {
    margin: 0 0 5px;
    font-size: 17px;
    font-weight: 600;
  }
  .fl-dr-heading p {
    margin: 0;
    font-size: var(--fl-font-micro);
    color: var(--fl-muted);
  }
  .fl-dr-heading > div:last-child {
    display: flex;
    gap: 5px;
  }
  .fl-dr-access {
    padding: 12px 14px;
    margin: 0 0 12px;
    background: var(--fl-panel);
    border-inline-start: 2px solid var(--fl-muted);
  }
  .fl-dr-access.error {
    border-color: var(--fl-warning);
  }
  .fl-dr-decisions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    padding: 16px 0 6px;
  }
  .fl-dr-decisions.sticky {
    position: sticky;
    bottom: -1px;
    z-index: 2;
    padding: 13px 0;
    margin-top: 18px;
    background: var(--fl-canvas);
    border-block: 1px solid var(--fl-border);
  }
  .fl-dr-decisions.sticky > div {
    flex: 1 0 100%;
  }
  .fl-dr-decisions strong {
    font-size: var(--fl-font-small);
    font-weight: 600;
  }
  .fl-dr-decisions small {
    margin-inline-start: 12px;
    font-size: var(--fl-font-micro);
    color: var(--fl-muted);
  }
  .fl-dr-footnote {
    margin: 8px 0;
    font-size: var(--fl-font-micro);
    color: var(--fl-muted);
  }
  .fl-dr-done {
    padding: 60px 25px;
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
    .fl-dr-bulk > span {
      width: 100%;
      margin: 3px 0 0;
    }
  }
  @media (max-width: 700px) {
    .fl-dr-session {
      flex-wrap: wrap;
    }
    .fl-dr-session > div {
      min-width: 100%;
    }
    .fl-dr-shortcuts,
    kbd {
      display: none;
    }
    .fl-dr-toolbar input,
    .fl-dr-toolbar select {
      min-width: 0;
      width: 100%;
    }
    .fl-dr-toolbar label {
      flex: 1 1 100%;
    }
    .fl-dr-decisions small {
      display: block;
      margin: 5px 0 0;
    }
  }
</style>
