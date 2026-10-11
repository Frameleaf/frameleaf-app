<script lang="ts">
  /**
   * The Locked view's filter (FL-34): All, the items moved over from the old Locked folder, the ones
   * the owner locked, and the ones sensitive-content detection locked. All is the default.
   */
  import { LOCKED_FILTERS, lockedFilterLabelKey, type LockedFilter } from '$lib/frameleaf/locked-view';
  import { t } from 'svelte-i18n';

  interface Props {
    value: LockedFilter;
    onChange: (filter: LockedFilter) => void;
  }

  let { value, onChange }: Props = $props();
</script>

<div class="fl-locked-filter" role="group" aria-label={$t('frameleaf_lock_filter_label')}>
  {#each LOCKED_FILTERS as filter (filter)}
    <button type="button" aria-pressed={value === filter} onclick={() => onChange(filter)}>
      {$t(lockedFilterLabelKey(filter))}
    </button>
  {/each}
</div>

<style>
  .fl-locked-filter {
    display: inline-flex;
    flex-wrap: wrap;
    gap: var(--fl-space-2);
  }
  /*
   * Phones: the page's title bar is one row, so the choices stay on one line and scroll sideways
   * instead of wrapping out of the bar. They take the room the title leaves, so the title is whole.
   */
  @media (max-width: 767px) {
    .fl-locked-filter {
      flex: 1 1 0;
      flex-wrap: nowrap;
      min-width: 0;
      overflow-x: auto;
      /* Room for the focus ring inside the scroller. */
      padding: var(--fl-space-1);
      scrollbar-width: none;
    }
    .fl-locked-filter button {
      flex: none;
    }
  }
  .fl-locked-filter button {
    min-height: 2rem;
    padding: 0 0.875rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-pill);
    background: var(--fl-panel);
    color: var(--fl-text);
    font-size: 0.875rem;
  }
  .fl-locked-filter button[aria-pressed='true'] {
    border-color: var(--fl-accent);
    background: var(--fl-raised);
  }
  .fl-locked-filter button:focus-visible {
    outline: var(--fl-focus-ring);
    outline-offset: var(--fl-focus-offset);
  }
</style>
