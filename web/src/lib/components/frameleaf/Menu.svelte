<script lang="ts">
  import { canAnimate, leave } from '$lib/frameleaf/motion';
  import { untrack, type Snippet } from 'svelte';
  /**
   * A keyboard-complete popup menu: the trigger opens it with click, Enter, Space or the
   * arrow keys, focus roves through the items with Arrow/Home/End, Escape closes and
   * returns focus to the trigger, and Tab or a pointer press outside closes it.
   *
   * Items are supplied by the caller as MenuItem components. Listeners are attached to the
   * popup imperatively so the container carries only its ARIA role and no handlers. It opens
   * and closes on the Pop motion pattern (BRAND.md; apple-style.css:322-332): it grows on the
   * spring from the corner it hangs from and fades out when dismissed, with a crossfade both
   * ways under Reduce Motion (apple-style.css:488-490). While it fades out the popup is inert
   * and hidden from assistive technology; focus has already gone back to the trigger.
   *
   * Activating an item closes the popup and returns focus to the trigger, unless that
   * MenuItem was given `keepOpen` (FL-38: a "Reassign…" command that swaps the popup's
   * content for a search field rather than completing immediately).
   *
   * `at` opens the same menu at a point instead, for a right-click (approved design, 2026-11-04):
   * the popup floats on the page at the pointer, kept inside the window, and closes when the page
   * scrolls or resizes. Focus goes back to what had it before, or to the trigger. Closing sets `at`
   * back to null.
   */
  let {
    label,
    align = 'start',
    open = $bindable(false),
    at = $bindable(null),
    hideTrigger = false,
    trigger,
    children,
  }: {
    /** Accessible name for both the trigger and the popup. */
    label: string;
    align?: 'start' | 'end';
    open?: boolean;
    /** Opens the menu at this point (a right-click's clientX/clientY) instead of under the trigger. */
    at?: { x: number; y: number } | null;
    /** No trigger button: the menu only opens at a point (the sidebar's right-click). */
    hideTrigger?: boolean;
    /** Visible trigger content; falls back to `label`. */
    trigger?: Snippet;
    children: Snippet;
  } = $props();

  const menuId = $props.id();
  let root: HTMLDivElement | undefined = $state();
  let triggerElement: HTMLButtonElement | undefined = $state();
  let menuElement: HTMLDivElement | undefined = $state();
  // Deliberately not $state: it steers the next open only and must not re-run the effect.
  let pendingFocus: 'first' | 'last' = 'first';
  // True while the closed popup is still fading out; it stays mounted, inert, until the exit ends.
  let leaving = $state(false);
  let cancelLeave: (() => void) | undefined;
  // Deliberately not $state: whether the last run of the effect below saw the popup open.
  let wasOpen = false;
  // Deliberately not $state: where focus goes back to after a menu opened at a point.
  let returnTo: HTMLElement | null = null;
  // True while the open popup floats at a point (a right-click) rather than hanging from the trigger.
  let floating = $state(false);

  /** Puts a floating popup at the point, inside the window with an 8px margin. */
  const place = (menu: HTMLElement, point: { x: number; y: number }) => {
    menu.style.left = `${Math.max(8, Math.min(point.x, innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(point.y, innerHeight - menu.offsetHeight - 8))}px`;
  };

  /**
   * A floating popup lives on <body>: a frosted rail or a card mid-animation would otherwise hold a
   * fixed popup inside it.
   */
  const float = (menu: HTMLElement, point: { x: number; y: number } | null) => {
    if (!point) {
      return;
    }
    document.body.append(menu);
    place(menu, point);
    return { destroy: () => menu.remove() };
  };

  // A right-click opens the menu where it happened; another right-click moves it there.
  $effect(() => {
    const point = at;
    if (!point) {
      return;
    }
    untrack(() => {
      if (!open) {
        const active = document.activeElement;
        returnTo = active instanceof HTMLElement && active !== document.body ? active : null;
        floating = true;
        pendingFocus = 'first';
        open = true;
      } else if (floating && menuElement) {
        place(menuElement, point);
      }
    });
  });
  $effect(() => {
    if (!open && untrack(() => at)) {
      at = null;
    }
  });

  // Before the DOM updates, so the popup is still there to fade when `open` turns false.
  $effect.pre(() => {
    if (open) {
      cancelLeave?.();
      cancelLeave = undefined;
      leaving = false;
      wasOpen = true;
      return;
    }
    if (!wasOpen) {
      return;
    }
    wasOpen = false;
    const menu = untrack(() => menuElement);
    // Without the Web Animations API (and in unit tests) the popup simply unmounts.
    if (!canAnimate(menu) || !menu.isConnected) {
      return;
    }
    leaving = true;
    cancelLeave = leave(menu, 'pop', () => (leaving = false));
  });

  const itemsOf = (menu: HTMLElement) => [
    ...menu.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"]):not(:disabled)'),
  ];

  const focusItem = (menu: HTMLElement, index: number) => {
    const items = itemsOf(menu);
    if (items.length === 0) {
      menu.focus();
      return;
    }
    items[(index + items.length) % items.length].focus();
  };

  const close = (restoreFocus: boolean) => {
    open = false;
    if (restoreFocus) {
      // Focus the still-mounted trigger before the popup unmounts, so focus never
      // falls back to the document body.
      (floating && returnTo?.isConnected ? returnTo : triggerElement)?.focus();
    }
  };

  $effect(() => {
    const menu = menuElement;
    const container = root;
    if (!open || !menu || !container) {
      return;
    }

    focusItem(menu, pendingFocus === 'last' ? -1 : 0);

    const onKeydown = (event: KeyboardEvent) => {
      const items = itemsOf(menu);
      const index = items.indexOf(document.activeElement as HTMLElement);
      switch (event.key) {
        case 'ArrowDown': {
          event.preventDefault();
          focusItem(menu, index + 1);
          break;
        }
        case 'ArrowUp': {
          event.preventDefault();
          focusItem(menu, index === -1 ? -1 : index - 1);
          break;
        }
        case 'Home': {
          event.preventDefault();
          focusItem(menu, 0);
          break;
        }
        case 'End': {
          event.preventDefault();
          focusItem(menu, -1);
          break;
        }
        case 'Tab': {
          // Let the browser move focus onward; only dismiss the popup.
          close(false);
          break;
        }
      }
    };

    // Escape is the open menu's wherever focus is (a click on a gap leaves it on the body), so the
    // page's own Escape (an album's "go back") never runs while a menu is open (LIB-04).
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close(true);
      }
    };

    const onClick = (event: MouseEvent) => {
      const item = (event.target as HTMLElement | null)?.closest<HTMLElement>('[role^="menuitem"]');
      if (!item || item.getAttribute('aria-disabled') === 'true' || item.dataset.keepOpen === 'true') {
        return;
      }
      // The item's own handler has already run in the target phase.
      close(true);
    };

    // A floating popup is on <body>, outside the container, so both count as inside.
    const inside = (node: Node | null) => !!node && (container.contains(node) || menu.contains(node));

    const onPointerDown = (event: PointerEvent) => {
      if (!inside(event.target as Node)) {
        close(false);
      }
    };

    const onFocusOut = (event: FocusEvent) => {
      const next = event.relatedTarget as Node | null;
      // A null relatedTarget means focus went nowhere yet; the pointer handler covers that.
      if (next && !inside(next)) {
        close(false);
      }
    };

    // A floating popup stays where it was put, so the page moving away from it closes it.
    const onMove = (event: Event) => {
      if (floating && !(event.target instanceof Node && menu.contains(event.target))) {
        close(false);
      }
    };

    menu.addEventListener('keydown', onKeydown);
    document.addEventListener('keydown', onEscape, { capture: true });
    menu.addEventListener('click', onClick);
    container.addEventListener('focusout', onFocusOut);
    menu.addEventListener('focusout', onFocusOut);
    document.addEventListener('pointerdown', onPointerDown, { capture: true });
    document.addEventListener('scroll', onMove, { capture: true, passive: true });
    addEventListener('resize', onMove);
    return () => {
      menu.removeEventListener('keydown', onKeydown);
      document.removeEventListener('keydown', onEscape, true);
      menu.removeEventListener('click', onClick);
      container.removeEventListener('focusout', onFocusOut);
      menu.removeEventListener('focusout', onFocusOut);
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('scroll', onMove, true);
      removeEventListener('resize', onMove);
    };
  });

  const onTriggerKeydown = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
      return;
    }
    event.preventDefault();
    pendingFocus = event.key === 'ArrowUp' ? 'last' : 'first';
    floating = false;
    open = true;
  };
</script>

<div class="menu-root" class:no-trigger={hideTrigger} bind:this={root}>
  {#if !hideTrigger}
    <button
      bind:this={triggerElement}
      type="button"
      aria-haspopup="menu"
      aria-expanded={open}
      aria-controls={open ? menuId : undefined}
      aria-label={trigger ? label : undefined}
      onkeydown={onTriggerKeydown}
      onclick={() => {
        pendingFocus = 'first';
        floating = false;
        open = !open;
      }}
    >
      {#if trigger}{@render trigger()}{:else}{label}{/if}
    </button>
  {/if}
  {#if open || leaving}
    <div
      bind:this={menuElement}
      id={menuId}
      role="menu"
      aria-label={label}
      aria-hidden={leaving && !open ? 'true' : undefined}
      inert={leaving && !open}
      tabindex="-1"
      class:end={align === 'end'}
      class:floating
      use:float={floating ? at : null}
      oncontextmenu={(event) => event.preventDefault()}
    >
      {@render children()}
    </div>
  {/if}
</div>

<style>
  .menu-root {
    position: relative;
    display: inline-flex;
  }
  /* Without a trigger the menu only floats on the page, so its root takes no place in the layout
     (a sidebar's menu sits beside the sidebar in the page grid). */
  .menu-root.no-trigger {
    display: contents;
  }
  button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    white-space: nowrap;
    padding: 0.4375rem 0.6875rem;
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    transition: background var(--fl-motion-fast) var(--fl-ease);
  }
  button:hover {
    background: color-mix(in srgb, var(--fl-raised), var(--fl-text) 8%);
  }
  [role='menu'] {
    position: absolute;
    top: calc(100% + var(--fl-space-2));
    inset-inline-start: 0;
    z-index: var(--fl-z-popover);
    /* Sized by its items, not by the (often narrow) trigger it hangs from, so labels don't wrap. */
    width: max-content;
    min-width: 11.25rem;
    max-width: min(20rem, calc(100vw - 2rem));
    padding: 0.375rem;
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    box-shadow: var(--fl-shadow-2);
    /* Grows from the inline-start (or, for `end`, inline-end) corner it hangs from. */
    transform-origin: top left;
    animation:
      fl-fade-in var(--fl-duration-reduced) var(--fl-ease) both,
      fl-pop-in var(--fl-duration-pop) var(--fl-spring) both;
  }
  [role='menu']:dir(rtl) {
    transform-origin: top right;
  }
  [role='menu'].end {
    inset-inline-start: auto;
    inset-inline-end: 0;
    transform-origin: top right;
  }
  [role='menu'].end:dir(rtl) {
    transform-origin: top left;
  }
  /* On <body>, outside every .frameleaf root, so it carries the type and layer itself. */
  [role='menu'].floating {
    position: fixed;
    inset: auto;
    z-index: var(--fl-z-menu);
    font: var(--fl-type-body);
    transform-origin: top left;
  }
  /*
   * Beats the tokens.css clamp (same !important, higher specificity) so the popup still
   * crossfades rather than snapping in; nothing moves.
   */
  @media (prefers-reduced-motion: reduce) {
    [role='menu'] {
      animation: fl-fade-in var(--fl-duration-reduced) var(--fl-ease) both !important;
    }
  }
</style>
