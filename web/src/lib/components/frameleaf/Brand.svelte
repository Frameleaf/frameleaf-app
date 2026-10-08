<script lang="ts">
  /**
   * The Frameleaf lockup for a page that stands outside the app shell: the full-screen error
   * page, a public share frame. It sits directly on the page, with the clear space the brand
   * asks for, and picks its artwork from the surface it is on (Logo.svelte holds the rules).
   *
   * `surface="auto"` follows the app theme, which is right for anything on the canvas. Pass
   * `dark` or `light` when the page draws its own background, and `mono` for the white artwork
   * over a photograph.
   */
  import Logo from '$lib/components/frameleaf/Logo.svelte';

  let {
    surface = 'auto',
    mono = false,
    size = 'tiny',
    arrive = false,
  }: {
    surface?: 'light' | 'dark' | 'auto';
    mono?: boolean;
    size?: 'tiny' | 'small' | 'medium';
    /** Play the Unfurl signature once as the lockup appears (sign-in, first run). */
    arrive?: boolean;
  } = $props();
</script>

<span class="brand"><Logo variant="lockup" {surface} {mono} {size} {arrive} clearSpace /></span>

<style>
  .brand {
    display: inline-flex;
    align-items: center;
  }
</style>
