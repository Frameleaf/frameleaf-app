import {
  MediaOperationBulkAction,
  MediaOperationDestination,
  MediaOperationKind,
  MediaOperationStatus,
  type MediaOperationDto,
} from '@immich/sdk';
import { describe, expect, it } from 'vitest';
import {
  activityCompletion,
  activityCounts,
  activityEtaSeconds,
  activityIndicatorState,
  activityStatusText,
  activitySettingsDetails,
  buildActivityList,
  formatActivityDuration,
  fromBulkOperation,
  fromDownload,
  fromMediaOperation,
  fromUpload,
  matchesActivityFilter,
  mediaOperationPauseState,
} from '$lib/frameleaf/activity';
import type { BulkOperationRecord } from '$lib/frameleaf/library-session';
import { UploadState } from '$lib/types';

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
    settings: { resolution: '3840×2160', format: 'MP4' },
    estimate: null,
    bulk: null,
    progress: 42,
    processedUnits: '420',
    totalUnits: '1000',
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
    startedAt: '2026-09-22T09:50:00.000Z',
    finishedAt: null,
    createdAt: '2026-09-22T09:49:00.000Z',
    updatedAt: '2026-09-22T09:59:00.000Z',
    ...overrides,
  }) as MediaOperationDto;

const bulk = (overrides: Partial<BulkOperationRecord> = {}): BulkOperationRecord =>
  ({
    requestId: 'request-1',
    action: 'add-to-album',
    scope: {} as never,
    status: 'running',
    submittedTotal: 100,
    processed: 25,
    total: 100,
    succeeded: 25,
    failed: 0,
    skipped: 0,
    failures: [],
    truncated: false,
    startedAt: 1_700_000_000_000,
    ...overrides,
  }) as BulkOperationRecord;

describe('fromMediaOperation', () => {
  it('reports the destination explicitly', () => {
    expect(fromMediaOperation(operation()).destinationKey).toBe('frameleaf_activity_destination_local');
    expect(fromMediaOperation(operation({ destination: MediaOperationDestination.Runpod })).destinationKey).toBe(
      'frameleaf_activity_destination_runpod',
    );
    expect(fromMediaOperation(operation({ destination: MediaOperationDestination.Lan })).destinationKey).toBe(
      'frameleaf_activity_destination_lan',
    );
  });

  it('never marks a server job as browser-local', () => {
    expect(fromMediaOperation(operation()).browserLocal).toBe(false);
  });

  it('reads an iCloud sync as syncing, and a run waiting out a back-off as waiting rather than retrying (FL-68)', () => {
    const icloud = { kind: MediaOperationKind.IcloudSync, label: 'Personal iCloud' };
    expect(fromMediaOperation(operation(icloud))).toMatchObject({
      kindKey: 'frameleaf_activity_kind_icloud_sync',
      statusKey: 'frameleaf_activity_icloud_syncing',
    });
    const retryAt = '2026-09-22T10:05:00.000Z';
    expect(
      fromMediaOperation(operation({ ...icloud, status: MediaOperationStatus.Queued, retryAt, autoRetries: 0 }))
        .statusKey,
    ).toBe('frameleaf_activity_status_waiting');
    expect(
      fromMediaOperation(operation({ ...icloud, status: MediaOperationStatus.Queued, retryAt, autoRetries: 1 }))
        .statusKey,
    ).toBe('frameleaf_activity_status_retrying');
  });

  it('shows no bar rather than a zero bar for a queued job with nothing counted', () => {
    const item = fromMediaOperation(
      operation({ status: MediaOperationStatus.Queued, progress: 0, totalUnits: null, startedAt: null }),
    );

    expect(item.progress).toBeNull();
    expect(item.running).toBe(true);
  });

  it('offers cancel while running and retry only after a failure or cancellation', () => {
    const running = fromMediaOperation(operation());
    expect(running).toMatchObject({ canCancel: true, canRetry: false, canDismiss: false });

    const failed = fromMediaOperation(operation({ status: MediaOperationStatus.Failed }));
    expect(failed).toMatchObject({ canCancel: false, canRetry: true, canDismiss: true, failed: true });

    const cancelled = fromMediaOperation(operation({ status: MediaOperationStatus.Cancelled }));
    expect(cancelled).toMatchObject({ canRetry: true, canDismiss: true, failed: false });

    const done = fromMediaOperation(operation({ status: MediaOperationStatus.Completed }));
    expect(done).toMatchObject({ canCancel: false, canRetry: false, canDismiss: true, progress: 100 });
  });

  it('titles a deduplication plan, names it and never offers a copied retry (FL-73)', () => {
    const item = fromMediaOperation(
      operation({
        kind: MediaOperationKind.PhysicalDeduplication,
        status: MediaOperationStatus.Failed,
        label: 'PD-ABABABAB',
        settings: { planId: 'PD-ABABABAB', copies: 2, resolution: '3840×2160' },
      }),
    );

    expect(item.titleKey).toBe('frameleaf_activity_title_physical_deduplication');
    expect(item.details).toEqual(['PD-ABABABAB']);
    expect(item.canRetry).toBe(false);
    expect(item.canDismiss).toBe(true);
  });

  it('titles a job about a withheld Locked item with words of its own, never an empty name (FL-43)', () => {
    const item = fromMediaOperation(
      operation({ kind: MediaOperationKind.Restoration, label: '', withheld: true, assetId: null }),
    );

    expect(item.titleKey).toBe('frameleaf_activity_title_locked_item');
    expect(item.assetId).toBeUndefined();
  });

  it('keeps cancelling as running until the server settles it', () => {
    const item = fromMediaOperation(operation({ status: MediaOperationStatus.Cancelling }));

    expect(item.running).toBe(true);
    expect(item.finished).toBe(false);
    expect(item.tone).toBe('warning');
  });

  it('carries the server’s failure detail verbatim', () => {
    const item = fromMediaOperation(
      operation({
        status: MediaOperationStatus.Failed,
        error: 'The worker stopped responding',
        errorCode: 'worker_lost',
      }),
    );

    expect(item.error).toBe('The worker stopped responding');
    expect(item.errorCode).toBe('worker_lost');
  });

  it('reads a job waiting for its automatic retry as retrying, with the failure it retries after (FL-104)', () => {
    const item = fromMediaOperation(
      operation({
        status: MediaOperationStatus.Queued,
        autoRetries: 1,
        retryAt: '2026-09-22T10:00:30.000Z',
        error: 'The worker stopped responding',
        errorCode: 'worker_lost',
      }),
    );

    expect(item.statusKey).toBe('frameleaf_activity_status_retrying');
    expect(item.tone).toBe('warning');
    expect(item.running).toBe(true);
    expect(item.failed).toBe(false);
    expect(item.canRetry).toBe(false);
    expect(item.error).toBe('The worker stopped responding');
  });

  it.each(Object.values(MediaOperationKind))(
    'reads a %s job waiting for its automatic retry as retrying, like every other kind (FL-104)',
    (kind) => {
      const item = fromMediaOperation(
        operation({
          kind,
          status: MediaOperationStatus.Queued,
          autoRetries: 1,
          retryAt: '2026-09-22T10:00:30.000Z',
          error: 'Could not finish',
          errorCode: 'failed_once',
        }),
      );

      expect(item.statusKey).toBe('frameleaf_activity_status_retrying');
      expect(item.tone).toBe('warning');
    },
  );

  it('reads a fresh queued job as queued', () => {
    expect(fromMediaOperation(operation({ status: MediaOperationStatus.Queued })).statusKey).toBe(
      'frameleaf_activity_status_queued',
    );
  });
});

describe('durable bulk jobs', () => {
  const bulkJob = (overrides: Partial<MediaOperationDto> = {}) =>
    operation({
      kind: MediaOperationKind.Bulk,
      label: 'favorite (1200 items)',
      settings: {},
      processedUnits: '600',
      totalUnits: '1200',
      progress: 50,
      bulk: {
        action: MediaOperationBulkAction.Favorite,
        requested: 1200,
        succeeded: 590,
        failed: 0,
        skipped: 10,
        snapshotTruncated: false,
        itemsTruncated: false,
        retried: 0,
      },
      ...overrides,
    });

  it('is titled by its action and reads as running, not rendering', () => {
    const item = fromMediaOperation(bulkJob());

    expect(item.titleKey).toBe('frameleaf_bulk_favorite');
    expect(item.statusKey).toBe('frameleaf_activity_bulk_running');
    expect(item.kindKey).toBe('frameleaf_activity_kind_bulk');
    expect(item.progress).toBe(50);
    expect(item.canCancel).toBe(true);
    expect(item.canRetry).toBe(false);
  });

  it('shows counts only, never the items themselves', () => {
    const item = fromMediaOperation(bulkJob());

    expect(item.bulk).toEqual({ requested: 1200, succeeded: 590, failed: 0, skipped: 10, retried: 0 });
    expect(item.assetId).toBeUndefined();
    expect(item.details).toEqual([]);
  });

  it('offers retry for a completed job with failures inside it', () => {
    const item = fromMediaOperation(
      bulkJob({
        status: MediaOperationStatus.Completed,
        processedUnits: '1200',
        bulk: {
          action: MediaOperationBulkAction.Favorite,
          requested: 1200,
          succeeded: 1100,
          failed: 90,
          skipped: 10,
          snapshotTruncated: false,
          itemsTruncated: false,
          retried: 0,
        },
      }),
    );

    expect(item.failed).toBe(true);
    expect(item.tone).toBe('danger');
    expect(item.canRetry).toBe(true);
    expect(item.canDismiss).toBe(true);
  });

  it('offers retry for a cancelled job and not for a clean one', () => {
    expect(fromMediaOperation(bulkJob({ status: MediaOperationStatus.Cancelled })).canRetry).toBe(true);
    expect(
      fromMediaOperation(
        bulkJob({
          status: MediaOperationStatus.Completed,
          bulk: {
            action: MediaOperationBulkAction.Favorite,
            requested: 1200,
            succeeded: 1190,
            failed: 0,
            skipped: 10,
            snapshotTruncated: false,
            itemsTruncated: false,
            retried: 0,
          },
        }),
      ).canRetry,
    ).toBe(false);
  });

  it('does not offer a second cancel while one is being settled', () => {
    expect(fromMediaOperation(bulkJob({ status: MediaOperationStatus.Cancelling })).canCancel).toBe(false);
  });
});

describe('activitySettingsDetails', () => {
  it('shows only the known settings that carry a value', () => {
    expect(activitySettingsDetails({ resolution: '1920×1080', format: 'MP4', secret: 'x' })).toEqual([
      '1920×1080',
      'MP4',
    ]);
    expect(activitySettingsDetails({})).toEqual([]);
    expect(activitySettingsDetails(undefined)).toEqual([]);
  });

  it('formats an upscale factor', () => {
    expect(activitySettingsDetails({ upscale: 2 })).toEqual(['2×']);
  });
});

describe('browser-local transfers', () => {
  it('marks uploads as belonging to this tab', () => {
    const item = fromUpload({
      id: 'upload-1',
      file: { name: 'DSC_0001.ARW' } as File,
      state: UploadState.STARTED,
      progress: 63,
      startDate: 1_700_000_000_000,
    });

    expect(item).toMatchObject({ browserLocal: true, running: true, progress: 63, title: 'DSC_0001.ARW' });
    expect(item.statusKey).toBe('frameleaf_activity_upload_started');
  });

  const download = (status: 'preparing' | 'ready' | 'error', progress = 40) => ({
    name: 'Summer.zip',
    archiveName: 'Summer',
    assetIds: ['a'],
    count: 1,
    total: 10,
    received: 4,
    status,
    progress,
    buffered: status === 'ready',
  });

  it('marks downloads as belonging to this tab, with their real progress', () => {
    const item = fromDownload('key-1', download('preparing'));

    expect(item).toMatchObject({ browserLocal: true, running: true, title: 'Summer', progress: 40 });
    expect(item.statusKey).toBe('frameleaf_activity_download_running');
  });

  it('reports a ready download as done and a failed one as failed (FL-45 D-2)', () => {
    expect(fromDownload('key-1', download('ready', 100))).toMatchObject({
      finished: true,
      failed: false,
      progress: 100,
    });
    const failed = fromDownload('key-2', download('error'));
    expect(failed).toMatchObject({ finished: true, failed: true, progress: null });
    expect(failed.statusKey).toBe('frameleaf_activity_download_failed');
  });
});

describe('fromBulkOperation', () => {
  it('treats a completed run with failures as needing attention', () => {
    const item = fromBulkOperation(bulk({ status: 'completed', processed: 100, failed: 4, succeeded: 96 }));

    expect(item.finished).toBe(true);
    expect(item.failed).toBe(true);
    expect(matchesActivityFilter(item, 'done')).toBe(false);
    expect(matchesActivityFilter(item, 'failed')).toBe(true);
  });

  it('reports real progress against the frozen total', () => {
    expect(fromBulkOperation(bulk()).progress).toBe(25);
    expect(fromBulkOperation(bulk({ total: null })).progress).toBeNull();
  });
});

describe('buildActivityList', () => {
  it('puts running work above finished work regardless of age', () => {
    const list = buildActivityList({
      operations: [
        operation({
          id: '0195e2a0-0000-7000-8000-00000000000a',
          status: MediaOperationStatus.Completed,
          startedAt: '2026-09-22T11:00:00.000Z',
        }),
        operation({
          id: '0195e2a0-0000-7000-8000-00000000000b',
          status: MediaOperationStatus.Rendering,
          startedAt: '2026-09-22T08:00:00.000Z',
        }),
      ],
    });

    expect(list.map((item) => item.running)).toEqual([true, false]);
  });

  it('never collides ids across sources', () => {
    const list = buildActivityList({
      operations: [operation({ id: 'shared-id' as never })],
      uploads: [{ id: 'shared-id', file: { name: 'a.jpg' } as File, state: UploadState.PENDING }],
      downloads: [
        [
          'shared-id',
          {
            name: 'a.zip',
            archiveName: 'a',
            assetIds: [],
            count: 0,
            total: 1,
            received: 0,
            status: 'preparing',
            progress: 0,
            buffered: false,
          },
        ],
      ],
    });

    expect(new Set(list.map((item) => item.id)).size).toBe(3);
  });
});

describe('counts and the indicator', () => {
  const items = buildActivityList({
    operations: [
      operation({ id: '0195e2a0-0000-7000-8000-000000000011', status: MediaOperationStatus.Rendering, progress: 40 }),
      operation({ id: '0195e2a0-0000-7000-8000-000000000012', status: MediaOperationStatus.Rendering, progress: 60 }),
      operation({ id: '0195e2a0-0000-7000-8000-000000000013', status: MediaOperationStatus.Completed }),
      operation({ id: '0195e2a0-0000-7000-8000-000000000014', status: MediaOperationStatus.Failed }),
    ],
  });

  it('counts each filter', () => {
    expect(activityCounts(items)).toEqual({ all: 4, running: 2, done: 1, failed: 1 });
  });

  it('averages only the jobs that have a real figure', () => {
    expect(activityIndicatorState(items)).toEqual({ count: 2, progress: 50 });
  });

  it('reports no progress when nothing running has been counted', () => {
    const queued = buildActivityList({
      operations: [operation({ status: MediaOperationStatus.Queued, progress: 0, totalUnits: null })],
    });

    expect(activityIndicatorState(queued)).toEqual({ count: 1, progress: null });
  });

  it('is silent when nothing is running', () => {
    expect(activityIndicatorState([])).toEqual({ count: 0, progress: null });
  });
});

describe('pause and resume (FL-104)', () => {
  it('offers pause on a running pausable job and counts its work', () => {
    const item = fromMediaOperation(operation());

    expect(item).toMatchObject({ canPause: true, canResume: false, paused: false, pausePending: false });
    expect(item).toMatchObject({ done: 420, total: 1000 });
    expect(item.pauseBlockedKey).toBeUndefined();
  });

  it('reads a paused job as paused: unfinished, cancellable, resumable, not counted as running', () => {
    const item = fromMediaOperation(
      operation({ status: MediaOperationStatus.Paused, pauseRequestedAt: '2026-09-23T10:00:00.000Z' }),
    );

    expect(item).toMatchObject({
      statusKey: 'frameleaf_activity_status_paused',
      tone: 'warning',
      paused: true,
      running: false,
      finished: false,
      canResume: true,
      canPause: false,
      canCancel: true,
      canRetry: false,
      canDismiss: false,
    });
    expect(matchesActivityFilter(item, 'running')).toBe(true);
    expect(matchesActivityFilter(item, 'done')).toBe(false);
    expect(activityIndicatorState([item])).toEqual({ count: 0, progress: null });
  });

  it('reads a pause the worker has not reached as pausing, with resume to withdraw it', () => {
    const item = fromMediaOperation(operation({ pauseRequestedAt: '2026-09-23T10:00:00.000Z' }));

    expect(item).toMatchObject({
      statusKey: 'frameleaf_activity_status_pausing',
      running: true,
      pausePending: true,
      canResume: true,
      canPause: false,
    });
  });

  it('says why a job cannot pause: a one-shot kind, validating, stopping', () => {
    expect(
      mediaOperationPauseState(
        operation({ kind: MediaOperationKind.StudioPreview, pausable: false, status: MediaOperationStatus.Rendering }),
      ).pauseBlockedKey,
    ).toBe('frameleaf_running_pause_unavailable_kind');
    expect(mediaOperationPauseState(operation({ status: MediaOperationStatus.Validating })).pauseBlockedKey).toBe(
      'frameleaf_running_pause_unavailable_finishing',
    );
    expect(mediaOperationPauseState(operation({ status: MediaOperationStatus.Cancelling })).pauseBlockedKey).toBe(
      'frameleaf_running_pause_unavailable_stopping',
    );
    const completed = operation({ status: MediaOperationStatus.Completed });
    expect(mediaOperationPauseState(completed).pauseBlockedKey).toBeUndefined();
  });

  it('keeps a paused bulk job out of retry and clearing, and counts items answered of items requested', () => {
    const item = fromMediaOperation(
      operation({
        kind: MediaOperationKind.Bulk,
        status: MediaOperationStatus.Paused,
        pauseRequestedAt: '2026-09-23T10:00:00.000Z',
        processedUnits: '600',
        totalUnits: '1200',
        bulk: {
          action: MediaOperationBulkAction.Favorite,
          requested: 1200,
          succeeded: 590,
          failed: 0,
          skipped: 10,
          snapshotTruncated: false,
          itemsTruncated: false,
          retried: 0,
        },
      }),
    );

    expect(item).toMatchObject({ paused: true, canRetry: false, canDismiss: false, canCancel: true, canResume: true });
    expect(item).toMatchObject({ done: 600, total: 1200 });
  });

  it('keeps paused work up with the running work', () => {
    const list = buildActivityList({
      operations: [
        operation({
          id: '0195e2a0-0000-7000-8000-000000000021',
          status: MediaOperationStatus.Completed,
          startedAt: '2026-09-23T11:00:00.000Z',
        }),
        operation({
          id: '0195e2a0-0000-7000-8000-000000000022',
          status: MediaOperationStatus.Paused,
          startedAt: '2026-09-23T08:00:00.000Z',
        }),
      ],
    });

    expect(list.map((item) => item.statusKey)).toEqual([
      'frameleaf_activity_status_paused',
      'frameleaf_activity_status_completed',
    ]);
  });
});

describe('fromMediaOperation, Studio bundles (FL-91)', () => {
  it('offers a finished export its file and a finished import its project, and nothing before', () => {
    const exported = fromMediaOperation(
      operation({ kind: MediaOperationKind.StudioBundleExport, status: MediaOperationStatus.Completed }),
    );
    expect(exported.studioBundle).toBe('export');
    expect(exported.kindKey).toBe('frameleaf_activity_kind_studio_bundle_export');

    const imported = fromMediaOperation(
      operation({ kind: MediaOperationKind.StudioBundleImport, status: MediaOperationStatus.Completed }),
    );
    expect(imported.studioBundle).toBe('import');

    for (const status of [
      MediaOperationStatus.Rendering,
      MediaOperationStatus.Cancelled,
      MediaOperationStatus.Failed,
    ]) {
      expect(fromMediaOperation(operation({ kind: MediaOperationKind.StudioBundleExport, status })).studioBundle).toBe(
        undefined,
      );
    }
    expect(fromMediaOperation(operation({ status: MediaOperationStatus.Completed })).studioBundle).toBeUndefined();
  });
});

describe('the status line (FL-30, prototype `statusText`)', () => {
  const translate = (key: string, options?: { values?: Record<string, unknown> }) =>
    options?.values ? `${key}(${JSON.stringify(options.values)})` : key;
  const formatDuration = (seconds: number) => `${seconds}s`;
  const started = Date.parse('2026-09-22T09:50:00.000Z');
  const item = (overrides: Partial<ReturnType<typeof fromMediaOperation>> = {}) => ({
    ...fromMediaOperation(operation()),
    startedAt: started,
    ...overrides,
  });

  it('estimates the time left from the rate so far, and only from a measured percentage', () => {
    // 42% in 42 seconds: 58 seconds to go.
    expect(activityEtaSeconds(item({ progress: 42 }), started + 42_000)).toBe(58);
    expect(activityEtaSeconds(item({ progress: null }), started + 42_000)).toBeNull();
    expect(activityEtaSeconds(item({ progress: 0 }), started + 42_000)).toBeNull();
    expect(activityEtaSeconds(item({ running: false }), started + 42_000)).toBeNull();
    expect(activityEtaSeconds(item({ startedAt: 0 }), started + 42_000)).toBeNull();
  });

  it('reads "state · percent · about time left" while running', () => {
    const text = activityStatusText(item({ progress: 42 }), { translate, formatDuration, now: started + 42_000 });
    expect(text).toBe(
      'frameleaf_activity_status_eta({"status":"frameleaf_activity_status_rendering","progress":42,"time":"58s"})',
    );
  });

  it('reads "Paused at N%" and "Waiting for connection" while offline', () => {
    const paused = item({ paused: true, running: false, statusKey: 'frameleaf_activity_status_paused', progress: 30 });
    expect(activityStatusText(paused, { translate, formatDuration })).toBe(
      'frameleaf_activity_status_at({"status":"frameleaf_activity_status_paused","progress":30})',
    );
    expect(activityStatusText(item({ progress: 42 }), { translate, formatDuration, online: false })).toBe(
      'frameleaf_activity_status_offline_progress({"progress":42})',
    );
    // A queued job waits for the connection too.
    const queued = item({ running: false, progress: null, statusKey: 'frameleaf_activity_status_queued' });
    expect(activityStatusText(queued, { translate, formatDuration, online: false })).toBe(
      'frameleaf_activity_status_offline',
    );
  });

  it('keeps a finished state plain, but says where a cancelled job stopped', () => {
    const done = item({
      finished: true,
      running: false,
      statusKey: 'frameleaf_activity_status_completed',
      progress: 100,
    });
    expect(activityStatusText(done, { translate, formatDuration })).toBe('frameleaf_activity_status_completed');
    const cancelled = item({
      finished: true,
      running: false,
      statusKey: 'frameleaf_activity_status_cancelled',
      progress: 63,
    });
    expect(activityStatusText(cancelled, { translate, formatDuration })).toBe(
      'frameleaf_activity_status_at({"status":"frameleaf_activity_status_cancelled","progress":63})',
    );
  });

  it('formats the estimate in seconds, minutes or hours', () => {
    expect(formatActivityDuration(20, 'en')).toBe('20 seconds');
    expect(formatActivityDuration(125, 'en')).toBe('3 minutes');
    expect(formatActivityDuration(5400, 'en')).toBe('1.5 hours');
  });
});

describe('Studio renders, server estimates and completion (FL-104)', () => {
  const translate = (key: string, options?: { values?: Record<string, unknown> }) =>
    options?.values ? `${key}(${JSON.stringify(options.values)})` : key;
  const formatDuration = (seconds: number) => `${seconds}s`;

  it('carries the project of a Studio export or preview so the row can open it in Studio', () => {
    expect(
      fromMediaOperation(operation({ kind: MediaOperationKind.StudioExport, projectId: 'project-1' })).projectId,
    ).toBe('project-1');
    expect(
      fromMediaOperation(operation({ kind: MediaOperationKind.StudioPreview, projectId: 'project-1' })).projectId,
    ).toBe('project-1');
    expect(
      fromMediaOperation(operation({ kind: MediaOperationKind.StudioBundleExport, projectId: 'p' })).projectId,
    ).toBe(undefined);
    expect(fromMediaOperation(operation({ kind: MediaOperationKind.StudioExport, projectId: null })).projectId).toBe(
      undefined,
    );
  });

  it("prefers the server's measured estimate and says the finished size", () => {
    const running = fromMediaOperation(
      operation({ progress: 10, estimate: { seconds: 125.2, sizeBytes: '12000000', cloudCost: null } }),
    );
    expect(activityEtaSeconds(running, Date.now())).toBe(126);
    expect(running.sizeBytes).toBe(12_000_000);

    const done = fromMediaOperation(
      operation({
        status: MediaOperationStatus.Completed,
        estimate: { seconds: 0, sizeBytes: '12000000', cloudCost: null },
      }),
    );
    expect(activityStatusText(done, { translate, formatDuration, formatSize: (bytes) => `${bytes}B` })).toBe(
      'frameleaf_activity_status_done_size({"status":"frameleaf_activity_status_completed","size":"12000000B"})',
    );
    // No estimate: nothing is invented.
    expect(fromMediaOperation(operation()).estimateSeconds).toBeUndefined();
  });

  it('announces a job that finishes or fails after it was seen, never on first sight', () => {
    const running = fromMediaOperation(operation());
    const done = fromMediaOperation(operation({ status: MediaOperationStatus.Completed }));
    const failed = fromMediaOperation(operation({ status: MediaOperationStatus.Failed }));

    expect(activityCompletion(new Map(), [done])).toBeNull();
    expect(activityCompletion(new Map([[running.id, running.statusKey]]), [done])).toEqual({
      id: done.id,
      outcome: 'finished',
    });
    expect(activityCompletion(new Map([[running.id, running.statusKey]]), [failed])).toEqual({
      id: failed.id,
      outcome: 'failed',
    });
    expect(activityCompletion(new Map([[done.id, done.statusKey]]), [done])).toBeNull();
  });
});
