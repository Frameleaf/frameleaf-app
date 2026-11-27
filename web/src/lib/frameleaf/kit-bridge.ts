import { modalManager } from '@frameleaf/ui';
import { t } from 'svelte-i18n';
import { get } from 'svelte/store';
import ConfirmDialog from '$lib/components/frameleaf/ConfirmDialog.svelte';
import { installFrameleafToasts } from '$lib/frameleaf/toast';

/**
 * The script half of "the legacy kit takes the brand" (the style half is the theme mapping in
 * web/src/app.css). Called once from the root layout:
 *
 * - every `toastManager` toast is drawn by the Frameleaf Toast ($lib/frameleaf/toast.ts);
 * - `modalManager.showDialog`, the kit's generic confirmation, opens the Frameleaf ConfirmDialog
 *   instead, so every confirmation in the app is the same sheet. Nothing in web/ calls it any more
 *   (FL-1814): app code calls `confirmFrameleaf` from `$lib/frameleaf/confirm`, which makes the
 *   title and the action text required. The generic "Confirm" here is only for the kit's own calls.
 */

type ShowDialogOptions = Parameters<typeof modalManager.showDialog>[0];

let installed = false;

export const installFrameleafKit = (): void => {
  if (installed) {
    return;
  }
  installed = true;
  installFrameleafToasts();
  modalManager.showDialog = async ({ title, prompt, confirmText, confirmColor, disabled }: ShowDialogOptions) =>
    (await modalManager.show(ConfirmDialog, {
      title: title ?? get(t)('confirm'),
      prompt,
      confirmText: confirmText ?? get(t)('confirm'),
      disabled,
      // The kit's confirmation was destructive unless told otherwise; so is this one.
      danger: (confirmColor ?? 'danger') === 'danger',
    })) === true;
};
