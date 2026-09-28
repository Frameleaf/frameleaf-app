<script lang="ts">
  /**
   * A timeline group's sticky header: the select-all checkbox, the title and the item count.
   *
   * Ported from the group header in `design/frameleaf/template/src/TimelineLibrary.jsx`. Day groups
   * and the month, year and "all" groups draw the same header; it fills exactly the height the
   * timeline manager reserves for it.
   */
  import { Icon } from '@immich/ui';
  import { mdiCheck, mdiMinus } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = {
    id: string;
    title: string;
    count: number;
    state: 'none' | 'some' | 'all';
    width: number;
    height: number;
    /** The pointer is over the group's items, which shows the checkbox (prototype `.tl-group:hover`). */
    hovered?: boolean;
    /** A selection is in progress: every group shows its checkbox (prototype `.is-selecting`). */
    selecting?: boolean;
    /**
     * Called with the checkbox's new state. Resolving `false` means the change did not take effect
     * (the group could not be loaded, or the view moved on), and the checkbox shows `state` again.
     */
    onSelect?: (checked: boolean) => void | boolean | Promise<boolean>;
  };

  let { id, title, count, state, width, height, hovered = false, selecting = false, onSelect }: Props = $props();

  const change = async (input: HTMLInputElement) => {
    const applied = await onSelect?.(input.checked);
    if (applied === false) {
      input.checked = state === 'all';
      input.indeterminate = state === 'some';
    }
  };
</script>

<header class="fl-group-header" style:width="{width}px" style:height="{height}px">
  <label class="fl-group-select" class:is-active={state !== 'none'} class:is-shown={hovered || selecting}>
    <input
      type="checkbox"
      checked={state === 'all'}
      indeterminate={state === 'some'}
      aria-label={$t('frameleaf_library_select_all_in_group', { values: { title } })}
      onchange={(event) => void change(event.currentTarget)}
    />
    <span aria-hidden="true">
      {#if state === 'all'}
        <Icon icon={mdiCheck} size="13" />
      {:else if state === 'some'}
        <Icon icon={mdiMinus} size="13" />
      {/if}
    </span>
  </label>
  <!-- A long title (a day's full date in a narrow group) is cut short; the tooltip keeps it whole. -->
  <h2 {id} {title}>{title}</h2>
  <span class="fl-group-count">{$t('items_count', { values: { count } })}</span>
</header>

<style>
  .fl-group-header {
    position: sticky;
    /* Below the frosted results toolbar, whatever its height (LibraryView publishes it). */
    top: var(--fl-sticky-offset, 0px);
    z-index: 3;
    display: flex;
    align-items: center;
    gap: 10px;
    box-sizing: border-box;
    margin: 0;
    padding: 0 0 6px;
    background: linear-gradient(var(--fl-canvas) 78%, transparent);
    pointer-events: auto;
  }
  .fl-group-header h2 {
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--fl-font-size, 14px);
    font-weight: 600;
    line-height: 1.4;
  }
  .fl-group-count {
    color: var(--fl-muted);
    font-size: var(--fl-font-small, 12px);
    white-space: nowrap;
  }
  .fl-group-select {
    position: relative;
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    margin-inline-start: -6px;
    cursor: pointer;
    opacity: 0;
    transition: opacity var(--fl-motion-fast, 120ms) ease;
  }
  .fl-group-header:hover .fl-group-select,
  :global(.fl-day:hover) .fl-group-select,
  .fl-group-select:focus-within,
  .fl-group-select.is-active,
  .fl-group-select.is-shown {
    opacity: 1;
  }
  .fl-group-select input {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    min-height: 0;
    margin: 0;
    opacity: 0;
    cursor: pointer;
  }
  .fl-group-select > span {
    display: grid;
    place-items: center;
    width: 20px;
    height: 20px;
    border: 2px solid var(--fl-muted);
    border-radius: 50%;
    color: var(--fl-accent-text);
  }
  .fl-group-select.is-active > span {
    background: var(--fl-accent);
    border-color: var(--fl-accent);
  }
  .fl-group-select:has(input:focus-visible) > span {
    outline: 2px solid var(--fl-accent);
    outline-offset: 2px;
  }
  /* Prototype `timeline-library.css`: without hover the checkbox always shows. */
  @media (hover: none) {
    .fl-group-select {
      opacity: 1;
    }
  }
  /* Prototype `timeline-library.css` `@container (max-width: 600px)`: a smaller title and a larger
     touch target. The container is the timeline (`LibraryTimeline` `.fl-timeline`). */
  @container fl-timeline (max-width: 600px) {
    .fl-group-header h2 {
      font-size: var(--fl-font-small, 12px);
    }
    .fl-group-select {
      width: 36px;
      height: 36px;
      margin-inline-start: -8px;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .fl-group-select {
      transition: none;
    }
  }
</style>
