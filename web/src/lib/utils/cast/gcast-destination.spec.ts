import { deferredPromise } from '@test-data/deferred';
import { GCastDestination } from './gcast-destination.svelte';

const auth = vi.hoisted(() => ({ generation: 0 }));
vi.mock('chromecast-caf-sender', () => ({}));
vi.mock('$lib/managers/cast-manager.svelte', () => ({
  CastDestinationType: { GCAST: 'GCAST' },
  CastState: { IDLE: 'IDLE', PLAYING: 'PLAYING' },
}));
vi.mock('$lib/managers/auth-manager.svelte', () => ({
  authManager: {
    captureSession: () => {
      const generation = auth.generation;
      return () => generation === auth.generation;
    },
  },
}));

const response = () => new Response(null, { headers: { 'content-type': 'image/jpeg' } });
const firstUrl = 'https://example.test/api/assets/first/original?download=1';
const secondUrl = 'https://example.test/api/assets/second/original?download=1';

beforeEach(() => {
  auth.generation = 0;
  vi.stubGlobal('chrome', {
    cast: {
      media: {
        MediaInfo: class {
          constructor(
            public contentId: string,
            public contentType: string,
          ) {}
        },
        QueueItem: class {
          constructor(public media: unknown) {}
        },
        QueueLoadRequest: class {
          constructor(public items: unknown[]) {}
        },
        RepeatMode: { SINGLE: 'SINGLE' },
      },
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

const setup = () => {
  const destination = new GCastDestination();
  const session = { queueLoad: vi.fn(), leave: vi.fn() };
  destination.isAvailable = true;
  destination.isConnected = true;
  destination['session'] = session as unknown as chrome.cast.Session;
  const fetch = vi.fn<typeof globalThis.fetch>();
  vi.stubGlobal('fetch', fetch);
  return { destination, session, fetch };
};

it('queues only the latest selection when HEAD responses arrive out of order', async () => {
  const { destination, session, fetch } = setup();
  const first = deferredPromise<Response>();
  fetch.mockReturnValueOnce(first.promise).mockResolvedValueOnce(response());
  const pending = destination.loadMedia(firstUrl, 'key');
  await destination.loadMedia(secondUrl, 'key');
  first.resolve(response());
  await pending;
  expect(session.queueLoad).toHaveBeenCalledOnce();
  expect(session.queueLoad.mock.calls[0][0].items[0].media.contentId).toContain('/second/original');
});

it.each(['disconnect', 'replacement', 'account'] as const)('abandons an in-flight HEAD after %s', async (change) => {
  const { destination, session, fetch } = setup();
  const head = deferredPromise<Response>();
  fetch.mockReturnValueOnce(head.promise);
  const pending = destination.loadMedia(firstUrl, 'key');
  switch (change) {
    case 'disconnect': {
      destination.disconnect();
      break;
    }
    case 'replacement': {
      destination['session'] = {} as chrome.cast.Session;
      break;
    }
    case 'account': {
      auth.generation++;
      break;
    }
  }
  head.resolve(response());
  await pending;
  expect(session.queueLoad).not.toHaveBeenCalled();
});

it('adds one encoded session token to a URL without query parameters', async () => {
  const { destination, session, fetch } = setup();
  fetch.mockResolvedValueOnce(response());
  const url = 'https://example.test/api/assets/first/original#preview';
  await destination.loadMedia(url, 'a&b=+?#');
  const sent = new URL(session.queueLoad.mock.calls[0][0].items[0].media.contentId);
  expect(sent.pathname).toBe('/api/assets/first/original');
  expect(sent.searchParams.getAll('sessionKey')).toEqual(['a&b=+?#']);
  expect(sent.hash).toBe('#preview');
  expect(fetch).toHaveBeenCalledExactlyOnceWith(url, { method: 'HEAD' });
});

it('keeps the current media when a newer selection returns to it during another HEAD request', async () => {
  const { destination, session, fetch } = setup();
  const head = deferredPromise<Response>();
  fetch.mockResolvedValueOnce(response()).mockReturnValueOnce(head.promise);
  await destination.loadMedia(firstUrl, 'key');
  const pending = destination.loadMedia(secondUrl, 'key');
  await destination.loadMedia(firstUrl, 'key');
  head.resolve(response());
  await pending;
  expect(session.queueLoad).toHaveBeenCalledOnce();
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('ignores media-discovery callbacks belonging to an older selection', async () => {
  const { destination, session, fetch } = setup();
  fetch.mockResolvedValue(response());
  await destination.loadMedia(firstUrl, 'key');
  await destination.loadMedia(secondUrl, 'key');
  const oldMedia = {} as chrome.cast.media.Media;
  const currentMedia = {} as chrome.cast.media.Media;
  session.queueLoad.mock.calls[0][1](oldMedia);
  expect(destination['currentMedia']).toBeNull();
  session.queueLoad.mock.calls[1][1](currentMedia);
  expect(destination['currentMedia']).toBe(currentMedia);
});
