<script lang="ts" module>
  export type DonutSegment = { id: string; label: string; value: number; color: string };
</script>

<script lang="ts">
  /**
   * A donut with its legend (FL-79), the template's `Donut` and `Legend`
   * (AnalyticsDashboard.jsx:81-139): one slice per segment with a hairline gap, and a legend listing
   * each value and its share of the whole.
   */
  import type { Snippet } from 'svelte';

  type Props = {
    segments: DonutSegment[];
    label: string;
    format: (value: number) => string;
    size?: number;
    stroke?: number;
    center?: Snippet;
  };
  let { segments, label, format, size = 168, stroke = 22, center }: Props = $props();

  const radius = $derived((size - stroke) / 2);
  const circumference = $derived(2 * Math.PI * radius);
  const whole = $derived(segments.reduce((sum, segment) => sum + segment.value, 0));
  const slices = $derived.by(() => {
    let offset = 0;
    return segments.map((segment) => {
      const length = whole ? (segment.value / whole) * circumference : 0;
      const slice = { ...segment, length, offset };
      offset += length;
      return slice;
    });
  });
  const share = (value: number) => (whole ? ((value / whole) * 100).toFixed(1) : '0.0');
</script>

<div class="an-donut-row">
  <div class="an-donut" style:width="{size}px" style:height="{size}px">
    <svg viewBox="0 0 {size} {size}" role="img" aria-label={label}>
      <circle cx={size / 2} cy={size / 2} r={radius} class="track" stroke-width={stroke} />
      {#each slices as slice (slice.id)}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={slice.color}
          stroke-width={stroke}
          stroke-dasharray="{Math.max(0, slice.length - 1.5)} {circumference}"
          stroke-dashoffset={-slice.offset}
          transform="rotate(-90 {size / 2} {size / 2})"
        >
          <title>{slice.label}: {format(slice.value)}</title>
        </circle>
      {/each}
    </svg>
    {#if center}<span class="center">{@render center()}</span>{/if}
  </div>
  <ul class="an-legend">
    {#each segments as segment (segment.id)}
      <li>
        <i style:background={segment.color}></i>
        <span>{segment.label}</span>
        <strong>{format(segment.value)}</strong>
        <small>{share(segment.value)}%</small>
      </li>
    {/each}
  </ul>
</div>

<style>
  .an-donut-row {
    display: flex;
    align-items: center;
    gap: 24px;
  }
  .an-donut {
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
  .center {
    position: absolute;
    inset: 0;
    display: grid;
    place-content: center;
    font-weight: 650;
    font-variant-numeric: tabular-nums;
    text-align: center;
  }
  .center :global(strong) {
    font-size: 24px;
    letter-spacing: -0.02em;
  }
  .center :global(small) {
    color: var(--fl-muted);
    font-size: 11px;
    font-weight: 500;
  }
  .an-legend {
    display: grid;
    flex: 1;
    gap: 8px;
    min-width: 0;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  li {
    display: grid;
    grid-template-columns: 10px minmax(0, 1fr) auto 46px;
    align-items: center;
    gap: 10px;
    font-size: 12.5px;
  }
  i {
    width: 10px;
    height: 10px;
    border-radius: 3px;
  }
  span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  strong,
  small {
    font-variant-numeric: tabular-nums;
    text-align: right;
  }
  small {
    color: var(--fl-muted);
  }
  @container (max-width: 520px) {
    .an-donut-row {
      flex-direction: column;
      align-items: stretch;
    }
    .an-donut {
      align-self: center;
    }
  }
</style>
