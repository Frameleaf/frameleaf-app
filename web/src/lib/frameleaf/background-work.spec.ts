import { QueueName, type DurableJobRun, type DurableQueueRun, type DurableRunningJobs } from '@frameleaf/sdk';
import { describe, expect, it } from 'vitest';
import {
  activityWorkStatus,
  buildBackgroundWorkCards,
  buildWorkFeatureRows,
  otherWorkCards,
  tonightStart,
  workEtaSeconds,
} from '$lib/frameleaf/background-work';

const queue = (name: QueueName, patch: Partial<DurableQueueRun> = {}): DurableQueueRun => ({
  name,
  isPaused: false,
  canPause: true,
  active: 0,
  waiting: 0,
  processed: 0,
  total: 0,
  startedAt: null,
  ...patch,
});

const counts = { active: 0, blocked: 0, cancelled: 0, completed: 0, delayed: 0, failed: 0 };
const run = (kind: QueueName, patch: Partial<DurableJobRun> = {}): DurableJobRun => ({
  id: `run-${kind}`,
  kind,
  createdAt: '2026-10-16T06:18:27.069Z',
  finishedAt: null,
  enumerationDone: true,
  total: 104,
  ...counts,
  completed: 84,
  needsAttention: 0,
  paused: 20,
  retrying: 0,
  waiting: 0,
  stageTotals: { ...counts, completed: 460, needsAttention: 0, paused: 77, retrying: 0, total: 537, waiting: 0 },
  state: 'paused',
  lastProgressAt: null,
  lastStage: 'SmartSearch',
  reasons: ['dependency_unavailable', 'queue_paused'],
  noDispatchBacklog: false,
  ...patch,
});

const summary = (patch: Partial<DurableRunningJobs>): DurableRunningJobs => ({
  operations: [],
  memoryExports: [],
  queues: [],
  canManageQueues: true,
  canReadJobRuns: true,
  durableRuns: [],
  ...patch,
});

describe('buildBackgroundWorkCards (SHARING-P1)', () => {
  it.each([false, true])('weights combined run progress by item totals (reverse=%s)', (reverse) => {
    const runs = [
      run(QueueName.MetadataExtraction, {
        id: 'small',
        state: 'running',
        active: 1,
        paused: 0,
        completed: 20,
        total: 100,
      }),
      run(QueueName.MetadataExtraction, {
        id: 'large',
        state: 'running',
        active: 1,
        paused: 0,
        completed: 90,
        total: 1000,
      }),
    ];
    const cards = buildBackgroundWorkCards(summary({ durableRuns: reverse ? [...runs].reverse() : runs }));
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ stage: 'running', waiting: 0, running: 2, progress: 10 });
  });

  it.each([false, true])('withholds combined progress until every run is enumerated (reverse=%s)', (reverse) => {
    const runs = [
      run(QueueName.MetadataExtraction, { id: 'known', state: 'running', active: 1 }),
      run(QueueName.MetadataExtraction, { id: 'discovering', state: 'running', active: 1, enumerationDone: false }),
    ];
    const cards = buildBackgroundWorkCards(summary({ durableRuns: reverse ? [...runs].reverse() : runs }));
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ stage: 'running', running: 2, progress: null });
  });

  it('makes one card per busy kind of work, in the Background work order, and none for idle ones', () => {
    const cards = buildBackgroundWorkCards(
      summary({
        queues: [
          queue(QueueName.SmartSearch, { isPaused: true, waiting: 52, total: 52 }),
          queue(QueueName.ThumbnailGeneration, { active: 2, waiting: 18, processed: 30, total: 50 }),
          queue(QueueName.Ocr),
        ],
      }),
    );

    expect(
      cards.map(({ queueName, stage, waiting, running, progress }) => [queueName, stage, waiting, running, progress]),
    ).toEqual([
      [QueueName.ThumbnailGeneration, 'running', 18, 2, 60],
      [QueueName.SmartSearch, 'paused', 52, 0, null],
    ]);
  });

  it('says work quiet hours saved for tonight as waiting, with when it starts, not as paused (FL-711)', () => {
    const cards = buildBackgroundWorkCards(
      summary({
        queues: [
          queue(QueueName.VideoConversion, {
            isPaused: false,
            heldForNight: true,
            resumesAt: '2026-10-31T06:00:00.000Z',
            state: 'paused',
            waiting: 3,
            total: 3,
          }),
          queue(QueueName.SmartSearch, { isPaused: true, waiting: 52, total: 52 }),
        ],
      }),
    );

    expect(cards).toEqual([
      expect.objectContaining({
        queueName: QueueName.VideoConversion,
        stage: 'queued',
        waiting: 3,
        tonight: { startsAt: '2026-10-31T06:00:00.000Z' },
      }),
      expect.objectContaining({ queueName: QueueName.SmartSearch, stage: 'paused' }),
    ]);
    expect(cards[1]).not.toHaveProperty('tonight');
  });

  it('counts an unfinished run once, only for a kind whose queue is idle, without its stages', () => {
    const cards = buildBackgroundWorkCards(
      summary({
        queues: [queue(QueueName.FaceDetection, { isPaused: true, waiting: 52, total: 52 })],
        durableRuns: [run(QueueName.MetadataExtraction), run(QueueName.FaceDetection, { id: 'other' })],
      }),
    );

    expect(cards).toHaveLength(2);
    expect(cards[0]).toEqual({
      id: 'run:run-metadataExtraction',
      queueName: QueueName.MetadataExtraction,
      stage: 'paused',
      statusKey: 'frameleaf_activity_stage_paused',
      stuck: false,
      reason: null,
      waiting: 20,
      running: 0,
      progress: null,
      done: 84,
      total: 104,
    });
    // The face detection queue speaks for its kind; the run of the same kind adds nothing.
    expect(cards[1]).toMatchObject({ queueName: QueueName.FaceDetection, waiting: 52 });
  });

  it.each([
    ['blocked', 'frameleaf_job_runs_state_blocked', true],
    ['delayed', 'frameleaf_job_runs_state_delayed', false],
    ['retrying', 'frameleaf_job_runs_state_retrying', false],
    ['unavailable', 'frameleaf_job_runs_state_unavailable', true],
    ['waiting', 'frameleaf_activity_stage_queued', false],
  ] as const)('says why %s work is not running rather than calling it queued', (state, statusKey, stuck) => {
    const [card] = buildBackgroundWorkCards(
      summary({ queues: [queue(QueueName.ThumbnailGeneration, { waiting: 40, total: 40, state })] }),
    );
    expect(card).toMatchObject({ stage: 'queued', statusKey, stuck });
  });

  it('says a queue the server could not read is unavailable, even when its last counts were running', () => {
    const [card] = buildBackgroundWorkCards(
      summary({
        queues: [queue(QueueName.ThumbnailGeneration, { active: 3, waiting: 40, total: 43, unavailable: true })],
      }),
    );
    expect(card).toMatchObject({ stage: 'running', statusKey: 'frameleaf_activity_bg_unreadable', stuck: true });
  });

  it('shows a queue the server could not read even with no counts to go on', () => {
    const [card] = buildBackgroundWorkCards(
      summary({ queues: [queue(QueueName.ThumbnailGeneration, { unavailable: true, state: 'unavailable' })] }),
    );
    expect(card).toMatchObject({ stage: 'queued', statusKey: 'frameleaf_activity_bg_unreadable', stuck: true });
  });

  it.each([false, true])('keeps the more telling reason of two queued runs of one kind (reverse=%s)', (reverse) => {
    const runs = [
      run(QueueName.MetadataExtraction, { id: 'waiting', state: 'waiting', paused: 0, waiting: 5 }),
      run(QueueName.MetadataExtraction, { id: 'blocked', state: 'blocked', paused: 0, blocked: 5 }),
    ];
    const [card] = buildBackgroundWorkCards(summary({ durableRuns: reverse ? [...runs].reverse() : runs }));
    expect(card).toMatchObject({ stage: 'queued', statusKey: 'frameleaf_job_runs_state_blocked', stuck: true });
  });

  it.each([false, true])(
    'keeps a paused stage when it meets a blocked queued run of one kind (reverse=%s)',
    (reverse) => {
      const runs = [
        run(QueueName.MetadataExtraction, { id: 'paused', state: 'paused' }),
        run(QueueName.MetadataExtraction, { id: 'blocked', state: 'blocked', paused: 0, blocked: 5 }),
      ];
      const [card] = buildBackgroundWorkCards(summary({ durableRuns: reverse ? [...runs].reverse() : runs }));
      expect(card).toMatchObject({ stage: 'paused', statusKey: 'frameleaf_activity_stage_paused' });
    },
  );

  it('reads running work as running whatever else waits behind it', () => {
    const [card] = buildBackgroundWorkCards(
      summary({
        queues: [queue(QueueName.ThumbnailGeneration, { active: 3, waiting: 40, total: 43, state: 'running' })],
      }),
    );
    expect(card).toMatchObject({ stage: 'running', statusKey: 'frameleaf_activity_stage_running', stuck: false });
  });

  describe('a Frameleaf Manager import (FL-1177)', () => {
    const importRun = (patch: Partial<DurableJobRun> = {}) =>
      run('library-import-derived' as QueueName, {
        state: 'waiting',
        paused: 0,
        waiting: 120,
        active: 0,
        held: 100,
        ...patch,
      });

    it('counts only the photos its first setup holds back, not the ones its queues already show', () => {
      const cards = buildBackgroundWorkCards(
        summary({
          queues: [queue(QueueName.ThumbnailGeneration, { active: 2, waiting: 18, total: 20, state: 'running' })],
          durableRuns: [importRun()],
        }),
      );
      expect(cards).toHaveLength(2);
      expect(cards.find(({ id }) => id.startsWith('run:'))).toEqual({
        id: 'run:run-library-import-derived',
        queueName: 'library-import-derived',
        stage: 'queued',
        statusKey: 'frameleaf_activity_bg_import_check',
        stuck: false,
        reason: null,
        waiting: 100,
        running: 0,
        progress: null,
        done: null,
        total: null,
      });
    });

    it('says a paused setup is paused', () => {
      const [card] = buildBackgroundWorkCards(summary({ durableRuns: [importRun({ state: 'paused' })] }));
      expect(card).toMatchObject({ stage: 'paused', statusKey: 'frameleaf_activity_stage_paused', waiting: 100 });
    });

    it.each([
      ['released to its queues', { held: 0, state: 'running', active: 4 }],
      ['from a server that does not count held photos', { held: undefined }],
      ['settled with machine learning off', { held: 0, state: 'completed', waiting: 0 }],
    ] as const)('makes no card once nothing is held: %s', (_, patch) => {
      expect(buildBackgroundWorkCards(summary({ durableRuns: [importRun(patch)] }))).toEqual([]);
    });
  });

  it('shows nothing to somebody the server sends no queues or runs to', () => {
    expect(
      buildBackgroundWorkCards(
        summary({
          canManageQueues: false,
          canReadJobRuns: false,
          queues: [queue(QueueName.ThumbnailGeneration, { active: 1 })],
          durableRuns: [run(QueueName.MetadataExtraction)],
        }),
      ),
    ).toEqual([]);
  });
});

describe('tonightStart (FL-711)', () => {
  // Local times, so the calendar days are the viewer's own.
  const evening = new Date(2026, 9, 30, 21, 28);

  it('calls a start after midnight but before noon tomorrow tonight', () => {
    expect(tonightStart(new Date(2026, 9, 31, 0, 0).toISOString(), evening)).toBe('tonight');
    expect(tonightStart(new Date(2026, 9, 30, 23, 0).toISOString(), evening)).toBe('tonight');
  });

  it('names the day of a start tomorrow evening, though it is less than 24 hours away', () => {
    expect(tonightStart(new Date(2026, 9, 31, 20, 0).toISOString(), evening)).toBe('day');
    expect(tonightStart(new Date(2026, 10, 2, 0, 0).toISOString(), evening)).toBe('day');
  });

  it('judges by calendar day across a daylight-saving change', () => {
    // 1 November 2026 is the fall-back day in North America; its start is still the morning after.
    const night = new Date(2026, 9, 31, 22, 0);
    expect(tonightStart(new Date(2026, 10, 1, 2, 0).toISOString(), night)).toBe('tonight');
  });

  it('says nothing about a time when the schedule never starts', () => {
    expect(tonightStart(null, evening)).toBe('unscheduled');
    expect(tonightStart('not a date', evening)).toBe('unscheduled');
  });
});

describe('buildWorkFeatureRows (FL-1388)', () => {
  const rowsOf = (patch: Partial<DurableRunningJobs>) => buildWorkFeatureRows(buildBackgroundWorkCards(summary(patch)));
  const row = (rows: ReturnType<typeof buildWorkFeatureRows>, id: string) =>
    rows.find(({ feature }) => feature.id === id)!;

  it('lists every feature in the order people meet them, idle ones too', () => {
    const rows = rowsOf({});
    expect(rows.map(({ feature }) => feature.id)).toEqual([
      'ready',
      'faces',
      'search',
      'text',
      'descriptions',
      'transcripts',
      'export',
      'upkeep',
    ]);
    expect(rows.every(({ state, left, total }) => state === 'idle' && left === 0 && total === null)).toBe(true);
  });

  it('adds up the tasks of one feature: what is done, what is left, and the most telling state', () => {
    const rows = rowsOf({
      queues: [
        queue(QueueName.ThumbnailGeneration, { active: 4, waiting: 120, processed: 1116, total: 1240 }),
        queue(QueueName.MetadataExtraction, { waiting: 10, processed: 1230, total: 1240 }),
        queue(QueueName.FaceDetection, { active: 2, waiting: 858, processed: 380, total: 1240 }),
        queue(QueueName.DuplicateDetection, { waiting: 3, total: 3 }),
      ],
    });
    // Thumbnails is running, Metadata only waiting: the feature is running, and counts both.
    expect(row(rows, 'ready')).toMatchObject({ state: 'running', done: 2346, total: 2480, left: 134 });
    expect(row(rows, 'faces')).toMatchObject({ state: 'running', done: 380, total: 1240, left: 860 });
    // A task named by no feature is upkeep.
    expect(row(rows, 'upkeep')).toMatchObject({ state: 'waiting', statusKey: null, left: 3 });
    expect(row(rows, 'search').state).toBe('idle');
  });

  it('says paused only when nothing of the feature is moving or waiting its turn', () => {
    const paused = rowsOf({
      queues: [
        queue(QueueName.FaceDetection, { isPaused: true, waiting: 52, total: 52 }),
        queue(QueueName.FacialRecognition, { isPaused: true, waiting: 8, total: 8 }),
      ],
    });
    expect(row(paused, 'faces')).toMatchObject({ state: 'paused', left: 60 });

    const mixed = rowsOf({
      queues: [
        queue(QueueName.FaceDetection, { isPaused: true, waiting: 52, total: 52 }),
        queue(QueueName.FacialRecognition, { waiting: 8, total: 8 }),
      ],
    });
    expect(row(mixed, 'faces').state).toBe('waiting');
  });

  it('says work saved for tonight waits for tonight, with the earliest start (FL-711)', () => {
    const rows = rowsOf({
      queues: [
        queue(QueueName.ImageDescription, {
          waiting: 214,
          total: 214,
          heldForNight: true,
          resumesAt: '2026-11-11T07:00:00.000Z',
        }),
        queue(QueueName.NsfwDetection, {
          waiting: 214,
          total: 214,
          heldForNight: true,
          resumesAt: '2026-11-11T06:00:00.000Z',
        }),
      ],
    });
    expect(row(rows, 'descriptions')).toMatchObject({
      state: 'tonight',
      left: 428,
      tonight: { startsAt: '2026-11-11T06:00:00.000Z' },
    });
  });

  it('says a feature is stuck, in the server’s words, when one of its tasks cannot be read', () => {
    const rows = rowsOf({
      queues: [
        queue(QueueName.SmartSearch, { unavailable: true }),
        queue(QueueName.Search, { active: 1, waiting: 4, processed: 5, total: 10 }),
      ],
    });
    expect(row(rows, 'search')).toMatchObject({ state: 'stuck', statusKey: 'frameleaf_activity_bg_unreadable' });
    // Only the task that could be read is counted.
    expect(row(rows, 'search')).toMatchObject({ done: 5, total: 10 });
  });

  it('keeps a run that is no feature’s task out of the features, on its own row (FL-1177)', () => {
    const cards = buildBackgroundWorkCards(
      summary({
        durableRuns: [
          run('library-import-derived' as QueueName, { state: 'waiting', held: 40, total: 40, completed: 0 }),
        ],
      }),
    );
    expect(otherWorkCards(cards).map(({ queueName }) => queueName)).toEqual(['library-import-derived']);
    expect(buildWorkFeatureRows(cards).every(({ state }) => state === 'idle')).toBe(true);
  });
});

describe('activityWorkStatus (FL-1388)', () => {
  const rowsOf = (queues: DurableQueueRun[]) => buildWorkFeatureRows(buildBackgroundWorkCards(summary({ queues })));
  const working = [queue(QueueName.ThumbnailGeneration, { active: 1, waiting: 9, processed: 10, total: 20 })];
  const paused = [queue(QueueName.FaceDetection, { isPaused: true, waiting: 52, total: 52 })];
  const tonight = [queue(QueueName.ImageDescription, { waiting: 5, total: 5, heldForNight: true })];

  it.each([
    ['idle', [], 0, 0],
    ['jobs', [], 0, 2],
    ['working', working, 0, 0],
    ['working', [...working, ...paused], 0, 0],
    ['tonight', tonight, 0, 0],
    ['tonight', [...tonight, ...paused], 0, 0],
    ['paused', paused, 0, 3],
    ['attention', working, 1, 0],
    ['attention', [], 2, 0],
    // Work the server could not count is neither up to date nor "0 items".
    ['unread', [queue(QueueName.SmartSearch, { unavailable: true })], 0, 0],
    ['working', [queue(QueueName.SmartSearch, { unavailable: true }), ...working], 0, 0],
    // Paused says why nothing moves; a failure keeps its card either way.
    ['paused', paused, 1, 0],
  ] as const)('says %s', (expected, queues, needsLook, jobs) => {
    expect(activityWorkStatus({ rows: rowsOf([...queues]), needsLook, jobs })).toBe(expected);
  });
});

describe('workEtaSeconds (FL-1388)', () => {
  const now = Date.parse('2026-11-10T10:00:00.000Z');
  const tenMinutesAgo = '2026-11-10T09:50:00.000Z';

  it('is the slowest moving task at the pace it has kept', () => {
    const eta = workEtaSeconds(
      summary({
        queues: [
          // 100 done in 600 s, 50 left: 300 s.
          queue(QueueName.ThumbnailGeneration, { active: 2, waiting: 48, processed: 100, startedAt: tenMinutesAgo }),
          // 10 done in 600 s, 20 left: 1,200 s.
          queue(QueueName.FaceDetection, { active: 1, waiting: 19, processed: 10, startedAt: tenMinutesAgo }),
        ],
      }),
      now,
    );
    expect(eta).toBe(1200);
  });

  it('leaves out work that is not moving: paused, or saved for tonight', () => {
    const eta = workEtaSeconds(
      summary({
        queues: [
          queue(QueueName.ThumbnailGeneration, { active: 2, waiting: 48, processed: 100, startedAt: tenMinutesAgo }),
          queue(QueueName.FaceDetection, { isPaused: true, waiting: 500 }),
          queue(QueueName.ImageDescription, { heldForNight: true, waiting: 500 }),
        ],
      }),
      now,
    );
    expect(eta).toBe(300);
  });

  it('gives no estimate while a moving task has finished nothing, or when nothing moves', () => {
    const waiting = queue(QueueName.FaceDetection, { waiting: 20, startedAt: tenMinutesAgo });
    const moving = queue(QueueName.ThumbnailGeneration, {
      active: 2,
      waiting: 48,
      processed: 100,
      startedAt: tenMinutesAgo,
    });
    expect(workEtaSeconds(summary({ queues: [moving, waiting] }), now)).toBeNull();
    expect(workEtaSeconds(summary({ queues: [{ ...moving, startedAt: null }] }), now)).toBeNull();
    expect(workEtaSeconds(summary({ queues: [] }), now)).toBeNull();
    expect(workEtaSeconds(summary({ queues: [moving], canManageQueues: false }), now)).toBeNull();
    expect(workEtaSeconds(null, now)).toBeNull();
  });
});
