import { modalManager } from '@immich/ui';
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
 * Ask for confirmation with the Frameleaf `ConfirmDialog` instead of `modalManager.showDialog`'s
 * upstream modal. Resolves `true` only when the action button was pressed; Cancel, the close
 * button and Escape all resolve `false`.
 */
export const confirmFrameleaf = async (options: FrameleafConfirmOptions): Promise<boolean> =>
  (await modalManager.show(ConfirmDialog, options)) === true;
