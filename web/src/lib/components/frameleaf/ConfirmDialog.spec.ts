import { fireEvent, render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '../../../../../i18n/en.json';
import ConfirmDialog from './ConfirmDialog.svelte';

describe('ConfirmDialog', () => {
  beforeAll(() => {
    addMessages('dev', en);
  });

  beforeEach(() => {
    HTMLDialogElement.prototype.showModal ??= vi.fn(function (this: HTMLDialogElement) {
      this.open = true;
    });
    HTMLDialogElement.prototype.close ??= vi.fn(function (this: HTMLDialogElement) {
      this.open = false;
    });
  });

  it('resolves true only from the action button', async () => {
    const onClose = vi.fn();
    render(ConfirmDialog, {
      title: 'Delete this backup?',
      prompt: 'Gone.',
      confirmText: 'Delete backup',
      danger: true,
      onClose,
    });

    expect(screen.getByRole('heading', { name: 'Delete this backup?' })).toBeInTheDocument();
    expect(screen.getByText('Gone.')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Delete backup' }));
    expect(onClose).toHaveBeenCalledWith(true);
  });

  it('resolves false from Cancel', async () => {
    const onClose = vi.fn();
    render(ConfirmDialog, { title: 'Revoke?', confirmText: 'Revoke', onClose });

    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledWith(false);
  });

  it('puts first focus on Cancel for a destructive action, on the action otherwise', () => {
    const { unmount } = render(ConfirmDialog, {
      title: 'Delete?',
      confirmText: 'Delete',
      danger: true,
      onClose: vi.fn(),
    });
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveAttribute('data-initial-focus');
    expect(screen.getByRole('button', { name: 'Delete' })).not.toHaveAttribute('data-initial-focus');
    unmount();

    render(ConfirmDialog, { title: 'Rotate?', confirmText: 'Rotate', onClose: vi.fn() });
    expect(screen.getByRole('button', { name: 'Rotate' })).toHaveAttribute('data-initial-focus');
  });
});
