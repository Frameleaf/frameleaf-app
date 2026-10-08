import { modalManager } from '@frameleaf/ui';
import ConfirmDialog from '$lib/components/frameleaf/ConfirmDialog.svelte';
import { installFrameleafToasts } from '$lib/frameleaf/toast';

/**
 * The script half of "the legacy kit takes the brand" (the style half is the theme mapping in
 * web/src/app.css). Called once from the root layout:
 *
 * - every `toastManager` toast is drawn by the Frameleaf Toast ($lib/frameleaf/toast.ts);
 * - `modalManager.showDialog`, the kit's generic confirmation, opens the Frameleaf ConfirmDialog
 *   instead, so every confirmation in the app is the same sheet. Call sites keep their options;
 *   new code should call `confirmFrameleaf` from `$lib/frameleaf/confirm` directly.
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
      title,
      prompt,
      confirmText,
      disabled,
      // The kit's confirmation was destructive unless told otherwise; so is this one.
      danger: (confirmColor ?? 'danger') === 'danger',
    })) === true;
};
