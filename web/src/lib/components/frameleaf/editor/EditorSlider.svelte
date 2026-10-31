<script lang="ts">
  /**
   * One develop slider (FL-113). Bipolar ranges fill from the centre so the direction of a
   * change is visible; a changed value is marked beside the label as well as by the fill, and a
   * double-click on the track resets it. `format` supplies the text of the output element.
   */
  let {
    id,
    label,
    value,
    min,
    max,
    step = 1,
    defaultValue = 0,
    disabled = false,
    format = String,
    onChange,
  }: {
    id: string;
    label: string;
    value: number;
    min: number;
    max: number;
    step?: number;
    defaultValue?: number;
    disabled?: boolean;
    format?: (value: number) => string;
    onChange: (value: number) => void;
  } = $props();

  const inputId = $props.id();
  const percent = (v: number) => ((v - min) / (max - min)) * 100;
  const bipolar = $derived(min < 0 && max > 0);
  const zero = $derived(bipolar ? percent(0) : 0);
  const fillStart = $derived(Math.min(zero, percent(value)));
  const fillEnd = $derived(Math.max(zero, percent(value)));
</script>

<div class={['ed-slider', bipolar && 'bipolar', value !== defaultValue && 'changed']}>
  <label for={inputId}>{label}</label>
  <output for={inputId}>{format(value)}</output>
  <input
    id={inputId}
    data-param={id}
    type="range"
    {min}
    {max}
    {step}
    {value}
    {disabled}
    aria-valuetext={format(value)}
    style="--fill-start: {fillStart}%; --fill-end: {fillEnd}%"
    oninput={(event) => onChange(Number(event.currentTarget.value))}
    ondblclick={() => onChange(defaultValue)}
  />
</div>
