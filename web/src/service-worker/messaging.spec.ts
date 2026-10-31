import { installMessageListener } from './messaging';
import { handleCancel } from './request';

vi.mock('./request', () => ({ handleCancel: vi.fn() }));

describe('worker cancellation messages', () => {
  let target: EventTarget;
  let listener: (event: ExtendableMessageEvent) => void;

  beforeEach(() => {
    vi.clearAllMocks();
    target = new EventTarget();
    vi.stubGlobal('location', new URL('https://frameleaf.test'));
    vi.spyOn(globalThis, 'addEventListener').mockImplementation((type, callback, options) => {
      target.addEventListener(type, callback as EventListener, options);
      listener = callback as (event: ExtendableMessageEvent) => void;
    });
    installMessageListener();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const client = { id: 'fixture-client' } as Client;
  const message = (data: unknown, source: ExtendableMessageEvent['source'] = client) =>
    Object.assign(new Event('message'), { data, source }) as ExtendableMessageEvent;

  it.each(['/api/assets/a/thumbnail?size=preview', 'https://frameleaf.test/api/assets/a/original?download=1'])(
    'forwards the normalized same-origin URL %s exactly once',
    (url) => {
      listener(message({ type: 'cancel', url }));
      expect(handleCancel).toHaveBeenCalledExactlyOnceWith(new URL(url, 'https://frameleaf.test'));
    },
  );

  it('installs one effective listener when installation is repeated', () => {
    installMessageListener();
    target.dispatchEvent(message({ type: 'cancel', url: '/api/assets/a/thumbnail' }));
    expect(handleCancel).toHaveBeenCalledOnce();
  });

  it('ignores messages without a source', () => {
    listener(message({ type: 'cancel', url: '/api/assets/a/thumbnail' }, new MessageEvent('message').source));
    expect(handleCancel).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    {},
    { type: 'other', url: '/api/assets/a/thumbnail' },
    { type: 'cancel' },
    { type: 'cancel', url: '' },
    { type: 'cancel', url: 1 },
    { type: 'cancel', url: { href: 'https://frameleaf.test/api/assets/a/thumbnail' } },
    { type: 'cancel', url: 'http://[' },
    { type: 'cancel', url: 'https://outside.test/api/assets/a/thumbnail' },
    { type: 'cancel', url: '//outside.test/api/assets/a/original' },
    { type: 'cancel', url: 'data:text/plain,media' },
  ])('ignores malformed or foreign cancellation data %j', (data) => {
    expect(() => listener(message(data))).not.toThrow();
    expect(handleCancel).not.toHaveBeenCalled();
  });

  it('retains URL normalization and resumes valid cancellation after malformed messages', () => {
    expect(() => listener(message({ type: 'cancel', url: 'http://[' }))).not.toThrow();
    listener(message({ type: 'cancel', url: '/api/assets/a/../b/thumbnail?size=preview' }));
    expect(handleCancel).toHaveBeenCalledExactlyOnceWith(
      new URL('https://frameleaf.test/api/assets/b/thumbnail?size=preview'),
    );
  });

  it('preserves request-layer cancellation failures', () => {
    const failure = new Error('cancel failed');
    vi.mocked(handleCancel).mockImplementationOnce(() => {
      throw failure;
    });
    expect(() => listener(message({ type: 'cancel', url: '/api/assets/a/thumbnail' }))).toThrow(failure);
  });
});
