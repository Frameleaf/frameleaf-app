import { vi } from 'vitest';

/**
 * Test DOMs disagree with browsers about `:focus-visible` (some match every focused element, some
 * throw). This makes it explicit: only the elements in `visible` match it, as for keyboard focus in
 * a browser, and a focus left by a click does not.
 */
export const stubFocusVisible = () => {
  const visible = new Set<Element>();
  const original = Element.prototype.matches;
  const spy = vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, selector: string) {
    return selector === ':focus-visible' ? visible.has(this) : original.call(this, selector);
  });
  return { visible, restore: () => spy.mockRestore() };
};
