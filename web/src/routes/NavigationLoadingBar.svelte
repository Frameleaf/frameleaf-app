<script lang="ts">
  /**
   * The route-change progress line: 2px of the brand gradient on a transparent track at the very
   * top of the window, one of the few places the gradient appears in the product (BRAND.md
   * decision 3). It waits a moment before showing so fast navigations never flash it, and fades
   * out when the page arrives rather than vanishing. Under Reduce Motion the line does not creep:
   * it appears part-way and fades.
   */
  import { motionFade, prefersReducedMotion } from '$lib/frameleaf/motion';
  import { DURATION } from '$lib/frameleaf/tokens';
  import { onMount } from 'svelte';
  import { cubicOut } from 'svelte/easing';
  import { tweened } from 'svelte/motion';

  let showing = $state(false);

  // delay showing any progress for a little bit so very fast loads
  // do not cause flicker
  const delay = 100;

  const progress = tweened(0, {
    duration: 1000,
    easing: cubicOut,
  });

  function animate() {
    showing = true;
    void progress.set(90, prefersReducedMotion() ? { duration: 0 } : undefined);
  }

  onMount(() => {
    const timer = setTimeout(animate, delay);
    return () => clearTimeout(timer);
  });
</script>

{#if showing}
  <div class="fl-nav-progress" aria-hidden="true" out:motionFade|global={{ duration: DURATION.fade }}>
    <span style:width={`${$progress}%`}></span>
  </div>
{/if}

<style>
  .fl-nav-progress {
    position: fixed;
    inset: 0 0 auto 0;
    z-index: var(--fl-z-toast);
    height: 2px;
    pointer-events: none;
  }
  span {
    display: block;
    height: 100%;
    background: var(--fl-accent);
    /* Sized to the window, not the line, so the colours stay put while the line grows across them. */
    background: var(--fl-brand-gradient) 0 0 / 100vw 100% no-repeat;
    border-start-end-radius: var(--fl-radius-pill);
    border-end-end-radius: var(--fl-radius-pill);
  }
</style>
