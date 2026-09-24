<script lang="ts">
  import { goto } from '$app/navigation';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import type { DiscoveryQuery } from '$lib/components/discovery/query';
  import { chunk, resolveMatchingIds } from '$lib/frameleaf/bulk-operations';
  import type { LibraryViewState } from '$lib/frameleaf/library-session';
  import { smartAlbumCriteria } from '$lib/frameleaf/search-palette';
  import { Route } from '$lib/route';
  import { savedSearchesStore } from '$lib/stores/saved-searches.svelte';
  import { handleError } from '$lib/utils/handle-error';
  import {
    addAssetsToAlbum,
    BulkIdErrorReason,
    createAlbum,
    createClassificationRule,
    deleteAlbum,
    searchAssets,
    searchSmart,
    type BulkIdResponseDto,
  } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiFilterOutline, mdiFolderOutline, mdiFolderSearchOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  /**
   * "Save search" from the search palette (FL-49). Ported from the prototype's save flow
   * (`SearchPalette.jsx` `save` → the "Save this collection" dialog in `App.jsx`): one name and three ways
   * to keep the search.
   *
   * - **Smart album**: the FL-60 rule-backed smart album, which keeps matching as new media arrives. It is
   *   offered only when the search is one a rule can say exactly (`smartAlbumCriteria`); otherwise it is
   *   disabled and says why. A rule checks each item against its threshold, so a smart-text album can hold
   *   different items than the ranked list, and the dialog says so.
   * - **Album snapshot**: an ordinary album holding the items that match now. The matching ids are
   *   collected first through the authenticated search (Locked items never come back to a session that is
   *   not unlocked, and the timeline default leaves them out), and the exact number that will be saved is
   *   confirmed before anything is created — smart search saves its top ranked page, and a very large
   *   metadata search saves its first 50,000. The web client has no server-side search snapshot to hand
   *   this to (the durable bulk path takes explicit ids), so the ids are added in chunks, and a chunk that
   *   fails can be retried or the half-filled album removed. The per-item answers (added, skipped, failed)
   *   are reported.
   * - **Saved search**: the compiled query in the `savedSearches` preference (the prototype's "Filter
   *   preset"), shown in the palette and the rail.
   */

  let {
    open = $bindable(false),
    query,
    defaultName = '',
    count,
    onSaved,
  }: {
    open?: boolean;
    /** The compiled search, exactly as the palette would submit it. */
    query: DiscoveryQuery;
    defaultName?: string;
    /** How many items match now, when known (a capped smart count is passed as null). */
    count?: number | null;
    /** Called after a save; `navigated` when the new album was opened. */
    onSaved?: (kind: 'smart' | 'snapshot' | 'search', navigated: boolean) => void;
  } = $props();

  type Snapshot = { ids: string[]; total: number | null; truncated: boolean; smart: boolean };
  type Tally = { added: number; skipped: number; failed: number };
  type Step =
    | { kind: 'choose' }
    | { kind: 'confirm'; snapshot: Snapshot }
    | { kind: 'adding'; done: number; of: number }
    | { kind: 'stalled'; albumId: string; remaining: string[][]; tally: Tally; of: number }
    | { kind: 'done'; albumId: string; tally: Tally };

  let name = $state('');
  let busy = $state(false);
  let error = $state('');
  let notice = $state('');
  let progress = $state('');
  let step = $state<Step>({ kind: 'choose' });

  $effect(() => {
    if (!open) {
      return;
    }
    name = defaultName.trim().slice(0, 100);
    error = '';
    notice = '';
    progress = '';
    step = { kind: 'choose' };
  });

  const smart = $derived(smartAlbumCriteria(query));
  const smartRanked = $derived(smart.ok && !!smart.criteria.visualQueries?.length);
  const nothingMatches = $derived(count === 0);

  const guard = async (work: () => Promise<void>) => {
    if (!name.trim() || busy) {
      return;
    }
    busy = true;
    error = '';
    notice = '';
    try {
      await work();
    } catch (error_) {
      error = $t('frameleaf_search_save_failed');
      handleError(error_, $t('frameleaf_search_save_failed'), { notify: false });
    } finally {
      busy = false;
      progress = '';
    }
  };

  const saveSmart = async () => {
    if (!smart.ok) {
      return;
    }
    const rule = await createClassificationRule({
      classificationRuleCreateDto: { ...smart.criteria, albumName: name.trim() },
    });
    open = false;
    onSaved?.('smart', true);
    await goto(Route.viewAlbum({ id: rule.albumId }));
  };

  /** Collect the matching ids first, so the exact number is confirmed before an album exists. */
  const prepareSnapshot = async () => {
    const state = {
      version: 1,
      scope: { kind: 'library' },
      query,
      sort: 'captured-desc',
      grouping: 'all',
      view: 'grid',
    };
    const resolved = await resolveMatchingIds(state as LibraryViewState, {
      gateway: { searchAssets, searchSmart },
      onProgress: (found) => (progress = $t('frameleaf_search_save_collecting', { values: { count: found } })),
    });
    if (resolved.ids.length === 0) {
      notice = $t('frameleaf_search_save_snapshot_empty');
      return;
    }
    const isSmart = query.mode === 'smart' && (!!query.text.trim() || !!query.queryAssetId);
    step = { kind: 'confirm', snapshot: { ...resolved, smart: isSmart } };
  };

  /** Answers that mean the item was left out on purpose, rather than failing. */
  const SKIPPED: ReadonlySet<BulkIdErrorReason> = new Set([
    BulkIdErrorReason.Duplicate,
    BulkIdErrorReason.NoPermission,
    BulkIdErrorReason.NotFound,
  ]);

  const tallyOf = (results: BulkIdResponseDto[], tally: Tally): Tally => {
    const next = { ...tally };
    for (const result of results) {
      if (result.success) {
        next.added += 1;
      } else if (result.error && SKIPPED.has(result.error)) {
        next.skipped += 1;
      } else {
        next.failed += 1;
      }
    }
    return next;
  };

  /** Add the chunks in order; a chunk that throws stops here with the rest kept for Retry. */
  const addChunks = async (albumId: string, chunks: string[][], tally: Tally, of: number) => {
    let current = tally;
    for (const [index, ids] of chunks.entries()) {
      step = { kind: 'adding', done: current.added + current.skipped + current.failed, of };
      try {
        current = tallyOf(await addAssetsToAlbum({ id: albumId, bulkIdsDto: { ids } }), current);
      } catch (error_) {
        handleError(error_, $t('frameleaf_search_save_snapshot_stalled_short'), { notify: false });
        step = { kind: 'stalled', albumId, remaining: chunks.slice(index), tally: current, of };
        return;
      }
    }
    step = { kind: 'done', albumId, tally: current };
  };

  const createSnapshot = async (snapshot: Snapshot) => {
    const album = await createAlbum({ createAlbumDto: { albumName: name.trim() } });
    await addChunks(album.id, chunk(snapshot.ids), { added: 0, skipped: 0, failed: 0 }, snapshot.ids.length);
  };

  const retry = async () => {
    if (step.kind !== 'stalled') {
      return;
    }
    const { albumId, remaining, tally, of } = step;
    await addChunks(albumId, remaining, tally, of);
  };

  const removeAlbum = async () => {
    if (step.kind !== 'stalled') {
      return;
    }
    await deleteAlbum({ id: step.albumId });
    step = { kind: 'choose' };
    notice = $t('frameleaf_search_save_snapshot_removed');
  };

  const openAlbum = async (albumId: string) => {
    open = false;
    onSaved?.('snapshot', true);
    await goto(Route.viewAlbum({ id: albumId }));
  };

  const saveSearch = async () => {
    if (await savedSearchesStore.save(name.trim(), query)) {
      open = false;
      onSaved?.('search', false);
    } else {
      error = $t('frameleaf_search_save_failed');
    }
  };

  const tallyText = (tally: Tally) =>
    [
      $t('frameleaf_search_save_snapshot_added', { values: { count: tally.added } }),
      ...(tally.skipped > 0
        ? [$t('frameleaf_search_save_snapshot_skipped', { values: { count: tally.skipped } })]
        : []),
      ...(tally.failed > 0 ? [$t('frameleaf_search_save_snapshot_failed', { values: { count: tally.failed } })] : []),
    ].join(' ');

  const confirmText = (snapshot: Snapshot) =>
    snapshot.smart
      ? $t('frameleaf_search_save_snapshot_ranked', { values: { count: snapshot.ids.length } })
      : snapshot.truncated
        ? $t('frameleaf_search_save_snapshot_truncated', {
            values: { count: snapshot.ids.length, total: snapshot.total ?? snapshot.ids.length },
          })
        : $t('frameleaf_search_save_snapshot_exact', { values: { count: snapshot.ids.length } });

  const choices = $derived([
    {
      id: 'smart',
      icon: mdiFolderSearchOutline,
      title: $t('frameleaf_search_save_smart_album'),
      description: smart.ok
        ? $t('frameleaf_search_save_smart_album_help')
        : $t('frameleaf_search_save_smart_album_blocked'),
      note: smartRanked ? $t('frameleaf_search_save_smart_album_threshold') : '',
      disabled: !smart.ok,
      action: saveSmart,
    },
    {
      id: 'snapshot',
      icon: mdiFolderOutline,
      title: $t('frameleaf_search_save_snapshot'),
      description: nothingMatches
        ? $t('frameleaf_search_save_snapshot_empty')
        : typeof count === 'number'
          ? $t('frameleaf_search_save_snapshot_count', { values: { count } })
          : $t('frameleaf_search_save_snapshot_help'),
      note: '',
      disabled: nothingMatches,
      action: prepareSnapshot,
    },
    {
      id: 'search',
      icon: mdiFilterOutline,
      title: $t('frameleaf_search_save_saved_search'),
      description: $t('frameleaf_search_save_saved_search_help'),
      note: '',
      disabled: false,
      action: saveSearch,
    },
  ]);
</script>

<Dialog bind:open title={$t('frameleaf_search_save_title')} closeLabel={$t('close')}>
  <div class="save">
    <label>
      <span>{$t('name')}</span>
      <input data-initial-focus maxlength="100" bind:value={name} disabled={busy || step.kind !== 'choose'} />
    </label>

    {#if step.kind === 'choose'}
      <div class="choices">
        {#each choices as choice (choice.id)}
          <button
            type="button"
            disabled={!name.trim() || busy || choice.disabled}
            onclick={() => void guard(choice.action)}
          >
            <Icon icon={choice.icon} size="20" aria-hidden={true} />
            <span>
              <strong>{choice.title}</strong>
              <small>{choice.description}</small>
              {#if choice.note}<small class="note">{choice.note}</small>{/if}
            </span>
          </button>
        {/each}
      </div>
    {:else if step.kind === 'confirm'}
      {@const snapshot = step.snapshot}
      <p class="summary" role="status">{confirmText(snapshot)}</p>
      <div class="actions">
        <Button onclick={() => (step = { kind: 'choose' })}>{$t('cancel')}</Button>
        <Button variant="primary" disabled={busy} onclick={() => void guard(() => createSnapshot(snapshot))}>
          {$t('frameleaf_search_save_snapshot_create')}
        </Button>
      </div>
    {:else if step.kind === 'adding'}
      <p class="summary" role="status">
        {$t('frameleaf_search_save_snapshot_adding', { values: { done: step.done, count: step.of } })}
      </p>
    {:else if step.kind === 'stalled'}
      <p class="summary" role="alert">
        {$t('frameleaf_search_save_snapshot_stalled', {
          values: { done: step.tally.added + step.tally.skipped + step.tally.failed, count: step.of },
        })}
        {tallyText(step.tally)}
      </p>
      <div class="actions">
        <Button disabled={busy} onclick={() => void guard(removeAlbum)}>
          {$t('frameleaf_search_save_snapshot_delete')}
        </Button>
        <Button variant="primary" disabled={busy} onclick={() => void guard(retry)}>
          {$t('frameleaf_search_save_snapshot_retry')}
        </Button>
      </div>
    {:else if step.kind === 'done'}
      {@const albumId = step.albumId}
      <p class="summary" role="status">{tallyText(step.tally)}</p>
      <div class="actions">
        <Button variant="primary" onclick={() => void openAlbum(albumId)}>
          {$t('frameleaf_search_save_snapshot_open')}
        </Button>
      </div>
    {/if}

    {#if progress}
      <p class="status" role="status">{progress}</p>
    {/if}
    {#if notice}
      <p class="status" role="status">{notice}</p>
    {/if}
    {#if error}
      <p class="error" role="alert">{error}</p>
    {/if}
  </div>
</Dialog>

<style>
  /* The prototype's "Save this collection" dialog: a name and an action list (App.jsx `.action-list`). */
  .save {
    display: grid;
    gap: 0.875rem;
  }
  label {
    display: grid;
    gap: 0.375rem;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  input {
    min-height: 36px;
    padding: 0 0.625rem;
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .choices {
    display: grid;
    gap: 0.375rem;
  }
  .choices button {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    min-height: 56px;
    padding: 0.5rem 0.75rem;
    text-align: start;
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  .choices button:hover:not(:disabled) {
    border-color: var(--fl-accent);
  }
  .choices button:disabled {
    opacity: 0.55;
    cursor: default;
  }
  .choices span {
    display: grid;
    gap: 0.125rem;
  }
  small {
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  .note {
    font-style: italic;
  }
  .summary {
    font-size: var(--fl-font-small);
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }
  .status {
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  .error {
    font-size: var(--fl-font-small);
    color: var(--fl-danger, #ff453a);
  }
</style>
