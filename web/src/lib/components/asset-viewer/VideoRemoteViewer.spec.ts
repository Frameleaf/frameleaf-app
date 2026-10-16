import { render } from '@testing-library/svelte';
import { tick } from 'svelte';
import TestWrapper from '$lib/components/TestWrapper.svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { handleError } from '$lib/utils/handle-error';
import { deferredPromise } from '@test-data/deferred';
import { renderWithTooltips } from '../../../../tests/helpers';
import VideoRemoteViewer from './VideoRemoteViewer.svelte';

vi.mock('$lib/utils/handle-error', () => ({ handleError: vi.fn() }));

const cast = vi.hoisted(() => ({ state: 'PLAYING', connected: true, load: vi.fn() }));
vi.mock('$lib/managers/cast-manager.svelte', async () => {
  const { SvelteMap } = await import('svelte/reactivity');
  const state = new SvelteMap<string, string | boolean>([
    ['state', cast.state],
    ['connected', cast.connected],
  ]);
  Object.defineProperties(cast, {
    state: { get: () => state.get('state'), set: (value: string) => state.set('state', value) },
    connected: { get: () => state.get('connected'), set: (value: boolean) => state.set('connected', value) },
  });
  return {
    CastState: { IDLE: 'IDLE', PLAYING: 'PLAYING', PAUSED: 'PAUSED', BUFFERING: 'BUFFERING' },
    castManager: {
      get castState() {
        return cast.state;
      },
      get isCasting() {
        return cast.connected;
      },
      receiverName: 'Receiver',
      duration: 10,
      currentTime: 0,
      loadMedia: cast.load,
      play: vi.fn(),
      pause: vi.fn(),
      seekTo: vi.fn(),
    },
  };
});

const props = () => ({ poster: '/poster.jpg', assetFileUrl: '/video', onVideoStarted: vi.fn(), onVideoEnded: vi.fn() });
beforeEach(() => {
  vi.mocked(handleError).mockClear();
  cast.load.mockReset().mockResolvedValue(undefined);
  cast.state = 'PLAYING';
  cast.connected = true;
  authManager.reset();
});

it('does not end a video just because the receiver initially reports idle', async () => {
  cast.state = 'IDLE';
  const callbacks = props();
  renderWithTooltips(VideoRemoteViewer, callbacks);
  await tick();
  expect(callbacks.onVideoEnded).not.toHaveBeenCalled();
});

it.each(['PLAYING', 'PAUSED'])('reports a transition from %s to idle with the existing pause policy', async (from) => {
  cast.state = from;
  const callbacks = props();
  renderWithTooltips(VideoRemoteViewer, callbacks);
  await tick();
  cast.state = 'IDLE';
  await tick();
  expect(callbacks.onVideoEnded).toHaveBeenCalledTimes(from === 'PLAYING' ? 1 : 0);
});

it.each(['current', 'replace', 'close', 'session', 'disconnect'])(
  'publishes cast start only for its owner: %s',
  async (change) => {
    const pending = deferredPromise<void>();
    cast.load.mockReturnValueOnce(pending.promise);
    const callbacks = props();
    const view = render(TestWrapper, { component: VideoRemoteViewer, componentProps: callbacks });
    await tick();
    expect(cast.load).toHaveBeenCalled();
    switch (change) {
      case 'replace': {
        cast.load.mockReturnValueOnce(new Promise(() => {}));
        await view.rerender({ componentProps: { ...callbacks, assetFileUrl: '/replacement' } });

        break;
      }
      case 'close': {
        view.unmount();

        break;
      }
      case 'session': {
        authManager.reset();

        break;
      }
      case 'disconnect': {
        cast.connected = false;

        break;
      }
      // No default
    }
    pending.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(callbacks.onVideoStarted).toHaveBeenCalledTimes(change === 'current' ? 1 : 0);
  },
);

it.each(['current', 'close', 'session'])('reports a cast failure only for its owner: %s', async (change) => {
  const pending = deferredPromise<void>();
  cast.load.mockReturnValueOnce(pending.promise);
  const callbacks = props();
  const view = renderWithTooltips(VideoRemoteViewer, callbacks);
  await tick();
  if (change === 'close') {
    view.unmount();
  } else if (change === 'session') {
    authManager.reset();
  }
  const error = new Error('Receiver disconnected');
  pending.reject(error);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(handleError).toHaveBeenCalledTimes(change === 'current' ? 1 : 0);
  expect(callbacks.onVideoStarted).not.toHaveBeenCalled();
});
