import { getServerConfig, type ServerConfigDto } from '@frameleaf/sdk';
import { waitForOnboardingMaintenance } from '$lib/utils/onboarding-maintenance';

vi.mock('@frameleaf/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@frameleaf/sdk')>()),
  getServerConfig: vi.fn(),
}));

const config = (maintenanceMode: boolean) => ({ maintenanceMode }) as ServerConfigDto;

describe(waitForOnboardingMaintenance.name, () => {
  const reload = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    vi.stubGlobal('location', { pathname: '/', reload });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('waits through an old worker and a restart outage, then reloads only for maintenance', async () => {
    vi.mocked(getServerConfig)
      .mockResolvedValueOnce(config(false))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(config(true));
    const waiting = waitForOnboardingMaintenance(new AbortController().signal);

    await vi.advanceTimersByTimeAsync(1000);
    expect(reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    await waiting;
    expect(reload).toHaveBeenCalledExactlyOnceWith();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops on page destruction, aborts the request and ignores its late ready response', async () => {
    let respond!: (value: ServerConfigDto) => void;
    vi.mocked(getServerConfig).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          respond = resolve;
        }),
    );
    const page = new AbortController();
    const waiting = waitForOnboardingMaintenance(page.signal);
    const stopped = expect(waiting).rejects.toMatchObject({ name: 'AbortError' });

    page.abort();
    expect(vi.mocked(getServerConfig).mock.calls[0][0]?.signal?.aborted).toBe(true);
    respond(config(true));
    await stopped;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(getServerConfig).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops waiting for an unchanged old worker within the bounded startup window', async () => {
    vi.mocked(getServerConfig).mockResolvedValue(config(false));
    const waiting = waitForOnboardingMaintenance(new AbortController().signal);
    const expired = expect(waiting).rejects.toMatchObject({ name: 'TimeoutError' });

    await vi.advanceTimersByTimeAsync(30_000);
    await expired;
    expect(reload).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves an HTTP rejection instead of retrying it', async () => {
    const rejection = { status: 401 };
    vi.mocked(getServerConfig).mockRejectedValue(rejection);
    await expect(waitForOnboardingMaintenance(new AbortController().signal)).rejects.toBe(rejection);
    expect(getServerConfig).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
