import { toastManager } from '@immich/ui';
import { handleError, setUnauthorizedHandler } from '$lib/utils/handle-error';
import { revokeSessionView } from '$lib/utils/session-privacy';

vi.mock('$lib/utils/session-privacy', () => ({ revokeSessionView: vi.fn() }));

const httpError = (status: number, message = 'Invalid share key') => ({
  name: 'HttpError',
  message,
  status,
  data: { message },
});

vi.mock('@immich/sdk', async (original) => ({
  ...(await original<typeof import('@immich/sdk')>()),
  isHttpError: (error: unknown) => (error as { name?: string })?.name === 'HttpError',
}));

describe('handleError', () => {
  beforeEach(() => {
    vi.mocked(revokeSessionView).mockClear();
    vi.spyOn(toastManager, 'danger').mockImplementation(() => undefined as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    setUnauthorizedHandler(undefined);
    vi.restoreAllMocks();
  });

  it('signs out when remote access needs a Frameleaf sign-in (FL-161)', () => {
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);

    handleError(
      {
        ...httpError(403, 'Away from home, sign in with your Frameleaf account'),
        data: { code: 'frameleaf_sign_in_required' },
      },
      'Unable to load',
    );

    expect(revokeSessionView).toHaveBeenCalledWith('/auth/logout');
    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(toastManager.danger).not.toHaveBeenCalled();
  });

  it('keeps an ordinary 403 a toast', () => {
    handleError(httpError(403, 'Forbidden'), 'Unable to load');

    expect(revokeSessionView).not.toHaveBeenCalled();
    expect(toastManager.danger).toHaveBeenCalledOnce();
  });

  it('hands a refused action to the registered handler instead of toasting (FL-56)', () => {
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);

    handleError(httpError(401), 'Unable to download');

    expect(onUnauthorized).toHaveBeenCalledOnce();
    expect(toastManager.danger).not.toHaveBeenCalled();
  });

  it('logs a refused action rather than swallowing it', () => {
    setUnauthorizedHandler(vi.fn());

    handleError(httpError(401), 'Unable to download');

    expect(console.error).toHaveBeenCalledOnce();
  });

  it('lets the handler show the normal toast when the link turns out to be valid', () => {
    setUnauthorizedHandler((showError) => showError());

    handleError(httpError(401, 'Not permitted'), 'Unable to download');

    expect(toastManager.danger).toHaveBeenCalledWith(expect.stringContaining('Not permitted'));
  });

  it('still toasts other failures while a handler is registered', () => {
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);

    handleError(httpError(400, 'Bad request'), 'Unable to download');

    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(toastManager.danger).toHaveBeenCalledOnce();
  });

  it('toasts a 401 when no page registered a handler', () => {
    handleError(httpError(401), 'Unable to download');

    expect(toastManager.danger).toHaveBeenCalledOnce();
  });
});
