<script lang="ts">
  /**
   * A small group of mutually exclusive view choices, matching the prototype's filter
   * segments. Each segment is an ordinary button carrying aria-pressed inside a labelled
   * group, so every segment is reachable with Tab and needs no roving-focus contract; the
   * pressed segment is distinguished by an elevated surface as well as the accent, so the
   * state is not carried by colour alone.
   *
   * Options and their counts come from the caller and are already translated.
   */
  let {
    label,
    options,
    value = $bindable(),
    disabled = false,
    onChange,
  }: {
    /** Accessible name for the group, for example "Media type". */
    label: string;
    /**
     * `label` is the segment's accessible name. `hint` is a decorative count, hidden from
     * assistive technology; callers that need the count announced fold it into `label`,
     * the way Picker options read "Camera A (12)".
     */
    options: { value: string; label: string; hint?: string }[];
    value?: string;
    disabled?: boolean;
    onChange?: (value: string) => void;
  } = $props();

  const select = (next: string) => {
    value = next;
    onChange?.(next);
  };
</script>

<div role="group" aria-label={label} class="segments">
  {#each options as option (option.value)}
    <button type="button" {disabled} aria-pressed={value === option.value} onclick={() => select(option.value)}>
      {option.label}{#if option.hint}<small aria-hidden="true">{option.hint}</small>{/if}
    </button>
  {/each}
</div>

<style>
  .segments {
    display: inline-flex;
    padding: 0.1875rem;
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  button {
    flex: 1;
    padding: 0.3125rem 0.625rem;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
    background: transparent;
    border: 0;
    border-radius: var(--fl-radius);
    transition:
      background var(--fl-motion-fast) var(--fl-ease),
      color var(--fl-motion-fast) var(--fl-ease);
  }
  button:hover:not(:disabled) {
    color: var(--fl-text);
  }
  button[aria-pressed='true'] {
    color: var(--fl-text);
    background: var(--fl-panel);
    box-shadow: var(--fl-shadow-1);
  }
  button:disabled {
    color: var(--fl-muted);
    box-shadow: none;
  }
  small {
    margin-inline-start: 0.3125rem;
    font-size: var(--fl-font-micro);
    color: var(--fl-muted);
  }
</style>
