import { toastManager } from '@frameleaf/ui';
import { t } from 'svelte-i18n';
import { get } from 'svelte/store';
import Toast from '$lib/components/frameleaf/Toast.svelte';

/**
 * Frameleaf toasts. Every existing `toastManager.primary/success/info/warning/danger/show` call
 * keeps working: `installFrameleafToasts()` (called once from the root layout) makes the
 * Frameleaf `Toast` the renderer for all of them, so they dock at the bottom centre in the brand
 * surface and honour Reduce Motion. New code can keep calling `toastManager`, or use the two
 * helpers here.
 */

type ToastItem = Parameters<typeof toastManager.open>[0];
type ToastOptions = Parameters<typeof toastManager.open>[1];

const isCustom = (item: ToastItem): boolean => !!(item as { component?: unknown }).component;

let installed = false;

/** Routes every non-custom toast through the Frameleaf Toast component. Safe to call twice. */
export const installFrameleafToasts = (): void => {
  if (installed) {
    return;
  }
  installed = true;
  const open = toastManager.open.bind(toastManager);
  toastManager.open = (item: ToastItem, options?: ToastOptions) =>
    open(isCustom(item) ? item : ({ component: Toast, props: { ...item } } as unknown as ToastItem), options);
  toastManager.setOptions({ class: 'fl-toast-panel' });
};

/** How long a toast with an action stays: long enough to read it and reach the button. */
export const TOAST_ACTION_TIMEOUT_MS = 8000;

export type ToastActionOptions = {
  /** The button text. */
  label: string;
  onAction: () => unknown;
  tone?: 'primary' | 'info' | 'warning' | 'danger';
  timeout?: number;
};

/** A toast with one action button. The toast closes when the action is taken. */
export const toastAction = (
  message: string,
  { label, onAction, tone = 'primary', timeout = TOAST_ACTION_TIMEOUT_MS }: ToastActionOptions,
): void => {
  toastManager.show({ description: message, color: tone, button: { label, onclick: onAction } }, { timeout });
};

/**
 * "Moved 3 photos to Trash" with an Undo button: `toastUndo($t('...'), () => restore(ids))`.
 * The action label is the shared "Undo" translation.
 */
export const toastUndo = (message: string, onUndo: () => unknown, timeout = TOAST_ACTION_TIMEOUT_MS): void =>
  toastAction(message, { label: get(t)('undo'), onAction: onUndo, timeout });
