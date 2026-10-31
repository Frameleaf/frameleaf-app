import type { ActionReturn } from 'svelte/action';
import { matchesShortcut } from '$lib/actions/shortcut';

interface Options {
  onOutclick?: () => void;
  onEscape?: () => void;
}

const escapeShortcut = { key: 'Escape' } as const;

/** Keeps outside-click and Escape callbacks current while retaining the same listeners. */
export function clickOutside(node: HTMLElement, options: Options = {}): ActionReturn<Options | undefined> {
  const handleClick = (event: MouseEvent) => {
    if (node.contains(event.target as Node | null)) {
      return;
    }
    const { onOutclick } = options;
    onOutclick?.();
  };

  const handleKey = (event: KeyboardEvent) => {
    const { onEscape } = options;
    if (onEscape && matchesShortcut(event, escapeShortcut)) {
      event.stopPropagation();
      onEscape();
    }
  };

  document.addEventListener('mousedown', handleClick);
  node.addEventListener('keydown', handleKey);

  return {
    update(next: Options = {}) {
      options = next;
    },
    destroy() {
      document.removeEventListener('mousedown', handleClick);
      node.removeEventListener('keydown', handleKey);
    },
  };
}
