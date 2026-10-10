import { tick } from 'svelte';
import { getTabbable } from '$lib/utils/focus-util';

interface Options {
  /**
   * Set whether the trap is active or not.
   */
  active?: boolean;
}

export function focusTrap(container: HTMLElement, options?: Options) {
  const triggerElement = document.activeElement;

  // Create sentinel nodes
  const startSentinel = document.createElement('div');
  startSentinel.dataset.focusTrap = 'start';

  const backupSentinel = document.createElement('div');
  backupSentinel.setAttribute('tabindex', '-1');
  backupSentinel.dataset.focusTrap = 'backup';

  const endSentinel = document.createElement('div');
  endSentinel.dataset.focusTrap = 'end';

  const withDefaults = (options?: Options) => {
    return {
      active: options?.active ?? true,
    };
  };

  /**
   * The start and end sentinels catch focus on its way out of an active trap and hand it back in at
   * once, so nobody rests on one and they draw no focus ring. While the trap is inactive they are
   * neither tab stops nor exposed to assistive technology: left tabbable, they were two invisible
   * stops in whatever the trap wraps (the library rail on desktop). An active sentinel is not
   * hidden from assistive technology, because a tabbable node must not be `aria-hidden`.
   */
  const setCatching = (active: boolean) => {
    for (const sentinel of [startSentinel, endSentinel]) {
      sentinel.setAttribute('tabindex', active ? '0' : '-1');
      sentinel.setAttribute('aria-hidden', String(!active));
    }
  };
  startSentinel.style.outline = 'none';
  endSentinel.style.outline = 'none';
  setCatching(withDefaults(options).active);

  // Insert sentinel nodes into the container
  container.insertBefore(startSentinel, container.firstChild);
  container.insertBefore(backupSentinel, startSentinel.nextSibling);
  container.append(endSentinel);

  const setInitialFocus = async () => {
    // Use tick() to ensure focus trap works correctly inside <Portal />
    await tick();

    // Get focusable elements, excluding our sentinel nodes
    const allTabbable = getTabbable(container, false);
    const focusableElement = allTabbable.find((el) => !Object.hasOwn(el.dataset, 'focusTrap'));

    if (focusableElement) {
      focusableElement.focus();
    } else {
      backupSentinel.setAttribute('tabindex', '-1');
      // No focusable elements found, use backup sentinel as fallback
      backupSentinel.focus();
    }
  };

  if (withDefaults(options).active) {
    void setInitialFocus();
  }

  const getFocusableElements = () => {
    // Get all tabbable elements except our sentinel nodes
    const allTabbable = getTabbable(container);
    const focusableElements = allTabbable.filter((el) => !Object.hasOwn(el.dataset, 'focusTrap'));

    return [
      focusableElements.at(0), //
      focusableElements.at(-1),
    ];
  };

  // Add focus event listeners to sentinel nodes
  const handleStartFocus = () => {
    if (!withDefaults(options).active) {
      return;
    }

    const [, lastElement] = getFocusableElements();
    // If no elements, stay on backup sentinel
    if (lastElement) {
      lastElement.focus();
    } else {
      backupSentinel.focus();
    }
  };

  const handleBackupFocus = () => {
    // Backup sentinel keeps focus when there are no other focusable elements
    if (!withDefaults(options).active) {
      return;
    }

    const [firstElement] = getFocusableElements();
    // Only move focus if there are actual focusable elements
    if (firstElement) {
      firstElement.focus();
    }
    // Otherwise, focus stays on backup sentinel
  };

  const handleEndFocus = () => {
    if (!withDefaults(options).active) {
      return;
    }

    const [firstElement] = getFocusableElements();
    // If no elements, move to backup sentinel
    if (firstElement) {
      firstElement.focus();
    } else {
      backupSentinel.focus();
    }
  };

  startSentinel.addEventListener('focus', handleStartFocus);
  backupSentinel.addEventListener('focus', handleBackupFocus);
  endSentinel.addEventListener('focus', handleEndFocus);

  return {
    update(newOptions?: Options) {
      options = newOptions;
      setCatching(withDefaults(options).active);
      if (withDefaults(options).active) {
        void setInitialFocus();
      }
    },
    destroy() {
      // Remove event listeners
      startSentinel.removeEventListener('focus', handleStartFocus);
      backupSentinel.removeEventListener('focus', handleBackupFocus);
      endSentinel.removeEventListener('focus', handleEndFocus);

      // Remove sentinel nodes from DOM
      startSentinel.remove();
      backupSentinel.remove();
      endSentinel.remove();

      if (triggerElement instanceof HTMLElement) {
        triggerElement.focus();
      }
    },
  };
}
