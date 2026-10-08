import { modalManager, toastManager } from '@frameleaf/ui';
import { afterAll, describe, expect, it, vi } from 'vitest';
import ConfirmDialog from '$lib/components/frameleaf/ConfirmDialog.svelte';
import Toast from '$lib/components/frameleaf/Toast.svelte';
import { installFrameleafKit } from './kit-bridge';
import { TOAST_ACTION_TIMEOUT_MS, toastAction, toastUndo } from './toast';

const originalOpen = toastManager.open;
const originalShowDialog = modalManager.showDialog;

describe('legacy kit bridge', () => {
  // The spy stands in for the kit's own `open`, so nothing is mounted.
  const open = vi.spyOn(toastManager, 'open').mockImplementation(() => {});
  const setOptions = vi.spyOn(toastManager, 'setOptions');
  installFrameleafKit();

  afterAll(() => {
    toastManager.open = originalOpen;
    modalManager.showDialog = originalShowDialog;
    vi.restoreAllMocks();
  });

  it('draws every existing toast call with the Frameleaf Toast and docks the panel', () => {
    expect(setOptions).toHaveBeenCalledWith({ class: 'fl-toast-panel' });

    toastManager.primary('Saved');
    const [item, options] = open.mock.calls.at(-1) as unknown as [{ component: unknown; props: object }, unknown];
    expect(item.component).toBe(Toast);
    expect(item.props).toMatchObject({ description: 'Saved', color: 'primary' });
    expect(options).toBeUndefined();

    toastManager.danger({ description: 'Could not save' }, { timeout: 10_000 });
    const [danger, dangerOptions] = open.mock.calls.at(-1) as unknown as [{ props: object }, unknown];
    expect(danger.props).toMatchObject({ description: 'Could not save', color: 'danger' });
    expect(dangerOptions).toEqual({ timeout: 10_000 });
  });

  it('leaves a caller’s own custom toast alone', () => {
    const custom = { component: ConfirmDialog, props: { onClose: () => {} } };
    toastManager.custom(custom as never);
    expect((open.mock.calls.at(-1) as unknown as [unknown])[0]).toBe(custom);
  });

  it('installs once', () => {
    const before = toastManager.open;
    installFrameleafKit();
    expect(toastManager.open).toBe(before);
  });

  it('offers Undo as a toast action that stays long enough to reach', () => {
    const onUndo = vi.fn();
    toastUndo('Moved 3 photos to Trash', onUndo);
    const [item, options] = open.mock.calls.at(-1) as unknown as [
      { props: { description: string; button: { label: string; onclick: () => void } } },
      { timeout: number },
    ];
    expect(item.props.description).toBe('Moved 3 photos to Trash');
    expect(item.props.button.label).toBe('undo');
    item.props.button.onclick();
    expect(onUndo).toHaveBeenCalledOnce();
    expect(options.timeout).toBe(TOAST_ACTION_TIMEOUT_MS);

    toastAction('Link copied', { label: 'Open', onAction: vi.fn(), tone: 'info', timeout: 4000 });
    const [info, infoOptions] = open.mock.calls.at(-1) as unknown as [
      { props: { color: string; button: { label: string } } },
      { timeout: number },
    ];
    expect(info.props.color).toBe('info');
    expect(info.props.button.label).toBe('Open');
    expect(infoOptions.timeout).toBe(4000);
  });

  it('opens the Frameleaf ConfirmDialog for the kit’s generic confirmation', async () => {
    const show = vi.spyOn(modalManager, 'show').mockResolvedValue(true as never);
    await expect(modalManager.showDialog({ title: 'Remove comment?', confirmText: 'Remove' })).resolves.toBe(true);
    // The kit's confirmation was destructive unless told otherwise.
    expect(show).toHaveBeenCalledWith(
      ConfirmDialog,
      expect.objectContaining({ title: 'Remove comment?', confirmText: 'Remove', danger: true }),
    );

    show.mockResolvedValue(undefined as never);
    await expect(modalManager.showDialog({ confirmColor: 'primary' })).resolves.toBe(false);
    expect(show).toHaveBeenLastCalledWith(ConfirmDialog, expect.objectContaining({ danger: false }));
  });
});
