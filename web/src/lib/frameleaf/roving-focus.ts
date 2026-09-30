import { readingKey } from '$lib/frameleaf/reading-direction';

/**
 * FL-139: the keyboard pattern of a radio group or a list box (WAI-ARIA APG), for the ones built from
 * buttons. The group is one tab stop: the checked or selected item, else the first. The arrow keys move
 * between items (← and → in reading order), Home and End go to the ends. In a radio group the item
 * that takes focus is also checked; in a list box it only takes focus, and Enter or Space picks it.
 */
const ITEM = '[role="radio"], [role="option"]';
const GROUP = '[role="radiogroup"], [role="listbox"]';

const items = (root: HTMLElement) =>
  [...root.querySelectorAll<HTMLElement>(ITEM)].filter(
    (item) =>
      item.closest(GROUP) === root && !item.hasAttribute('disabled') && item.getAttribute('aria-disabled') !== 'true',
  );

const syncTabStop = (root: HTMLElement) => {
  const list = items(root);
  const stop =
    list.find((item) => item === document.activeElement) ??
    list.find(
      (item) => item.getAttribute('aria-checked') === 'true' || item.getAttribute('aria-selected') === 'true',
    ) ??
    list[0];
  for (const item of list) {
    item.tabIndex = item === stop ? 0 : -1;
  }
};

export const rovingFocus = (root: HTMLElement) => {
  const onKeydown = (event: KeyboardEvent) => {
    if (event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }
    const list = items(root);
    const index = list.indexOf(document.activeElement as HTMLElement);
    if (index === -1) {
      return;
    }
    const key = readingKey(event.key);
    const target =
      key === 'ArrowDown' || key === 'ArrowRight'
        ? list[(index + 1) % list.length]
        : key === 'ArrowUp' || key === 'ArrowLeft'
          ? list[(index - 1 + list.length) % list.length]
          : key === 'Home'
            ? list[0]
            : key === 'End'
              ? list.at(-1)
              : undefined;
    if (!target) {
      return;
    }
    // the arrows belong to the group here, not to a page shortcut behind it
    event.preventDefault();
    event.stopPropagation();
    target.focus();
    if (target.getAttribute('role') === 'radio' && target.getAttribute('aria-checked') !== 'true') {
      target.click();
    }
    syncTabStop(root);
  };
  const onFocusin = () => syncTabStop(root);
  // items come and go (a filtered list) and change state (a click elsewhere)
  const observer = new MutationObserver(() => syncTabStop(root));

  syncTabStop(root);
  root.addEventListener('keydown', onKeydown);
  root.addEventListener('focusin', onFocusin);
  observer.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['aria-checked', 'aria-selected', 'disabled', 'aria-disabled'],
  });

  return {
    destroy() {
      observer.disconnect();
      root.removeEventListener('keydown', onKeydown);
      root.removeEventListener('focusin', onFocusin);
    },
  };
};
