<script lang="ts">
  import { goto } from '$app/navigation';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import type { DiscoveryQuery } from '$lib/components/discovery/query';
  import { chunk, resolveMatchingIds } from '$lib/frameleaf/bulk-operations';
  import type { LibraryViewState } from '$lib/frameleaf/library-session';
  import { smartAlbumCriteria } from '$lib/frameleaf/search-palette';
  import { Route } from '$lib/route';
  import { savedSearchesStore } from '$lib/stores/saved-searches.svelte';
  import { handleError } from '$lib/utils/handle-error';
  import { addAssetsToAlbum, createAlbum, createClassificationRule, searchAssets, searchSmart } from '@immich/sdk';
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
   *   disabled and says why.
   * - **Album snapshot**: an ordinary album holding the items that match now, collected through the
   *   authenticated search endpoints (Locked items are never returned to a session that is not unlocked,
   *   and the timeline default leaves them out of every snapshot) and added in chunks.
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
    /** How many items match now, when known, for the snapshot line. */
    count?: number | null;
    /** Called after a save; `navigated` when the new album was opened. */
    onSaved?: (kind: 'smart' | 'snapshot' | 'search', navigated: boolean) => void;
  } = $props();

  let name = $state('');
  let busy = $state(false);
  let error = $state('');
  let progress = $state('');

  $effect(() => {
    if (!open) {
      return;
    }
    name = defaultName.trim().slice(0, 100);
    error = '';
    progress = '';
  });

  const smart = $derived(smartAlbumCriteria(query));

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

  const saveSnapshot = async () => {
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
    const album = await createAlbum({ createAlbumDto: { albumName: name.trim() } });
    for (const ids of chunk(resolved.ids)) {
      await addAssetsToAlbum({ id: album.id, bulkIdsDto: { ids } });
    }
    open = false;
    onSaved?.('snapshot', true);
    await goto(Route.viewAlbum({ id: album.id }));
  };

  const saveSearch = async () => {
    if (await savedSearchesStore.save(name.trim(), query)) {
      open = false;
      onSaved?.('search', false);
    } else {
      error = $t('frameleaf_search_save_failed');
    }
  };

  const run = async (work: () => Promise<void>, failureKey: 'frameleaf_search_save_failed') => {
    if (!name.trim() || busy) {
      return;
    }
    busy = true;
    error = '';
    try {
      await work();
    } catch (error_) {
      error = $t(failureKey);
      handleError(error_, $t(failureKey), { notify: false });
    } finally {
      busy = false;
      progress = '';
    }
  };

  const choices = $derived([
    {
      id: 'smart',
      icon: mdiFolderSearchOutline,
      title: $t('frameleaf_search_save_smart_album'),
      description: smart.ok
        ? $t('frameleaf_search_save_smart_album_help')
        : $t('frameleaf_search_save_smart_album_blocked'),
      disabled: !smart.ok,
      action: saveSmart,
    },
    {
      id: 'snapshot',
      icon: mdiFolderOutline,
      title: $t('frameleaf_search_save_snapshot'),
      description:
        typeof count === 'number'
          ? $t('frameleaf_search_save_snapshot_count', { values: { count } })
          : $t('frameleaf_search_save_snapshot_help'),
      disabled: false,
      action: saveSnapshot,
    },
    {
      id: 'search',
      icon: mdiFilterOutline,
      title: $t('frameleaf_search_save_saved_search'),
      description: $t('frameleaf_search_save_saved_search_help'),
      disabled: false,
      action: saveSearch,
    },
  ]);
</script>

<Dialog bind:open title={$t('frameleaf_search_save_title')} closeLabel={$t('close')}>
  <div class="save">
    <label>
      <span>{$t('name')}</span>
      <input data-initial-focus maxlength="100" bind:value={name} disabled={busy} />
    </label>
    <div class="choices">
      {#each choices as choice (choice.id)}
        <button
          type="button"
          disabled={!name.trim() || busy || choice.disabled}
          onclick={() => void run(choice.action, 'frameleaf_search_save_failed')}
        >
          <Icon icon={choice.icon} size="20" aria-hidden={true} />
          <span>
            <strong>{choice.title}</strong>
            <small>{choice.description}</small>
          </span>
        </button>
      {/each}
    </div>
    {#if progress}
      <p class="status" role="status">{progress}</p>
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
  .status {
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  .error {
    font-size: var(--fl-font-small);
    color: var(--fl-danger, #ff453a);
  }
</style>
