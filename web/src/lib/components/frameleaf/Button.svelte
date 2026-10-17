<script lang="ts">
  import type { Snippet } from 'svelte';
  /**
   * The Frameleaf text button. `primary` is reserved for the single primary action of a
   * surface, because the accent also carries selection and focus; status belongs on Badge.
   * `danger` is the template's `.resource-button.danger` (accounts-libraries.css:63-65): an
   * ordinary button whose label is in the danger colour, for an irreversible confirmation.
   * Callers supply translated content and own the action.
   */
  let {
    variant = 'default',
    type = 'button',
    disabled = false,
    pressed,
    label,
    initialFocus = false,
    onclick,
    children,
  }: {
    variant?: 'default' | 'primary' | 'quiet' | 'danger';
    type?: 'button' | 'submit' | 'reset';
    disabled?: boolean;
    /** Sets aria-pressed for a two-state action; leave undefined for a plain action. */
    pressed?: boolean;
    /** Only needed when the visible content is not a sufficient accessible name. */
    label?: string;
    /** Marks the control a Frameleaf Dialog focuses when it opens, as the prototype's `data-initial-focus`. */
    initialFocus?: boolean;
    onclick?: (event: MouseEvent) => void;
    children: Snippet;
  } = $props();
</script>

<button
  {type}
  {disabled}
  class="fl-control {variant}"
  aria-pressed={pressed}
  aria-label={label}
  data-initial-focus={initialFocus ? '' : undefined}
  {onclick}
>
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
    /* The Press pattern (base.css): settle on the spring, colours on the ease curve. */
    transition:
      transform var(--fl-duration) var(--fl-spring),
      background-color var(--fl-motion-fast) var(--fl-ease),
      border-color var(--fl-motion-fast) var(--fl-ease),
      color var(--fl-motion-fast) var(--fl-ease);
  }
  /* The 44px/48px height floor comes from tokens.css; the prototype's 34px is not ported. */
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
    background: var(--fl-accent-hover);
    border-color: var(--fl-accent-hover);
  }
  button.primary:active:not(:disabled) {
    background: var(--fl-accent-pressed);
    border-color: var(--fl-accent-pressed);
  }
  button.danger {
    font-weight: 600;
    color: var(--fl-danger);
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
  button:active:not(:disabled) {
    transform: scale(0.96);
    transition-duration: var(--fl-duration-press);
  }
  @media (prefers-reduced-motion: reduce) {
    button:active:not(:disabled) {
      transform: none;
    }
  }
  /* Last so a disabled button of any variant reads as disabled, as the prototype dims it. */
  button:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
</style>
