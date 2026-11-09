<script lang="ts">
  import AlbumDestinationPicker from '$lib/components/frameleaf/AlbumDestinationPicker.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import { descendantIds } from '$lib/frameleaf/album-tree';
  import type { AlbumResponseDto } from '@frameleaf/sdk';
  import { t } from 'svelte-i18n';

  /**
   * Keyboard and touch alternative to dragging (prototype `MoveCollectionDialog`, README point 2):
   * move one album or collection, or several chosen on the Albums page, into another one the user
   * can edit, or up to the top level. Before anything is typed it lists the most recently changed
   * albums, so a library of thousands opens at once; typing searches them all. The albums being
   * moved and everything inside them stay listed but cannot be chosen, and say why.
   */
  interface Props {
    /** The albums being moved (one from a menu, several from a selection). */
    moving: AlbumResponseDto[];
    /** Albums and collections the user may move into (the albums and their own descendants included). */
    albums: AlbumResponseDto[];
    open?: boolean;
    busy?: boolean;
    onMove: (collectionId: string | null) => void;
  }

  /** Albums listed before the person types. */
  const RECENT = 10;

  let { moving, albums, open = $bindable(false), busy = false, onMove }: Props = $props();

  let selected = $state<string | null>(null);
  const title = $derived(
    moving.length === 1
      ? $t('frameleaf_albums_move_title', { values: { name: moving[0].albumName || $t('unnamed_album') } })
      : $t('frameleaf_albums_move_many_title', { values: { count: moving.length } }),
  );
  const unchanged = $derived(moving.every(({ parentId }) => parentId === selected));
  const candidates = $derived.by(() => {
    const ids = new Set(albums.map(({ id }) => id));
    return [...albums, ...moving.filter(({ id }) => !ids.has(id))];
  });
  const movingIds = $derived(new Set(moving.map(({ id }) => id)));
  /** Worked out once per open, not once per row: thousands of rows would make it slow. */
  const inside = $derived.by(() => {
    const found = new Set<string>();
    for (const { id } of moving) {
      for (const child of descendantIds(candidates, id)) {
        found.add(child);
      }
    }
    return found;
  });

  $effect(() => {
    if (open) {
      selected = moving[0]?.parentId ?? null;
    }
  });

  const refusal = (target: AlbumResponseDto) =>
    movingIds.has(target.id)
      ? $t('frameleaf_boards_move_refuse_self')
      : inside.has(target.id)
        ? $t('frameleaf_boards_move_refuse_inside')
        : null;
</script>

<Dialog {title} closeLabel={$t('close')} bind:open>
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
      recent={RECENT}
      name="album-move-{moving[0]?.id ?? 'none'}"
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
