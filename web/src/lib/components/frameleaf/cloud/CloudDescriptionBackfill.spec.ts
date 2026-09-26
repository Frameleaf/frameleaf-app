import type { CloudMlDescriptionEstimateResponseDto } from '@immich/sdk';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { handleError } from '$lib/utils/handle-error';
import en from '../../../../../../i18n/en.json';
import CloudDescriptionBackfill from './CloudDescriptionBackfill.svelte';

vi.mock('$lib/utils/handle-error', () => ({ handleError: vi.fn() }));

const estimate = (
  overrides: Partial<CloudMlDescriptionEstimateResponseDto> = {},
): CloudMlDescriptionEstimateResponseDto => ({
  photos: 250,
  batches: 2,
  truncated: false,
  modelId: 'ms_K6WT70CS',
  modelName: 'Descriptions · Standard',
  p50Usd: 0.52,
  p90Usd: 0.64,
  holdUsd: 0.78,
  startupUsd: 0.02,
  perPhotoP50Usd: 0.002,
  perPhotoP90Usd: 0.0024,
  basis: 'measured',
  availableUsd: 10,
  dailyCapUsd: 20,
  spentTodayUsd: 0,
  guidance: null,
  refusal: null,
  ...overrides,
});

describe('CloudDescriptionBackfill (FL-163)', () => {
  beforeAll(() => {
    addMessages('en', en);
  });

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('asks for nothing while descriptions cannot run on Frameleaf Cloud', () => {
    render(CloudDescriptionBackfill, { available: false });
    expect(screen.queryByRole('button', { name: 'Estimate' })).not.toBeInTheDocument();
    expect(sdkMock.estimateCloudMlDescriptionBackfill).not.toHaveBeenCalled();
  });

  it('shows the GPU-time estimate before anything is queued', async () => {
    sdkMock.estimateCloudMlDescriptionBackfill.mockResolvedValue(estimate());
    render(CloudDescriptionBackfill, { available: true });

    await fireEvent.click(screen.getByRole('button', { name: 'Estimate' }));

    expect(await screen.findByText('250 photos in 2 batches with Descriptions · Standard.')).toBeInTheDocument();
    expect(screen.getByText(/^Likely \$0\.52, at most about \$0\.64\. \$0\.78 is held/)).toBeInTheDocument();
    expect(
      screen.getByText(/About \$0\.0020 to \$0\.0024 of GPU time per photo, plus a \$0\.0200 start fee/),
    ).toBeInTheDocument();
    expect(screen.getByText('$10.00 available in the AI Wallet.')).toBeInTheDocument();
    expect(sdkMock.startCloudMlDescriptionBackfill).not.toHaveBeenCalled();
  });

  it('queues the batches with what the estimate showed', async () => {
    sdkMock.estimateCloudMlDescriptionBackfill.mockResolvedValue(estimate());
    sdkMock.startCloudMlDescriptionBackfill.mockResolvedValue({ batches: 2, photos: 250, operationIds: ['a', 'b'] });
    render(CloudDescriptionBackfill, { available: true });

    await fireEvent.click(screen.getByRole('button', { name: 'Estimate' }));
    await fireEvent.click(await screen.findByRole('button', { name: 'Describe 250 photos' }));

    expect(sdkMock.startCloudMlDescriptionBackfill).toHaveBeenCalledWith({
      cloudMlDescriptionBatchCreateDto: {
        modelId: 'ms_K6WT70CS',
        perPhotoP90Usd: 0.0024,
        startupUsd: 0.02,
        maxTotalUsd: 0.64,
      },
    });
    expect(await screen.findByText('2 batches queued. Follow them in Activity.')).toBeInTheDocument();
  });

  it('refuses to queue when the wallet cannot cover it', async () => {
    sdkMock.estimateCloudMlDescriptionBackfill.mockResolvedValue(
      estimate({
        refusal:
          'The AI Wallet has 0.10 USD available and these descriptions may cost up to 0.64 USD. Add credit first.',
      }),
    );
    render(CloudDescriptionBackfill, { available: true });

    await fireEvent.click(screen.getByRole('button', { name: 'Estimate' }));

    expect(await screen.findByText(/Add credit first\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Describe 250 photos' })).toBeDisabled();
  });

  it('suggests the 27B/35B class when 72B-class batches are too small', async () => {
    sdkMock.estimateCloudMlDescriptionBackfill.mockResolvedValue(
      estimate({
        guidance: {
          minimumBatch: 200,
          smallBatches: 1,
          suggestedModelId: 'ms_M1D00000',
          suggestedModelName: 'Descriptions · Detailed',
        },
      }),
    );
    render(CloudDescriptionBackfill, { available: true });

    await fireEvent.click(screen.getByRole('button', { name: 'Estimate' }));

    const guidance = await screen.findByTestId('backfill-guidance');
    expect(guidance).toHaveTextContent('With this model, batches under 200 photos pay mostly for the start fee.');
    expect(guidance).toHaveTextContent('For smaller batches, choose Descriptions · Detailed in the models above.');
  });

  it('says when every photo already has a description', async () => {
    sdkMock.estimateCloudMlDescriptionBackfill.mockResolvedValue(estimate({ photos: 0, batches: 0 }));
    render(CloudDescriptionBackfill, { available: true });

    await fireEvent.click(screen.getByRole('button', { name: 'Estimate' }));

    expect(await screen.findByText('Every photo already has a description.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Describe/ })).not.toBeInTheDocument();
  });

  it('reports a failed estimate', async () => {
    sdkMock.estimateCloudMlDescriptionBackfill.mockRejectedValue(new Error('capacity'));
    render(CloudDescriptionBackfill, { available: true });

    await fireEvent.click(screen.getByRole('button', { name: 'Estimate' }));

    await vi.waitFor(() =>
      expect(handleError).toHaveBeenCalledWith(expect.any(Error), 'Could not estimate the descriptions'),
    );
  });
});
