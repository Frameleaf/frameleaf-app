<script lang="ts">
  /**
   * The one Frameleaf spinner: a ring in the current text colour, for work with no known length.
   * Use Skeleton when the shape of what is loading is known, and a progress bar when its length is.
   *
   * `label` is announced to assistive technology (the ring itself is decorative); pass
   * `decorative` when the surrounding control already says what is happening, for example a
   * button whose text reads "Saving…". `delay` keeps the ring hidden for fast loads so it never
   * flashes. Under Reduce Motion the ring holds still.
   */
  import { ICON_PX, type IconSize } from '$lib/frameleaf/tokens';
  import { t } from 'svelte-i18n';

  let {
    size = 'lg',
    label,
    decorative = false,
    delay = 0,
  }: {
    /** A named icon size, or a number of px for a hero spinner. */
    size?: IconSize | number;
    /** What is loading; defaults to the shared "Loading" translation. */
    label?: string;
    decorative?: boolean;
    /** Milliseconds to wait before showing anything. */
    delay?: number;
  } = $props();

  const px = $derived(typeof size === 'number' ? size : ICON_PX[size]);
  let shown = $state(false);
  $effect(() => {
    if (delay <= 0) {
      shown = true;
      return;
    }
    shown = false;
    const timer = setTimeout(() => (shown = true), delay);
    return () => clearTimeout(timer);
  });
</script>

{#if shown}
  {#if decorative}
    <span class="fl-spinner" style:--fl-spinner-size="{px}px" aria-hidden="true"></span>
  {:else}
    <span class="fl-spinner-status" role="status">
      <span class="fl-spinner" style:--fl-spinner-size="{px}px" aria-hidden="true"></span>
      <span class="sr-only">{label ?? $t('loading')}</span>
    </span>
  {/if}
{/if}

<style>
  .fl-spinner-status {
    display: inline-flex;
  }
</style>
