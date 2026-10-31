import { tick } from 'svelte';
import { focusTrap } from '$lib/actions/focus-trap';
import { setDefaultTabbleOptions } from '$lib/utils/focus-util';
import { deferredPromise } from '@test-data/deferred';

vi.mock('svelte', async (importOriginal) => ({
  ...(await importOriginal<typeof import('svelte')>()),
  tick: vi.fn(),
}));

beforeEach(() => {
  setDefaultTabbleOptions({ displayCheck: 'none' });
  vi.mocked(tick).mockReset();
});
afterEach(() => document.body.replaceChildren());

function fixture() {
  const trigger = document.createElement('button');
  const container = document.createElement('div');
  const button = document.createElement('button');
  container.append(button);
  document.body.append(trigger, container);
  trigger.focus();
  return { trigger, container, button };
}

it('does not take focus after being deactivated while waiting for tick', async () => {
  const pending = deferredPromise<void>();
  vi.mocked(tick).mockReturnValue(pending.promise);
  const { trigger, container } = fixture();
  const action = focusTrap(container);
  action.update({ active: false });
  pending.resolve();
  await pending.promise;
  expect(document.activeElement).toBe(trigger);
  action.destroy();
});

it('does not take focus back from the trigger after being destroyed before tick', async () => {
  const pending = deferredPromise<void>();
  vi.mocked(tick).mockReturnValue(pending.promise);
  const { trigger, container } = fixture();
  const action = focusTrap(container);
  action.destroy();
  pending.resolve();
  await pending.promise;
  expect(document.activeElement).toBe(trigger);
  expect(container.querySelector('[data-focus-trap]')).toBeNull();
});

it('only the latest activation may move initial focus', async () => {
  const first = deferredPromise<void>();
  const second = deferredPromise<void>();
  vi.mocked(tick).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const { container, button } = fixture();
  const focus = vi.spyOn(button, 'focus');
  const action = focusTrap(container);
  action.update({ active: false });
  action.update({ active: true });
  second.resolve();
  await second.promise;
  expect(focus).toHaveBeenCalledTimes(1);
  first.resolve();
  await first.promise;
  expect(focus).toHaveBeenCalledTimes(1);
  action.destroy();
});
