<script lang="ts">
  /**
   * A two-state preference control. It is a real `role="switch"` button, so Space and Enter
   * both operate it, and the translated on/off text is rendered beside the track: the state
   * is never carried by the accent colour alone.
   *
   * The knob transition uses the shared motion token, which the token sheet already clamps
   * under prefers-reduced-motion.
   */
  let {
    label,
    checked = $bindable(false),
    onLabel,
    offLabel,
    disabled = false,
    describedBy,
    onChange,
  }: {
    /** Translated accessible name for the preference. */
    label: string;
    checked?: boolean;
    /** Translated "On" text. */
    onLabel: string;
    /** Translated "Off" text. */
    offLabel: string;
    disabled?: boolean;
    /** Id of the caller's help or error text. */
    describedBy?: string;
    onChange?: (checked: boolean) => void;
  } = $props();
</script>

<button
  type="button"
  role="switch"
  aria-checked={checked}
  aria-label={label}
  aria-describedby={describedBy}
  {disabled}
  onclick={() => {
    checked = !checked;
    onChange?.(checked);
  }}
>
  <span class="track" aria-hidden="true"></span>
  <span class="state">{checked ? onLabel : offLabel}</span>
</button>

<style>
  button {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.25rem;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--fl-radius-control);
  }
  .track {
    position: relative;
    display: block;
    flex-shrink: 0;
    width: 2rem;
    height: 1.125rem;
    background: var(--fl-border);
    border: 1px solid var(--fl-muted);
    border-radius: var(--fl-radius-pill);
  }
  .track::after {
    content: '';
    position: absolute;
    inset-block-start: 0.125rem;
    inset-inline-start: 0.125rem;
    width: 0.6875rem;
    height: 0.6875rem;
    background: var(--fl-muted);
    border-radius: 50%;
    transition: inset-inline-start var(--fl-motion-fast) var(--fl-ease);
  }
  button[aria-checked='true'] {
    color: var(--fl-text);
  }
  button[aria-checked='true'] .track {
    background: var(--fl-accent);
    border-color: var(--fl-accent);
  }
  button[aria-checked='true'] .track::after {
    inset-inline-start: 1.0625rem;
    background: var(--fl-accent-text);
  }
  /*
   * A disabled switch keeps its on/off colours: the state still has to be legible, and the
   * `disabled` attribute plus the muted text is what actually reports unavailability.
   */
  button:disabled {
    color: var(--fl-muted);
  }
</style>
