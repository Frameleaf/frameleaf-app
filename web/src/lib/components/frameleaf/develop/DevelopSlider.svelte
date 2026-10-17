<script lang="ts">
  /** The develop editor's slider (prototype PhotographyEditor.jsx `Slider`): label, value and range. */
  let {
    label,
    value,
    min = -100,
    max = 100,
    step = 1,
    format,
    disabled = false,
    onChange,
  }: {
    label: string;
    value: number;
    min?: number;
    max?: number;
    step?: number;
    format?: (value: number) => string;
    disabled?: boolean;
    onChange: (value: number) => void;
  } = $props();
  const id = $props.id();
  const shown = $derived(format ? format(value) : `${value > 0 && min < 0 ? '+' : ''}${Math.round(value)}`);
</script>

<label class="rde-slider" for={id}>
  <span><span>{label}</span><output for={id}>{shown}</output></span>
  <input
    {id}
    type="range"
    {min}
    {max}
    {step}
    {value}
    {disabled}
    oninput={(event) => onChange(Number(event.currentTarget.value))}
  />
</label>
