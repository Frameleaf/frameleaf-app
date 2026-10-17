<script lang="ts">
  /**
   * A number that counts up to its value when it appears or changes, for the figures on Overview
   * and Analytics. Under Reduce Motion the value is shown at once. Digits are tabular so the
   * width does not shimmer, and assistive technology reads the final value only.
   */
  import { countUp } from '$lib/frameleaf/motion';
  import { locale } from '$lib/stores/preferences.store';

  let {
    value,
    format,
    duration = 900,
    delay = 0,
  }: {
    value: number;
    /** Formats each frame's number; defaults to a whole number in the app locale. */
    format?: (value: number) => string;
    duration?: number;
    delay?: number;
  } = $props();

  const show = $derived(format ?? ((number: number) => new Intl.NumberFormat($locale).format(Math.round(number))));

  let shown = $state(0);
  // Deliberately not $state: where the next count starts from, read without subscribing.
  let last = 0;
  $effect(() => {
    const target = value;
    const stop = countUp(
      last,
      target,
      (next) => {
        shown = next;
        last = next;
      },
      { duration, delay },
    );
    return stop;
  });
</script>

<span class="fl-tabular"><span aria-hidden="true">{show(shown)}</span><span class="sr-only">{show(value)}</span></span>
