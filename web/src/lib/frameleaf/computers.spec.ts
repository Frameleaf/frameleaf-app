import {
  MediaOperationKind,
  MlDestinationKind,
  MlWorkerReadiness,
  QueueName,
  WorkerInventorySource,
  type QueueResponseDto,
  type WorkerInventoryEntryDto,
  type WorkerInventoryResponseDto,
} from '@frameleaf/sdk';
import { describe, expect, it } from 'vitest';
import {
  aiState,
  areaStatus,
  canRunStudioWork,
  computersFrom,
  notAnswering,
  studioWorkUnavailable,
  summariseWork,
  workNow,
  workRows,
  workState,
} from '$lib/frameleaf/computers';

const entry = (overrides: Partial<WorkerInventoryEntryDto>): WorkerInventoryEntryDto =>
  ({
    id: overrides.name ?? 'id',
    source: WorkerInventorySource.MlDestination,
    name: 'This server',
    kind: MlDestinationKind.Local,
    enabled: true,
    readiness: MlWorkerReadiness.ModelReady,
    gpus: [],
    ...overrides,
  }) as WorkerInventoryEntryDto;

const inventory = (entries: WorkerInventoryEntryDto[], machineLearningEnabled = true) =>
  ({ entries, machineLearningEnabled }) as WorkerInventoryResponseDto;

const queue = (name: QueueName, statistics: Partial<QueueResponseDto['statistics']> = {}, isPaused = false) =>
  ({
    name,
    isPaused,
    statistics: { active: 0, completed: 0, delayed: 0, failed: 0, paused: 0, waiting: 0, ...statistics },
  }) as QueueResponseDto;

describe('computersFrom', () => {
  it('always lists this server, even when nothing could be read', () => {
    expect(computersFrom(null)).toEqual([expect.objectContaining({ key: 'server', place: 'server', state: 'ready' })]);
    expect(computersFrom(inventory([]))).toHaveLength(1);
  });

  it('shows a helper set up for AI features and for Studio as one computer', () => {
    const computers = computersFrom(
      inventory([
        entry({}),
        entry({ name: 'Office PC', kind: MlDestinationKind.Lan }),
        entry({
          name: 'office pc ',
          kind: 'lan',
          source: WorkerInventorySource.RenderWorker,
          gpus: [{ name: 'GeForce RTX 3060', memoryTotalBytes: 12 }],
        }),
        entry({ name: 'Frameleaf Cloud', kind: MlDestinationKind.FrameleafCloud }),
      ]),
    );
    expect(computers.map(({ key, place }) => [key, place])).toEqual([
      ['server', 'server'],
      ['office pc', 'home'],
      ['cloud', 'cloud'],
    ]);
    expect(computers[1].entries).toHaveLength(2);
    expect(computers[1].card).toBe('GeForce RTX 3060');
  });

  it('a computer is as healthy as its least healthy record that is switched on', () => {
    const [, office] = computersFrom(
      inventory([
        entry({ name: 'Office PC', kind: MlDestinationKind.Lan, readiness: MlWorkerReadiness.Unreachable }),
        entry({ name: 'Office PC', kind: 'lan', source: WorkerInventorySource.RenderWorker }),
      ]),
    );
    expect(office.state).toBe('not-answering');
    expect(notAnswering([office])).toEqual([office]);
  });

  it('tells switched off, not asked yet and not answering apart', () => {
    const states = (readiness: MlWorkerReadiness, enabled = true) =>
      computersFrom(inventory([entry({ name: 'Den', kind: MlDestinationKind.Lan, readiness, enabled })]))[1].state;
    expect(states(MlWorkerReadiness.ModelReady, false)).toBe('off');
    expect(states(MlWorkerReadiness.Disabled)).toBe('off');
    expect(states(MlWorkerReadiness.Unknown)).toBe('unchecked');
    expect(states(MlWorkerReadiness.Unreachable)).toBe('not-answering');
    expect(states(MlWorkerReadiness.Cpu)).toBe('ready');
    expect(states(MlWorkerReadiness.NotServing)).toBe('ready');
  });
});

describe('aiState', () => {
  it('is off when AI features are turned off, whatever the record says', () => {
    expect(aiState(inventory([entry({ readiness: MlWorkerReadiness.Unreachable })], false))).toBe('off');
  });
  it('follows this server’s own record when AI features are on', () => {
    expect(aiState(inventory([entry({ readiness: MlWorkerReadiness.Unreachable })]))).toBe('not-answering');
    expect(aiState(inventory([entry({})]))).toBe('ready');
    expect(aiState(inventory([]))).toBe('unchecked');
    expect(aiState(null)).toBeUndefined();
  });
});

describe('the one rule for Studio work', () => {
  const compatibility = {
    qualified: [MediaOperationKind.Restoration],
    unavailable: [MediaOperationKind.StudioExport],
  };
  it('reads what the server says can run now', () => {
    expect(canRunStudioWork(compatibility, 'restoration')).toBe(true);
    expect(canRunStudioWork(compatibility, 'export')).toBe(false);
    expect(studioWorkUnavailable(compatibility)).toEqual(['export']);
  });
  it('claims nothing when the answer could not be read', () => {
    expect(canRunStudioWork(null, 'export')).toBeUndefined();
    expect(studioWorkUnavailable(undefined)).toEqual([]);
  });
});

describe('background work', () => {
  it('lists only work that is running, waiting, paused or failed', () => {
    const rows = workRows([
      queue(QueueName.ThumbnailGeneration, { active: 2, waiting: 122 }),
      queue(QueueName.SmartSearch, { waiting: 40 }),
      queue(QueueName.VideoConversion, { failed: 3 }),
      queue(QueueName.ImageDescription, { paused: 5200 }, true),
      queue(QueueName.MetadataExtraction),
    ]);
    expect(workNow(rows).map((row) => [row.definition.name, workState(row)])).toEqual([
      [QueueName.ThumbnailGeneration, 'running'],
      [QueueName.VideoConversion, 'failed'],
      [QueueName.SmartSearch, 'waiting'],
      [QueueName.ImageDescription, 'paused'],
    ]);
    const summary = summariseWork(rows);
    expect(summary.left).toBe(124 + 40 + 5200);
    expect(summary.failedCount).toBe(3);
    expect(summary.paused).toHaveLength(1);
  });

  it('does not call work the server has booked for later "waiting"', () => {
    const rows = workRows([queue(QueueName.BackupDatabase, { delayed: 1 })]);
    expect(workNow(rows)).toEqual([]);
    expect(summariseWork(rows).left).toBe(0);
  });

  it('does not show Housekeeping as paused: the server never pauses it', () => {
    const [row] = workRows([queue(QueueName.BackgroundTask, {}, true)]);
    expect(workState(row)).toBe('up-to-date');
  });
});

describe('areaStatus', () => {
  const idle = summariseWork([]);
  it('puts what needs a look first, then work in progress, then a pause', () => {
    const failed = summariseWork(workRows([queue(QueueName.VideoConversion, { failed: 1, active: 1 })]));
    const working = summariseWork(workRows([queue(QueueName.FaceDetection, { waiting: 9 })]));
    const paused = summariseWork(workRows([queue(QueueName.Ocr, {}, true)]));
    expect(areaStatus(failed, [], 'ready')).toBe('attention');
    expect(areaStatus(working, [], 'ready')).toBe('working');
    expect(areaStatus(paused, [], 'ready')).toBe('paused');
    expect(areaStatus(idle, [], 'off')).toBe('up-to-date');
  });
  it('counts AI features that do not answer, and a silent helper, as needing a look', () => {
    expect(areaStatus(idle, [], 'not-answering')).toBe('attention');
    const [, den] = computersFrom(
      inventory([entry({ name: 'Den', kind: MlDestinationKind.Lan, readiness: MlWorkerReadiness.Unreachable })]),
    );
    expect(areaStatus(idle, [den], 'ready')).toBe('attention');
  });
});
