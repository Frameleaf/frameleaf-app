<script lang="ts">
  /**
   * The welcome arrival: the Frameleaf lockup opens with Unfurl, the signature motion, once
   * (BRAND.md decisions 6 and 9), then the `[data-intro]` children are revealed in turn. The artwork
   * is the brand kit's own, through `Logo`; nothing is redrawn here.
   */
  import Logo from '$lib/components/frameleaf/Logo.svelte';
  import { logoIntro } from '$lib/components/frameleaf/setup/setup-motion';
  import type { Snippet } from 'svelte';

  const { onSettled, children }: { onSettled?: () => void; children?: Snippet } = $props();
</script>

<div class="frs-logo" use:logoIntro={onSettled}>
  <Logo variant="lockup" surface="dark" size="large" arrive clearSpace />
  {@render children?.()}
</div>
