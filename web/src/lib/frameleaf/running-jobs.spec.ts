import {
  MediaOperationBulkAction,
  MediaOperationDestination,
  MediaOperationKind,
  MediaOperationStatus,
  MemoryExportFormat,
  MemoryExportStatus,
  QueueName,
  type MediaOperationDto,
  type MemoryExportResponseDto,
  type QueueRunDto,
  type RunningJobsResponseDto,
} from '@immich/sdk';
import { describe, expect, it } from 'vitest';
import {
  buildRunningJobRows,
  countActiveRunningJobs,
  memoryExportRow,
  operationRow,
  queueRow,
} from '$lib/frameleaf/running-jobs';

const operation = (overrides: Partial<MediaOperationDto> = {}): MediaOperationDto =>
  ({
    id: '0195e2a0-0000-7000-8000-000000000001',
    kind: MediaOperationKind.StudioExport,
    status: MediaOperationStatus.Rendering,
    destination: MediaOperationDestination.Local,
    destinationDetail: null,
    label: 'Summer in the Rockies',
    assetId: null,
    resultAssetId: null,
    retryOfId: null,
    projectId: null,
    revisionId: null,
    settings: {},
    estimate: null,
    bulk: null,
    progress: 30,
    processedUnits: '120',
    totalUnits: '400',
    attempt: 1,
    maxAttempts: 3,
    autoRetries: 0,
    retryAt: null,
    error: null,
    errorCode: null,
    cancelRequestedAt: null,
    cancelAcknowledgedAt: null,
    pausable: true,
    pauseRequestedAt: null,
    startedAt: '2026-09-23T09:50:00.000Z',
    finishedAt: null,
    createdAt: '2026-09-23T09:49:00.000Z',
    updatedAt: '2026-09-23T09:59:00.000Z',
    ...overrides,
  }) as MediaOperationDto;

const exportRun = (overrides: Partial<MemoryExportResponseDto> = {}): MemoryExportResponseDto =>
  ({
    id: '6d2d1f0a-0000-4000-8000-000000000001',
    memoryId: '6d2d1f0a-0000-4000-8000-0000000000aa',
    ownerId: '6d2d1f0a-0000-4000-8000-0000000000bb',
    title: 'Summer 2026',
    format: MemoryExportFormat.Archive,
    status: MemoryExportStatus.Running,
    assetCount: 40,
    processedAssets: 12,
    sizeInBytes: null,
    error: null,
    isDownloadable: false,
    createdAt: '2026-09-23T09:54:00.000Z',
    updatedAt: '2026-09-23T09:56:00.000Z',
    startedAt: '2026-09-23T09:55:00.000Z',
    finishedAt: null,
    expiresAt: null,
    ...overrides,
  }) as MemoryExportResponseDto;

const queue = (overrides: Partial<QueueRunDto> = {}): QueueRunDto => ({
  name: QueueName.ThumbnailGeneration,
  isPaused: false,
  canPause: true,
  active: 4,
  waiting: 96,
  processed: 300,
  total: 400,
  startedAt: '2026-09-23T09:40:00.000Z',
  ...overrides,
});

const summary = (overrides: Partial<RunningJobsResponseDto> = {}): RunningJobsResponseDto => ({
  operations: [],
  memoryExports: [],
  queues: [],
  canManageQueues: false,
  ...overrides,
});

describe('operationRow', () => {
  it('shows counted work as done of total, and offers pause on a pausable kind', () => {
    const row = operationRow(operation());

    expect(row).toMatchObject({ done: 120, total: 400, percent: 30, paused: false, pausing: false });
    expect(row.control).toEqual({ kind: 'pause' });
    expect(row.href).toBe('/activity?filter=running');
  });

  it('counts a bulk job in items answered of items requested', () => {
    const row = operationRow(
      operation({
        kind: MediaOperationKind.Bulk,
        processedUnits: '50',
        totalUnits: '200',
        bulk: {
          action: MediaOperationBulkAction.Favorite,
          requested: 200,
          succeeded: 45,
          failed: 2,
          skipped: 3,
          snapshotTruncated: false,
          itemsTruncated: false,
          retried: 0,
        },
      }),
    );

    expect(row).toMatchObject({ done: 50, total: 200, percent: 25, titleKey: 'frameleaf_bulk_favorite' });
  });

  it('is indeterminate while nothing has been counted', () => {
    const row = operationRow(
      operation({ status: MediaOperationStatus.Queued, processedUnits: '0', totalUnits: null, progress: 0 }),
    );

    expect(row).toMatchObject({ done: 0, total: null, percent: null });
  });

  it('offers resume on a paused job and on one still pausing', () => {
    expect(operationRow(operation({ status: MediaOperationStatus.Paused })).control).toEqual({ kind: 'resume' });

    const pausing = operationRow(operation({ pauseRequestedAt: '2026-09-23T10:00:00.000Z' }));
    expect(pausing).toMatchObject({ pausing: true, statusKey: 'frameleaf_activity_status_pausing' });
    expect(pausing.control).toEqual({ kind: 'resume' });
  });

  it('shows the control disabled, with the reason, for a kind that runs in one go', () => {
    const row = operationRow(operation({ kind: MediaOperationKind.StudioPreview, pausable: false }));

    expect(row.control).toEqual({ kind: 'unavailable', reasonKey: 'frameleaf_running_pause_unavailable_kind' });
  });

  it('shows the control disabled while the output is being checked', () => {
    const row = operationRow(operation({ status: MediaOperationStatus.Validating }));

    expect(row.control).toEqual({ kind: 'unavailable', reasonKey: 'frameleaf_running_pause_unavailable_finishing' });
  });
});

describe('row tone, as on the prototype’s Activity chips', () => {
  it('reads working as info with a live dot, held or pausing as warning, waiting as neutral', () => {
    expect(operationRow(operation())).toMatchObject({ tone: 'info', live: true });
    expect(operationRow(operation({ status: MediaOperationStatus.Paused }))).toMatchObject({
      tone: 'warning',
      live: false,
    });
    expect(operationRow(operation({ pauseRequestedAt: '2026-09-23T10:00:00.000Z' }))).toMatchObject({
      tone: 'warning',
      live: false,
    });
    expect(queueRow(queue({ active: 0 }))).toMatchObject({ tone: 'neutral', live: false });
    expect(queueRow(queue({ isPaused: true }))).toMatchObject({ tone: 'warning', live: false });
    expect(memoryExportRow(exportRun())).toMatchObject({ tone: 'info', live: true });
  });
});

describe('memoryExportRow', () => {
  it('counts assets written of assets in the export and cannot pause', () => {
    const row = memoryExportRow(exportRun());

    expect(row).toMatchObject({ done: 12, total: 40, percent: 30, title: 'Summer 2026' });
    expect(row.control).toEqual({ kind: 'unavailable', reasonKey: 'frameleaf_running_pause_unavailable_export' });
    expect(row.href).toBe('/memories/6d2d1f0a-0000-4000-8000-0000000000aa');
  });
});

describe('queueRow', () => {
  it('reads a growing run as processed of processed + active + waiting', () => {
    const row = queueRow(queue());

    expect(row).toMatchObject({ done: 300, total: 400, percent: 75, active: 4, waiting: 96 });
    expect(row.control).toEqual({ kind: 'pause' });
    expect(row.href).toBe('/user-settings?area=processing&section=queues&queue=thumbnail-generation');
  });

  it('never shows a total smaller than the work visibly in hand', () => {
    const row = queueRow(queue({ total: 10, processed: 5, active: 2, waiting: 8 }));

    expect(row.total).toBe(15);
  });

  it('offers resume on a paused queue and nothing on one that cannot pause', () => {
    expect(queueRow(queue({ isPaused: true })).control).toEqual({ kind: 'resume' });
    expect(queueRow(queue({ isPaused: true })).statusKey).toBe('frameleaf_activity_status_paused');
    expect(queueRow(queue({ name: QueueName.BackgroundTask, canPause: false })).control).toEqual({
      kind: 'unavailable',
      reasonKey: 'frameleaf_running_pause_unavailable_queue',
    });
  });

  it('reads a queue with only waiting work as queued', () => {
    expect(queueRow(queue({ active: 0 })).statusKey).toBe('frameleaf_activity_status_queued');
  });
});

describe('buildRunningJobRows', () => {
  it('lists the viewer’s own work first, newest first, then the server queues', () => {
    const rows = buildRunningJobRows(
      summary({
        operations: [operation()],
        memoryExports: [exportRun()],
        queues: [queue()],
        canManageQueues: true,
      }),
    );

    expect(rows.map((row) => row.source)).toEqual(['memoryExport', 'operation', 'queue']);
  });

  it('never shows queues to somebody who may not manage them, whatever arrives', () => {
    const rows = buildRunningJobRows(summary({ queues: [queue()], canManageQueues: false }));

    expect(rows).toEqual([]);
  });

  it('is empty before the first answer', () => {
    expect(buildRunningJobRows(null)).toEqual([]);
  });

  it('does not count paused work as running', () => {
    const rows = buildRunningJobRows(
      summary({
        operations: [operation({ status: MediaOperationStatus.Paused }), operation({ id: 'other' })],
        queues: [queue({ isPaused: true })],
        canManageQueues: true,
      }),
    );

    expect(countActiveRunningJobs(rows)).toBe(1);
  });
});
