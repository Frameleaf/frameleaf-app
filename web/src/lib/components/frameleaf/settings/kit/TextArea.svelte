<script lang="ts">
  /** A bigger text box that fills its group, for a message or a block of styling (`code`). */
  let {
    label,
    value,
    rows = 4,
    placeholder,
    code = false,
    disabled = false,
    describedBy,
    onChange,
  }: {
    label: string;
    value: string;
    rows?: number;
    placeholder?: string;
    code?: boolean;
    disabled?: boolean;
    describedBy?: string;
    onChange?: (value: string) => void;
  } = $props();
</script>

<textarea
  class="kit-area"
  class:is-code={code}
  aria-label={label}
  aria-describedby={describedBy}
  {rows}
  {value}
  {placeholder}
  {disabled}
  spellcheck={!code}
  oninput={(event) => onChange?.(event.currentTarget.value)}></textarea>

<style>
  .kit-area {
    display: block;
    width: 100%;
    margin-bottom: var(--fl-space-5);
    padding: var(--fl-space-3);
    color: var(--fl-text);
    font: inherit;
    font-size: var(--fl-font-callout);
    line-height: 1.5;
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    resize: vertical;
  }
  .kit-area.is-code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: var(--fl-font-small);
  }
  .kit-area::placeholder {
    color: var(--fl-muted);
  }
  .kit-area:disabled {
    opacity: 0.6;
  }
  .kit-area:focus-visible {
    outline: var(--fl-focus-ring);
    outline-offset: var(--fl-focus-offset);
  }
</style>
