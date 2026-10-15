<script lang="ts">
  /**
   * A slider with words at each end and the number beside it, for the image quality settings
   * (prototype `care/shared.jsx`, `Slider`). Reports whole numbers between `min` and `max`.
   */
  let {
    label,
    value,
    low,
    high,
    min = 1,
    max = 100,
    disabled = false,
    onChange,
  }: {
    label: string;
    value: number;
    low: string;
    high: string;
    min?: number;
    max?: number;
    disabled?: boolean;
    onChange: (value: number) => void;
  } = $props();
</script>

<label class="scale">
  <span class="end">{low}</span>
  <input
    type="range"
    aria-label={label}
    {min}
    {max}
    {value}
    {disabled}
    oninput={(event) => onChange(Number(event.currentTarget.value))}
  />
  <span class="end">{high}</span>
  <output>{value}</output>
</label>

<style>
  .scale {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--fl-space-2) var(--fl-space-3);
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  input {
    width: 160px;
    accent-color: var(--fl-accent);
  }
  input:disabled {
    opacity: 0.6;
  }
  input:focus-visible {
    outline: var(--fl-focus-ring);
    outline-offset: var(--fl-focus-offset);
  }
  output {
    min-width: 2.5ch;
    color: var(--fl-text);
    font-variant-numeric: tabular-nums;
    text-align: end;
  }
</style>
