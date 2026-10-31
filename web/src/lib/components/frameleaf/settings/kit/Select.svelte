<script lang="ts">
  /** A choice from a longer list, for the control side of a Row. */
  let {
    label,
    value,
    options,
    disabled = false,
    describedBy,
    onChange,
  }: {
    label: string;
    value: string;
    options: { value: string; label: string }[];
    disabled?: boolean;
    describedBy?: string;
    onChange: (value: string) => void;
  } = $props();
</script>

<select
  class="kit-select"
  aria-label={label}
  aria-describedby={describedBy}
  {value}
  {disabled}
  onchange={(event) => onChange(event.currentTarget.value)}
>
  {#each options as option (option.value)}
    <option value={option.value}>{option.label}</option>
  {/each}
</select>

<style>
  .kit-select {
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
  .kit-select:disabled {
    opacity: 0.6;
  }
  .kit-select:focus-visible {
    outline: var(--fl-focus-ring);
    outline-offset: var(--fl-focus-offset);
  }
  @container kit (max-width: 620px) {
    .kit-select {
      width: 100%;
    }
  }
</style>
