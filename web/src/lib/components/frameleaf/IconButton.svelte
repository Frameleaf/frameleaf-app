<script lang="ts">
  import type { Snippet } from 'svelte';
  /**
   * A square action button whose only content is an icon. `label` is required and is the
   * accessible name; the icon snippet is rendered aria-hidden so it is never announced.
   * Callers pass their own icon component, so no icon catalogue is bundled here.
   */
  let {
    label,
    variant = 'quiet',
    type = 'button',
    disabled = false,
    pressed,
    href,
    onclick,
    children,
  }: {
    label: string;
    variant?: 'default' | 'primary' | 'quiet';
    type?: 'button' | 'submit' | 'reset';
    disabled?: boolean;
    /** Sets aria-pressed for a two-state control such as a favourite toggle. */
    pressed?: boolean;
    /** Renders an `<a>` instead of a `<button>` for a control that navigates. */
    href?: string;
    onclick?: (event: MouseEvent) => void;
    children: Snippet;
  } = $props();
</script>

{#if href}
  <a {href} class={variant} aria-label={label} aria-current={pressed ? 'true' : undefined} {onclick}>
    <span aria-hidden="true">{@render children()}</span>
  </a>
{:else}
  <button {type} {disabled} class={variant} aria-label={label} aria-pressed={pressed} {onclick}>
    <span aria-hidden="true">{@render children()}</span>
  </button>
{/if}

<style>
  a,
  button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    /* Matches the 44px floor the token sheet sets for every control. */
    min-width: 44px;
    padding: 0.375rem;
    color: var(--fl-text);
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--fl-radius-control);
    transition:
      background var(--fl-motion-fast) var(--fl-ease),
      color var(--fl-motion-fast) var(--fl-ease);
  }
  span {
    display: inline-flex;
  }
  a:hover,
  button:hover:not(:disabled) {
    background: var(--fl-raised);
  }
  a.default,
  button.default {
    background: var(--fl-raised);
    border-color: var(--fl-border);
  }
  a.default:hover,
  button.default:hover:not(:disabled) {
    background: color-mix(in srgb, var(--fl-raised), var(--fl-text) 8%);
  }
  a.primary,
  button.primary {
    color: var(--fl-accent-text);
    background: var(--fl-accent);
    border-color: var(--fl-accent);
  }
  a.primary:hover,
  button.primary:hover:not(:disabled) {
    background: color-mix(in srgb, var(--fl-accent), var(--fl-text) 12%);
  }
  /* After the variants so a pressed control of any variant still reads as pressed. */
  a[aria-current='true']:not(.primary),
  button[aria-pressed='true']:not(.primary, :disabled) {
    color: var(--fl-accent);
    background: var(--fl-accent-soft);
    border-color: var(--fl-accent);
  }
  /*
   * The muted colours already read as disabled; the baseline's 0.45 opacity for text buttons
   * (base.css) is cancelled so an icon button is not dimmed twice.
   */
  button:disabled {
    opacity: 1;
    cursor: not-allowed;
    color: var(--fl-muted);
    background: var(--fl-canvas);
    border-color: var(--fl-border);
  }
</style>
