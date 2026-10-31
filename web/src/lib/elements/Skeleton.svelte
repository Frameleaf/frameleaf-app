<script lang="ts">
  import { cleanClass } from '$lib';

  interface Props {
    height: number;
    title?: string;
    /** The height of the group header the title stands in for (LibraryGroupHeader). */
    headerHeight?: number;
    invisible?: boolean;
    class?: string;
  }

  let { height = 0, title, headerHeight = 32, invisible = false, class: className }: Props = $props();
</script>

<div class={cleanClass('overflow-clip', invisible && 'invisible', className)} style:height={height + 'px'}>
  {#if title}
    <!--
      The month's title, set and placed exactly as LibraryGroupHeader sets it (the same box, the
      space its select control takes, the same type), so nothing shifts when the month loads.
    -->
    <div class="fl-skeleton-title" style:height="{headerHeight}px">
      <span class="fl-skeleton-select" aria-hidden="true"></span>
      <span class="fl-skeleton-name">{title}</span>
    </div>
  {/if}
  <div class="size-full" data-skeleton="true"></div>
</div>

<style>
  .fl-skeleton-title {
    display: flex;
    align-items: center;
    gap: 10px;
    box-sizing: border-box;
    padding: 0 0 6px;
    color: var(--fl-text);
  }
  .fl-skeleton-select {
    flex-shrink: 0;
    width: 32px;
    height: 32px;
    margin-inline-start: -6px;
  }
  .fl-skeleton-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--fl-font-size);
    font-weight: 600;
    line-height: 1.4;
  }
  @container fl-timeline (max-width: 600px) {
    .fl-skeleton-name {
      font-size: var(--fl-font-small);
    }
    .fl-skeleton-select {
      width: 36px;
      height: 36px;
      margin-inline-start: -8px;
    }
  }
  /*
   * A quiet grid of placeholder tiles drawn from the brand tokens (review finding 7), in place of
   * the earlier bitmap: raised squares with the grid's 2px gaps showing the canvas. It breathes
   * on the shared pulse and holds still under Reduce Motion (the global motion clamp).
   */
  [data-skeleton] {
    --tile: 235px;
    background-color: var(--fl-raised);
    background-image:
      linear-gradient(to right, var(--fl-canvas) 2px, transparent 2px),
      linear-gradient(to bottom, var(--fl-canvas) 2px, transparent 2px);
    background-size: var(--tile) var(--tile);
    animation: fl-skeleton-pulse var(--fl-duration-pulse) var(--fl-ease) infinite alternate;
  }
  @media (max-width: 767px) {
    [data-skeleton] {
      --tile: 100px;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    [data-skeleton] {
      animation: none;
    }
  }
  .invisible [data-skeleton] {
    visibility: hidden !important;
  }
</style>
