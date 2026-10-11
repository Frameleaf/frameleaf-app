<script lang="ts">
  /**
   * A number with its unit in words, for the few places a number is the right control. It reports a
   * value only while what is typed is a whole number within its bounds; until then the field is
   * marked invalid and the last good value stands.
   */
  let {
    label,
    value,
    unit,
    min = 0,
    max = 365,
    disabled = false,
    onChange,
  }: {
    label: string;
    value: number;
    unit: string;
    min?: number;
    max?: number;
    disabled?: boolean;
    onChange: (value: number) => void;
  } = $props();

  /** What is in the field while it is not a value the setting accepts. */
  let typed = $state<string>();
  const parse = (text: string) => {
    const number = Number(text);
    return text.trim() !== '' && Number.isSafeInteger(number) && number >= min && number <= max ? number : null;
  };
  const input = (text: string) => {
    const number = parse(text);
    typed = number === null ? text : undefined;
    if (number !== null && number !== value) {
      onChange(number);
    }
  };
</script>

<label class="kit-amount">
  <input
    type="number"
    aria-label={label}
    {min}
    {max}
    step="1"
    {disabled}
    aria-invalid={typed !== undefined}
    value={typed ?? String(value)}
    oninput={(event) => input(event.currentTarget.value)}
  />
  <span>{unit}</span>
</label>

<style>
  .kit-amount {
    display: flex;
    align-items: center;
    gap: var(--fl-space-2);
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
  }
  input {
    width: 88px;
    min-height: var(--fl-control-height);
    padding: 0 var(--fl-space-3);
    color: var(--fl-text);
    text-align: end;
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  input[aria-invalid='true'] {
    border-color: var(--fl-danger);
  }
  input:focus-visible {
    outline: var(--fl-focus-ring);
    outline-offset: var(--fl-focus-offset);
  }
</style>
