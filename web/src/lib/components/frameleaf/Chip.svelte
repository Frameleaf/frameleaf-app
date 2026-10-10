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
    <button type="button" class="fl-control" aria-label={removeLabel} onclick={onRemove}>
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
    min-height: 1.75rem;
    font-size: var(--fl-font-small);
    font-variant-numeric: var(--fl-numeric);
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-pill);
  }
  /* Selection is an accent job; the accompanying label still states the condition. */
  .chip.selected {
    border-color: var(--fl-accent);
    background: var(--fl-accent-soft);
    font-weight: 500;
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
  /*
   * The remove mark is drawn at chip size so a removable chip is as tall as a plain one; the
   * pseudo-element keeps the pointer target at the full control height around it.
   */
  button {
    position: relative;
    display: inline-grid;
    flex-shrink: 0;
    place-items: center;
    width: 1.5rem;
    min-width: 0;
    height: 1.5rem;
    min-height: 0;
    margin-inline-end: 0.125rem;
    padding: 0;
    color: inherit;
    background: transparent;
    border: 0;
    border-radius: var(--fl-radius-pill);
  }
  button::after {
    position: absolute;
    inset: calc((1.5rem - var(--fl-control-height)) / 2);
    content: '';
  }
  button:hover {
    background: color-mix(in srgb, var(--fl-raised), var(--fl-text) 12%);
  }
</style>
