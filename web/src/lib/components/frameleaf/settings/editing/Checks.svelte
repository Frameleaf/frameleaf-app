<script lang="ts" generics="T extends string | number">
  /**
   * Several choices that can all be on, for the video format lists under Advanced. A `locked` choice
   * stays ticked and cannot be cleared (the format copies are made in is always accepted).
   */
  let {
    label,
    value,
    options,
    locked = [],
    disabled = false,
    onChange,
  }: {
    label: string;
    value: T[];
    options: { value: T; label: string }[];
    locked?: T[];
    disabled?: boolean;
    onChange: (value: T[]) => void;
  } = $props();

  const toggle = (option: T, on: boolean) => {
    const rest = value.filter((item) => item !== option);
    onChange(on ? [...rest, option] : rest);
  };
</script>

<div class="checks" role="group" aria-label={label}>
  {#each options as option (option.value)}
    <label>
      <input
        type="checkbox"
        checked={value.includes(option.value) || locked.includes(option.value)}
        disabled={disabled || locked.includes(option.value)}
        onchange={(event) => toggle(option.value, event.currentTarget.checked)}
      />
      {option.label}
    </label>
  {/each}
</div>

<style>
  .checks {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fl-space-2) var(--fl-space-4);
    font-size: var(--fl-font-callout);
  }
  label {
    display: inline-flex;
    align-items: center;
    gap: var(--fl-space-2);
    min-height: var(--fl-control-height);
  }
  input {
    accent-color: var(--fl-accent);
  }
  input:focus-visible {
    outline: var(--fl-focus-ring);
    outline-offset: var(--fl-focus-offset);
  }
</style>
