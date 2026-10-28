<script lang="ts">
  import { longPress } from '$lib/actions/long-press';
  import { DRAG_SELECT_EVENT } from '$lib/components/timeline/drag-select';
  import { libraryReferenceUrl } from '$lib/frameleaf/library-reference';
  import { getAssetMediaUrl } from '$lib/utils';
  import { AssetMediaSize, type BookmarkResponseDto } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiLinkVariant } from '@mdi/js';
  import { t } from 'svelte-i18n';

  let {
    bookmark,
    selected = false,
    selecting = false,
    onOpen,
    onToggleSelect,
    onFocus,
  }: {
    bookmark: BookmarkResponseDto;
    selected?: boolean;
    selecting?: boolean;
    onOpen?: (bookmark: BookmarkResponseDto) => void;
    onToggleSelect?: (bookmark: BookmarkResponseDto, event: MouseEvent | KeyboardEvent) => void;
    onFocus?: () => void;
  } = $props();
  const url = $derived(libraryReferenceUrl(bookmark.url));
  const host = $derived(url ? new URL(url).hostname : '');
  const dragSelect = (node: HTMLElement) => {
    const listener = () => {
      if (!selected) {
        onToggleSelect?.(bookmark, new MouseEvent('click'));
      }
    };
    node.addEventListener(DRAG_SELECT_EVENT, listener);
    return { destroy: () => node.removeEventListener(DRAG_SELECT_EVENT, listener) };
  };
  const toggle = (event: MouseEvent | KeyboardEvent) => onToggleSelect?.(bookmark, event);
</script>

<div
  class="fl-bookmark"
  class:is-selected={selected}
  data-testid="frameleaf-bookmark-card"
  data-asset-id="bookmark:{bookmark.id}"
  use:dragSelect
>
  <button
    type="button"
    class="fl-bookmark-open"
    aria-label={bookmark.title || host}
    onfocus={onFocus}
    use:longPress={{ onLongPress: () => onToggleSelect?.(bookmark, new MouseEvent('click')) }}
    onclick={(event) => (selecting ? toggle(event) : onOpen?.(bookmark))}
    onkeydown={(event) => {
      if (event.key === ' ' && event.shiftKey) {
        event.preventDefault();
        toggle(event);
      }
    }}
  >
    <div class="fl-bookmark-preview">
      {#if bookmark.previewAssetId}
        <img
          src={getAssetMediaUrl({ id: bookmark.previewAssetId, size: AssetMediaSize.Thumbnail })}
          alt=""
          loading="lazy"
        />
      {:else}<Icon icon={mdiLinkVariant} size="32" />{/if}
    </div>
    <span class="fl-bookmark-title">{bookmark.title || host}</span>
    <span class="fl-bookmark-host">{host}</span>
  </button>
  <label class="fl-bookmark-select"
    ><input
      type="checkbox"
      checked={selected}
      aria-label={$t('frameleaf_bookmark_select', { values: { title: bookmark.title || host } })}
      onclick={toggle}
    /></label
  >
</div>

<style>
  .fl-bookmark {
    position: relative;
    width: 100%;
    height: 100%;
    border-radius: var(--fl-radius-control);
    background: var(--fl-panel);
    overflow: hidden;
  }
  .fl-bookmark.is-selected {
    outline: 2px solid var(--fl-accent);
    outline-offset: -2px;
  }
  .fl-bookmark-open {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    text-align: start;
    padding: var(--fl-space-2);
    gap: var(--fl-space-1);
    color: var(--fl-text);
  }
  .fl-bookmark-open:focus-visible {
    outline: 2px solid var(--fl-accent);
    outline-offset: -3px;
  }
  .fl-bookmark-preview {
    flex: 1;
    min-height: 0;
    display: grid;
    place-items: center;
    color: var(--fl-muted);
  }
  img {
    width: 100%;
    height: 100%;
    object-fit: contain;
    min-height: 0;
  }
  .fl-bookmark-title,
  .fl-bookmark-host {
    display: block;
    width: 100%;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .fl-bookmark-title {
    font-size: var(--fl-font-size);
  }
  .fl-bookmark-host {
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  .fl-bookmark-select {
    position: absolute;
    top: 0;
    inset-inline-start: 0;
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
  }
  .fl-bookmark-select input {
    width: 20px;
    height: 20px;
    margin: 0;
    accent-color: var(--fl-accent);
  }
</style>
