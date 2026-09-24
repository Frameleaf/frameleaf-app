<script lang="ts">
  import AlbumIcon from '$lib/components/frameleaf/AlbumIcon.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import { defaultIconFor } from '$lib/frameleaf/album-directory';
  import type { AlbumCollectionResponseDto, AlbumResponseDto } from '@immich/sdk';
  import { t } from 'svelte-i18n';

  /**
   * Keyboard and touch alternative to dragging: move an album into one of the
   * collections the user can edit, or take it out so it stands on its own.
   * Only collections are offered; an album never nests inside an album.
   */
  interface Props {
    album: AlbumResponseDto;
    targets: AlbumCollectionResponseDto[];
    open?: boolean;
    busy?: boolean;
    onMove: (collectionId: string | null) => void;
  }

  let { album, targets, open = $bindable(false), busy = false, onMove }: Props = $props();

  let selected = $state<string | null>(album.parentId);
  const name = $derived(album.albumName || $t('unnamed_album'));
  const unchanged = $derived(selected === album.parentId);

  $effect(() => {
    if (open) {
      selected = album.parentId;
    }
  });
</script>

<Dialog title={$t('frameleaf_albums_move_title', { values: { name } })} closeLabel={$t('close')} bind:open>
  <form
    class="move"
    onsubmit={(event) => {
      event.preventDefault();
      onMove(selected);
    }}
  >
    <fieldset>
      <legend class="sr-only">{$t('frameleaf_albums_move_to')}</legend>
      <label class="choice">
        <input type="radio" name="collection" value={null} bind:group={selected} />
        <span class="label">{$t('frameleaf_albums_move_on_its_own')}</span>
      </label>
      {#each targets as target (target.collection.id)}
        <label class="choice">
          <input type="radio" name="collection" value={target.collection.id} bind:group={selected} />
          <span class="icon" aria-hidden="true">
            <AlbumIcon name={target.collection.icon ?? defaultIconFor(target.collection.kind)} size="18" />
          </span>
          <span class="label">
            {target.collection.albumName || $t('unnamed_album')}
            <small>{$t('frameleaf_albums_count', { values: { count: target.albumCount } })}</small>
          </span>
        </label>
      {/each}
      {#if targets.length === 0}
        <p class="empty">{$t('frameleaf_albums_move_no_collections')}</p>
      {/if}
    </fieldset>
    <div class="buttons">
      <button type="button" onclick={() => (open = false)}>{$t('cancel')}</button>
      <button type="submit" class="primary" disabled={busy || unchanged}>{$t('move')}</button>
    </div>
  </form>
</Dialog>

<style>
  .move {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    margin-block-start: 1rem;
    min-width: min(24rem, 100%);
  }
  fieldset {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    margin: 0;
    padding: 0;
    border: 0;
    max-height: 50dvh;
    overflow-y: auto;
  }
  .choice {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    min-height: 44px;
    padding: 0.25rem 0.5rem;
    border-radius: var(--fl-radius);
    cursor: pointer;
  }
  .choice:hover {
    background: var(--fl-raised);
  }
  .choice input {
    accent-color: var(--fl-accent);
    min-height: 0;
  }
  .icon {
    display: inline-flex;
    color: var(--fl-muted);
  }
  .label {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .label small {
    color: var(--fl-muted);
    font-size: 0.75rem;
  }
  .empty {
    margin: 0.5rem;
    color: var(--fl-muted);
    font-size: 0.875rem;
  }
  .buttons {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }
  .buttons button {
    padding: 0 1rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    background: var(--fl-raised);
    color: var(--fl-text);
  }
  .buttons .primary {
    background: var(--fl-accent);
    border-color: var(--fl-accent);
    color: var(--fl-accent-text);
  }
  .buttons button:disabled {
    opacity: 0.6;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
  }
</style>
