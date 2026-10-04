import { modalManager } from '@immich/ui';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ConfirmDialog from '$lib/components/frameleaf/ConfirmDialog.svelte';
import { confirmFrameleaf } from './confirm';

describe('confirmFrameleaf', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('opens the Frameleaf ConfirmDialog and resolves true only for the action', async () => {
    const show = vi.spyOn(modalManager, 'show').mockResolvedValue(true as never);
    const options = { title: 'Delete this key?', confirmText: 'Delete', danger: true };

    await expect(confirmFrameleaf(options)).resolves.toBe(true);
    expect(show).toHaveBeenCalledWith(ConfirmDialog, options);

    show.mockResolvedValue(undefined as never);
    await expect(confirmFrameleaf(options)).resolves.toBe(false);
  });
});
