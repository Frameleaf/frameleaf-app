<script lang="ts">
  /**
   * How much of something is used: the amount in words, and a bar when there is a limit to measure
   * it against. `value` and `max` arrive formatted ("653 GB"); `fraction` is the same thing as a
   * number from 0 to 1 for the bar. Without a `fraction` only the words are shown.
   */
  let {
    label,
    value,
    max,
    fraction,
  }: {
    /** What the bar measures, for a screen reader: "Cloud Backup storage used". */
    label: string;
    value: string;
    /** The limit, already in a phrase: "of 1 TB". */
    max?: string;
    fraction?: number;
  } = $props();

  const percent = $derived(fraction === undefined ? undefined : Math.round(Math.min(1, Math.max(0, fraction)) * 100));
</script>

<div class="kit-meter">
  <div>
    <strong>{value}</strong>{#if max}{' '}<span>{max}</span>{/if}
  </div>
  {#if percent !== undefined}
    <div
      class="track"
      class:is-high={percent >= 90}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-valuetext={max ? `${value} ${max}` : value}
    >
      <span style:width="{percent}%"></span>
    </div>
  {/if}
</div>

<style>
  .kit-meter {
    display: grid;
    gap: var(--fl-space-2);
    min-width: 0;
    font-size: var(--fl-font-small);
  }
  strong {
    font-weight: 600;
  }
  .kit-meter > div > span {
    color: var(--fl-muted);
  }
  .track {
    height: 6px;
    overflow: hidden;
    background: var(--fl-raised);
    border-radius: var(--fl-radius-pill);
  }
  .track span {
    display: block;
    height: 100%;
    background: var(--fl-accent);
    border-radius: inherit;
  }
  /* Nearly full is said in words by the page; the bar only turns to the warning colour with it. */
  .track.is-high span {
    background: var(--fl-warning);
  }
</style>
