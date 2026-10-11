<script lang="ts">
  /**
   * The frame of a plain-words settings page (FL-361, first used by Backup in FL-362): one column of
   * the kit's pieces with a fixed rhythm between them. It is the size container the pieces answer
   * to, so a page reads the same in the wide settings pane, beside an open rail and on a phone.
   * The look follows the approved prototype (`settings-v2/kit.jsx`, `backup-v2.css`), drawn with the
   * app's own tokens.
   */
  import type { Snippet } from 'svelte';

  let { children }: { children: Snippet } = $props();
</script>

<div class="kit-page">{@render children()}</div>

<style>
  .kit-page {
    container: kit / inline-size;
    display: grid;
    gap: var(--fl-space-6);
    min-width: 0;
    max-width: 1120px;
    /* The shell centres wide pages; these start on the heading's edge, as the other settings pages do. */
    margin-inline: 0 auto;
    padding-bottom: var(--fl-space-8);
    color: var(--fl-text);
  }
  @container kit (max-width: 620px) {
    /* The phone rhythm between sections. */
    .kit-page {
      gap: var(--fl-space-4);
    }
  }
</style>
