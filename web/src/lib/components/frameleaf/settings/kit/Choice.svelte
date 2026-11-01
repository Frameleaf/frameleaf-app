<script lang="ts" module>
  export type ChoiceOption = { value: string; label: string; detail?: string; disabled?: boolean };
</script>

<script lang="ts">
  /**
   * One choice from a few, each said as an outcome with a line about what it means (the prototype's
   * `Choice`). A radio group: arrow keys move between the options.
   */
  let {
    label,
    value,
    options,
    disabled = false,
    onChange,
  }: {
    label: string;
    value: string;
    options: ChoiceOption[];
    disabled?: boolean;
    onChange?: (value: string) => void;
  } = $props();
  const name = $props.id();
</script>

<div class="kit-choice" role="radiogroup" aria-label={label}>
  {#each options as option (option.value)}
    <label class:is-on={option.value === value} class:is-disabled={disabled || option.disabled}>
      <input
        type="radio"
        {name}
        value={option.value}
        checked={option.value === value}
        disabled={disabled || option.disabled}
        onchange={() => onChange?.(option.value)}
      />
      <span>
        <strong>{option.label}</strong>
        {#if option.detail}<small>{option.detail}</small>{/if}
      </span>
    </label>
  {/each}
</div>

<style>
  .kit-choice {
    display: grid;
    gap: var(--fl-space-2);
    margin: var(--fl-space-2) 0 var(--fl-space-3);
  }
  label {
    display: flex;
    gap: var(--fl-space-3);
    align-items: flex-start;
    padding: var(--fl-space-3);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control, 10px);
    cursor: pointer;
  }
  label.is-on {
    border-color: var(--fl-accent);
    background: var(--fl-accent-soft, transparent);
  }
  label.is-disabled {
    cursor: default;
    opacity: 0.6;
  }
  /*
   * The radio keeps its own 18px size: the shared form-field look (padding, touch floor) would
   * otherwise squash it to a sliver beside a long option.
   */
  input {
    flex: none;
    width: 18px;
    height: 18px;
    min-width: 0;
    min-height: 0;
    margin: 0.125rem 0 0;
    padding: 0;
    accent-color: var(--fl-accent);
  }
  span {
    display: grid;
    gap: 0.15rem;
  }
  strong {
    color: var(--fl-text);
    font-weight: 600;
  }
  small {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.4;
  }
</style>
