<script lang="ts">
  import { mediaQueryManager } from '$lib/stores/media-query-manager.svelte';
  import { cleanClass } from '$lib';
  import { queueManager } from '$lib/managers/queue-manager.svelte';
  import type { QueueSnapshot } from '$lib/types';
  import type { QueueResponseDto } from '@frameleaf/sdk';
  import { LoadingSpinner, themeManager } from '@frameleaf/ui';
  import { DateTime } from 'luxon';
  import { onMount } from 'svelte';
  import uPlot, { type AlignedData, type Axis } from 'uplot';
  import 'uplot/dist/uPlot.min.css';

  type Props = {
    queue: QueueResponseDto;
    class?: string;
  };

  const { queue, class: className }: Props = $props();

  type Data = number | null;
  type NormalizedData = [
    Data[], // timestamps
    Data[], // failed counts
    Data[], // active counts
    Data[], // waiting counts
  ];

  const normalizeData = (snapshots: QueueSnapshot[]) => {
    const items: NormalizedData = [[], [], [], []];

    for (const { timestamp, snapshot } of snapshots) {
      items[0].push(timestamp);

      const statistics = (snapshot || []).find(({ name }) => name === queue.name)?.statistics;

      if (statistics) {
        items[1].push(statistics.failed);
        items[2].push(statistics.active);
        items[3].push(statistics.waiting + statistics.paused);
      } else {
        items[0].push(timestamp);
        items[1].push(null);
        items[2].push(null);
        items[3].push(null);
      }
    }

    items[0].push(Date.now() + 5000);
    items[1].push(items[1].at(-1) ?? 0);
    items[2].push(items[2].at(-1) ?? 0);
    items[3].push(items[3].at(-1) ?? 0);

    return items;
  };

  const data = $derived(normalizeData(queueManager.snapshots));

  let chartElement: HTMLDivElement | undefined = $state();
  let plot: uPlot | undefined;

  /**
   * The chart is drawn on a canvas, so it reads the Frameleaf tokens off its element. They are
   * read once and read again when the theme changes; no colours are kept in this file.
   */
  const tokens = new Map<string, string>();
  const token = (name: string) => {
    let value = tokens.get(name);
    if (value === undefined && chartElement) {
      value = getComputedStyle(chartElement).getPropertyValue(name).trim() || 'gray';
      tokens.set(name, value);
    }
    return value ?? 'gray';
  };

  const axisOptions: Axis = {
    stroke: () => token('--fl-muted'),
    ticks: {
      show: false,
      stroke: () => token('--fl-border'),
    },
    grid: {
      show: true,
      stroke: () => token('--fl-border'),
    },
  };

  const seriesOptions: uPlot.Series = {
    spanGaps: false,
    points: {
      show: false,
    },
    width: 2,
    pxAlign: 0,
  };

  const options: uPlot.Options = {
    legend: {
      show: false,
    },
    cursor: {
      show: false,
      lock: true,
      drag: {
        setScale: false,
      },
    },
    width: 200,
    height: 200,
    ms: 1,
    pxAlign: 0,
    scales: {
      y: {
        distr: 1,
      },
    },
    series: [
      {},
      {
        stroke: () => token('--fl-danger'),
        ...seriesOptions,
      },
      {
        stroke: () => token('--fl-accent'),
        ...seriesOptions,
      },
      {
        stroke: () => token('--fl-blue'),
        ...seriesOptions,
      },
    ],

    axes: [
      {
        ...axisOptions,
        size: 40,
        ticks: { show: true },
        values: (plot, values) => {
          return values.map((value) => {
            if (!value) {
              return '';
            }
            return DateTime.fromMillis(value).toFormat('hh:mm:ss');
          });
        },
      },
      {
        ...axisOptions,
        size: 60,
      },
    ],
  };

  const onThemeChange = () => {
    tokens.clear();
    plot?.redraw(false);
    // The theme may reach the document just after the store changes; the next draw reads again.
    setTimeout(() => tokens.clear(), 0);
  };

  $effect(() => themeManager.value && onThemeChange());

  const update = () => {
    if (!plot || !chartElement || data[0].length === 0) {
      return;
    }
    const now = Date.now();
    const scale = { min: now - chartElement.clientWidth * 100, max: now };

    plot.setData(data as AlignedData, false);
    plot.setScale('x', scale);
    plot.setSize({ width: chartElement.clientWidth, height: chartElement.clientHeight });
  };

  onMount(() => {
    plot = new uPlot(options, data as AlignedData, chartElement);
    return () => {
      plot?.destroy();
      plot = undefined;
    };
  });

  /**
   * FL-139: the graph scrolls with time on every frame; under Reduce Motion it steps once a second
   * instead. Either loop stops when the graph goes away (it used to run forever after unmounting).
   */
  $effect(() => {
    if (mediaQueryManager.reducedMotion) {
      update();
      const interval = setInterval(update, 1000);
      return () => clearInterval(interval);
    }
    let frame = requestAnimationFrame(function tick() {
      update();
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  });
</script>

<div class={cleanClass('w-full', className)} bind:this={chartElement}>
  {#if data[0].length === 0}
    <LoadingSpinner size="giant" />
  {/if}
</div>
