import { on } from 'svelte/events';

interface Options {
  onFocusOut?: (event: FocusEvent) => void;
}

/** Forwards focus leaving the container to its current callback. */
export function focusOutside(node: HTMLElement, options: Options = {}) {
  const handleFocusOut = (event: FocusEvent) => {
    const { onFocusOut } = options;
    if (
      onFocusOut &&
      (!event.relatedTarget || (event.relatedTarget instanceof Node && !node.contains(event.relatedTarget)))
    ) {
      onFocusOut(event);
    }
  };

  const off = on(node, 'focusout', handleFocusOut);

  return {
    update(next: Options = {}) {
      options = next;
    },
    destroy() {
      off();
    },
  };
}
