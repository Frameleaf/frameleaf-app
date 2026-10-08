<script lang="ts">
  /**
   * The typed confirmation of a destructive action that is unbounded or server-wide: emptying the
   * trash, removing a library, deleting an account, revoking a worker, applying a deduplication
   * plan (design review finding 74, tier 2). A bounded action on the account's own items takes a
   * summary and a danger button instead (`confirmFrameleaf({ danger: true })`).
   *
   * Every such dialog uses this field so the ritual looks and behaves the same: the label names
   * what to type, capitals and surrounding spaces do not matter (`matchesTyped`), Cancel comes
   * first and the action is the danger button, disabled until the phrase matches.
   */
  type Props = {
    /** The visible label, naming what to type: "Type the library name to confirm". */
    label: string;
    /** What was typed; compare it with `matchesTyped(phrase, value)`. */
    value?: string;
    /** Shown in the empty field when the label does not spell the phrase out. */
    placeholder?: string;
    /** The accessible name when it must differ from the visible label. */
    ariaLabel?: string;
    disabled?: boolean;
    /** The field takes focus when its dialog opens. */
    initialFocus?: boolean;
    maxlength?: number;
  };

  let {
    label,
    value = $bindable(''),
    placeholder,
    ariaLabel,
    disabled = false,
    initialFocus = false,
    maxlength,
  }: Props = $props();

  const id = $props.id();
</script>

<label class="typed-confirmation" for={id}>
  <span>{label}</span>
  <input
    {id}
    type="text"
    autocomplete="off"
    autocapitalize="off"
    spellcheck="false"
    required
    aria-label={ariaLabel}
    data-initial-focus={initialFocus ? '' : undefined}
    {placeholder}
    {maxlength}
    {disabled}
    bind:value
  />
</label>

<style>
  .typed-confirmation {
    display: grid;
    gap: var(--fl-space-2);
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.5;
  }
  .typed-confirmation input {
    width: 100%;
    min-height: var(--fl-control-height);
    margin: 0;
    padding: var(--fl-space-2) var(--fl-space-3);
    font: inherit;
    font-size: var(--fl-font-size);
    color: var(--fl-text);
    background: var(--fl-canvas);
    border: 1px solid var(--fl-border-strong);
    border-radius: var(--fl-radius-control);
  }
  .typed-confirmation input:focus-visible {
    outline: var(--fl-focus-ring);
    outline-offset: var(--fl-focus-offset);
  }
  .typed-confirmation input:disabled {
    opacity: 0.6;
  }
</style>
