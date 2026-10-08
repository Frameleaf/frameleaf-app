<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    onClick: (e: MouseEvent) => void;
    label: string;
    children?: Snippet;
  }

  let { onClick, label, children }: Props = $props();
</script>

<button type="button" class="fl-viewer-arrow" aria-label={label} onclick={onClick}>
  {@render children?.()}
</button>

<style>
  /* media-viewer.css:377-399: a small frosted pill that stays quiet until it is pointed at or focused. */
  .fl-viewer-arrow {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--fl-control-height);
    height: var(--fl-control-height);
    margin: auto var(--fl-space-4);
    border: 1px solid var(--fl-viewer-border);
    border-radius: var(--fl-radius-pill);
    background: color-mix(in srgb, var(--fl-viewer-panel) 78%, transparent);
    backdrop-filter: var(--fl-material-blur);
    color: var(--fl-viewer-text);
    opacity: 0.6;
    cursor: pointer;
    transition: opacity var(--fl-motion) var(--fl-ease);
  }

  .fl-viewer-arrow:hover,
  .fl-viewer-arrow:focus-visible {
    opacity: 1;
  }

  .fl-viewer-arrow:focus-visible {
    outline: 2px solid var(--fl-viewer-focus);
    outline-offset: var(--fl-focus-offset);
  }

  /*
   * Touch-only devices swipe between items, so the arrows leave the photo; they stay in the page
   * for a screen reader or a switch, which cannot swipe the photo.
   */
  @media (hover: none) and (pointer: coarse) {
    .fl-viewer-arrow:not(:focus-visible) {
      position: absolute;
      width: 1px;
      height: 1px;
      margin: 0;
      overflow: hidden;
      clip-path: inset(50%);
      border: 0;
    }
  }

  @media (prefers-contrast: more), (prefers-reduced-transparency: reduce) {
    .fl-viewer-arrow {
      background: var(--fl-viewer-panel);
      backdrop-filter: none;
      opacity: 1;
    }
  }
</style>
