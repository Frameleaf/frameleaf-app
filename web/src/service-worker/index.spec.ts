import { installMessageListener } from './messaging';
import { handleFetch } from './request';

vi.mock('./messaging', () => ({ installMessageListener: vi.fn() }));
vi.mock('./request', () => ({ handleFetch: vi.fn() }));

const listeners = new Map<string, EventListener>();
const skipWaiting = vi.fn();
const claim = vi.fn();

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  listeners.clear();
  vi.stubGlobal('location', new URL('https://frameleaf.test'));
  vi.stubGlobal('skipWaiting', skipWaiting);
  vi.stubGlobal('clients', { claim });
  vi.stubGlobal(
    'addEventListener',
    vi.fn((type: string, listener: EventListener) => listeners.set(type, listener)),
  );
  await import('./index');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it('registers the native lifecycle and fetch listeners plus cancellation dispatch', () => {
  expect(listeners.size).toBe(3);
  for (const type of ['install', 'activate', 'fetch']) {
    expect(listeners.has(type)).toBe(true);
  }
  expect(installMessageListener).toHaveBeenCalledOnce();
});

it.each([
  ['install', skipWaiting],
  ['activate', claim],
] as const)('extends %s with the exact lifecycle promise', (type, method) => {
  const promise = Promise.resolve();
  method.mockReturnValueOnce(promise);
  const waitUntil = vi.fn();
  listeners.get(type)!({ type, waitUntil } as unknown as Event);
  expect(method).toHaveBeenCalledOnce();
  expect(waitUntil).toHaveBeenCalledExactlyOnceWith(promise);
});

it.each(['thumbnail?size=preview', 'original?download=1'])(
  'hands the same request and response promise to %s',
  (path) => {
    const request = new Request(`https://frameleaf.test/api/assets/a/${path}`);
    const promise = Promise.resolve(new Response('media'));
    vi.mocked(handleFetch).mockReturnValueOnce(promise);
    const respondWith = vi.fn();
    listeners.get('fetch')!({ request, respondWith } as unknown as Event);
    expect(handleFetch).toHaveBeenCalledExactlyOnceWith(request);
    expect(respondWith).toHaveBeenCalledExactlyOnceWith(promise);
  },
);

it.each([
  ['POST', 'https://frameleaf.test/api/assets/a/thumbnail'],
  ['HEAD', 'https://frameleaf.test/api/assets/a/original'],
  ['GET', 'https://outside.test/api/assets/a/thumbnail'],
  ['GET', 'https://frameleaf.test/api/albums'],
  ['GET', 'https://frameleaf.test/api/assets/a/metadata'],
])('leaves %s %s to the browser', (method, url) => {
  const respondWith = vi.fn();
  listeners.get('fetch')!({ request: new Request(url, { method }), respondWith } as unknown as Event);
  expect(handleFetch).not.toHaveBeenCalled();
  expect(respondWith).not.toHaveBeenCalled();
});
