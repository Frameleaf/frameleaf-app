<script lang="ts">
  import AlbumMark from '$lib/components/frameleaf/AlbumMark.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import { sameAlbumName } from '$lib/frameleaf/album-directory';
  import { getAssetMediaUrl } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import {
    AssetMediaSize,
    getAlbumMergePreview,
    type AlbumMergePreviewResponseDto,
    type AlbumResponseDto,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiMagnify } from '@mdi/js';
  import { t } from 'svelte-i18n';

  /**
   * "Merge with…" (prototype `MergeAlbumDialog`): pick an album, same names first, then confirm. The server
   * says which album keeps its name and icon, so the choice is one the person can read before agreeing.
   */
  interface Props {
    album: AlbumResponseDto;
    /** Albums this one may be merged with; the album itself is left out here. */
    albums: AlbumResponseDto[];
    open?: boolean;
    busy?: boolean;
    onMerge: (other: AlbumResponseDto) => Promise<void> | void;
  }

  /** Enough to find an album by scrolling; a library with thousands of albums searches. */
  const MAX_ROWS = 200;

  let { album, albums, open = $bindable(false), busy = false, onMerge }: Props = $props();

  let query = $state('');
  let other = $state<AlbumResponseDto | null>(null);
  let preview = $state<AlbumMergePreviewResponseDto | null>(null);
  /** Which pick the preview belongs to: a slower answer for an earlier pick must not replace it. */
  let requested = 0;

  // The dialog stays mounted after it closes, so each opening starts at the picker.
  $effect(() => {
    if (!open) {
      requested++;
      other = null;
      preview = null;
      query = '';
    }
  });

  const unnamed = $derived($t('unnamed_album'));
  const nameOf = (item: AlbumResponseDto) => item.albumName || unnamed;
  const needle = $derived(query.trim().toLowerCase());
  const matches = $derived(
    albums
      .filter((item) => item.id !== album.id && (!needle || item.albumName.toLowerCase().includes(needle)))
      .map((item) => ({ item, same: sameAlbumName(item.albumName, album.albumName) }))
      .sort((a, b) => Number(b.same) - Number(a.same) || a.item.albumName.localeCompare(b.item.albumName)),
  );
  const shown = $derived(matches.slice(0, MAX_ROWS));

  const coverOf = (item: AlbumResponseDto) =>
    item.albumThumbnailAssetId
      ? getAssetMediaUrl({ id: item.albumThumbnailAssetId, size: AssetMediaSize.Thumbnail })
      : undefined;
  const photos = (count: number) => $t('frameleaf_album_merge_photos', { values: { count } });

  const choose = async (item: AlbumResponseDto) => {
    other = item;
    preview = null;
    const request = ++requested;
    try {
      const answer = await getAlbumMergePreview({ id: album.id, otherId: item.id });
      if (request === requested) {
        preview = answer;
      }
    } catch (error) {
      if (request === requested) {
        other = null;
        handleError(error, $t('frameleaf_album_merge_preview_failed'));
      }
    }
  };

  const back = () => {
    requested++;
    other = null;
    preview = null;
  };

  const pair = $derived.by(() => {
    if (!other || !preview) {
      return null;
    }
    return preview.winnerId === album.id ? { winner: album, loser: other } : { winner: other, loser: album };
  });
  const names = $derived(pair ? { winner: nameOf(pair.winner), loser: nameOf(pair.loser) } : { winner: '', loser: '' });
  // The row that was clicked is gone once the confirmation shows, so focus moves to its button.
  let confirmButton = $state<HTMLButtonElement>();
  $effect(() => {
    if (pair) {
      confirmButton?.focus();
    }
  });

  /** A merged album is locked only when both were, and that is the one case with nothing to explain. */
  const lockChanges = $derived(!!pair && pair.winner.isLocked !== pair.loser.isLocked);
</script>

{#snippet tile(item: AlbumResponseDto, keeps: boolean)}
  {@const cover = coverOf(item)}
  <div class="tile" class:keeps>
    {#if cover}
      <img src={cover} alt="" />
    {:else}
      <span class="empty-cover"><AlbumMark icon={item.icon} color={item.color} kind={item.kind} size="24" /></span>
    {/if}
    <strong>{nameOf(item)}</strong>
    <small>{photos(item.assetCount)}</small>
    <span class="tag" class:strong={keeps}>
      {keeps ? $t('frameleaf_album_merge_keeps') : $t('frameleaf_album_merge_removed')}
    </span>
  </div>
{/snippet}

<Dialog
  title={other
    ? $t('frameleaf_album_merge_confirm_title')
    : $t('frameleaf_album_merge_pick_title', { values: { name: nameOf(album) } })}
  closeLabel={$t('close')}
  bind:open
>
  {#if other && pair && preview}
    <div class="tiles">
      {@render tile(pair.winner, true)}
      {@render tile(pair.loser, false)}
    </div>
    <div class="copy">
      <p>
        {preview.inBoth > 0
          ? $t('frameleaf_album_merge_will_hold_both', {
              values: { name: names.winner, count: preview.total, inBoth: preview.inBoth },
            })
          : $t('frameleaf_album_merge_will_hold', { values: { name: names.winner, count: preview.total } })}
      </p>
      {#if preview.winnerShared}
        <p class="warn">{$t('frameleaf_album_merge_winner_shared', { values: { name: names.winner } })}</p>
      {/if}
      {#if preview.loserShared}
        <p class="warn">{$t('frameleaf_album_merge_loser_shared', { values: names })}</p>
      {/if}
      <p class="note">{$t('frameleaf_album_merge_also', { values: names })}</p>
      {#if lockChanges}
        <p class="note">{$t('frameleaf_album_merge_locked')}</p>
      {/if}
      <p class="note">{$t('frameleaf_album_merge_undo', { values: names })}</p>
    </div>
  {:else if other}
    <p class="note" role="status">{$t('frameleaf_album_merge_checking')}</p>
  {:else}
    <label class="search">
      <Icon icon={mdiMagnify} size="17" aria-hidden={true} />
      <input
        type="search"
        data-initial-focus
        bind:value={query}
        placeholder={$t('frameleaf_album_merge_search')}
        aria-label={$t('frameleaf_album_merge_search')}
        autocomplete="off"
      />
    </label>
    <ul class="picker">
      {#each shown as { item, same } (item.id)}
        {@const cover = coverOf(item)}
        <li>
          <button type="button" onclick={() => void choose(item)}>
            {#if cover}
              <img src={cover} alt="" loading="lazy" />
            {:else}
              <span class="mark"><AlbumMark icon={item.icon} color={item.color} kind={item.kind} size="18" /></span>
            {/if}
            <span class="name">{nameOf(item)}</span>
            {#if same}<span class="tag strong">{$t('frameleaf_album_merge_same_name')}</span>{/if}
            <small>{photos(item.assetCount)}</small>
          </button>
        </li>
      {:else}
        <li class="none">{$t('frameleaf_album_merge_no_match')}</li>
      {/each}
    </ul>
    {#if matches.length > MAX_ROWS}
      <p class="note">{$t('frameleaf_album_merge_more', { values: { count: MAX_ROWS } })}</p>
    {/if}
  {/if}
  {#snippet actions()}
    {#if other}
      <button type="button" class="button" disabled={busy} onclick={back}>{$t('back')}</button>
      <button
        type="button"
        class="button primary"
        bind:this={confirmButton}
        disabled={busy || !pair}
        onclick={() => other && void onMerge(other)}>{$t('frameleaf_album_merge_confirm')}</button
      >
    {:else}
      <button type="button" class="button" onclick={() => (open = false)}>{$t('cancel')}</button>
    {/if}
  {/snippet}
</Dialog>

<style>
  .search {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-block-end: var(--fl-space-3);
    padding: 0 var(--fl-space-3);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    background: var(--fl-raised);
    color: var(--fl-muted);
  }
  .search:focus-within {
    outline: 2px solid var(--fl-accent);
    outline-offset: 1px;
  }
  .search input {
    flex: 1;
    min-width: 0;
    min-height: 40px;
    border: 0;
    background: transparent;
    color: var(--fl-text);
    font: inherit;
    outline: none;
  }
  .picker {
    display: grid;
    gap: 2px;
    max-height: 360px;
    margin: 0;
    padding: 0;
    overflow: auto;
    list-style: none;
  }
  .picker button {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    min-height: 44px;
    padding: 4px 8px;
    border: 0;
    border-radius: var(--fl-radius-sm);
    background: none;
    color: var(--fl-text);
    font: inherit;
    text-align: start;
    cursor: pointer;
  }
  .picker button:hover {
    background: var(--fl-raised);
  }
  .picker button:focus-visible {
    outline: 2px solid var(--fl-accent);
    outline-offset: -2px;
  }
  .picker img {
    flex: 0 0 auto;
    width: 32px;
    height: 32px;
    object-fit: cover;
    border-radius: var(--fl-radius-xs);
  }
  .mark {
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
  }
  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .picker small,
  .tile small {
    flex: 0 0 auto;
    color: var(--fl-muted);
    font-size: 0.8125rem;
  }
  .none {
    padding: var(--fl-space-3);
    color: var(--fl-muted);
    font-size: 0.875rem;
  }
  .tag {
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    padding: 2px 8px;
    border-radius: var(--fl-radius-sm);
    background: var(--fl-raised);
    color: var(--fl-muted);
    font-size: 0.8125rem;
    white-space: nowrap;
  }
  .tag.strong {
    background: var(--fl-accent-soft, var(--fl-raised));
    color: var(--fl-text);
  }
  .tiles {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
    margin-block-end: var(--fl-space-3);
  }
  .tile {
    display: grid;
    gap: 4px;
    align-content: start;
    justify-items: start;
    padding: 8px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  .tile.keeps {
    border-color: var(--fl-accent);
  }
  .tile img,
  .empty-cover {
    width: 100%;
    aspect-ratio: 4 / 3;
    object-fit: cover;
    border-radius: var(--fl-radius-sm);
    background: var(--fl-raised);
  }
  .empty-cover {
    display: grid;
    place-items: center;
    color: var(--fl-muted);
  }
  .tile strong {
    overflow-wrap: anywhere;
  }
  .copy {
    display: flex;
    flex-direction: column;
    gap: var(--fl-space-3);
  }
  p {
    margin: 0;
    color: var(--fl-text);
    font-size: 0.875rem;
    line-height: 1.5;
  }
  .warn {
    color: var(--fl-warning);
  }
  :global([data-theme='light']) .warn {
    color: var(--fl-text);
  }
  .note {
    color: var(--fl-muted);
  }
  .primary {
    background: var(--fl-accent);
    border-color: var(--fl-accent);
    color: var(--fl-accent-text);
  }
</style>
