import type { ToastShow } from '@frameleaf/ui';

const svelte = vi.hoisted(() => ({ mount: vi.fn(), unmount: vi.fn() }));
vi.mock('svelte', async (original) => ({ ...(await original<object>()), ...svelte }));

type ToastManager = typeof import('../../../../packages/ui/dist/services/toast-manager.svelte.js').toastManager;
let manager: ToastManager;

beforeEach(async () => {
  vi.resetModules();
  svelte.mount.mockReset().mockImplementation(() => ({}));
  svelte.unmount.mockReset().mockResolvedValue(undefined);
  manager = (await import('../../../../packages/ui/dist/services/toast-manager.svelte.js')).toastManager;
});

afterEach(async () => {
  svelte.unmount.mockResolvedValue(undefined);
  await manager.unmount();
});

it('mounts one panel for several toasts opened in the same turn', async () => {
  manager.show({ title: 'First' }, { id: 'first', timeout: 0 });
  manager.show({ title: 'Second' }, { id: 'second', timeout: 0 });
  manager.show({ title: 'Third' }, { id: 'third', timeout: 0 });
  await manager.mount();
  expect(svelte.mount).toHaveBeenCalledTimes(1);
  expect(svelte.mount.mock.calls[0][1].props.items.map((item: ToastShow) => item.title)).toEqual([
    'First',
    'Second',
    'Third',
  ]);
});

it('can mount again after the renderer has been unmounted', async () => {
  await manager.mount();
  await manager.unmount();
  await manager.mount();
  expect(svelte.mount).toHaveBeenCalledTimes(2);
  expect(svelte.unmount).toHaveBeenCalledTimes(1);
});

it('detaches the renderer once when cleanup is requested twice in the same turn', async () => {
  await manager.mount();
  await Promise.all([manager.unmount(), manager.unmount()]);
  expect(svelte.unmount).toHaveBeenCalledTimes(1);
});

it('preserves unmount errors and permits a fresh renderer after failed cleanup', async () => {
  await manager.mount();
  const error = new Error('cleanup failed');
  svelte.unmount.mockRejectedValueOnce(error);
  await expect(manager.unmount()).rejects.toBe(error);
  await manager.mount();
  expect(svelte.mount).toHaveBeenCalledTimes(2);
});

it('keeps a new renderer when old asynchronous cleanup finishes later', async () => {
  const first = {};
  const second = {};
  svelte.mount.mockReturnValueOnce(first).mockReturnValueOnce(second);
  await manager.mount();
  let finish!: () => void;
  svelte.unmount.mockReturnValueOnce(new Promise<void>((resolve) => (finish = resolve)));
  const old = manager.unmount();
  await manager.mount();
  finish();
  await old;
  await manager.mount();
  expect(svelte.mount).toHaveBeenCalledTimes(2);
  expect(svelte.unmount).toHaveBeenCalledExactlyOnceWith(first);
  await manager.unmount();
  expect(svelte.unmount).toHaveBeenLastCalledWith(second);
});

it('preserves live options, item identity, close callbacks and dismissal', async () => {
  manager.setOptions({ class: 'fl-toast-panel' });
  const item: ToastShow & { onClose?: () => void } = { title: 'Saved', description: 'Photo saved' };
  manager.show(item, { id: 'saved', timeout: 0 });
  await manager.mount();
  const props = svelte.mount.mock.calls[0][1].props;
  expect(props.class).toBe('fl-toast-panel');
  expect(props.items[0]).toMatchObject(item);
  expect(item).toMatchObject({ id: 'saved', onClose: expect.any(Function) });
  item.onClose?.();
  expect(props.items).toEqual([]);
});
