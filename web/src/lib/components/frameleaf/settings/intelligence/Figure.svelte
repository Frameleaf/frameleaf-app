<script lang="ts">
  /**
   * A number that may have decimals, with its scale in words (the prototype's `Figure` in
   * `settings-v2/care/shared.jsx`). Only for Advanced sections. Like the kit's Amount it reports a
   * value only while what is typed is a number within its bounds; until then the field is marked
   * invalid and the last good value stands.
   */
  let {
    label,
    value,
    unit,
    min,
    max,
    step = 0.01,
    disabled = false,
    onChange,
  }: {
    label: string;
    value: number;
    unit: string;
    min: number;
    max: number;
    step?: number;
    disabled?: boolean;
    onChange: (value: number) => void;
  } = $props();

  let typed = $state<string>();
  const parse = (text: string) => {
    const number = Number(text);
    return text.trim() !== '' && Number.isFinite(number) && number >= min && number <= max ? number : null;
  };
  const input = (text: string) => {
    const number = parse(text);
    typed = number === null ? text : undefined;
    if (number !== null && number !== value) {
      onChange(number);
    }
  };
</script>

<label class="figure">
  <input
    type="number"
    aria-label={label}
    {min}
    {max}
    {step}
    {disabled}
    aria-invalid={typed !== undefined}
    value={typed ?? String(value)}
    oninput={(event) => input(event.currentTarget.value)}
  />
  <span>{unit}</span>
</label>

<style>
  .figure {
    display: flex;
    align-items: center;
    gap: var(--fl-space-2);
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
  }
  input {
    width: 96px;
    min-height: var(--fl-control-height);
    padding: 0 var(--fl-space-3);
    color: var(--fl-text);
    text-align: end;
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  input:disabled {
    opacity: 0.6;
  }
  input[aria-invalid='true'] {
    border-color: var(--fl-danger);
  }
  input:focus-visible {
    outline: var(--fl-focus-ring);
    outline-offset: var(--fl-focus-offset);
  }
</style>
