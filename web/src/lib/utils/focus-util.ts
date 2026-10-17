import { focusable, isTabbable, tabbable, type CheckOptions, type TabbableOptions } from 'tabbable';

type TabbableOpts = TabbableOptions & CheckOptions;
let defaultOpts: TabbableOpts = {
  includeContainer: false,
};

export const setDefaultTabbleOptions = (options: TabbableOpts) => {
  defaultOpts = options;
};

export const getTabbable = (container: Element, includeContainer: boolean = false) =>
  tabbable(container, { ...defaultOpts, includeContainer });

export const moveFocus = (
  selector: (element: HTMLElement | SVGElement) => boolean,
  direction: 'previous' | 'next',
): void => {
  const elements = focusable(document.body, { includeContainer: true });

  if (elements.length === 0) {
    return;
  }

  const currentIndex = elements.indexOf(document.activeElement as HTMLElement);

  if (currentIndex === -1) {
    (elements.find((element) => selector(element)) ?? elements[0]).focus();
    return;
  }

  const step = direction === 'next' ? 1 : -1;
  for (let offset = 1; offset <= elements.length; offset++) {
    const candidate = elements[(currentIndex + step * offset + elements.length) % elements.length];
    if (selector(candidate) && isTabbable(candidate)) {
      candidate.focus();
      return;
    }
  }
};
