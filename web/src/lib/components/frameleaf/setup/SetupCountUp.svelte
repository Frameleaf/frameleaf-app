<script lang="ts">
  /** Counts up to `value` with an ease-out; shows the value at once when motion is reduced. */
  import { mediaQueryManager } from '$lib/stores/media-query-manager.svelte';

  const {
    value,
    format = (value: number) => new Intl.NumberFormat().format(Math.round(value)),
    duration = 1400,
    delay = 0,
  }: { value: number; format?: (value: number) => string; duration?: number; delay?: number } = $props();

  let shown = $state(0);
  $effect(() => {
    const target = value;
    if (mediaQueryManager.reducedMotion || typeof requestAnimationFrame !== 'function') {
      shown = target;
      return;
    }
    let frame = 0;
    let start: number | undefined;
    const tick = (now: number) => {
      start ??= now + delay;
      const progress = Math.min(1, Math.max(0, (now - start) / duration));
      shown = target * (1 - Math.pow(1 - progress, 3));
      if (progress < 1) {
        frame = requestAnimationFrame(tick);
      }
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  });
</script>

<span class="frs-count">{format(shown)}</span>
