<script lang="ts">
  /**
   * Duplicate review › "Merged for you" (FL-416, after the approved prototype's `DuplicateReview.jsx`
   * `MergedForYou`). Identical files are merged by themselves, keeping the oldest copy. Each merge can be
   * undone here, and an undone merge is never made again by itself: in one library Undo brings the newer
   * photo back out of the Trash (the decision job's own undo); across people it puts the photo back on
   * its own file (`undoIdenticalFileChange`, an administrator's).
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import { formatBytes } from '$lib/frameleaf/format-bytes';
  import { MERGED_ROWS, mergedRows, type MergedRow } from '$lib/frameleaf/merged-for-you';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import { handleError } from '$lib/utils/handle-error';
  import {
    getAssetInfo,
    getRecentIdenticalFileChanges,
    undoIdenticalFileChange,
    type DuplicateDecisionBatchDto,
    type IdenticalFilesRecentChangeDto,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiUndo } from '@mdi/js';
  import { DateTime } from 'luxon';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  let {
    recent,
    undoing = false,
    onUndoMerge,
  }: {
    /** The decision history the review keeps current. */
    recent: readonly DuplicateDecisionBatchDto[];
    undoing?: boolean;
    onUndoMerge: (batch: DuplicateDecisionBatchDto, duplicateId: string) => Promise<boolean>;
  } = $props();

  let changes = $state<IdenticalFilesRecentChangeDto[]>([]);
  let names = $state<Record<string, string>>({});
  let busy = $state<string | null>(null);

  onMount(() => {
    if (!(authManager.authenticated && authManager.user.isAdmin)) {
      return;
    }
    void (async () => {
      try {
        changes = await getRecentIdenticalFileChanges({ limit: MERGED_ROWS });
      } catch {
        changes = [];
      }
    })();
  });

  const rows = $derived(mergedRows(recent, changes));

  // The kept photo's name, for a merge in one library: the history only has its id.
  $effect(() => {
    for (const row of rows) {
      if (row.kind === 'merge' && names[row.keepId] === undefined) {
        names[row.keepId] = '';
        void getAssetInfo({ id: row.keepId })
          .then((asset) => (names[row.keepId] = asset.originalFileName))
          .catch(() => undefined);
      }
    }
  });

  const week = $derived(rows.filter((row) => DateTime.fromISO(row.at) > DateTime.now().minus({ days: 7 })).length);
  const savedBytes = $derived(
    rows.reduce((sum, row) => sum + (row.kind === 'link' && !row.change.undoneAt ? row.change.sizeInBytes : 0), 0),
  );

  const when = (value: string) => {
    const at = DateTime.fromISO(value).setLocale($locale ?? 'en');
    if (at.hasSame(DateTime.now(), 'day')) {
      return $t('frameleaf_merged_today', { values: { time: at.toLocaleString(DateTime.TIME_SIMPLE) } });
    }
    if (at.hasSame(DateTime.now().minus({ days: 1 }), 'day')) {
      return $t('frameleaf_merged_yesterday');
    }
    return at.toLocaleString({ day: 'numeric', month: 'short' });
  };

  const what = (row: MergedRow) => {
    if (row.kind === 'merge') {
      return row.undone
        ? $t('frameleaf_merged_undone')
        : $t('frameleaf_merged_in_library', { values: { count: row.photos } });
    }
    const { change } = row;
    if (change.undoneAt) {
      return $t('frameleaf_merged_undone');
    }
    const other = change.keptOwnerName ?? $t('frameleaf_merged_someone');
    return authManager.authenticated && change.ownerId === authManager.user.id
      ? $t('frameleaf_merged_shared_yours', { values: { name: other } })
      : $t('frameleaf_merged_shared', { values: { owner: change.ownerName, name: other } });
  };

  const undo = async (row: MergedRow) => {
    busy = row.key;
    try {
      if (row.kind === 'merge') {
        await onUndoMerge(row.batch, row.duplicateId);
      } else {
        const undone = await undoIdenticalFileChange({ id: row.change.id });
        changes = changes.map((change) =>
          change.id === row.change.id ? { ...change, undoneAt: undone.undoneAt, restorable: false } : change,
        );
      }
    } catch (error) {
      handleError(error, $t('frameleaf_merged_undo_failed'));
    } finally {
      busy = null;
    }
  };
</script>

{#if rows.length > 0}
  <section class="fl-merged" aria-labelledby="fl-merged-title">
    <header>
      <div>
        <h2 id="fl-merged-title">{$t('frameleaf_merged_title')}</h2>
        <p>{$t('frameleaf_merged_description')}</p>
      </div>
      <span>
        {savedBytes > 0
          ? $t('frameleaf_merged_summary_saved', { values: { count: week, size: formatBytes(savedBytes, $locale) } })
          : $t('frameleaf_merged_summary', { values: { count: week } })}
      </span>
    </header>
    <ul>
      {#each rows as row (row.key)}
        {@const done = row.kind === 'merge' ? row.undone : !!row.change.undoneAt}
        {@const can = row.kind === 'merge' ? row.undoable : row.change.restorable && !row.change.undoneAt}
        <li>
          <time datetime={row.at}>{when(row.at)}</time>
          <strong>
            {row.kind === 'merge'
              ? names[row.keepId] || $t('frameleaf_merged_identical_photos')
              : row.change.originalFileName}
          </strong>
          <span>{what(row)}</span>
          <span class="size">
            {row.kind === 'link' && !done
              ? $t('frameleaf_merged_saved', { values: { size: formatBytes(row.change.sizeInBytes, $locale) } })
              : ''}
          </span>
          <Button disabled={done || !can || busy !== null || undoing} onclick={() => undo(row)}>
            <Icon icon={mdiUndo} size="16" aria-hidden />
            {done ? $t('frameleaf_merged_undone_button') : $t('frameleaf_merged_undo')}
          </Button>
        </li>
      {/each}
    </ul>
  </section>
{/if}

<style>
  /* duplicate-review.css .dr-merged */
  .fl-merged {
    margin-top: var(--fl-space-6);
    padding: 0 var(--fl-space-6);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    background: var(--fl-panel);
    color: var(--fl-text);
  }
  header {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--fl-space-3) var(--fl-space-6);
    padding: var(--fl-space-5) 0;
  }
  h2 {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
  }
  header p {
    max-width: 640px;
    margin: var(--fl-space-2) 0 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.5;
  }
  header > span {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  li {
    display: grid;
    grid-template-columns: 120px minmax(0, 1fr) minmax(0, 2fr) 96px auto;
    align-items: center;
    gap: var(--fl-space-4);
    padding: var(--fl-space-3) 0;
    border-top: 1px solid var(--fl-border);
    font-size: var(--fl-font-small);
  }
  li strong {
    overflow-wrap: anywhere;
  }
  li time,
  li > span {
    color: var(--fl-muted);
  }
  .size {
    text-align: end;
  }
  @media (max-width: 760px) {
    .fl-merged {
      padding: 0 var(--fl-space-4);
    }
    li {
      grid-template-columns: minmax(0, 1fr) auto;
    }
    li time,
    li > span {
      grid-column: 1;
    }
  }
</style>
