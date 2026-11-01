import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { deferredPromise } from '@test-data/deferred';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';
import en from '../../../../../../../i18n/en.json';
import PhotoLocationScan from './PhotoLocationScan.svelte';

const api = vi.hoisted(() => ({ status: vi.fn(), start: vi.fn(), cancel: vi.fn() }));
vi.mock('@frameleaf/sdk', async (original) => ({
  ...(await original<typeof import('@frameleaf/sdk')>()),
  getLocationScanStatus: api.status,
  startLocationScan: api.start,
  cancelLocationScan: api.cancel,
}));

const scan = (status = 'running') => ({
  id: 'scan-1',
  status,
  total: 10,
  processed: 6,
  matched: 3,
  unmatched: 1,
  skipped: 1,
  failed: 1,
  error: null,
  reason: null as string | null,
});
const status = (value: ReturnType<typeof scan> | null = null) => ({ enabled: true, available: true, scan: value });
const consent = () => screen.getByRole('checkbox', { name: /I agree to send/ });
const start = () => screen.getByRole('button', { name: 'Identify photo locations' });

describe('manual photo location scan', () => {
  beforeAll(() => addMessages('dev', en));
  beforeEach(() => {
    vi.resetAllMocks();
    authManager.setUser(userAdminFactory.build({ id: 'owner' }));
    authManager.setPreferences(preferencesFactory.build());
    api.status.mockResolvedValue(status());
    api.start.mockResolvedValue(status(scan('queued')));
    api.cancel.mockResolvedValue(undefined);
  });
  afterEach(() => vi.useRealTimers());

  it('never starts on load and requires explicit consent to send coordinates without photos', async () => {
    render(PhotoLocationScan);
    await screen.findByRole('heading', { name: 'Identify photo locations' });

    expect(start()).toBeDisabled();
    expect(consent()).not.toBeChecked();
    expect(screen.getByText(/No photos are uploaded/)).toBeInTheDocument();
    expect(screen.getByText(/current map listings.*historical visit/i)).toBeInTheDocument();
    expect(api.start).not.toHaveBeenCalled();
    await fireEvent.click(consent());
    await fireEvent.click(start());

    expect(api.start).toHaveBeenCalledExactlyOnceWith({ startLocationScanDto: { consent: true, refresh: false } });
    expect(await screen.findByText('Queued')).toBeInTheDocument();
  });

  it('offers refresh only by explicit choice and clears consent after each attempted run', async () => {
    api.start.mockResolvedValue(status(scan('completed')));
    render(PhotoLocationScan);
    await screen.findByRole('heading', { name: 'Identify photo locations' });
    await fireEvent.click(screen.getByRole('checkbox', { name: 'Refresh existing suggestions' }));
    await fireEvent.click(consent());
    await fireEvent.click(start());

    expect(api.start).toHaveBeenCalledExactlyOnceWith({ startLocationScanDto: { consent: true, refresh: true } });
    expect(await screen.findByText('Completed')).toBeInTheDocument();
    expect(consent()).not.toBeChecked();
    expect(start()).toBeDisabled();
  });

  it('hides the feature when disabled by the backend', async () => {
    api.status.mockResolvedValue({ ...status(), enabled: false, available: false });
    render(PhotoLocationScan);
    await waitFor(() => expect(api.status).toHaveBeenCalledOnce());
    expect(screen.queryByRole('heading', { name: 'Identify photo locations' })).not.toBeInTheDocument();
    expect(api.start).not.toHaveBeenCalled();
  });

  it('keeps an existing scan cancellable when the backend is disabled', async () => {
    api.status
      .mockResolvedValueOnce({ ...status(scan('paused')), enabled: false, available: false })
      .mockResolvedValue({ ...status(scan('cancelled')), enabled: false, available: false });
    render(PhotoLocationScan);
    await fireEvent.click(await screen.findByRole('button', { name: 'Cancel scan' }));
    expect(api.cancel).toHaveBeenCalledExactlyOnceWith({ id: 'scan-1' });
    expect(await screen.findByText('Cancelled')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Identify photo locations' })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('shows backend unavailability and the paid plan inclusion without a start control', async () => {
    api.status.mockResolvedValue({ ...status(), available: false });
    render(PhotoLocationScan);
    expect(await screen.findByText(/unavailable for this account/)).toBeInTheDocument();
    expect(screen.getByText(/included with paid Frameleaf Cloud plans/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Identify photo locations' })).not.toBeInTheDocument();
  });

  it('reports progress and every result count and lets the owner cancel', async () => {
    api.status.mockResolvedValueOnce(status(scan())).mockResolvedValue(status(scan('cancelled')));
    render(PhotoLocationScan);
    const progress = await screen.findByRole('progressbar', { name: 'Photo location scan' });
    expect(progress).toHaveAttribute('aria-valuenow', '6');
    expect(progress).toHaveAttribute('aria-valuemax', '10');
    for (const [label, count] of [
      ['Matched', 3],
      ['Unmatched', 1],
      ['Skipped', 1],
      ['Failed', 1],
    ] as const) {
      expect(screen.getByText(label).nextElementSibling).toHaveTextContent(String(count));
    }
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel scan' }));

    expect(api.cancel).toHaveBeenCalledExactlyOnceWith({ id: 'scan-1' });
    expect(await screen.findByText('Cancelled')).toBeInTheDocument();
    expect(start()).toBeDisabled();
  });

  it('polls an active scan, stops after completion, and keeps a completed summary', async () => {
    vi.useFakeTimers();
    api.status.mockResolvedValueOnce(status(scan())).mockResolvedValue(status(scan('completed')));
    const view = render(PhotoLocationScan);
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByText('Running')).toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(screen.getByText('Completed')).toBeInTheDocument();
    expect(screen.getByText('Matched').nextElementSibling).toHaveTextContent('3');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.status).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it('stops polling when the panel closes', async () => {
    vi.useFakeTimers();
    api.status.mockResolvedValue(status(scan()));
    const view = render(PhotoLocationScan);
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByText('Running')).toBeInTheDocument();
    view.unmount();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.status).toHaveBeenCalledOnce();
  });

  it('does not let a slow progress read overwrite cancellation', async () => {
    vi.useFakeTimers();
    const pending = deferredPromise<ReturnType<typeof status>>();
    api.status
      .mockResolvedValueOnce(status(scan()))
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(status(scan('cancelled')));
    render(PhotoLocationScan);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.status).toHaveBeenCalledTimes(2);
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel scan' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByText('Cancelled')).toBeInTheDocument();
    pending.resolve(status(scan()));
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByText('Cancelled')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel scan' })).not.toBeInTheDocument();
  });

  it('ignores a start response after the session ends', async () => {
    const pending = deferredPromise<ReturnType<typeof status>>();
    api.start.mockReturnValueOnce(pending.promise);
    render(PhotoLocationScan);
    await screen.findByRole('heading', { name: 'Identify photo locations' });
    await fireEvent.click(consent());
    await fireEvent.click(start());
    authManager.reset();
    pending.resolve(status(scan('queued')));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText('Queued')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel scan' })).not.toBeInTheDocument();
  });

  it('keeps a paused scan cancellable and explains a failed scan can be retried manually', async () => {
    api.status.mockResolvedValue(status(scan('paused')));
    const view = render(PhotoLocationScan);
    expect(await screen.findByText('Paused')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel scan' })).toBeEnabled();
    view.unmount();

    api.status.mockResolvedValue(status(scan('failed')));
    render(PhotoLocationScan);
    expect(await screen.findByRole('alert')).toHaveTextContent(/Start a new scan to retry/);
    expect(start()).toBeDisabled();
    expect(api.start).not.toHaveBeenCalled();
  });

  it('explains why the backend paused a scan', async () => {
    api.status.mockResolvedValue(status({ ...scan('paused'), reason: 'Waiting for the Cloud request allowance' }));
    render(PhotoLocationScan);
    expect(await screen.findByText('Waiting for the Cloud request allowance')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel scan' })).toBeEnabled();
  });

  it('retries a failed status read without starting a scan', async () => {
    api.status.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(status());
    render(PhotoLocationScan);
    const alert = await screen.findByRole('alert');
    await fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('checkbox', { name: /I agree to send/ })).not.toBeChecked();
    expect(api.start).not.toHaveBeenCalled();
  });

  it('clears consent when starting fails and checks status before another manual attempt', async () => {
    api.start.mockRejectedValue(new Error('offline'));
    render(PhotoLocationScan);
    await screen.findByRole('heading', { name: 'Identify photo locations' });
    await fireEvent.click(consent());
    await fireEvent.click(start());
    const alert = await screen.findByRole('alert');
    expect(consent()).not.toBeChecked();
    expect(start()).toBeDisabled();
    await fireEvent.click(within(alert).getByRole('button', { name: 'Check status' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(api.start).toHaveBeenCalledOnce();
  });

  it('keeps a cancellation failure retryable', async () => {
    api.status.mockResolvedValue(status(scan()));
    api.cancel.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    render(PhotoLocationScan);
    await fireEvent.click(await screen.findByRole('button', { name: 'Cancel scan' }));
    const alert = await screen.findByRole('alert');
    api.status.mockResolvedValue(status(scan('cancelled')));
    await fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Cancelled')).toBeInTheDocument();
    expect(api.cancel).toHaveBeenCalledTimes(2);
  });

  it.each(['close', 'session'])('ignores stale reads after a %s change', async (change) => {
    const pending = deferredPromise<ReturnType<typeof status>>();
    api.status.mockReturnValue(pending.promise);
    const view = render(PhotoLocationScan);
    await waitFor(() => expect(api.status).toHaveBeenCalledOnce());
    if (change === 'close') {
      view.unmount();
    } else {
      authManager.reset();
    }
    pending.resolve(status(scan()));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText('Running')).not.toBeInTheDocument();
    expect(api.start).not.toHaveBeenCalled();
  });
});
