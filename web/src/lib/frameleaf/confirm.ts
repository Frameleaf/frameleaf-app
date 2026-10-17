import { modalManager } from '@frameleaf/ui';
import ConfirmDialog from '$lib/components/frameleaf/ConfirmDialog.svelte';

export type FrameleafConfirmOptions = {
  title: string;
  prompt?: string;
  confirmText: string;
  cancelText?: string;
  /** A destructive action takes the danger button, as the prototype's delete and revoke confirms do. */
  danger?: boolean;
};

/**
 * The one way to ask for confirmation: the Frameleaf `ConfirmDialog`. Resolves `true` only when
 * the action button was pressed; Cancel, the close button and Escape all resolve `false`.
 *
 * Say what will happen in the title ("Delete this album?"), the consequence in `prompt`, and name
 * the action in `confirmText` ("Delete album", never "OK" or "Yes"). Set `danger` for anything
 * that cannot be undone: the action turns red and Cancel takes first focus. Prefer an Undo toast
 * (`toastUndo`) over a confirmation when the action can be reversed.
 *
 * The legacy `modalManager.showDialog` is routed to the same dialog by `$lib/frameleaf/kit-bridge`,
 * so older call sites already look the same; new code calls this.
 */
export const confirmFrameleaf = async (options: FrameleafConfirmOptions): Promise<boolean> =>
  (await modalManager.show(ConfirmDialog, options)) === true;

/** `confirmFrameleaf` under its short name. */
export const confirm = confirmFrameleaf;
