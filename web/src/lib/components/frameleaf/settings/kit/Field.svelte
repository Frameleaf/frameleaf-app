<script lang="ts">
  /** A text box for the control side of a Row. It reports what is typed; the page owns the value. */
  import type { HTMLInputAttributes } from 'svelte/elements';

  let {
    label,
    value,
    type = 'text',
    placeholder,
    wide = false,
    disabled = false,
    invalid = false,
    describedBy,
    autocomplete = 'off',
    onChange,
  }: {
    label: string;
    value: string;
    type?: 'text' | 'email' | 'password' | 'url' | 'number';
    placeholder?: string;
    wide?: boolean;
    disabled?: boolean;
    invalid?: boolean;
    describedBy?: string;
    autocomplete?: HTMLInputAttributes['autocomplete'];
    onChange?: (value: string) => void;
  } = $props();
</script>

<input
  class="kit-field"
  class:is-wide={wide}
  {type}
  aria-label={label}
  aria-describedby={describedBy}
  aria-invalid={invalid || undefined}
  {value}
  {placeholder}
  {disabled}
  {autocomplete}
  oninput={(event) => onChange?.(event.currentTarget.value)}
/>

<style>
  .kit-field {
    width: 300px;
    max-width: 100%;
    min-height: var(--fl-control-height);
    padding: 0 var(--fl-space-3);
    color: var(--fl-text);
    font: inherit;
    font-size: var(--fl-font-callout);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .kit-field.is-wide {
    width: 380px;
  }
  .kit-field::placeholder {
    color: var(--fl-muted);
  }
  .kit-field:disabled {
    opacity: 0.6;
  }
  .kit-field[aria-invalid='true'] {
    border-color: var(--fl-danger);
  }
  .kit-field:focus-visible {
    outline: var(--fl-focus-ring);
    outline-offset: var(--fl-focus-offset);
  }
  @container kit (max-width: 620px) {
    .kit-field,
    .kit-field.is-wide {
      width: 100%;
    }
  }
</style>
