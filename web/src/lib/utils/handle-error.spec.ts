import { toastManager } from '@immich/ui';
import { handleError, setUnauthorizedHandler } from '$lib/utils/handle-error';

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
    vi.spyOn(toastManager, 'danger').mockImplementation(() => undefined as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    setUnauthorizedHandler(undefined);
    vi.restoreAllMocks();
  });

  it('hands a refused action to the registered handler instead of toasting (FL-56)', () => {
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);

    handleError(httpError(401), 'Unable to download');

    expect(onUnauthorized).toHaveBeenCalledOnce();
    expect(toastManager.danger).not.toHaveBeenCalled();
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
