<script lang="ts">
  import type { Snippet } from 'svelte';
  /**
   * A keyboard-complete popup menu: the trigger opens it with click, Enter, Space or the
   * arrow keys, focus roves through the items with Arrow/Home/End, Escape closes and
   * returns focus to the trigger, and Tab or a pointer press outside closes it.
   *
   * Items are supplied by the caller as MenuItem components. Listeners are attached to the
   * popup imperatively so the container carries only its ARIA role and no handlers. It opens
   * on the September 24 spring (apple-style.css:322-332), growing from the corner it hangs
   * from, and crossfades instead under Reduce Motion (apple-style.css:488-490).
   *
   * Activating an item closes the popup and returns focus to the trigger, unless that
   * MenuItem was given `keepOpen` (FL-38: a "Reassign…" command that swaps the popup's
   * content for a search field rather than completing immediately).
   */
  let {
    label,
    align = 'start',
    open = $bindable(false),
    trigger,
    children,
  }: {
    /** Accessible name for both the trigger and the popup. */
    label: string;
    align?: 'start' | 'end';
    open?: boolean;
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

  const itemsOf = (menu: HTMLElement) => [...menu.querySelectorAll<HTMLElement>('[role^="menuitem"]')];

  const focusItem = (menu: HTMLElement, index: number) => {
    const items = itemsOf(menu);
    if (items.length === 0) {
      return;
    }
    items[(index + items.length) % items.length].focus();
  };

  const close = (restoreFocus: boolean) => {
    open = false;
    if (restoreFocus) {
      // Focus the still-mounted trigger before the popup unmounts, so focus never
      // falls back to the document body.
      triggerElement?.focus();
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
        case 'Escape': {
          event.preventDefault();
          close(true);
          break;
        }
        case 'Tab': {
          // Let the browser move focus onward; only dismiss the popup.
          close(false);
          break;
        }
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

    const onPointerDown = (event: PointerEvent) => {
      if (!container.contains(event.target as Node)) {
        close(false);
      }
    };

    const onFocusOut = (event: FocusEvent) => {
      const next = event.relatedTarget as Node | null;
      // A null relatedTarget means focus went nowhere yet; the pointer handler covers that.
      if (next && !container.contains(next)) {
        close(false);
      }
    };

    menu.addEventListener('keydown', onKeydown);
    menu.addEventListener('click', onClick);
    container.addEventListener('focusout', onFocusOut);
    document.addEventListener('pointerdown', onPointerDown, { capture: true });
    return () => {
      menu.removeEventListener('keydown', onKeydown);
      menu.removeEventListener('click', onClick);
      container.removeEventListener('focusout', onFocusOut);
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  });

  const onTriggerKeydown = (event: KeyboardEvent) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
      return;
    }
    event.preventDefault();
    pendingFocus = event.key === 'ArrowUp' ? 'last' : 'first';
    open = true;
  };
</script>

<div class="menu-root" bind:this={root}>
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
      open = !open;
    }}
  >
    {#if trigger}{@render trigger()}{:else}{label}{/if}
  </button>
  {#if open}
    <div bind:this={menuElement} id={menuId} role="menu" aria-label={label} class:end={align === 'end'}>
      {@render children()}
    </div>
  {/if}
</div>

<style>
  .menu-root {
    position: relative;
    display: inline-flex;
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
    top: calc(100% + 0.375rem);
    inset-inline-start: 0;
    z-index: 30;
    min-width: 11.25rem;
    max-width: min(20rem, calc(100vw - 2rem));
    padding: 0.375rem;
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    box-shadow: var(--fl-shadow-2);
    /* Grows from the inline-start (or, for `end`, inline-end) corner it hangs from. */
    transform-origin: top left;
    animation: fl-menu-in 320ms var(--fl-spring);
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
  @keyframes fl-menu-in {
    from {
      opacity: 0;
      scale: 0.9;
    }
  }
  @keyframes fl-menu-fade {
    from {
      opacity: 0;
    }
  }
  /*
   * Beats the tokens.css clamp (same !important, higher specificity) so the popup still
   * crossfades rather than snapping in; nothing moves.
   */
  @media (prefers-reduced-motion: reduce) {
    [role='menu'] {
      animation: fl-menu-fade 150ms ease !important;
    }
  }
</style>
