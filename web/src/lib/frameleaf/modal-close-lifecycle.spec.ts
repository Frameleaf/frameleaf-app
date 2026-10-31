import type { Component } from 'svelte';

const svelte = vi.hoisted(() => ({ mount: vi.fn(), unmount: vi.fn() }));
vi.mock('svelte', async (original) => ({ ...(await original<object>()), ...svelte }));

type ModalManager = typeof import('../../../../packages/ui/dist/services/modal-manager.svelte.js').modalManager;
type ModalProps = { label?: string; onClose: (value: string) => void };
const Component: Component<ModalProps> = () => ({});
let manager: ModalManager;

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => (resolve = accept));
  return { promise, resolve };
};

beforeEach(async () => {
  vi.resetModules();
  svelte.mount.mockReset().mockImplementation(() => ({}));
  svelte.unmount.mockReset().mockResolvedValue(undefined);
  manager = (await import('../../../../packages/ui/dist/services/modal-manager.svelte.js')).modalManager;
});

it('runs teardown once when UI and session callbacks close concurrently', async () => {
  const cleanup = deferred();
  svelte.unmount.mockReturnValueOnce(cleanup.promise);
  const modal = manager.open(Component, {});
  const first = modal.close('first');
  const second = modal.close('second');
  cleanup.resolve();
  await Promise.all([first, second]);
  expect(svelte.unmount).toHaveBeenCalledTimes(1);
});

it('keeps the first close result while its asynchronous cleanup is pending', async () => {
  const cleanup = deferred();
  svelte.unmount.mockReturnValueOnce(cleanup.promise);
  const modal = manager.open(Component, {});
  const first = modal.close('accepted');
  const second = modal.close('dismissed');
  await Promise.resolve();
  cleanup.resolve();
  await Promise.all([first, second]);
  await expect(modal.onClose).resolves.toBe('accepted');
});

it('uses the actual mounted instance when a component requests close during mount', async () => {
  const instance = {};
  svelte.mount.mockImplementation((_component, options) => {
    options.props.onClose('closed during mount');
    return instance;
  });
  const modal = manager.open(Component, {});
  await expect(modal.onClose).resolves.toBe('closed during mount');
  expect(svelte.unmount).toHaveBeenCalledExactlyOnceWith(instance);
});

it('does not repeat cleanup or replace data when teardown synchronously reenters close', async () => {
  const modal = manager.open(Component, {});
  svelte.unmount.mockImplementation(() => {
    if (svelte.unmount.mock.calls.length === 1) {
      svelte.mount.mock.calls[0][1].props.onClose('reentrant');
    }
    return Promise.resolve();
  });
  await modal.close('original');
  await expect(modal.onClose).resolves.toBe('original');
  expect(svelte.unmount).toHaveBeenCalledTimes(1);
});

it('retires a completed modal once even when close is requested again', async () => {
  const modal = manager.open(Component, {});
  await modal.close('first');
  await modal.close('again');
  await expect(modal.onClose).resolves.toBe('first');
  expect(svelte.unmount).toHaveBeenCalledTimes(1);
});

it('shares a failed attempt then permits a new attempt without releasing the result early', async () => {
  const error = new Error('cleanup failed');
  svelte.unmount.mockRejectedValueOnce(error);
  const modal = manager.open(Component, {});
  let settled = false;
  void modal.onClose.then(() => (settled = true));
  const first = modal.close('failed');
  const second = modal.close('also failed');
  const outcomes = await Promise.allSettled([first, second]);
  expect(outcomes).toEqual([
    { status: 'rejected', reason: error },
    { status: 'rejected', reason: error },
  ]);
  expect(settled).toBe(false);
  await modal.close('retried');
  await expect(modal.onClose).resolves.toBe('retried');
  expect(svelte.unmount).toHaveBeenCalledTimes(2);
});

it('preserves mount-error rejection on the result promise', async () => {
  const error = new Error('mount failed');
  svelte.mount.mockImplementationOnce(() => {
    throw error;
  });
  const modal = manager.open(Component, {});
  await expect(modal.onClose).rejects.toBe(error);
  expect(svelte.unmount).not.toHaveBeenCalled();
});

it('preserves the component, body target, caller props and overridden close callback', async () => {
  const originalClose = vi.fn();
  const props = { label: 'Album', onClose: originalClose };
  const modal = manager.open(Component, props);
  expect(svelte.mount).toHaveBeenCalledWith(
    Component,
    expect.objectContaining({ target: document.body, props: expect.objectContaining({ label: 'Album' }) }),
  );
  const callback = svelte.mount.mock.calls[0][1].props.onClose;
  await callback('selected');
  await expect(modal.onClose).resolves.toBe('selected');
  expect(originalClose).not.toHaveBeenCalled();
  expect(props).toEqual({ label: 'Album', onClose: originalClose });
});

it('keeps a failed modal in the actual session sweep until a retry succeeds', async () => {
  const { trackSessionModals, closeSessionModals } = await import('./session-access.svelte');
  trackSessionModals(manager);
  const modal = manager.open(Component, {});
  const error = new Error('busy');
  svelte.unmount.mockRejectedValueOnce(error);
  let retired = false;
  void modal.onClose.then(() => (retired = true));
  await expect(closeSessionModals()).rejects.toBe(error);
  expect(retired).toBe(false);
  await expect(closeSessionModals()).resolves.toBeUndefined();
  await expect(modal.onClose).resolves.toBeUndefined();
  expect(svelte.unmount).toHaveBeenCalledTimes(2);
});
