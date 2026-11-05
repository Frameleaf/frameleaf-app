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
    /* Stated, so the page keeps its width inside a form that lays its children out in a column. */
    width: 100%;
    min-width: 0;
    max-width: 1120px;
    /* The shell centres wide pages; these start on the heading's edge, as the other settings pages do. */
    margin-inline: 0 auto;
    padding-bottom: var(--fl-space-8);
    color: var(--fl-text);
  }
  /*
   * The gap is the rhythm between the pieces: a piece's own outer margin would double it (Background
   * work's view switch, Computers' list, a person's removal card), so a direct child has none.
   */
  .kit-page.kit-page > :global(*) {
    margin-block: 0;
  }
  /*
   * A choice between a few settings values is the prototype's `.bk2-segmented` (backup-v2.css:691-718):
   * a track sunk below the card with the chosen value on a raised thumb (`--fl-control-track` and
   * `--fl-control-thumb` in design-system.css), not the accent. The shared control keeps its quieter
   * filter look everywhere else.
   */
  .kit-page {
    --kit-segment-track: color-mix(in srgb, var(--fl-canvas), black 38%);
    --kit-segment-thumb: color-mix(in srgb, var(--fl-raised), var(--fl-text) 9%);
  }
  :global(.frameleaf[data-theme='light']) .kit-page {
    --kit-segment-track: color-mix(in srgb, var(--fl-raised), var(--fl-text) 5%);
    --kit-segment-thumb: var(--fl-panel);
  }
  .kit-page :global(.segments) {
    gap: var(--fl-space-half);
    padding: var(--fl-space-half);
    background: var(--kit-segment-track);
    border-radius: var(--fl-radius-control);
  }
  /*
   * The whole control is one 44px control (48 on touch) beside the selects and buttons in the same
   * row: the segments are 38px inside the 2px track and its border. 13px labels (backup-v2.css:703).
   */
  .kit-page :global(.segments > button) {
    min-height: 38px;
    padding-block: 0;
    padding-inline: var(--fl-space-3);
    border-radius: var(--fl-radius-sm);
    font-size: var(--fl-font-callout);
  }
  @media (pointer: coarse) {
    .kit-page :global(.segments > button) {
      min-height: 42px;
    }
  }
  .kit-page :global(.segments > button[aria-pressed='true']) {
    color: var(--fl-text);
    background: var(--kit-segment-thumb);
    box-shadow: var(--fl-shadow-1);
  }
  .kit-page :global(.segments > button[aria-pressed='true']:disabled) {
    opacity: 0.6;
  }
  @container kit (max-width: 620px) {
    /* The phone rhythm between sections. */
    .kit-page {
      gap: var(--fl-space-4);
    }
    /* backup-v2.css:1197-1204: a choice that does not fit the phone wraps inside its track. */
    .kit-page :global(.segments) {
      display: flex;
      flex-wrap: wrap;
      max-width: 100%;
    }
    .kit-page :global(.segments > button) {
      flex: 1 1 auto;
    }
  }
</style>
