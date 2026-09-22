<script lang="ts">
  import type { Snippet } from 'svelte';
  /**
   * The general Frameleaf chip: a pill that states an active condition and can offer a
   * removal control. Filter chips carrying face evidence use FilterChip, which adds the
   * person avatar and its privacy contract on top of the same shape.
   *
   * `removeLabel` must name what is removed, not just say "Remove"; the caller performs the
   * real mutation in `onRemove`.
   */
  let {
    label,
    removeLabel,
    onRemove,
    selected = false,
    leading,
  }: {
    label: string;
    removeLabel?: string;
    onRemove?: () => void;
    selected?: boolean;
    leading?: Snippet;
  } = $props();
</script>

<span class="chip" class:selected>
  {#if leading}<span class="leading" aria-hidden="true">{@render leading()}</span>{/if}
  <span class="label">{label}</span>
  {#if onRemove && removeLabel}
    <button type="button" aria-label={removeLabel} onclick={onRemove}>
      <span aria-hidden="true">&times;</span>
    </button>
  {/if}
</span>

<style>
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    max-width: 100%;
    padding-inline-start: 0.6875rem;
    padding-block: 0.25rem;
    font-size: var(--fl-font-small);
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-pill);
  }
  /* Selection is an accent job; the accompanying label still states the condition. */
  .chip.selected {
    border-color: var(--fl-accent);
    background: var(--fl-accent-soft);
  }
  .chip:not(:has(button)) {
    padding-inline-end: 0.6875rem;
  }
  .leading {
    display: inline-flex;
    flex-shrink: 0;
  }
  .label {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  button {
    flex-shrink: 0;
    min-width: 44px;
    color: inherit;
    background: transparent;
    border: 0;
    border-radius: var(--fl-radius-pill);
  }
  button:hover {
    background: color-mix(in srgb, var(--fl-raised), var(--fl-text) 12%);
  }
</style>
