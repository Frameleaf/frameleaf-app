import { toastManager } from '@frameleaf/ui';
import { handleError, setUnauthorizedHandler } from '$lib/utils/handle-error';
import { revokeSessionView } from '$lib/utils/session-privacy';

vi.mock('$lib/utils/session-privacy', () => ({ revokeSessionView: vi.fn() }));

const httpError = (status: number, message = 'Invalid share key') => ({
  name: 'HttpError',
  message,
  status,
  data: { message },
});

vi.mock('@frameleaf/sdk', async (original) => ({
  ...(await original<typeof import('@frameleaf/sdk')>()),
  isHttpError: (error: unknown) => (error as { name?: string })?.name === 'HttpError',
}));

/** The shape `uploadRequest` rejects with (`$lib/utils`, not exported). */
class UploadApiError extends Error {
  override name = 'ApiError';

  constructor(
    message: string,
    public statusCode: number,
  ) {
    super(message);
  }
}

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

  it('shows Frameleaf Cloud’s whole message when it paused new work (FC-62), and shortens others', () => {
    const message =
      'Linking new servers is paused while we move to new hardware. Servers already linked keep working; try again this evening.';
    handleError(
      { name: 'HttpError', message, status: 503, data: { message, code: 'service-paused' } },
      'Could not link',
    );
    expect(toastManager.danger).toHaveBeenLastCalledWith(`Could not link\n${message}`);

    handleError(httpError(503, message), 'Could not link');
    expect(toastManager.danger).toHaveBeenLastCalledWith('Could not link\nframeleaf_error_reason_try_later');
  });

  it('keeps server text out of the toast and says what the answer means instead', () => {
    handleError(httpError(404, 'Not Found (Frameleaf Server Error)'), 'Unable to load');
    expect(toastManager.danger).toHaveBeenLastCalledWith('Unable to load\nframeleaf_error_reason_not_found');

    handleError(httpError(400, 'Bad Request'), 'Unable to load');
    expect(toastManager.danger).toHaveBeenLastCalledWith('Unable to load');

    handleError(httpError(413, 'Payload Too Large'), 'Unable to upload');
    expect(toastManager.danger).toHaveBeenLastCalledWith('Unable to upload\nframeleaf_error_reason_too_large');
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

    expect(toastManager.danger).toHaveBeenCalledWith('Unable to download\nframeleaf_error_forbidden_title');
  });

  it('still toasts other failures while a handler is registered', () => {
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);

    handleError(httpError(400, 'Bad request'), 'Unable to download');

    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(toastManager.danger).toHaveBeenCalledOnce();
  });

  it('hands an upload refused with 401 to the registered handler (FL-56: link revoked mid-upload)', () => {
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    // `uploadRequest` (XMLHttpRequest) rejects with its own ApiError, not the SDK's HttpError.
    const uploadError = new UploadApiError('Unauthorized', 401);

    handleError(uploadError, 'Unable to upload file');

    expect(onUnauthorized).toHaveBeenCalledOnce();
    expect(toastManager.danger).not.toHaveBeenCalled();
  });

  it('keeps other refused uploads a toast', () => {
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    const uploadError = new UploadApiError('Payload Too Large', 413);

    handleError(uploadError, 'Unable to upload file');

    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(toastManager.danger).toHaveBeenCalledOnce();
  });

  it('toasts a 401 when no page registered a handler', () => {
    handleError(httpError(401), 'Unable to download');

    expect(toastManager.danger).toHaveBeenCalledOnce();
  });
});
