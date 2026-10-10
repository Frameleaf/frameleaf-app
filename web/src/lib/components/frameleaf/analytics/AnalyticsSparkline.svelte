<script lang="ts">
  /** A tiny filled trend line (FL-79), the template's `Sparkline` (AnalyticsDashboard.jsx:43-53). */
  type Props = { values: number[]; label: string };
  let { values, label }: Props = $props();

  const points = $derived.by(() => {
    const max = Math.max(1, ...values);
    return values
      .map((value, index) => `${(index / Math.max(1, values.length - 1)) * 100},${30 - (value / max) * 28}`)
      .join(' ');
  });
</script>

<svg class="an-spark" viewBox="0 0 100 30" preserveAspectRatio="none" role="img" aria-label={label}>
  <polygon points="0,30 {points} 100,30" class="fill" />
  <polyline {points} class="line" vector-effect="non-scaling-stroke" />
</svg>

<style>
  .an-spark {
    width: 100%;
    height: 34px;
    margin-top: auto;
  }
  .line {
    fill: none;
    stroke: var(--an-1);
    stroke-width: 2;
    stroke-linejoin: round;
  }
  .fill {
    fill: color-mix(in srgb, var(--an-1) 16%, transparent);
  }
</style>
