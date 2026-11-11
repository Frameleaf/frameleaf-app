import {
  CloudMlJobActivityStage,
  CloudMlJobPurpose,
  CloudMlJobStage,
  MediaOperationKind,
  MediaOperationStatus,
  type MediaOperationDto,
  type MediaOperationListResponseDto,
} from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { Route } from '$lib/route';
import StudioCloudReceipts from './StudioCloudReceipts.svelte';

const receipt = (id: string, projectId: string, label: string, withheld = false): MediaOperationDto =>
  ({
    id,
    projectId,
    createdAt: '2026-11-10T23:00:00.000Z',
    kind: MediaOperationKind.CloudMlJob,
    label,
    status: MediaOperationStatus.Completed,
    withheld,
    cloudJob: {
      activityStage: CloudMlJobActivityStage.Done,
      purpose: CloudMlJobPurpose.Restoration,
      stage: CloudMlJobStage.Full,
      model: 'Caption model',
      cost: { estimatedP50Usd: 0.05, estimatedP90Usd: 0.09, holdUsd: 0.1, settledUsd: 0.08, soFarUsd: null },
    },
  }) as unknown as MediaOperationDto;

describe('Studio Cloud receipts', () => {
  beforeEach(() => {
    sdkMock.searchMediaOperations.mockReset();
    sdkMock.createCloudMlJob.mockClear();
  });

  it('shows authorized receipts for this saved project and pages past unrelated jobs', async () => {
    sdkMock.searchMediaOperations
      .mockResolvedValueOnce({
        items: [receipt('other', 'p2', 'Other project'), receipt('locked', 'p1', 'Withheld item', true)],
        total: 4,
      })
      .mockResolvedValueOnce({
        items: [
          { ...receipt('first', 'p1', 'Lake morning'), resultAssetId: 'restored-photo' },
          receipt('second', 'p1', 'Lake evening'),
        ],
        total: 4,
      });
    render(StudioCloudReceipts, { open: true, projectId: 'p1' });

    const older = await screen.findByRole('button', { name: 'frameleaf_studio_receipts_older' });
    expect(screen.queryByText('Other project')).not.toBeInTheDocument();
    expect(screen.queryByText('Withheld item')).not.toBeInTheDocument();
    expect(screen.queryByText('frameleaf_studio_cloud_receipts_empty')).not.toBeInTheDocument();
    await fireEvent.click(older);

    expect(await screen.findByText('Lake morning')).toBeInTheDocument();
    expect(screen.getByText('Lake evening')).toBeInTheDocument();
    expect(screen.getAllByText('frameleaf_activity_cloud_settled')).toHaveLength(2);
    expect(screen.getByRole('link', { name: 'frameleaf_activity_open_result' })).toHaveAttribute(
      'href',
      Route.viewAsset({ id: 'restored-photo' }),
    );
    expect(sdkMock.searchMediaOperations).toHaveBeenLastCalledWith(
      { kind: MediaOperationKind.CloudMlJob, includeDismissed: true, take: 50, skip: 2 },
      { signal: expect.any(AbortSignal) },
    );
    expect(sdkMock.createCloudMlJob).not.toHaveBeenCalled();
  });

  it('discards an earlier project response even when transport ignores abort', async () => {
    let finishOld!: (page: MediaOperationListResponseDto) => void;
    sdkMock.searchMediaOperations
      .mockImplementationOnce(() => new Promise((resolve) => (finishOld = resolve)))
      .mockResolvedValueOnce({ items: [receipt('new', 'p2', 'Current project')], total: 1 });
    const view = render(StudioCloudReceipts, { open: true, projectId: 'p1' });
    await waitFor(() => expect(sdkMock.searchMediaOperations).toHaveBeenCalledTimes(1));

    await view.rerender({ projectId: 'p2' });
    expect(await screen.findByText('Current project')).toBeInTheDocument();
    finishOld({ items: [receipt('stale', 'p1', 'Old project')], total: 1 });
    await waitFor(() => expect(screen.queryByText('Old project')).not.toBeInTheDocument());
    expect(sdkMock.searchMediaOperations.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });
});
