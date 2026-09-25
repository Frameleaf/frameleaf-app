import { toastManager } from '@immich/ui';
import { t } from 'svelte-i18n';
import { get } from 'svelte/store';

/** How long a pet decision can be undone from its toast (FL-58), as for trashing photos. */
export const PET_UNDO_TIMEOUT_MS = 6000;

/**
 * The toast after a pet decision (add, remove, accept, reassign, ignore) with its Undo (FL-58).
 * `undo` performs the reverse write through the pets API; it is the caller's, so the reverse of
 * each decision stays next to the decision itself.
 */
export const toastPetDecision = (description: string, undo: () => Promise<void>) => {
  const $t = get(t);
  toastManager.primary(
    { description, button: { label: $t('undo'), color: 'secondary', onclick: () => void undo() } },
    { timeout: PET_UNDO_TIMEOUT_MS },
  );
};
