import {
  ICloudReviewKind,
  MediaOperationStatus,
  type ICloudConnectionResponseDto,
  type ICloudSyncRunDto,
} from '@immich/sdk';
import { describe, expect, it } from 'vitest';
import {
  GIB,
  icloudAuthStep,
  icloudConsentNeeded,
  icloudDraft,
  icloudDraftProblems,
  icloudDraftUpdate,
  icloudErrorKey,
  icloudReviewReasonKey,
  icloudReviewTarget,
  icloudRunControls,
  icloudRunProgress,
  icloudStatus,
  icloudSummary,
  toggleLibrary,
} from '$lib/frameleaf/icloud-sync';

const run = (overrides: Partial<ICloudSyncRunDto> = {}): ICloudSyncRunDto => ({
  id: '0195e2a0-0000-7000-8000-000000000001',
  status: MediaOperationStatus.Rendering,
  progress: 40,
  processedUnits: 4,
  totalUnits: 10,
  retrying: false,
  waiting: false,
  pauseRequested: false,
  errorCode: null,
  startedAt: '2026-09-23T10:00:00.000Z',
  finishedAt: null,
  createdAt: '2026-09-23T10:00:00.000Z',
  ...overrides,
});

const connection = (overrides: Partial<ICloudConnectionResponseDto> = {}): ICloudConnectionResponseDto => ({
  id: '00000000-0000-4000-8000-000000000001',
  label: 'Personal iCloud',
  state: 'connected',
  authenticated: true,
  lastError: null,
  nextRunAt: null,
  counts: {},
  run: null,
  config: {
    libraries: [],
    albums: [],
    includeEdits: true,
    includeHidden: false,
    recoverExternalAsManaged: false,
    intervalHours: 24,
    concurrency: 1,
    stagingBytes: 20 * GIB,
  },
  ...overrides,
});

describe('icloudStatus', () => {
  it('reads the account first, then the run', () => {
    expect(icloudStatus(connection({ state: 'paused', authenticated: false }))).toBe('not-connected');
    expect(icloudStatus(connection({ state: 'awaiting-2fa' }))).toBe('awaiting-code');
    expect(icloudStatus(connection({ state: 'reauthentication-required' }))).toBe('sign-in-again');
    expect(icloudStatus(connection({ state: 'error', run: run() }))).toBe('needs-attention');
    expect(icloudStatus(connection())).toBe('connected');
    expect(icloudStatus(connection({ run: run() }))).toBe('syncing');
    expect(icloudStatus(connection({ run: run({ pauseRequested: true }) }))).toBe('pausing');
    expect(icloudStatus(connection({ run: run({ status: MediaOperationStatus.Queued, waiting: true }) }))).toBe(
      'waiting',
    );
    expect(icloudStatus(connection({ run: run({ status: MediaOperationStatus.Queued, retrying: true }) }))).toBe(
      'retrying',
    );
    expect(icloudStatus(connection({ run: run({ status: MediaOperationStatus.Completed }) }))).toBe('completed');
  });
});

describe('icloudAuthStep', () => {
  it('asks only for the step the server says is next', () => {
    expect(icloudAuthStep(connection({ state: 'paused', authenticated: false }))).toBe('sign-in');
    expect(icloudAuthStep(connection({ state: 'awaiting-2fa' }))).toBe('code');
    expect(icloudAuthStep(connection({ state: 'awaiting-device-approval' }))).toBe('approval');
    expect(icloudAuthStep(connection())).toBe('connected');
    expect(icloudAuthStep(connection({ state: 'reauthentication-required' }))).toBe('sign-in');
    expect(icloudAuthStep(connection({ state: 'disconnected', authenticated: false }))).toBe('sign-in');
  });
});

describe('icloudRunControls', () => {
  it('offers Sync now only to a connected account with nothing running', () => {
    expect(icloudRunControls(connection()).syncNow).toBe(true);
    expect(icloudRunControls(connection({ run: run() })).syncNow).toBe(false);
    expect(icloudRunControls(connection({ state: 'awaiting-2fa' })).syncNow).toBe(false);
  });

  it('pauses a running run, resumes a paused one and never both', () => {
    expect(icloudRunControls(connection({ run: run() }))).toMatchObject({ pause: true, resume: false, cancel: true });
    expect(icloudRunControls(connection({ run: run({ status: MediaOperationStatus.Paused }) }))).toMatchObject({
      pause: false,
      resume: true,
      cancel: true,
    });
    expect(icloudRunControls(connection({ run: run({ pauseRequested: true }) }))).toMatchObject({
      pause: false,
      resume: true,
    });
  });

  it('retries a failed or cancelled run, and never beside a running one', () => {
    expect(icloudRunControls(connection({ run: run({ status: MediaOperationStatus.Failed }) })).retry).toBe(true);
    expect(icloudRunControls(connection({ run: run({ status: MediaOperationStatus.Cancelled }) })).retry).toBe(true);
    expect(icloudRunControls(connection({ state: 'error' })).retry).toBe(true);
    expect(icloudRunControls(connection({ run: run() }))).toMatchObject({ retry: false, rescan: false });
    expect(icloudRunControls(connection({ run: run({ status: MediaOperationStatus.Completed }) })).retry).toBe(false);
  });
});

describe('icloudRunProgress', () => {
  it('shows no bar until something is counted', () => {
    expect(icloudRunProgress(run({ totalUnits: null, progress: 0 }))).toBeNull();
    expect(icloudRunProgress(run())).toBe(40);
    expect(icloudRunProgress(run({ status: MediaOperationStatus.Completed, totalUnits: null }))).toBe(100);
  });
});

describe('sync preferences', () => {
  it('validates the design’s bounds', () => {
    const draft = icloudDraft(connection());
    expect(icloudDraftProblems(draft)).toEqual([]);
    expect(
      icloudDraftProblems({ ...draft, label: ' ', intervalHours: '0', concurrency: '5', stagingGiB: '0.0001' }),
    ).toEqual(['label', 'interval', 'concurrency', 'staging']);
    expect(icloudDraftProblems({ ...draft, intervalHours: '1.5' })).toEqual(['interval']);
    expect(icloudDraftProblems({ ...draft, librariesAll: false, libraries: [] })).toEqual(['libraries']);
  });

  it('keeps "all libraries" as the server’s empty list and makes a partial choice explicit', () => {
    const draft = icloudDraft(connection());
    const partial = toggleLibrary(draft, 'shared', ['personal', 'shared']);
    expect(partial).toMatchObject({ librariesAll: false, libraries: ['personal'] });
    expect(toggleLibrary(partial, 'shared', ['personal', 'shared'])).toMatchObject({
      librariesAll: true,
      libraries: [],
    });
    const none = toggleLibrary(partial, 'personal', ['personal', 'shared']);
    expect(icloudDraftProblems(none)).toContain('libraries');
  });

  it('keeps the exact staging bytes unless the budget was changed, and drops albums of unselected libraries', () => {
    const current = connection({ config: { ...connection().config, stagingBytes: 20 * GIB + 7 } });
    const draft = {
      ...icloudDraft(current),
      librariesAll: false,
      libraries: ['personal'],
      albums: ['personal:a', 'shared:b'],
    };
    const inventory = {
      albums: [
        { id: 'personal:a', libraryId: 'personal', name: 'A', parentId: null },
        { id: 'shared:b', libraryId: 'shared', name: 'B', parentId: null },
      ],
    };
    const update = icloudDraftUpdate(draft, current, inventory);
    expect(update.config?.stagingBytes).toBe(20 * GIB + 7);
    expect(update.config?.libraries).toEqual(['personal']);
    expect(update.config?.albums).toEqual(['personal:a']);
    expect(icloudDraftUpdate({ ...draft, stagingGiB: '2' }, current).config?.stagingBytes).toBe(2 * GIB);
  });

  it('asks for consent only to what saving newly allows', () => {
    const draft = { ...icloudDraft(connection()), includeHidden: true };
    expect(icloudConsentNeeded(draft, connection())).toEqual({ hidden: true });
    expect(icloudConsentNeeded(draft, connection({ config: { ...connection().config, includeHidden: true } }))).toEqual(
      { hidden: false },
    );
  });
});

describe('reconciliation', () => {
  it('summarises only what the server counted', () => {
    expect(
      icloudSummary({
        imported: 128,
        reused: 42,
        'needs-review': 3,
        unsupported: 1,
        'preserve-trashed': 2,
        'repaired-missing': 1,
        source_removed: 5,
      }),
    ).toMatchObject({ imported: 128, matched: 42, review: 3, skipped: 3, repaired: 1, sourceRemoved: 5 });
    expect(icloudSummary({})).toMatchObject({ imported: 0, matched: 0, review: 0, skipped: 0 });
  });

  it('explains findings and sends Live Photo pairs to their review', () => {
    expect(icloudReviewReasonKey({ kind: ICloudReviewKind.Review, reason: 'live_photo_identity_conflict' })).toBe(
      'frameleaf_icloud_reason_live_photo',
    );
    expect(icloudReviewReasonKey({ kind: ICloudReviewKind.SourceRemoved, reason: null })).toBe(
      'frameleaf_icloud_reason_source_removed',
    );
    expect(icloudReviewReasonKey({ kind: ICloudReviewKind.Failed, reason: 'something_new' })).toBe(
      'frameleaf_icloud_reason_kind_failed',
    );
    expect(icloudReviewTarget({ reason: 'local_live_photo_override', assetId: null })).toBe('live-photos');
    expect(icloudReviewTarget({ reason: 'multiple_content_matches', assetId: 'asset' })).toBe('asset');
    expect(icloudReviewTarget({ reason: 'multiple_content_matches', assetId: null })).toBeNull();
  });

  it('turns a server code into a message, and anything unknown into a general one', () => {
    expect(icloudErrorKey('rate_limited')).toBe('frameleaf_icloud_error_rate_limited');
    expect(icloudErrorKey('icloud_transport_timeout')).toBe('frameleaf_icloud_error_provider_unavailable');
    expect(icloudErrorKey('provider said something private')).toBe('frameleaf_icloud_error_generic');
    expect(icloudErrorKey(undefined)).toBe('frameleaf_icloud_error_generic');
  });
});
