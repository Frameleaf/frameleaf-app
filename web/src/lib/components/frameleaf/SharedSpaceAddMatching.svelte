<script lang="ts">
  import BulkOperationStatus from '$lib/components/frameleaf/BulkOperationStatus.svelte';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { BulkController } from '$lib/frameleaf/bulk-controller.svelte';
  import { librarySession } from '$lib/frameleaf/library-session.svelte';
  import { addSourceOptions, spaceAddScope, type SpaceAddSource } from '$lib/frameleaf/shared-space';
  import { Icon } from '@frameleaf/ui';
  import { mdiPlaylistPlus } from '@mdi/js';
  import type { AlbumResponseDto } from '@frameleaf/sdk';
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
    /**
     * SHARING-P5: the choice lives in a dialog the Photos tab's "Add matching…" button opens, so the
     * space opens on its photos. Progress stays on the tab once it starts.
     */
    open?: boolean;
  }

  let { space, albums = [], controller, open = $bindable(false) }: Props = $props();

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
    const run = bulk.runMatching('add-to-album', spaceAddScope(source), {
      payload: { albumId: space.id },
      submittedTotal: total,
    });
    // The dialog's job is done once the work is handed off; its progress shows on the Photos tab.
    open = false;
    await run;
    total = null;
  };

  const operations = $derived(librarySession.session.operations);
</script>

<Dialog title={$t('frameleaf_spaces_add_matching')} closeLabel={$t('close')} bind:open>
  <div class="add-matching">
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

      <Button disabled={counting} onclick={preview}>
        {counting ? $t('frameleaf_spaces_add_matching_counting') : $t('frameleaf_spaces_add_matching_preview')}
      </Button>
    </div>

    {#if total !== null}
      <p class="count" aria-live="polite">
        {total === 0
          ? $t('frameleaf_spaces_add_matching_unavailable')
          : $t('frameleaf_spaces_add_matching_count', { values: { count: total } })}
      </p>
    {/if}
  </div>

  {#snippet actions()}
    <Button onclick={() => (open = false)}>{$t('cancel')}</Button>
    <Button variant="primary" disabled={total === null || total === 0} onclick={start}>
      <Icon icon={mdiPlaylistPlus} size="18" aria-hidden={true} />
      {$t('frameleaf_spaces_add_matching_apply', { values: { count: total ?? 0 } })}
    </Button>
  {/snippet}
</Dialog>

<BulkOperationStatus
  {operations}
  onCancel={(requestId) => bulk.cancel(requestId)}
  onRetry={(operation) => void bulk.retry(operation)}
  onDismiss={(requestId) => bulk.dismiss(requestId)}
/>

<style>
  .add-matching {
    display: flex;
    flex-direction: column;
    gap: var(--fl-space-3);
  }
  .hint,
  .count {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
  }
  .controls {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: var(--fl-space-2);
  }
  label {
    display: flex;
    flex: 1 1 200px;
    flex-direction: column;
    gap: var(--fl-space-1);
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  select {
    min-height: 44px;
    padding: 0 var(--fl-space-3);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    background: var(--fl-panel);
    color: var(--fl-text);
    font-size: var(--fl-font-callout);
  }
</style>
