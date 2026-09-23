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
    /** Tooltip, e.g. the full date of a day. */
    fullTitle?: string;
    count: number;
    state: 'none' | 'some' | 'all';
    width: number;
    height: number;
    onSelect?: (checked: boolean) => void;
  };

  let { id, title, fullTitle, count, state, width, height, onSelect }: Props = $props();
</script>

<header class="fl-group-header" style:width="{width}px" style:height="{height}px">
  <label class="fl-group-select" class:is-active={state !== 'none'}>
    <input
      type="checkbox"
      checked={state === 'all'}
      indeterminate={state === 'some'}
      aria-label={$t('frameleaf_library_select_all_in_group', { values: { title } })}
      onchange={(event) => onSelect?.(event.currentTarget.checked)}
    />
    <span aria-hidden="true">
      {#if state === 'all'}
        <Icon icon={mdiCheck} size="13" />
      {:else if state === 'some'}
        <Icon icon={mdiMinus} size="13" />
      {/if}
    </span>
  </label>
  <h2 {id} title={fullTitle}>{title}</h2>
  <span class="fl-group-count">{$t('items_count', { values: { count } })}</span>
</header>

<style>
  .fl-group-header {
    position: sticky;
    top: 0;
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
  :global(.is-selecting) .fl-group-select,
  .fl-group-select:focus-within,
  .fl-group-select.is-active {
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
  @media (prefers-reduced-motion: reduce) {
    .fl-group-select {
      transition: none;
    }
  }
</style>
