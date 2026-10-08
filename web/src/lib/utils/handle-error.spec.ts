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

  it('shows Frameleaf Cloud’s whole message when it paused new work (FC-62), and no other 503 text', () => {
    const message =
      'Linking new servers is paused while we move to new hardware. Servers already linked keep working; try again this evening.';
    handleError(
      { name: 'HttpError', message, status: 503, data: { message, code: 'service-paused' } },
      'Could not link',
    );
    expect(toastManager.danger).toHaveBeenLastCalledWith(message);

    handleError(httpError(503, message), 'Could not link');
    expect(toastManager.danger).toHaveBeenLastCalledWith('Could not link. frameleaf_error_reason_server');
  });

  it('keeps an ordinary 403 a toast', () => {
    handleError(httpError(403, 'Forbidden'), 'Unable to load');

    expect(revokeSessionView).not.toHaveBeenCalled();
    expect(toastManager.danger).toHaveBeenCalledExactlyOnceWith('Unable to load. frameleaf_error_reason_not_allowed');
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

    expect(toastManager.danger).toHaveBeenCalledExactlyOnceWith('Not permitted');
  });

  it('still toasts other failures while a handler is registered', () => {
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);

    handleError(httpError(400, 'Bad request'), 'Unable to download');

    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(toastManager.danger).toHaveBeenCalledExactlyOnceWith('Unable to download');
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
    expect(toastManager.danger).toHaveBeenCalledExactlyOnceWith(
      'Unable to upload file. frameleaf_error_reason_too_large',
    );
  });

  it('toasts a 401 when no page registered a handler', () => {
    handleError(httpError(401), 'Unable to download');

    expect(toastManager.danger).toHaveBeenCalledExactlyOnceWith('Invalid share key');
  });

  describe('what the toast says (BRAND.md decision 10)', () => {
    const online = (value: boolean) => vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(value);

    it.each([
      [401, 'Unauthorized', 'sign_in'],
      [403, 'Forbidden', 'not_allowed'],
      [403, 'Forbidden resource', 'not_allowed'],
      [404, 'Not found', 'not_found'],
      [404, 'Not Found.', 'not_found'],
      [409, 'Conflict', 'conflict'],
      [413, 'Payload Too Large', 'too_large'],
      [500, 'Internal server error', 'server'],
      [502, 'Bad Gateway', 'server'],
      [503, 'Service Unavailable', 'server'],
    ])('says why for a bare %i (%s) after what the caller said', (status, message, reason) => {
      const shown = handleError(httpError(status, message), 'The album did not load');

      expect(shown).toBe(`The album did not load. frameleaf_error_reason_${reason}`);
      expect(toastManager.danger).toHaveBeenCalledExactlyOnceWith(shown);
    });

    it('never shows the old server-error suffix or a status name', () => {
      for (const [status, message] of [
        [400, 'Bad Request'],
        [404, 'Not found'],
        [500, 'Internal server error'],
      ] as const) {
        const shown = handleError(httpError(status, message), 'The album did not load') ?? '';
        expect(shown).not.toContain('Frameleaf Server Error');
        expect(shown.toLowerCase()).not.toContain(message.toLowerCase());
      }
    });

    it('does not repeat a full stop the caller already wrote', () => {
      expect(handleError(httpError(404, 'Not found'), 'The album did not load. Try again.')).toBe(
        'The album did not load. Try again. frameleaf_error_reason_not_found',
      );
    });

    it('keeps a specific refusal in the server’s own words', () => {
      expect(handleError(httpError(400, 'That email is already in use'), 'Unable to save')).toBe(
        'That email is already in use',
      );
      expect(handleError(httpError(409, 'An album with this name already exists'), 'Unable to save')).toBe(
        'An album with this name already exists',
      );
      expect(toastManager.danger).toHaveBeenLastCalledWith('An album with this name already exists');
    });

    it('keeps the fields of a refused form', () => {
      const error = {
        name: 'HttpError',
        message: 'Bad Request',
        status: 400,
        data: { message: 'Check these fields', errors: [{ path: ['email'], message: 'Enter an email address' }] },
      };

      expect(handleError(error, 'Unable to save')).toBe('Check these fields: email: Enter an email address');
    });

    it('never shows what a failing server (5xx) said, whatever it said', () => {
      expect(handleError(httpError(500, 'Your library is fine, honest'), 'Unable to save')).toBe(
        'Unable to save. frameleaf_error_reason_server',
      );
    });

    it.each([
      [400, 'Not found or no asset.read access'],
      [400, 'Not found or no album.update access'],
      [404, 'Cannot GET /api/albums/123'],
      [400, 'QueryFailedError: duplicate key value violates unique constraint'],
      [400, 'connect ECONNREFUSED 127.0.0.1:5432'],
      [400, 'Error: 400'],
      [400, '<html><body>Bad Request</body></html>'],
      [400, 'Immich is in maintenance mode'],
      [400, 'Invalid uuid'],
      [400, '   '],
    ])('does not show system text (%i: %s)', (status, message) => {
      const shown = handleError(httpError(status, message), 'Unable to save') ?? '';

      expect(shown.startsWith('Unable to save')).toBe(true);
      expect(shown).not.toContain(message.trim() || 'never');
      expect(toastManager.danger).toHaveBeenCalledExactlyOnceWith(shown);
    });

    it('shows only what the caller said when the status gives no reason', () => {
      expect(handleError(httpError(400, 'Bad Request'), 'Unable to save')).toBe('Unable to save');
      expect(handleError(httpError(418, 'Not found or no asset.read access'), 'Unable to save')).toBe('Unable to save');
    });

    it('shortens a long refusal at a word, with an ellipsis', () => {
      const long = `${'The name you chose is longer than this library allows '.repeat(4)}end`;

      const shown = handleError(httpError(400, long), 'Unable to save') ?? '';

      expect(shown.length).toBeLessThanOrEqual(141);
      expect(shown.endsWith('…')).toBe(true);
      expect(long.startsWith(shown.slice(0, -1))).toBe(true);
      expect(shown.slice(0, -1).endsWith(' ')).toBe(false);
      expect(long.charAt(shown.length - 1)).toBe(' ');
    });

    it('says you are offline when the browser is', () => {
      online(false);

      expect(handleError(new TypeError('Failed to fetch'), 'Unable to save')).toBe(
        'Unable to save. frameleaf_error_reason_offline',
      );
    });

    it.each(['Failed to fetch', 'Load failed', 'NetworkError when attempting to fetch resource.'])(
      'says Frameleaf could not be reached when the request got no answer (%s)',
      (message) => {
        online(true);

        expect(handleError(new TypeError(message), 'Unable to save')).toBe(
          'Unable to save. frameleaf_error_reason_unreachable',
        );
      },
    );

    it('shows only what the caller said for a failure that is not a request', () => {
      online(false);

      expect(handleError(new TypeError('x is not a function'), 'Unable to save')).toBe('Unable to save');
      expect(handleError('nope', 'Unable to save')).toBe('Unable to save');
      expect(toastManager.danger).toHaveBeenLastCalledWith('Unable to save');
    });

    it('gives the reason alone when the caller had nothing to say', () => {
      expect(handleError(httpError(404, 'Not found'), '')).toBe('frameleaf_error_reason_not_found');
    });

    it('returns the message without a toast when asked not to notify', () => {
      expect(handleError(httpError(404, 'Not found'), 'Unable to load', { notify: false })).toBe(
        'Unable to load. frameleaf_error_reason_not_found',
      );
      expect(toastManager.danger).not.toHaveBeenCalled();
    });

    it('stays silent for a request that was cancelled', () => {
      const aborted = new Error('The user aborted a request.');
      aborted.name = 'AbortError';

      expect(handleError(aborted, 'Unable to load')).toBeUndefined();
      expect(toastManager.danger).not.toHaveBeenCalled();
    });
  });

  it('has every reason in the English catalogue, in the Frameleaf voice', async () => {
    const { default: en } = await import('$i18n/en.json');
    const reasons = Object.entries(en as Record<string, unknown>).filter(([key]) =>
      key.startsWith('frameleaf_error_reason_'),
    );

    expect(reasons.map(([key]) => key.replace('frameleaf_error_reason_', '')).sort()).toEqual(
      ['conflict', 'not_allowed', 'not_found', 'offline', 'server', 'sign_in', 'too_large', 'unreachable'].sort(),
    );
    for (const [key, value] of reasons) {
      expect(value, key).toEqual(expect.any(String));
      expect(value as string, key).toMatch(/\.$/);
      expect(value as string, key).not.toMatch(/!|immich|asset|successfully|please|sorry|error|\d{3}/i);
    }
  });
});
