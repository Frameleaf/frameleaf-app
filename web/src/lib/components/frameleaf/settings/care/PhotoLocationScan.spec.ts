import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { getCloudManager } from '$lib/managers/get-cloud-manager.svelte';
import { deferredPromise } from '@test-data/deferred';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';
import en from '../../../../../../../i18n/en.json';
import PhotoLocationScan from './PhotoLocationScan.svelte';

const api = vi.hoisted(() => ({ status: vi.fn(), estimate: vi.fn(), start: vi.fn(), cancel: vi.fn() }));
vi.mock('@frameleaf/sdk', async (original) => ({
  ...(await original<typeof import('@frameleaf/sdk')>()),
  getLocationScanStatus: api.status,
  estimateLocationScan: api.estimate,
  startLocationScan: api.start,
  cancelLocationScan: api.cancel,
}));

const billing = (state = 'held') => ({
  currency: 'USD',
  unitPriceMicros: 5000,
  heldMicros: 5_000_000,
  checkedPhotos: 4,
  chargedMicros: null as number | null,
  releasedMicros: null as number | null,
  state,
});
const finalBilling = () => ({ ...billing('settled'), chargedMicros: 20_000, releasedMicros: 4_980_000 });
const scan = (status = 'running', receipt: ReturnType<typeof billing> | null = billing()) => ({
  id: 'scan-1',
  status,
  total: 1000,
  processed: 6,
  matched: 3,
  unmatched: 1,
  skipped: 1,
  failed: 1,
  error: null,
  reason: null as string | null,
  eligiblePhotos: 1200,
  selectedPhotos: 1000,
  remainingPhotos: 200,
  estimatedMicros: 5_000_000,
  billing: receipt,
});
const status = (value: ReturnType<typeof scan> | null = null) => ({ enabled: true, available: true, scan: value });
const quote = () => ({
  estimateId: 'quote-1' as string | null,
  expiresAt: new Date(Date.now() + 60_000).toISOString() as string | null,
  currency: 'USD',
  unitPriceMicros: 5000,
  eligiblePhotos: 1200,
  selectedPhotos: 1000,
  remainingPhotos: 200,
  estimatedMicros: 5_000_000,
  holdMicros: 5_000_000,
  availableMicros: 10_000_000 as number | null,
  canStart: true,
  refusal: null as string | null,
  topUpUrl: null as string | null,
});
const consent = () => screen.getByRole('checkbox', { name: /I agree to send/ });
const start = () => screen.getByRole('button', { name: /Run scan · reserve/ });
const estimateButton = () => screen.getByRole('button', { name: 'Estimate library' });
const openQuote = async () => {
  await fireEvent.click(await screen.findByRole('button', { name: 'Estimate library' }));
  return screen.findByRole('dialog', { name: 'Review photo location scan' });
};

describe('paid manual photo location scan', () => {
  beforeAll(() => addMessages('dev', en));
  beforeEach(() => {
    vi.resetAllMocks();
    authManager.setUser(userAdminFactory.build({ id: 'owner' }));
    authManager.setPreferences(preferencesFactory.build());
    api.status.mockResolvedValue(status());
    api.estimate.mockImplementation(() => Promise.resolve(quote()));
    api.start.mockResolvedValue(status(scan('queued')));
    api.cancel.mockResolvedValue(undefined);
    getCloudManager.close();
  });
  afterEach(() => vi.useRealTimers());

  it('shows the optional fixed price without automatically estimating or starting', async () => {
    render(PhotoLocationScan);
    await screen.findByRole('button', { name: 'Estimate library' });
    expect(screen.getByText(/\$5 per 1,000 checked GPS photos/)).toBeInTheDocument();
    expect(screen.queryByText(/Included with paid/)).not.toBeInTheDocument();
    expect(screen.getByRole('spinbutton', { name: 'Maximum spend (USD)' })).toHaveValue(5);
    expect(api.estimate).not.toHaveBeenCalled();
    expect(api.start).not.toHaveBeenCalled();
  });

  it('estimates the default spend cap without reserving credit and reviews server counts and price', async () => {
    render(PhotoLocationScan);
    const dialog = await openQuote();
    expect(api.estimate).toHaveBeenCalledExactlyOnceWith({
      locationScanEstimateRequestDto: { refresh: false, maxSpendMicros: 5_000_000 },
    });
    for (const [label, value] of [
      ['Eligible GPS photos', '1200'],
      ['Estimated cost for all eligible photos', '$6.00'],
      ['Selected for this job', '1000'],
      ['Remaining for another job', '200'],
      ['Estimated job charge', '$5.00'],
      ['Maximum credit reservation', '$5.00'],
      ['Available AI credit', '$10.00'],
    ]) {
      expect(within(dialog).getByText(label).nextElementSibling).toHaveTextContent(value);
    }
    expect(dialog).toHaveTextContent(/cached results and no-match results/);
    expect(dialog).toHaveTextContent(/Validation failures and unprocessed photos are not charged/);
    expect(dialog).toHaveTextContent(/No photos are uploaded/);
    expect(dialog).toHaveTextContent(/current map listings.*historical visit/i);
    expect(consent()).not.toBeChecked();
    expect(start()).toBeDisabled();
    expect(api.start).not.toHaveBeenCalled();
  });

  it('starts only the reviewed quote after explicit GPS sharing and credit reservation consent', async () => {
    render(PhotoLocationScan);
    await openQuote();
    expect(consent()).toHaveAccessibleName(/reserve up to \$5\.00 in AI credits/);
    await fireEvent.click(consent());
    await fireEvent.click(start());
    expect(api.start).toHaveBeenCalledExactlyOnceWith({
      startLocationScanDto: { estimateId: 'quote-1', consent: true },
    });
    expect(await screen.findByText('Queued')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('requires a new explicit refresh choice for the next paid job', async () => {
    api.start.mockResolvedValue(status(scan('completed', finalBilling())));
    render(PhotoLocationScan);
    await screen.findByRole('button', { name: 'Estimate library' });
    await fireEvent.click(screen.getByRole('checkbox', { name: 'Refresh existing suggestions' }));
    await openQuote();
    await fireEvent.click(consent());
    await fireEvent.click(start());
    await screen.findByText('Completed');
    expect(screen.getByRole('checkbox', { name: 'Refresh existing suggestions' })).not.toBeChecked();
    await openQuote();
    expect(api.estimate).toHaveBeenLastCalledWith({
      locationScanEstimateRequestDto: { refresh: false, maxSpendMicros: 5_000_000 },
    });
  });

  it('sends the photo cap instead of the spend cap and includes refresh only by choice', async () => {
    render(PhotoLocationScan);
    await screen.findByRole('button', { name: 'Estimate library' });
    await fireEvent.click(screen.getByRole('button', { name: 'Photo limit' }));
    expect(screen.getByRole('spinbutton', { name: 'Maximum photos' })).toHaveValue(1000);
    await fireEvent.input(screen.getByRole('spinbutton', { name: 'Maximum photos' }), { target: { value: '25' } });
    await fireEvent.click(screen.getByRole('checkbox', { name: 'Refresh existing suggestions' }));
    await openQuote();
    expect(api.estimate).toHaveBeenCalledExactlyOnceWith({
      locationScanEstimateRequestDto: { refresh: true, maxPhotos: 25 },
    });
  });

  it('preserves a half-cent spend cap and shows the pro-rata reservation without rounding it up', async () => {
    api.estimate.mockResolvedValue({
      ...quote(),
      eligiblePhotos: 1,
      selectedPhotos: 1,
      remainingPhotos: 0,
      estimatedMicros: 5000,
      holdMicros: 5000,
    });
    render(PhotoLocationScan);
    await screen.findByRole('button', { name: 'Estimate library' });
    await fireEvent.input(screen.getByRole('spinbutton', { name: 'Maximum spend (USD)' }), {
      target: { value: '0.005' },
    });
    const dialog = await openQuote();
    expect(api.estimate).toHaveBeenCalledExactlyOnceWith({
      locationScanEstimateRequestDto: { refresh: false, maxSpendMicros: 5000 },
    });
    expect(within(dialog).getByText('Maximum credit reservation').nextElementSibling).toHaveTextContent('$0.0050');
  });

  it('does not round a fractional-micro spend cap up to a billable photo', async () => {
    render(PhotoLocationScan);
    await screen.findByRole('button', { name: 'Estimate library' });
    await fireEvent.input(screen.getByRole('spinbutton', { name: 'Maximum spend (USD)' }), {
      target: { value: '0.0049999' },
    });
    expect(estimateButton()).toBeDisabled();
    expect(api.estimate).not.toHaveBeenCalled();
  });

  it('preserves valid decimal spend limits at micro-dollar precision', async () => {
    render(PhotoLocationScan);
    await screen.findByRole('button', { name: 'Estimate library' });
    await fireEvent.input(screen.getByRole('spinbutton', { name: 'Maximum spend (USD)' }), {
      target: { value: '1.005' },
    });
    await openQuote();
    expect(api.estimate).toHaveBeenCalledExactlyOnceWith({
      locationScanEstimateRequestDto: { refresh: false, maxSpendMicros: 1_005_000 },
    });
  });

  it.each(['limit', 'mode', 'refresh'])('invalidates the quote and consent after changing %s', async (change) => {
    render(PhotoLocationScan);
    await openQuote();
    await fireEvent.click(consent());
    if (change === 'limit') {
      await fireEvent.input(screen.getByRole('spinbutton', { name: 'Maximum spend (USD)' }), {
        target: { value: '2' },
      });
    } else if (change === 'mode') {
      await fireEvent.click(screen.getByRole('button', { name: 'Photo limit' }));
    } else {
      await fireEvent.click(screen.getByRole('checkbox', { name: 'Refresh existing suggestions' }));
    }
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await openQuote();
    expect(consent()).not.toBeChecked();
    expect(start()).toBeDisabled();
    expect(api.start).not.toHaveBeenCalled();
  });

  it('refuses empty, zero, negative, and fractional photo limits', async () => {
    render(PhotoLocationScan);
    await screen.findByRole('button', { name: 'Estimate library' });
    await fireEvent.input(screen.getByRole('spinbutton', { name: 'Maximum spend (USD)' }), { target: { value: '' } });
    expect(estimateButton()).toBeDisabled();
    await fireEvent.click(screen.getByRole('button', { name: 'Photo limit' }));
    for (const value of ['0', '-1', '2.5', '']) {
      await fireEvent.input(screen.getByRole('spinbutton', { name: 'Maximum photos' }), { target: { value } });
      expect(estimateButton()).toBeDisabled();
    }
    expect(api.estimate).not.toHaveBeenCalled();
  });

  it('expires a quote and requires fresh consent after estimating again', async () => {
    vi.useFakeTimers();
    render(PhotoLocationScan);
    await vi.advanceTimersByTimeAsync(0);
    await fireEvent.click(estimateButton());
    await vi.advanceTimersByTimeAsync(0);
    await fireEvent.click(consent());
    await vi.advanceTimersByTimeAsync(60_001);
    expect(screen.getByText(/This estimate expired/)).toBeInTheDocument();
    expect(consent()).not.toBeChecked();
    expect(start()).toBeDisabled();
    await fireEvent.click(screen.getByRole('button', { name: 'Estimate again' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(consent()).not.toBeChecked();
    expect(api.start).not.toHaveBeenCalled();
  });

  it('displays credit refusal and opens the existing AI credit action without a start button', async () => {
    api.estimate.mockResolvedValue({
      ...quote(),
      canStart: false,
      refusal: 'Not enough AI credit',
      topUpUrl: 'https://frameleaf.cloud/account/credits',
    });
    render(PhotoLocationScan);
    const dialog = await openQuote();
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Not enough AI credit');
    expect(screen.queryByRole('button', { name: /Run scan · reserve/ })).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Add AI credit' }));
    expect(getCloudManager.request).toMatchObject({
      feature: 'processing',
      topUpUrl: 'https://frameleaf.cloud/account/credits',
    });
    expect(api.start).not.toHaveBeenCalled();
  });

  it('handles an empty library with no quote or charge', async () => {
    api.estimate.mockResolvedValue({
      ...quote(),
      estimateId: null,
      expiresAt: null,
      eligiblePhotos: 0,
      selectedPhotos: 0,
      remainingPhotos: 0,
      estimatedMicros: 0,
      holdMicros: 0,
      availableMicros: null,
      canStart: false,
      refusal: 'No eligible photos need location identification',
    });
    render(PhotoLocationScan);
    const dialog = await openQuote();
    expect(dialog).toHaveTextContent('No eligible photos need location identification');
    expect(screen.queryByRole('checkbox', { name: /I agree to send/ })).not.toBeInTheDocument();
    expect(api.start).not.toHaveBeenCalled();
  });

  it('has no environment or paid-plan gate and lets an unavailable account request estimate details', async () => {
    api.status.mockResolvedValue({ ...status(), enabled: false, available: false });
    render(PhotoLocationScan);
    expect(await screen.findByRole('heading', { name: 'Identify photo locations' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Estimate library' })).toBeEnabled();
    expect(screen.queryByText(/paid Frameleaf Cloud plan/)).not.toBeInTheDocument();
  });

  it('shows progress and every result count and cancels without claiming credit was released', async () => {
    api.status.mockResolvedValueOnce(status(scan())).mockResolvedValue(status(scan('cancelled', billing('settling'))));
    render(PhotoLocationScan);
    const progress = await screen.findByRole('progressbar', { name: 'Photo location scan' });
    expect(progress).toHaveAttribute('aria-valuenow', '6');
    expect(progress).toHaveAttribute('aria-valuemax', '1000');
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
    expect(screen.getByText('Cloud is settling this job')).toBeInTheDocument();
    expect(screen.queryByText('Unused credit released')).not.toBeInTheDocument();
    expect(screen.queryByText('Charged')).not.toBeInTheDocument();
  });

  it('keeps polling after cancellation until Cloud supplies the final charge and release receipt', async () => {
    vi.useFakeTimers();
    api.status
      .mockResolvedValueOnce(status(scan('cancelled', billing('settling'))))
      .mockResolvedValue(status(scan('cancelled', finalBilling())));
    const view = render(PhotoLocationScan);
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.queryByText('Unused credit released')).not.toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(screen.getByText('Charged').nextElementSibling).toHaveTextContent('$0.0200');
    expect(screen.getByText('Unused credit released').nextElementSibling).toHaveTextContent('$4.98');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.status).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it('keeps a terminal scan with a missing receipt pending and polls for reconciliation', async () => {
    vi.useFakeTimers();
    api.status
      .mockResolvedValueOnce(status(scan('completed', null)))
      .mockResolvedValue(status(scan('completed', finalBilling())));
    render(PhotoLocationScan);
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByText('Waiting for the Cloud billing receipt')).toBeInTheDocument();
    expect(screen.queryByText('Unused credit released')).not.toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(screen.getByText('Charged')).toBeInTheDocument();
  });

  it('shows an authoritative no-charge receipt for cancellation before a hold', async () => {
    api.status.mockResolvedValue(
      status(
        scan('cancelled', {
          ...billing('no_charge'),
          heldMicros: 0,
          checkedPhotos: 0,
          chargedMicros: 0,
          releasedMicros: 0,
        }),
      ),
    );
    render(PhotoLocationScan);
    expect(await screen.findByText('No charge')).toBeInTheDocument();
    expect(screen.getByText('Charged').nextElementSibling).toHaveTextContent('$0.00');
  });

  it('clears a rejected quote and checks status before another estimate or reservation', async () => {
    api.start.mockRejectedValueOnce({ status: 409, data: { code: 'estimate-expired' } });
    render(PhotoLocationScan);
    await openQuote();
    await fireEvent.click(consent());
    await fireEvent.click(start());
    const alert = await screen.findByRole('alert');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(estimateButton()).toBeDisabled();
    await fireEvent.click(within(alert).getByRole('button', { name: 'Check status' }));
    await waitFor(() => expect(estimateButton()).toBeEnabled());
    await openQuote();
    expect(consent()).not.toBeChecked();
    expect(api.start).toHaveBeenCalledOnce();
  });

  it('retries a failed estimate without starting', async () => {
    api.estimate.mockRejectedValueOnce(new Error('offline')).mockImplementation(() => Promise.resolve(quote()));
    render(PhotoLocationScan);
    await fireEvent.click(await screen.findByRole('button', { name: 'Estimate library' }));
    await screen.findByRole('alert');
    await fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('dialog', { name: 'Review photo location scan' })).toBeInTheDocument();
    expect(api.start).not.toHaveBeenCalled();
  });

  it('retries a cancellation failure and waits for the Cloud receipt', async () => {
    api.status.mockResolvedValue(status(scan()));
    api.cancel.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    render(PhotoLocationScan);
    await fireEvent.click(await screen.findByRole('button', { name: 'Cancel scan' }));
    const alert = await screen.findByRole('alert');
    api.status.mockResolvedValue(status(scan('cancelled', billing('settling'))));
    await fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Cancelled')).toBeInTheDocument();
    expect(screen.getByText('Cloud is settling this job')).toBeInTheDocument();
    expect(api.cancel).toHaveBeenCalledTimes(2);
  });

  it('does not let an earlier progress read overwrite a cancelled scan and final receipt', async () => {
    vi.useFakeTimers();
    const pending = deferredPromise<ReturnType<typeof status>>();
    api.status
      .mockResolvedValueOnce(status(scan()))
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(status(scan('cancelled', finalBilling())));
    render(PhotoLocationScan);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10_000);
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel scan' }));
    await vi.advanceTimersByTimeAsync(0);
    pending.resolve(status(scan()));
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByText('Cancelled')).toBeInTheDocument();
    expect(screen.getByText('Unused credit released')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel scan' })).not.toBeInTheDocument();
  });

  it('ignores a start response after the session ends', async () => {
    const pending = deferredPromise<ReturnType<typeof status>>();
    api.start.mockReturnValueOnce(pending.promise);
    render(PhotoLocationScan);
    await openQuote();
    await fireEvent.click(consent());
    await fireEvent.click(start());
    authManager.reset();
    pending.resolve(status(scan('queued')));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText('Queued')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('retries a failed status read without estimating or starting a job', async () => {
    api.status.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(status());
    render(PhotoLocationScan);
    const alert = await screen.findByRole('alert');
    await fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(estimateButton()).toBeEnabled());
    expect(api.estimate).not.toHaveBeenCalled();
    expect(api.start).not.toHaveBeenCalled();
  });

  it('shows a pause reason and requires a new estimate to retry a failed job', async () => {
    api.status.mockResolvedValue(status({ ...scan('paused'), reason: 'Waiting for Cloud capacity' }));
    const view = render(PhotoLocationScan);
    expect(await screen.findByText('Waiting for Cloud capacity')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel scan' })).toBeEnabled();
    view.unmount();
    api.status.mockResolvedValue(status(scan('failed', finalBilling())));
    render(PhotoLocationScan);
    expect(await screen.findByRole('alert')).toHaveTextContent('request a new estimate');
    expect(estimateButton()).toBeEnabled();
    expect(api.start).not.toHaveBeenCalled();
  });

  it.each(['close', 'session', 'scope'])('ignores a stale estimate after %s', async (change) => {
    const pending = deferredPromise<ReturnType<typeof quote>>();
    api.estimate.mockReturnValue(pending.promise);
    const view = render(PhotoLocationScan);
    await fireEvent.click(await screen.findByRole('button', { name: 'Estimate library' }));
    if (change === 'close') {
      view.unmount();
    } else if (change === 'session') {
      authManager.reset();
    } else {
      await fireEvent.input(screen.getByRole('spinbutton', { name: 'Maximum spend (USD)' }), {
        target: { value: '2' },
      });
    }
    pending.resolve(quote());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.start).not.toHaveBeenCalled();
  });

  it('stops active and settlement polling when the panel closes', async () => {
    vi.useFakeTimers();
    api.status.mockResolvedValue(status(scan('cancelled', billing('settling'))));
    const view = render(PhotoLocationScan);
    await vi.advanceTimersByTimeAsync(0);
    view.unmount();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(api.status).toHaveBeenCalledOnce();
  });
});
