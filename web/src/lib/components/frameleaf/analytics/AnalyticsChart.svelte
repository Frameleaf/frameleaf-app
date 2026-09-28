<script lang="ts" module>
  export type ChartTone = 'primary' | 'secondary' | 'missing' | 'failure';
  export type ChartDataset = {
    label: string;
    /** One value per label; `null` is a gap and is never drawn as zero. */
    values: Array<number | null>;
    tone?: ChartTone;
    dashed?: boolean;
    fill?: boolean;
  };
</script>

<script lang="ts">
  /**
   * The analytics charts (FL-79): the template's Chart.js canvases redrawn as plain SVG, so the page
   * needs no chart library. Line charts break at gaps instead of bridging them; bar charts stack
   * when asked. Every value is also in the data table under the chart, which is what assistive
   * technology is pointed to — the drawing itself is one labelled image.
   */
  import { locale } from '$lib/stores/preferences.store';
  import { t } from 'svelte-i18n';

  type Props = {
    title: string;
    kind?: 'line' | 'bar';
    horizontal?: boolean;
    stacked?: boolean;
    labels: string[];
    datasets: ChartDataset[];
    unit: string;
    height?: number;
    compact?: boolean;
  };

  let {
    title,
    kind = 'bar',
    horizontal = false,
    stacked = false,
    labels,
    datasets,
    unit,
    height = 240,
    compact = false,
  }: Props = $props();

  const WIDTH = 640;
  const PAD = { top: 10, right: 10, bottom: 24, left: 56 };
  const LABEL_WIDTH = 170;

  const format = (value: number) => new Intl.NumberFormat($locale, { maximumFractionDigits: 2 }).format(value);

  const totals = $derived(
    labels.map((_, index) =>
      stacked
        ? datasets.reduce((sum, dataset) => sum + (dataset.values[index] ?? 0), 0)
        : Math.max(0, ...datasets.map((dataset) => dataset.values[index] ?? 0)),
    ),
  );
  const observed = $derived(datasets.flatMap((dataset) => dataset.values).filter((value) => value !== null));
  const maximum = $derived(Math.max(1, ...totals));
  const minimum = $derived(kind === 'line' && observed.length > 0 ? Math.min(...observed) * 0.9 : 0);
  const ticks = $derived(
    Array.from(
      { length: (compact ? 3 : 5) + 1 },
      (_, index) => minimum + ((maximum - minimum) * index) / (compact ? 3 : 5),
    ),
  );

  const plotLeft = $derived(horizontal ? LABEL_WIDTH : PAD.left);
  const plotWidth = $derived(WIDTH - plotLeft - PAD.right);
  const plotHeight = $derived(height - PAD.top - PAD.bottom);
  const band = $derived((horizontal ? plotHeight : plotWidth) / Math.max(1, labels.length));
  const scale = (value: number) =>
    ((value - minimum) / Math.max(1e-9, maximum - minimum)) * (horizontal ? plotWidth : plotHeight);
  const y = (value: number) => PAD.top + plotHeight - scale(value);

  /** Line segments between gaps; a lone observation becomes a dot. */
  const segments = (values: Array<number | null>) => {
    const runs: Array<Array<[number, number]>> = [];
    let run: Array<[number, number]> = [];
    for (const [index, value] of values.entries()) {
      if (value === null) {
        if (run.length > 0) {
          runs.push(run);
        }
        run = [];
        continue;
      }
      run.push([plotLeft + band * index + band / 2, y(value)]);
    }
    if (run.length > 0) {
      runs.push(run);
    }
    return runs;
  };

  const labelEvery = $derived(Math.max(1, Math.ceil(labels.length / (compact ? 4 : 7))));
  const hasGap = $derived(datasets.some((dataset) => dataset.values.includes(null)));
</script>

<figure class="chart" style:height="{height}px">
  <svg
    viewBox="0 0 {WIDTH} {height}"
    preserveAspectRatio="none"
    role="img"
    aria-label={$t('frameleaf_analytics_chart_label', { values: { title } })}
  >
    {#if horizontal}
      {#each ticks as tick (tick)}
        <line
          class="grid"
          x1={plotLeft + scale(tick)}
          x2={plotLeft + scale(tick)}
          y1={PAD.top}
          y2={PAD.top + plotHeight}
        />
        <text class="tick" x={plotLeft + scale(tick)} y={height - 6} text-anchor="middle">{format(tick)}</text>
      {/each}
      {#each labels as label, index (index)}
        <text class="tick category" x={plotLeft - 8} y={PAD.top + band * index + band / 2 + 3} text-anchor="end"
          >{label}</text
        >
        {#each datasets as dataset, d (dataset.label)}
          {@const value = dataset.values[index]}
          {#if value !== null}
            {@const before = stacked
              ? datasets.slice(0, d).reduce((sum, item) => sum + (item.values[index] ?? 0), 0)
              : 0}
            {@const size = stacked ? band * 0.6 : (band * 0.6) / datasets.length}
            <rect
              data-tone={dataset.tone ?? 'primary'}
              x={plotLeft + scale(before)}
              y={PAD.top + band * index + band * 0.2 + (stacked ? 0 : size * d)}
              width={Math.max(0, scale(before + value) - scale(before))}
              height={size}
              rx="2"
            >
              <title>{label} · {dataset.label}: {format(value)} {unit}</title>
            </rect>
          {/if}
        {/each}
      {/each}
    {:else}
      {#each ticks as tick (tick)}
        <line class="grid" x1={plotLeft} x2={WIDTH - PAD.right} y1={y(tick)} y2={y(tick)} />
        <text class="tick" x={plotLeft - 8} y={y(tick) + 3} text-anchor="end">{format(tick)}</text>
      {/each}
      {#each labels as label, index (index)}
        {#if index % labelEvery === 0}
          <text class="tick" x={plotLeft + band * index + band / 2} y={height - 6} text-anchor="middle">{label}</text>
        {/if}
      {/each}
      {#if kind === 'line'}
        {#each datasets as dataset (dataset.label)}
          {#each segments(dataset.values) as run, r (r)}
            {#if dataset.fill && run.length > 1}
              <path
                class="area"
                d="M {run[0][0]} {PAD.top + plotHeight} {run.map(([px, py]) => `L ${px} ${py}`).join(' ')} L {run.at(
                  -1,
                )![0]} {PAD.top + plotHeight} Z"
              />
            {/if}
            {#if run.length > 1}
              <path
                class="line"
                data-tone={dataset.tone ?? 'primary'}
                class:dashed={dataset.dashed}
                d={run.map(([px, py], i) => `${i === 0 ? 'M' : 'L'} ${px} ${py}`).join(' ')}
              />
            {/if}
            {#each run as [px, py] (px)}
              <circle class="dot" data-tone={dataset.tone ?? 'primary'} cx={px} cy={py} r={run.length === 1 ? 3 : 1.5}>
                <title>{labels[Math.round((px - plotLeft - band / 2) / band)]} · {dataset.label}</title>
              </circle>
            {/each}
          {/each}
        {/each}
      {:else}
        {#each labels as label, index (index)}
          {#each datasets as dataset, d (dataset.label)}
            {@const value = dataset.values[index]}
            {#if value !== null}
              {@const before = stacked
                ? datasets.slice(0, d).reduce((sum, item) => sum + (item.values[index] ?? 0), 0)
                : minimum}
              {@const size = stacked ? band * 0.7 : (band * 0.7) / datasets.length}
              <rect
                data-tone={dataset.tone ?? 'primary'}
                x={plotLeft + band * index + band * 0.15 + (stacked ? 0 : size * d)}
                y={y(before + value)}
                width={size}
                height={Math.max(0, y(before) - y(before + value))}
                rx="1.5"
              >
                <title>{label} · {dataset.label}: {format(value)} {unit}</title>
              </rect>
            {/if}
          {/each}
        {/each}
      {/if}
    {/if}
  </svg>
  {#if !compact && (datasets.length > 1 || hasGap)}
    <figcaption class="legend">
      {#each datasets as dataset (dataset.label)}
        <span
          ><i class="swatch" data-tone={dataset.tone ?? 'primary'} class:dashed={dataset.dashed}
          ></i>{dataset.label}</span
        >
      {/each}
      {#if hasGap}
        <span class="gap">{$t('frameleaf_analytics_gap_legend')}</span>
      {/if}
    </figcaption>
  {/if}
</figure>

<style>
  .chart {
    position: relative;
    display: flex;
    flex-direction: column;
    width: 100%;
    min-width: 0;
    margin: 0;
  }
  svg {
    flex: 1;
    width: 100%;
    min-height: 0;
    overflow: visible;
  }
  .grid {
    stroke: var(--fl-border);
    stroke-width: 1;
    vector-effect: non-scaling-stroke;
  }
  /* Chart text uses the interface font with tabular figures, like the template's chart labels. */
  .tick {
    fill: var(--fl-muted);
    font-family: inherit;
    font-size: 10px;
    font-variant-numeric: tabular-nums;
  }
  .category {
    font-size: 11px;
  }
  .line {
    fill: none;
    stroke-width: 2;
    vector-effect: non-scaling-stroke;
  }
  .line.dashed {
    stroke-dasharray: 4 4;
  }
  .area {
    fill: color-mix(in srgb, var(--fl-accent) 12%, transparent);
  }
  [data-tone='primary'] {
    fill: var(--fl-accent);
    stroke: var(--fl-accent);
  }
  /* Series tones from the foundation tokens (analytics-dashboard.css:1-12). */
  [data-tone='secondary'] {
    fill: var(--fl-teal);
    stroke: var(--fl-teal);
  }
  [data-tone='missing'] {
    fill: color-mix(in srgb, var(--fl-muted) 55%, var(--fl-panel));
    stroke: color-mix(in srgb, var(--fl-muted) 55%, var(--fl-panel));
  }
  [data-tone='failure'] {
    fill: var(--fl-danger);
    stroke: var(--fl-danger);
  }
  path.line {
    fill: none;
  }
  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 18px;
    padding-top: 8px;
    color: var(--fl-muted);
    font-size: 11px;
  }
  .legend span {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .swatch {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 1px;
  }
  .swatch.dashed {
    height: 2px;
  }
  .gap::before {
    content: '';
    display: inline-block;
    width: 14px;
    border-top: 1px dotted var(--fl-muted);
    margin-right: 6px;
    vertical-align: middle;
  }
</style>
