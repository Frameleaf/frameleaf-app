<script lang="ts">
  import AlbumDestinationPicker from '$lib/components/frameleaf/AlbumDestinationPicker.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import type { AlbumResponseDto } from '@frameleaf/sdk';
  import { t } from 'svelte-i18n';

  /**
   * "Merge into…" for albums chosen on the Albums page: pick the album they all go into. It keeps its
   * name and icon whatever its size, and may be one of the chosen albums (it is simply not merged with
   * itself). One Undo brings every merged album back.
   */
  interface Props {
    /** The albums chosen on the page. */
    merging: AlbumResponseDto[];
    /** Albums they may be merged into (plain albums the person owns). */
    albums: AlbumResponseDto[];
    open?: boolean;
    busy?: boolean;
    onMerge: (target: AlbumResponseDto) => Promise<void> | void;
  }

  const RECENT = 10;

  let { merging, albums, open = $bindable(false), busy = false, onMerge }: Props = $props();

  let selected = $state<string | null>(null);
  $effect(() => {
    if (open) {
      selected = null;
    }
  });
  const target = $derived(selected ? albums.find(({ id }) => id === selected) : undefined);
  /** What actually merges: the chosen albums other than the target. */
  const others = $derived(merging.filter(({ id }) => id !== selected));
  const name = $derived(target?.albumName || $t('unnamed_album'));
</script>

<Dialog
  title={$t('frameleaf_albums_merge_into_title', { values: { count: merging.length } })}
  closeLabel={$t('close')}
  bind:open
>
  <form
    class="merge"
    onsubmit={(event) => {
      event.preventDefault();
      if (target && others.length > 0) {
        void onMerge(target);
      }
    }}
  >
    <AlbumDestinationPicker
      {albums}
      value={selected}
      onChange={(id) => (selected = id)}
      recent={RECENT}
      name="album-merge-into"
      label={$t('frameleaf_albums_merge_into')}
    />
    {#if target}
      <p class="note">
        {others.length > 0
          ? $t('frameleaf_albums_merge_into_note', { values: { count: others.length, name } })
          : $t('frameleaf_albums_merge_into_nothing')}
      </p>
    {/if}
    <div class="buttons">
      <button type="button" onclick={() => (open = false)}>{$t('cancel')}</button>
      <button type="submit" class="primary" disabled={busy || !target || others.length === 0}>
        {$t('frameleaf_albums_merge_into_confirm', { values: { count: others.length } })}
      </button>
    </div>
  </form>
</Dialog>

<style>
  .merge {
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
