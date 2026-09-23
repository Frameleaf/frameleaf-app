<script lang="ts">
  import BulkOperationStatus from '$lib/components/frameleaf/BulkOperationStatus.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { BulkController } from '$lib/frameleaf/bulk-controller.svelte';
  import { librarySession } from '$lib/frameleaf/library-session.svelte';
  import { addSourceOptions, spaceAddScope, type SpaceAddSource } from '$lib/frameleaf/shared-space';
  import { Icon } from '@immich/ui';
  import { mdiPlaylistPlus } from '@mdi/js';
  import type { AlbumResponseDto } from '@immich/sdk';
  import { t } from 'svelte-i18n';

  /**
   * Add everything matching a source into this shared space (FL-55 over FL-32).
   *
   * This is the scope-bound snapshot path, not a second implementation of it.
   * The user picks where the items come from, sees the count the server reports
   * for exactly that source, and starts a background operation. From that
   * moment the set is frozen: `spaceAddScope` hands the controller a fresh view
   * state, so nothing the user does afterwards can change what the operation
   * touches. Progress, cancellation and the per-item failure report are the
   * existing ones, and the shared space is the destination in the action's
   * payload, never the scope — a space is not expressible as a search, and
   * guessing a wider set is the failure that path exists to prevent.
   *
   * Every item is still permission checked per item on the server, so a source
   * containing something the signed-in person may not share is reported as a
   * skipped item rather than quietly added.
   */
  interface Props {
    space: AlbumResponseDto;
    /** Albums the signed-in person can read, offered as sources. */
    albums?: AlbumResponseDto[];
    /** Injected in tests; production uses the session-bound controller. */
    controller?: BulkController;
  }

  let { space, albums = [], controller }: Props = $props();

  const bulk =
    controller ??
    new BulkController({
      dispatch: (action) => librarySession.dispatch(action),
      context: () => ({ currentUserId: authManager.authenticated ? authManager.user.id : undefined }),
    });

  const sources = $derived(addSourceOptions(albums, space.id));

  let sourceId = $state('');
  let counting = $state(false);
  let total: number | null = $state(null);

  const source: SpaceAddSource = $derived(sourceId ? { kind: 'album', id: sourceId } : { kind: 'library' });

  const preview = async () => {
    counting = true;
    try {
      total = await bulk.count(spaceAddScope(source));
    } finally {
      counting = false;
    }
  };

  const start = async () => {
    // The scope is taken here, once. The count shown is what the user agreed to.
    await bulk.runMatching('add-to-album', spaceAddScope(source), {
      payload: { albumId: space.id },
      submittedTotal: total,
    });
    total = null;
  };

  const operations = $derived(librarySession.session.operations);
</script>

<section class="add-matching" aria-labelledby="frameleaf-space-add-matching">
  <h2 id="frameleaf-space-add-matching">{$t('frameleaf_spaces_add_matching')}</h2>
  <p class="hint">{$t('frameleaf_spaces_add_matching_hint')}</p>

  <div class="controls">
    <label>
      <span>{$t('frameleaf_spaces_add_matching_source')}</span>
      <select bind:value={sourceId} onchange={() => (total = null)}>
        <option value="">{$t('frameleaf_spaces_add_matching_source_library')}</option>
        {#each sources as album (album.id)}
          <option value={album.id}>{album.albumName}</option>
        {/each}
      </select>
    </label>

    <button type="button" disabled={counting} onclick={preview}>
      {counting ? $t('frameleaf_spaces_add_matching_counting') : $t('frameleaf_spaces_add_matching_preview')}
    </button>

    <button type="button" class="primary" disabled={total === null || total === 0} onclick={start}>
      <Icon icon={mdiPlaylistPlus} size="16" aria-hidden={true} />
      {$t('frameleaf_spaces_add_matching_apply', { values: { count: total ?? 0 } })}
    </button>
  </div>

  {#if total !== null}
    <p class="count" aria-live="polite">
      {total === 0
        ? $t('frameleaf_spaces_add_matching_unavailable')
        : $t('frameleaf_spaces_add_matching_count', { values: { count: total } })}
    </p>
  {/if}

  <BulkOperationStatus
    {operations}
    onCancel={(requestId) => bulk.cancel(requestId)}
    onRetry={(operation) => void bulk.retry(operation)}
    onDismiss={(requestId) => bulk.dismiss(requestId)}
  />
</section>

<style>
  .add-matching {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  h2 {
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
  }
  .hint,
  .count {
    margin: 0;
    color: var(--fl-muted);
    font-size: 0.75rem;
  }
  .controls {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: 0.5rem;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.75rem;
    color: var(--fl-muted);
  }
  select {
    min-height: 32px;
    padding: 0 0.5rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    background: var(--fl-panel);
    color: var(--fl-text);
    font-size: 0.8125rem;
  }
  button {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0 0.875rem;
    min-height: 32px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    background: var(--fl-raised);
    color: var(--fl-text);
    font-size: 0.8125rem;
    font-weight: 600;
  }
  button.primary {
    border-color: var(--fl-accent);
    background: var(--fl-accent);
    color: var(--fl-accent-text);
  }
  button:disabled {
    opacity: 0.6;
  }
</style>
