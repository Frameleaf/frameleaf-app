<script lang="ts">
  import { clickOutside } from '$lib/actions/click-outside';
  import { languageManager } from '$lib/managers/language-manager.svelte';
  import type { Snippet } from 'svelte';

  interface Props {
    isVisible?: boolean;
    direction?: 'left' | 'right';
    x?: number;
    y?: number;
    id?: string | undefined;
    ariaLabel?: string | undefined;
    ariaLabelledBy?: string | undefined;
    ariaActiveDescendant?: string | undefined;
    menuScrollView?: HTMLDivElement | undefined;
    menuElement?: HTMLUListElement | undefined;
    /**
     * Keeps the menu at most `window height - maxHeightInset` pixels tall, scrolling inside, so it stays
     * clear of chrome along the bottom edge (e.g. the viewer footer).
     */
    maxHeightInset?: number | undefined;
    /**
     * Keeps the menu's bottom edge at least this many pixels above the bottom of the window, whatever
     * its height or where it opens (e.g. clear of a footer that paints over it).
     */
    bottomInset?: number | undefined;
    onClose?: (() => void) | undefined;
    children?: Snippet;
  }

  let {
    isVisible = false,
    direction = 'right',
    x = 0,
    y = 0,
    id = undefined,
    ariaLabel = undefined,
    ariaLabelledBy = undefined,
    ariaActiveDescendant = undefined,
    menuScrollView = $bindable(),
    menuElement = $bindable(),
    maxHeightInset = undefined,
    bottomInset = undefined,
    onClose = undefined,
    children,
  }: Props = $props();

  const swap = (direction: string) => (direction === 'left' ? 'right' : 'left');

  const layoutDirection = $derived(languageManager.rtl ? swap(direction) : direction);
  const position = $derived.by(() => {
    if (!menuScrollView || !menuElement) {
      return { left: 0, top: 0 };
    }

    const rect = menuScrollView.getBoundingClientRect();
    const directionWidth = layoutDirection === 'left' ? rect.width : 0;

    const margin = 8;
    const heightCap = maxHeightInset === undefined ? Infinity : Math.max(0, windowInnerHeight - maxHeightInset);
    // The lowest the menu may reach: the window's bottom, or `bottomInset` above it.
    const bottomLimit = windowInnerHeight - (bottomInset ?? 0);

    const left = Math.max(margin, Math.min(windowInnerWidth - rect.width - margin, x - directionWidth));
    const top = Math.max(margin, Math.min(bottomLimit - Math.min(menuElement.clientHeight, heightCap), y));
    const maxHeight = Math.max(0, Math.min(bottomLimit - top - margin, heightCap));

    const needScrollBar = menuElement.clientHeight > maxHeight;

    return { left, top, maxHeight, needScrollBar };
  });

  let windowInnerHeight: number = $state(0);
  let windowInnerWidth: number = $state(0);

  // The menu stays mounted while it is closed, so each opening starts again from its first entry.
  $effect(() => {
    if (isVisible && menuScrollView) {
      menuScrollView.scrollTop = 0;
    }
  });
</script>

<svelte:window bind:innerWidth={windowInnerWidth} bind:innerHeight={windowInnerHeight} />

<div
  bind:this={menuScrollView}
  class={[
    'fl-context-menu fixed z-70 immich-scrollbar',
    isVisible && 'open',
    // FL-139: a closed menu (max-height 0) must not be an empty scrollable region (axe scrollable-region-focusable).
    isVisible && position.needScrollBar ? 'overflow-auto' : 'overflow-hidden',
  ]}
  style:left="{position.left}px"
  style:top="{position.top}px"
  style:max-height={isVisible ? `${position.maxHeight}px` : '0px'}
  use:clickOutside={{ onOutclick: onClose }}
  tabindex="-1"
>
  <ul
    {id}
    aria-activedescendant={ariaActiveDescendant ?? ''}
    aria-label={ariaLabel}
    aria-labelledby={ariaLabelledBy}
    bind:this={menuElement}
    class="flex flex-col outline-none"
    role="menu"
    tabindex="-1"
  >
    {@render children?.()}
  </ul>
</div>

<style>
  /*
   * The viewer's menu (.mv-menu, media-viewer.css:130-148): a raised dark card in both themes, like
   * the rest of the viewer, which is the only place this menu opens. The edge and the shadow are
   * drawn without a border so the box measures the same open and closed.
   */
  .fl-context-menu {
    width: max-content;
    min-width: 248px;
    max-width: min(300px, calc(100vw - 16px));
    border-radius: var(--fl-radius-card);
    color: var(--fl-viewer-text);
    scrollbar-color: color-mix(in srgb, var(--fl-viewer-text) 28%, transparent) transparent;
  }

  /* A closed menu is an empty box of no height: it draws nothing until it opens. */
  .fl-context-menu.open {
    background: var(--fl-viewer-raised);
    box-shadow:
      inset 0 0 0 1px var(--fl-viewer-border),
      var(--fl-shadow-2);
    animation: fl-context-menu-pop var(--fl-motion, 180ms) var(--fl-ease, ease);
  }

  ul {
    padding: 6px;
  }

  @keyframes fl-context-menu-pop {
    from {
      opacity: 0;
      transform: translateY(-4px);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .fl-context-menu.open {
      animation-name: fl-context-menu-fade;
    }

    @keyframes fl-context-menu-fade {
      from {
        opacity: 0;
      }
    }
  }
</style>
