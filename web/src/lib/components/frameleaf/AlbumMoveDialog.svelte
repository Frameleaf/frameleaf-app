<script lang="ts">
  import AlbumDestinationPicker from '$lib/components/frameleaf/AlbumDestinationPicker.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import { moveRefusal } from '$lib/frameleaf/album-tree';
  import type { AlbumResponseDto } from '@frameleaf/sdk';
  import { t } from 'svelte-i18n';

  /**
   * Keyboard and touch alternative to dragging (prototype `MoveCollectionDialog`, README point 2):
   * move an album or collection into another one the user can edit, or up to the top level.
   * The same searchable tree as every other picker, each in its own icon and colour. The album
   * itself and everything inside it stay listed but cannot be chosen, and say why.
   */
  interface Props {
    album: AlbumResponseDto;
    /** Albums and collections the user may move into (the album and its own descendants included). */
    albums: AlbumResponseDto[];
    open?: boolean;
    busy?: boolean;
    onMove: (collectionId: string | null) => void;
  }

  let { album, albums, open = $bindable(false), busy = false, onMove }: Props = $props();

  let selected = $state<string | null>(album.parentId);
  const name = $derived(album.albumName || $t('unnamed_album'));
  const unchanged = $derived(selected === album.parentId);
  const candidates = $derived(albums.some(({ id }) => id === album.id) ? albums : [...albums, album]);

  $effect(() => {
    if (open) {
      selected = album.parentId;
    }
  });

  const refusal = (target: AlbumResponseDto) => {
    switch (moveRefusal(candidates, album.id, target.id)) {
      case 'self': {
        return $t('frameleaf_boards_move_refuse_self');
      }
      case 'inside': {
        return $t('frameleaf_boards_move_refuse_inside');
      }
      default: {
        return null;
      }
    }
  };
</script>

<Dialog title={$t('frameleaf_albums_move_title', { values: { name } })} closeLabel={$t('close')} bind:open>
  <form
    class="move"
    onsubmit={(event) => {
      event.preventDefault();
      onMove(selected);
    }}
  >
    <AlbumDestinationPicker
      albums={candidates}
      value={selected}
      onChange={(id) => (selected = id)}
      allowTop
      {refusal}
      name="album-move-{album.id}"
      label={$t('frameleaf_albums_move_to')}
    />
    <p class="note">{$t('frameleaf_boards_move_note')}</p>
    <div class="buttons">
      <button type="button" onclick={() => (open = false)}>{$t('cancel')}</button>
      <button type="submit" class="primary" disabled={busy || unchanged}>{$t('frameleaf_boards_move_here')}</button>
    </div>
  </form>
</Dialog>

<style>
  .move {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    margin-block-start: 1rem;
    min-width: min(26rem, 100%);
  }
  .note {
    margin: 0;
    color: var(--fl-muted);
    font-size: 0.8125rem;
  }
  .buttons {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }
  .buttons button {
    min-height: 36px;
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
  .buttons button:focus-visible {
    outline: 2px solid var(--fl-accent);
    outline-offset: 2px;
  }
</style>
