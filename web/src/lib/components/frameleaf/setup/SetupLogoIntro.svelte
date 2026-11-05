<script lang="ts">
  /**
   * The welcome arrival (prototype `LogoIntro`): the big app icon in its soft glow over the wordmark,
   * faded in once, then the `[data-intro]` children are revealed in turn. The artwork is the brand
   * kit's own, through `Logo`; the wordmark is the lockup cropped to its lettering, nothing redrawn.
   */
  import Logo from '$lib/components/frameleaf/Logo.svelte';
  import { logoIntro } from '$lib/components/frameleaf/setup/setup-motion';
  import type { Snippet } from 'svelte';

  const { onSettled, children }: { onSettled?: () => void; children?: Snippet } = $props();
</script>

<div class="frs-logo" use:logoIntro={onSettled}>
  <span class="frs-logo-mark">
    <span class="frs-logo-glow" aria-hidden="true"></span>
    <Logo variant="symbol" surface="dark" arrive />
  </span>
  <span class="frs-wordmark" aria-hidden="true"><Logo variant="lockup" surface="dark" decorative arrive /></span>
  {@render children?.()}
</div>

<style>
  /* first-run-setup.css (prototype): a 132px icon, its glow, and the 44px wordmark under it. */
  .frs-logo-mark {
    position: relative;
    display: block;
    width: 132px;
    height: 132px;
  }
  .frs-logo-mark :global(img) {
    position: relative;
    display: block;
    width: 100%;
    height: 100%;
  }
  .frs-logo-glow {
    position: absolute;
    inset: -60%;
    border-radius: 50%;
    background: radial-gradient(circle, rgb(0 196 214 / 0.28), rgb(54 236 114 / 0.08) 45%, transparent 70%);
    filter: blur(8px);
    animation: fl-fade-in var(--fl-motion-slow) var(--fl-ease) both;
  }
  /* The lockup is 1080 × 264 with the lettering from x ≈ 289: at 44px tall, 48px of symbol is cropped off. */
  .frs-wordmark {
    display: block;
    width: 132px;
    height: 44px;
    overflow: hidden;
  }
  .frs-wordmark :global(img) {
    display: block;
    width: auto;
    max-width: none;
    height: 44px;
    min-height: 0;
    margin-inline-start: -48px;
  }
  @media (prefers-reduced-motion: reduce) {
    .frs-logo-glow {
      animation: none;
    }
  }
</style>
