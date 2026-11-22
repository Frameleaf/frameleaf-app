import { MlDestinationKind } from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import RestorationBatchDialog from './RestorationBatchDialog.svelte';

// The generated SDK gains this function with FL-955's OpenAPI regeneration.
const restoreAssetsBatch = (sdkMock as unknown as { restoreAssetsBatch: ReturnType<typeof vi.fn> }).restoreAssetsBatch;

const row = (id: string, kind: MlDestinationKind, available: boolean, estimateSeconds: number | null = null) => ({
  id,
  kind,
  name: id,
  available,
  refusal: available ? null : 'workload-not-served',
  refusalDetail: null,
  leavesNetwork: kind === MlDestinationKind.FrameleafCloud,
  estimateSeconds,
  costUsd: null,
});
const answer = (destinations: unknown[], overrides = {}) => ({
  batchId: 'batch-1',
  operation: 'repair',
  total: 3,
  eligible: 3,
  queued: 0,
  skipped: [],
  destinations,
  ...overrides,
});
const assetIds = ['a', 'b', 'c'];

describe('RestorationBatchDialog (FL-955)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('estimates first, and queues only on Start with the estimate it showed', async () => {
    restoreAssetsBatch.mockResolvedValue(
      answer([
        row('local', MlDestinationKind.Local, false),
        row('Studio PC', MlDestinationKind.Lan, true, 840),
        row('cloud', MlDestinationKind.FrameleafCloud, false),
      ]),
    );
    render(RestorationBatchDialog, { assetIds });

    const start = await screen.findByRole('button', { name: 'frameleaf_repair_batch_start' });
    await waitFor(() => expect(start).toBeEnabled());
    expect(restoreAssetsBatch).toHaveBeenCalledTimes(1);
    expect(restoreAssetsBatch).toHaveBeenCalledWith({
      assetRestorationBatchRequestDto: { assetIds, operation: 'repair', confirm: false },
    });

    await fireEvent.click(start);

    expect(restoreAssetsBatch).toHaveBeenLastCalledWith({
      assetRestorationBatchRequestDto: {
        assetIds,
        operation: 'repair',
        confirm: true,
        destinationId: 'Studio PC',
        batchId: 'batch-1',
      },
    });
  });

  it('turns Start off and says so when nothing can run it', async () => {
    restoreAssetsBatch.mockResolvedValue(
      answer([row('local', MlDestinationKind.Local, false), row('cloud', MlDestinationKind.FrameleafCloud, false)]),
    );
    render(RestorationBatchDialog, { assetIds });

    expect(await screen.findByTestId('batch-nowhere')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'frameleaf_repair_batch_start' })).toBeDisabled();
    expect(restoreAssetsBatch).toHaveBeenCalledTimes(1);
  });

  it('shows Frameleaf Cloud without a price while it has none', async () => {
    restoreAssetsBatch.mockResolvedValue(
      answer([row('Studio PC', MlDestinationKind.Lan, true), row('cloud', MlDestinationKind.FrameleafCloud, false)]),
    );
    render(RestorationBatchDialog, { assetIds });

    expect(await screen.findByText('frameleaf_repair_batch_cloud_not_yet')).toBeInTheDocument();
    expect(screen.queryByText(/frameleaf_repair_batch_cost/)).not.toBeInTheDocument();
  });
});
