<script lang="ts">
  import type { Snippet } from 'svelte';
  /**
   * The Frameleaf text button. `primary` is reserved for the single primary action of a
   * surface, because the accent also carries selection and focus; status belongs on Badge.
   * Callers supply translated content and own the action.
   */
  let {
    variant = 'default',
    type = 'button',
    disabled = false,
    pressed,
    label,
    onclick,
    children,
  }: {
    variant?: 'default' | 'primary' | 'quiet';
    type?: 'button' | 'submit' | 'reset';
    disabled?: boolean;
    /** Sets aria-pressed for a two-state action; leave undefined for a plain action. */
    pressed?: boolean;
    /** Only needed when the visible content is not a sufficient accessible name. */
    label?: string;
    onclick?: (event: MouseEvent) => void;
    children: Snippet;
  } = $props();
</script>

<button {type} {disabled} class={variant} aria-pressed={pressed} aria-label={label} {onclick}>
  {@render children()}
</button>

<style>
  button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    flex-shrink: 0;
    white-space: nowrap;
    padding: 0.4375rem 0.6875rem;
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    transition:
      background var(--fl-motion-fast) var(--fl-ease),
      border-color var(--fl-motion-fast) var(--fl-ease),
      color var(--fl-motion-fast) var(--fl-ease);
  }
  button:hover:not(:disabled) {
    background: color-mix(in srgb, var(--fl-raised), var(--fl-text) 8%);
  }
  button.primary {
    font-weight: 600;
    color: var(--fl-accent-text);
    background: var(--fl-accent);
    border-color: var(--fl-accent);
  }
  button.primary:hover:not(:disabled) {
    background: color-mix(in srgb, var(--fl-accent), var(--fl-text) 12%);
  }
  button.quiet {
    background: transparent;
    border-color: transparent;
  }
  button.quiet:hover:not(:disabled) {
    background: var(--fl-raised);
  }
  /* After the variants so a pressed button of any variant still reads as pressed. */
  button[aria-pressed='true']:not(.primary, :disabled) {
    background: color-mix(in srgb, var(--fl-text) 12%, var(--fl-raised));
    border-color: color-mix(in srgb, var(--fl-text) 28%, var(--fl-border));
  }
  /* Last so a disabled button of any variant reads as disabled. */
  button:disabled {
    /* Dim the surface rather than the text so the label keeps its contrast. */
    color: var(--fl-muted);
    background: var(--fl-canvas);
    border-color: var(--fl-border);
  }
</style>
