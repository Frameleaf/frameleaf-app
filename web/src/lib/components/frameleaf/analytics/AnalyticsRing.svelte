<script lang="ts">
  /**
   * A progress ring (FL-79), the template's `Ring` (AnalyticsDashboard.jsx:55-79). The value sweeps
   * in on the spring curve, and simply appears under Reduce Motion.
   */
  import type { Snippet } from 'svelte';

  type Props = { value: number; size?: number; stroke?: number; label: string; children?: Snippet };
  let { value, size = 64, stroke = 7, label, children }: Props = $props();

  const radius = $derived((size - stroke) / 2);
  const circumference = $derived(2 * Math.PI * radius);
</script>

<div class="an-ring" style:width="{size}px" style:height="{size}px">
  <svg viewBox="0 0 {size} {size}" role="img" aria-label={label}>
    <circle cx={size / 2} cy={size / 2} r={radius} class="track" stroke-width={stroke} />
    <circle
      cx={size / 2}
      cy={size / 2}
      r={radius}
      class="value"
      stroke-width={stroke}
      stroke-dasharray="{(Math.min(100, Math.max(0, value)) / 100) * circumference} {circumference}"
      transform="rotate(-90 {size / 2} {size / 2})"
    />
  </svg>
  {#if children}<span class="center">{@render children()}</span>{/if}
</div>

<style>
  .an-ring {
    position: relative;
    flex-shrink: 0;
  }
  svg {
    display: block;
    width: 100%;
    height: 100%;
  }
  .track {
    fill: none;
    stroke: var(--an-cell);
  }
  .value {
    fill: none;
    stroke: var(--an-1);
    stroke-linecap: round;
    transition: stroke-dasharray 900ms var(--fl-spring, ease);
  }
  .center {
    position: absolute;
    inset: 0;
    display: grid;
    place-content: center;
    font-size: 15px;
    font-weight: 650;
    font-variant-numeric: tabular-nums;
    text-align: center;
  }
  @media (prefers-reduced-motion: reduce) {
    .value {
      transition: none;
    }
  }
</style>
