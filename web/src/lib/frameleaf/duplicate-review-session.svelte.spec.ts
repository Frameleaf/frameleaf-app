import {
  DuplicateDecisionKind,
  DuplicateGroupKind,
  MediaOperationBulkAction,
  MediaOperationStatus,
  type DuplicateDecisionHistoryDto,
  type MediaOperationDetailDto,
  type MediaOperationDto,
} from '@immich/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewGroup } from '$lib/frameleaf/duplicate-review';
import {
  DuplicateReviewSession,
  newRequestId,
  type DuplicateReviewGateway,
} from '$lib/frameleaf/duplicate-review-session.svelte';

const group = (id: string, members: string[]): ReviewGroup => ({
  duplicateId: id,
  assets: members.map((assetId) => ({ id: assetId, originalFileName: `${assetId}.jpg` })) as ReviewGroup['assets'],
  suggestedKeepAssetIds: [members[0]],
  kind: DuplicateGroupKind.Duplicates,
  editable: true,
  blockedReason: null,
  hiddenMemberCount: 0,
  totalBytes: 0,
  qualities: [],
});

const emptyHistory = (): DuplicateDecisionHistoryDto => ({ recent: [], active: [] });

const detail = (overrides: Partial<MediaOperationDetailDto>) =>
  ({
    status: MediaOperationStatus.Rendering,
    processedUnits: '0',
    bulkItems: [],
    bulkRetryPending: [],
    bulk: { retried: 0, itemsTruncated: false },
    ...overrides,
  }) as unknown as MediaOperationDetailDto;

describe('the duplicate review session', () => {
  let gateway: { [K in keyof DuplicateReviewGateway]: ReturnType<typeof vi.fn> };
  let session: DuplicateReviewSession;
  const lake = group('lake', ['a', 'b']);
  const forest = group('forest', ['c', 'd']);

  beforeEach(() => {
    vi.useFakeTimers();
    gateway = {
      getReview: vi.fn().mockResolvedValue([forest]),
      getHistory: vi.fn().mockResolvedValue(emptyHistory()),
      submit: vi.fn().mockResolvedValue({ id: 'job-1' } as MediaOperationDto),
      getOperation: vi.fn(),
    };
    session = new DuplicateReviewSession(
      { groups: [lake, forest], history: emptyHistory() },
      { gateway: gateway as unknown as DuplicateReviewGateway, pollMs: 1000 },
    );
  });

  afterEach(() => {
    session.destroy();
    vi.useRealTimers();
  });

  const lakeDecision = {
    duplicateId: 'lake',
    decision: DuplicateDecisionKind.KeepAll,
    memberIds: ['a', 'b'],
    keepAssetIds: [],
  };

  it('puts a loader on a decided group at once and submits one durable job', async () => {
    const pending = session.decide([lakeDecision]);
    expect(session.progress.get('lake')).toEqual({ state: 'pending' });
    await pending;

    expect(gateway.submit).toHaveBeenCalledWith(
      MediaOperationBulkAction.ResolveDuplicates,
      [lakeDecision],
      expect.any(String),
    );
    expect(session.tracking).toBe(1);
  });

  it('takes the loader off again when the job could not be submitted', async () => {
    gateway.submit.mockRejectedValue(new Error('offline'));

    await expect(session.decide([lakeDecision])).rejects.toThrow('offline');

    expect(session.progress.has('lake')).toBe(false);
  });

  it('follows the job and reads the review again from the server when it is done', async () => {
    await session.decide([lakeDecision]);
    gateway.getOperation.mockResolvedValue(detail({ status: MediaOperationStatus.Completed, processedUnits: '2' }));

    await session.poll();

    expect(gateway.getReview).toHaveBeenCalled();
    expect(session.groups.map(({ duplicateId }) => duplicateId)).toEqual(['forest']);
    expect(session.progress.has('lake')).toBe(false);
    expect(session.tracking).toBe(0);
    // decided in this visit: still counted, and still listed under "All results"
    expect(session.reviewed.has('lake')).toBe(true);
    expect(session.allGroups.map(({ duplicateId }) => duplicateId)).toEqual(['forest', 'lake']);
  });

  it('never starts following again once the page is gone', async () => {
    await session.decide([lakeDecision]);
    let answer: (detail: MediaOperationDetailDto) => void = () => {};
    gateway.getOperation.mockReturnValue(new Promise((resolve) => (answer = resolve)));

    const polling = session.poll();
    session.destroy();
    answer(detail({ status: MediaOperationStatus.Completed, processedUnits: '2' }));
    await polling;

    expect(gateway.getReview).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shows why a group was not decided, and leaves it in the review', async () => {
    await session.decide([lakeDecision]);
    gateway.getReview.mockResolvedValue([lake, forest]);
    gateway.getOperation.mockResolvedValue(
      detail({
        status: MediaOperationStatus.Completed,
        processedUnits: '2',
        bulkItems: [
          { id: 'a', status: 'skipped', reasonKey: 'frameleaf_bulk_reason_group_changed' },
          { id: 'b', status: 'skipped', reasonKey: 'frameleaf_bulk_reason_group_changed' },
        ] as MediaOperationDetailDto['bulkItems'],
      }),
    );

    await session.poll();

    expect(session.progress.get('lake')).toEqual({
      state: 'failed',
      reasonKey: 'frameleaf_bulk_reason_group_changed',
    });
  });

  it('keeps loaders on the groups of a job still running after a reload', () => {
    const resumed = new DuplicateReviewSession(
      {
        groups: [lake, forest],
        history: {
          recent: [],
          active: [
            {
              operationId: 'job-9',
              action: MediaOperationBulkAction.ResolveDuplicates,
              groups: [{ duplicateId: 'forest', memberIds: ['c', 'd'] }],
            },
          ],
        },
      },
      { gateway: gateway as unknown as DuplicateReviewGateway },
    );

    expect(resumed.progress.get('forest')).toEqual({ state: 'pending' });
    expect(resumed.tracking).toBe(1);
    resumed.destroy();
  });

  it('undoes the newest undoable decision job and stops offering it while the undo runs', async () => {
    const withHistory = new DuplicateReviewSession(
      {
        groups: [forest],
        history: {
          active: [],
          recent: [
            {
              operationId: 'job-1',
              createdAt: '2026-09-23T10:00:00.000Z',
              undoable: true,
              groups: [
                {
                  decisionId: 'decision-1',
                  duplicateId: 'lake',
                  decision: DuplicateDecisionKind.KeepAll,
                  memberIds: ['a', 'b'],
                  keepAssetIds: ['a', 'b'],
                  trashAssetIds: [],
                  applied: true,
                  undone: false,
                  undoing: false,
                },
              ],
            },
          ],
        },
      },
      { gateway: gateway as unknown as DuplicateReviewGateway },
    );

    expect(await withHistory.undo()).toBe(true);

    expect(gateway.submit).toHaveBeenCalledWith(
      MediaOperationBulkAction.UndoDuplicates,
      [expect.objectContaining({ duplicateId: 'lake', decisionId: 'decision-1' })],
      expect.any(String),
    );
    expect(withHistory.undoable).toHaveLength(0);
    expect(withHistory.undoing).toBe(true);
    expect(await withHistory.undo()).toBe(false);
    withHistory.destroy();
  });

  it('makes a v4 idempotency key even where randomUUID is unavailable', () => {
    const original = crypto.randomUUID;
    Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true });
    try {
      expect(newRequestId()).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
    } finally {
      Object.defineProperty(crypto, 'randomUUID', { value: original, configurable: true });
    }
  });
});
