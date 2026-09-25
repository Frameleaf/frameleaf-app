/**
 * Which keyboard targets keep their own keys in the viewer (MediaViewer.jsx:749-754, 781): a field,
 * a video, a slider or a combobox takes every key, and Space on a button or link presses it rather
 * than playing the slideshow.
 */
export const VIEWER_TYPING_SELECTOR =
  'input, select, textarea, [contenteditable="true"], [contenteditable=""], video, [role="slider"], [role="combobox"]';

export const VIEWER_CONTROL_SELECTOR = 'button, a[href], [role="button"], [role="menuitem"], [role="option"]';

const closest = (target: EventTarget | null, selector: string): boolean =>
  typeof Element !== 'undefined' && target instanceof Element && !!target.closest(selector);

/** A key pressed in a field, a video, a slider or a combobox belongs to it, not to the viewer. */
export const isTypingTarget = (target: EventTarget | null): boolean => closest(target, VIEWER_TYPING_SELECTOR);

/** Space on a focused control presses that control. */
export const isControlTarget = (target: EventTarget | null): boolean =>
  isTypingTarget(target) || closest(target, VIEWER_CONTROL_SELECTOR);

/** Whether a modal dialog is open over the viewer; its keys are its own (MediaViewer.jsx:727-747). */
export const isDialogOpen = (root: ParentNode = document): boolean =>
  !!root.querySelector('dialog[open], [role="dialog"][aria-modal="true"], [role="alertdialog"]');
