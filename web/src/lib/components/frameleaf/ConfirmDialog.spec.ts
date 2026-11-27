import { fireEvent, render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '../../../../../i18n/en.json';
import ConfirmDialog from './ConfirmDialog.svelte';

vi.mock('$lib/utils/handle-error', () => ({ handleError: vi.fn() }));
const { handleError } = await import('$lib/utils/handle-error');

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

  it('stays open and busy while onConfirm runs, then closes; a failure leaves it open', async () => {
    let finish!: () => void;
    const onConfirm = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const onClose = vi.fn();
    render(ConfirmDialog, {
      title: 'Delete “Lake days”?',
      prompt: 'This can’t be undone.',
      keepNote: 'Its 37 photos stay in your library.',
      confirmText: 'Delete album',
      danger: true,
      onConfirm,
      onClose,
    });
    expect(screen.getByText('Its 37 photos stay in your library.')).toBeInTheDocument();

    const action = screen.getByRole('button', { name: 'Delete album' });
    await fireEvent.click(action);
    expect(action).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(onClose).not.toHaveBeenCalled();

    finish();
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledWith(true));
  });

  it('stays open when onConfirm fails', async () => {
    const onClose = vi.fn();
    const onConfirm = vi.fn().mockRejectedValue(new Error('offline'));
    render(ConfirmDialog, { title: 'Leave?', confirmText: 'Leave album', onConfirm, onClose });

    const action = screen.getByRole('button', { name: 'Leave album' });
    await fireEvent.click(action);
    await vi.waitFor(() => expect(action).not.toBeDisabled());
    expect(handleError).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('keeps Escape and the close button from closing it while the action runs', async () => {
    let finish!: () => void;
    const onClose = vi.fn();
    render(ConfirmDialog, {
      title: 'Leave “Lake days”?',
      confirmText: 'Leave album',
      onConfirm: () => new Promise<void>((resolve) => (finish = resolve)),
      onClose,
    });

    await fireEvent.click(screen.getByRole('button', { name: 'Leave album' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.getByRole('heading', { name: 'Leave “Lake days”?' })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    finish();
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledWith(true));
  });

  it('gives the focus back to the action after a failure', async () => {
    render(ConfirmDialog, {
      title: 'Delete?',
      confirmText: 'Delete album',
      danger: true,
      onConfirm: vi.fn().mockRejectedValue(new Error('offline')),
      onClose: vi.fn(),
    });
    const action = screen.getByRole('button', { name: 'Delete album' });
    action.focus();
    await fireEvent.click(action);
    await vi.waitFor(() => expect(action).toHaveFocus());
  });
});
