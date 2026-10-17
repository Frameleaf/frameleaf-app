import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it('does not read navigator outside a secure context', async () => {
  vi.stubGlobal('isSecureContext', false);
  vi.stubGlobal('navigator', undefined);
  const { cancelImageUrl } = await import('./sw-messaging');
  expect(() => cancelImageUrl('/image')).not.toThrow();
});

it('ignores a missing service worker and empty URLs', async () => {
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('navigator', {});
  const { cancelImageUrl } = await import('./sw-messaging');
  expect(() => cancelImageUrl('/image')).not.toThrow();
  expect(() => cancelImageUrl(null)).not.toThrow();
  expect(() => cancelImageUrl(undefined)).not.toThrow();
});

it('captures the container once and reads its current controller for each message', async () => {
  const first = { postMessage: vi.fn() };
  const second = { postMessage: vi.fn() };
  const serviceWorker = { controller: first };
  const read = vi.fn(() => serviceWorker);
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('navigator', {
    get serviceWorker() {
      return read();
    },
  });
  const { cancelImageUrl } = await import('./sw-messaging');
  cancelImageUrl('');
  cancelImageUrl('/first');
  expect(first.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'cancel', url: '/first' });
  expect(first.postMessage.mock.contexts).toEqual([first]);
  serviceWorker.controller = second;
  vi.stubGlobal('navigator', {});
  cancelImageUrl('/second');
  expect(second.postMessage).toHaveBeenCalledExactlyOnceWith({ type: 'cancel', url: '/second' });
  expect(read).toHaveBeenCalledOnce();
});

it('allows an uncontrolled page and propagates transport failures', async () => {
  const serviceWorker: { controller: { postMessage: () => void } | null } = { controller: null };
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('navigator', { serviceWorker });
  const { cancelImageUrl } = await import('./sw-messaging');
  expect(() => cancelImageUrl('/image')).not.toThrow();
  const error = new Error('message failed');
  serviceWorker.controller = {
    postMessage: () => {
      throw error;
    },
  };
  expect(() => cancelImageUrl('/image')).toThrow(error);
});
