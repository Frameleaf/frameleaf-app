<script lang="ts">
  import type { Snippet } from 'svelte';
  /**
   * One command inside a Menu. Focus is roving, so every item stays out of the tab order
   * and the owning Menu moves focus with the arrow keys. Menu closes and restores focus to
   * its trigger after activation, so `onSelect` only performs the caller's action.
   */
  let {
    onSelect,
    disabled = false,
    checked,
    children,
  }: {
    onSelect?: () => void;
    disabled?: boolean;
    /** Renders the item as a checkable command (role="menuitemcheckbox"). */
    checked?: boolean;
    children: Snippet;
  } = $props();
</script>

<button
  type="button"
  role={checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
  aria-checked={checked}
  aria-disabled={disabled ? 'true' : undefined}
  tabindex="-1"
  onclick={() => !disabled && onSelect?.()}
>
  {@render children()}
</button>

<style>
  button {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    width: 100%;
    padding: 0.5625rem 0.625rem;
    text-align: start;
    color: var(--fl-text);
    background: transparent;
    border: 0;
    border-radius: var(--fl-radius-control);
    transition: background var(--fl-motion-fast) var(--fl-ease);
  }
  button:hover:not([aria-disabled='true']),
  button:focus-visible {
    background: var(--fl-raised);
  }
  button[aria-checked='true'] {
    color: var(--fl-accent);
  }
  button[aria-disabled='true'] {
    color: var(--fl-muted);
    cursor: default;
  }
</style>
