<script lang="ts" module>
  import { PersistedLocalStorage } from '$lib/utils/persisted';

  /**
   * Which folds were left open, by fold id. Kept in this browser, beside the panel's own open state
   * (`asset-viewer-state`): there is no per-account store for viewer layout. It names no content, so
   * it is a device preference that a lock or sign-out keeps (`DEVICE_PREFERENCE_KEYS`).
   */
  /**
   * The only folds there are. Fixed names on purpose: the store outlives a sign-out, so it must never
   * hold anything tied to an item or an account (an asset id, an album name).
   */
  export type FoldId = 'details' | 'credits' | 'sensitive' | 'scan' | 'text';

  const folds = new PersistedLocalStorage<Partial<Record<FoldId, boolean>>>('frameleaf-viewer-info-folds', {});
</script>

<script lang="ts">
  /**
   * A rarely used part of the information panel that folds away (FL-1811, prototype `InfoFold`).
   * It starts closed and remembers whether it was left open. Its content stays mounted while closed,
   * so a fold with nothing to show for this item can hide itself (the `:has` rule below).
   */
  import { Icon } from '@frameleaf/ui';
  import { mdiChevronDown } from '@mdi/js';
  import type { Snippet } from 'svelte';

  type Props = {
    id: FoldId;
    label: string;
    /** Keep the headings of the sections inside: for a fold that holds more than one kind of thing. */
    headings?: boolean;
    children: Snippet;
  };

  let { id, label, headings = false, children }: Props = $props();

  const onToggle = (event: Event & { currentTarget: HTMLDetailsElement }) => {
    const open = event.currentTarget.open;
    if ((folds.current[id] ?? false) !== open) {
      folds.current = { ...folds.current, [id]: open };
    }
  };
</script>

<details class="fl-fold" class:headings open={folds.current[id] ?? false} ontoggle={onToggle} data-fold={id}>
  <summary>
    {label}
    <Icon icon={mdiChevronDown} size="16" aria-hidden />
  </summary>
  {@render children()}
</details>

<style>
  /* .mv-fold (prototype media-viewer.css): one band, like the sections around it. */
  .fl-fold {
    border-bottom: 1px solid var(--fl-viewer-border);
  }
  .fl-fold > summary {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--fl-space-2);
    min-height: 44px;
    color: var(--fl-viewer-text);
    font-size: var(--fl-font-small);
    font-weight: 550;
    cursor: pointer;
    list-style: none;
  }
  .fl-fold > summary::-webkit-details-marker {
    display: none;
  }
  .fl-fold > summary:focus-visible {
    border-radius: var(--fl-radius-xs);
    outline: 2px solid var(--fl-viewer-focus);
    outline-offset: 2px;
  }
  .fl-fold > summary :global(svg) {
    flex-shrink: 0;
    color: var(--fl-viewer-muted);
    transition: rotate var(--fl-motion) var(--fl-ease);
  }
  .fl-fold[open] > summary :global(svg) {
    rotate: 180deg;
  }

  /* The sections inside lose their own divider; the fold draws one for all of them. */
  .fl-fold > :global(section) {
    margin: 0;
    padding: var(--fl-space-2) 0 var(--fl-space-4);
    border-bottom: 0;
  }

  /* The summary already names the section; an action beside the heading stays, at the end of its row. */
  .fl-fold:not(.headings) > :global(section > .fl-info-heading),
  .fl-fold:not(.headings) > :global(section > .fl-info-heading-row > .fl-info-heading),
  .fl-fold:not(.headings) > :global(section > .fl-info-heading-row:not(:has(> :not(.fl-info-heading)))) {
    display: none;
  }
  .fl-fold:not(.headings) > :global(section > .fl-info-heading-row) {
    justify-content: flex-end;
  }

  /* Nothing to show for this item: no empty heading is left behind. */
  .fl-fold:not(:has(> :not(summary))) {
    display: none;
  }
</style>
