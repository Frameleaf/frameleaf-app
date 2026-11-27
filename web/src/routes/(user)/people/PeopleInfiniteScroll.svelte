<script lang="ts" generics="T extends PersonResponseDto">
  import { onDestroy, untrack } from 'svelte';
  import { listEnter, listFlip, listLeave } from '$lib/components/frameleaf/people/list-motion';
  import { cellGrid } from '$lib/frameleaf/library-grid';
  import { FLIP_TILE_LIMIT } from '$lib/frameleaf/motion';
  import type { PersonResponseDto } from '@frameleaf/sdk';

  interface Props {
    people: T[];
    managed?: boolean;
    hasNextPage?: boolean | undefined;
    loadNextPage: () => void;
    children?: import('svelte').Snippet<[{ person: T; index: number }]>;
  }

  let { people, managed = false, hasNextPage = undefined, loadNextPage, children }: Props = $props();

  /**
   * FL-1801: a long list mounts only the cards in or near the viewport, as the photo grid does, so
   * 5,000 people scroll like 50. A list short enough to animate (`FLIP_TILE_LIMIT`) is mounted whole,
   * as before: its cards slide and fade, which a card entering the window must not do.
   */
  const OVERSCAN_ROWS = 3;
  /** Mounted before the grid has been measured: enough to fill a screen and read a card's height. */
  const UNMEASURED_CARDS = 60;

  let grid: HTMLElement | undefined = $state();
  const windowed = $derived(people.length > FLIP_TILE_LIMIT);
  /** `null` until measured; `false` when nothing is measurable (a hidden page, or a test DOM). */
  let measured:
    false | null | { columns: number; gap: number; cellHeight: number; width: number; frameHeight: number } =
    $state(null);
  let scrollTop = $state(0);
  let rowsOffset = $state(0);

  const scrollParentOf = (element: HTMLElement): HTMLElement | null => {
    for (let node = element.parentElement; node; node = node.parentElement) {
      const overflow = getComputedStyle(node).overflowY;
      if (overflow === 'auto' || overflow === 'scroll') {
        return node;
      }
    }
    return null;
  };

  /**
   * Where the grid sits in its scroller, its columns and a card's height, measured when either
   * resizes; the scroll offset alone is read while scrolling, so scrolling never forces a layout.
   */
  $effect(() => {
    const element = grid;
    if (!element || !windowed) {
      measured = null;
      return;
    }
    const scroller = scrollParentOf(element);
    const frame = scroller ?? document.documentElement;
    // returned as well as stored: reading the state here would run this effect again on every scroll
    const readScroll = () => (scrollTop = scroller ? scroller.scrollTop : scrollY);
    const measure = () => {
      const scrolled = readScroll();
      const style = getComputedStyle(element);
      const columns = style.gridTemplateColumns.split(' ').filter(Boolean).length;
      const cellHeight = element.firstElementChild?.getBoundingClientRect().height ?? 0;
      if (frame.clientHeight <= 0 || columns === 0 || cellHeight <= 0) {
        // Nothing measurable: mount everything rather than nothing.
        measured = false;
        return;
      }
      const frameTop = scroller ? scroller.getBoundingClientRect().top : 0;
      // the grid's own top, without the room it leaves for the rows above the window
      rowsOffset = element.getBoundingClientRect().top - frameTop + scrolled;
      const next = {
        columns,
        gap: Number(style.rowGap.replace('px', '')) || 0,
        cellHeight,
        width: element.clientWidth,
        frameHeight: frame.clientHeight,
      };
      // untracked: this effect sets up the measuring, it must not run again for what it measured
      const last = untrack(() => measured);
      if (!last || Object.entries(next).some(([key, value]) => last[key as keyof typeof next] !== value)) {
        measured = next;
      }
    };
    measure();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : undefined;
    observer?.observe(frame);
    observer?.observe(element);
    const target: HTMLElement | typeof globalThis = scroller ?? globalThis;
    target.addEventListener('scroll', readScroll, { passive: true });
    return () => {
      observer?.disconnect();
      target.removeEventListener('scroll', readScroll);
    };
  });

  /**
   * The cards to mount, the room to leave for the rows above them and the height of the whole grid.
   * The rows below are held by that height, not by a second spacer: cards and spacers are not swapped
   * in one step, and a grid that is shorter for a moment makes the browser pull the scroll position up.
   */
  const mounted = $derived.by(() => {
    const all = { start: 0, end: people.length, before: 0, height: 0 };
    if (!windowed || measured === false) {
      return all;
    }
    if (measured === null) {
      return { ...all, end: Math.min(people.length, UNMEASURED_CARDS) };
    }
    const { columns, gap, cellHeight, width, frameHeight } = measured;
    const rows = cellGrid(people.length, width, {
      minCellWidth: 1,
      aspect: 1,
      gap,
      captionHeight: 0,
      columns,
      imageHeight: cellHeight,
    });
    // kept inside the grid: scrolled past either end, the rows at that end stay mounted, never all of them
    const viewTop = Math.min(Math.max(0, scrollTop - rowsOffset), Math.max(0, rows.height - 1));
    const { start, end } = rows.range(viewTop, viewTop + frameHeight, OVERSCAN_ROWS);
    return { start, end, before: (start / columns) * rows.rowPitch, height: rows.height };
  });
  const shown = $derived(
    mounted.start === 0 && mounted.end === people.length ? people : people.slice(mounted.start, mounted.end),
  );

  // The last card is what the next page loads behind; it is read from the grid, so every card
  // keeps the same wrapper and can slide when the list is sorted or filtered. With a window that
  // stops short of the end, the last mounted card is not the last person: nothing is observed.
  const lastPersonContainer = $derived(
    people.length > 0 && mounted.end === people.length ? (grid?.lastElementChild ?? undefined) : undefined,
  );
  const motion = $derived({ count: people.length });

  let retired = false;
  const intersectionObserver = new IntersectionObserver((entries) => {
    const entry = entries.find((entry) => entry.target === lastPersonContainer);
    if (!retired && hasNextPage && entry?.isIntersecting) {
      loadNextPage();
    }
  });

  onDestroy(() => {
    retired = true;
    intersectionObserver.disconnect();
  });

  $effect(() => {
    intersectionObserver.disconnect();
    if (!lastPersonContainer || !hasNextPage) {
      return;
    }

    intersectionObserver.observe(lastPersonContainer);
  });
</script>

<div
  class={managed ? 'managed-grid' : 'library-grid'}
  class:windowed={mounted.height > 0}
  style:padding-top={mounted.before > 0 ? `${mounted.before}px` : undefined}
  style:min-height={mounted.height > 0 ? `${mounted.height}px` : undefined}
  bind:this={grid}
>
  {#each shown as person, offset (person.id)}
    <div class="cell" animate:listFlip={motion} in:listEnter={motion} out:listLeave={motion}>
      {@render children?.({ person, index: mounted.start + offset })}
    </div>
  {/each}
</div>

<style>
  /* template/src/people.css `.pl-grid`. */
  .library-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(196px, 1fr));
    gap: 20px;
  }
  .managed-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
    gap: 14px;
  }
  /* FL-1801: the whole list's height, with the mounted rows at their own size at the top of what is left. */
  .windowed {
    box-sizing: border-box;
    align-content: start;
  }
  .cell {
    min-width: 0;
  }
  @media (max-width: 700px) {
    /* Two faces on a small phone, three once there is room for them. */
    .library-grid {
      grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
      gap: 8px;
    }
    .managed-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }
  }
</style>
