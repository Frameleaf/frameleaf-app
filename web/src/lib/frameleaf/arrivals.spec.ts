import { QueueName, type DurableJobRun, type DurableRunningJobs } from '@frameleaf/sdk';
import { describe, expect, it } from 'vitest';
import { durableRun } from '$lib/__mocks__/durable-runs.mock';
import { arrivalSteps, buildArrivals, uploadRunTitle } from '$lib/frameleaf/arrivals';
import { buildBackgroundWorkCards } from '$lib/frameleaf/background-work';

const zero = { total: 0, completed: 0, failed: 0, needsAttention: 0, cancelled: 0, active: 0, retrying: 0 };
const step = (queue: QueueName, patch: Partial<typeof zero & Record<string, number>> = {}) => ({
  queue,
  ...zero,
  delayed: 0,
  paused: 0,
  waiting: 0,
  blocked: 0,
  ...patch,
});
const upload = (patch: Partial<DurableJobRun> = {}): DurableJobRun =>
  durableRun({
    id: 'upload-1',
    kind: 'upload',
    state: 'running',
    reasons: [],
    pausedQueues: [],
    origin: 'phone',
    label: 'Pixel 8',
    ownerId: 'owner-1',
    ownerName: 'Taylor',
    itemCount: 1240,
    createdAt: '2026-11-11T15:41:00.000Z',
    ...patch,
  }) as DurableJobRun;
const summary = (runs: DurableJobRun[]): DurableRunningJobs => ({
  operations: [],
  memoryExports: [],
  queues: [],
  canManageQueues: true,
  canReadJobRuns: true,
  durableRuns: runs,
});

describe('arrivals (FL-1459)', () => {
  it('names what came in, with its count, newest first; work with no origin is not one', () => {
    const older = upload({
      id: 'scan',
      origin: 'library',
      label: undefined,
      libraryName: 'Family archive',
      createdAt: '2026-11-11T10:00:00.000Z',
    });
    const arrivals = buildArrivals(summary([older, upload(), durableRun({ id: 'night' }) as DurableJobRun]));
    expect(arrivals.map(({ run, name, count }) => [run.id, name, count])).toEqual([
      ['upload-1', 'Pixel 8', 1240],
      ['scan', 'Family archive', 1240],
    ]);
  });

  it('leaves out finished work, and everything for anyone the server sends no runs', () => {
    expect(buildArrivals(summary([upload({ state: 'completed' })]))).toEqual([]);
    expect(buildArrivals({ ...summary([upload()]), canReadJobRuns: false })).toEqual([]);
  });

  it('adds up its steps by feature, in the order people meet them', () => {
    const steps = arrivalSteps([
      step(QueueName.SmartSearch, { total: 1240, waiting: 1240 }),
      step(QueueName.ThumbnailGeneration, { total: 1240, completed: 1116, active: 4, waiting: 120 }),
      step(QueueName.MetadataExtraction, { total: 1240, completed: 1240 }),
      step(QueueName.FaceDetection, { total: 1240, completed: 1237, failed: 3 }),
      step(QueueName.ImageDescription, { total: 1240, delayed: 1240 }),
    ]);
    expect(steps.map(({ feature, state, done, total }) => [feature.id, state, done, total])).toEqual([
      ['ready', 'running', 2356, 2480],
      ['faces', 'failed', 1240, 1240],
      ['search', 'waiting', 0, 1240],
      ['descriptions', 'tonight', 0, 1240],
    ]);
  });

  it("keeps an upload's own run off By feature: its work is on the queues' rows", () => {
    expect(buildBackgroundWorkCards(summary([upload({ active: 4, waiting: 10 })]))).toEqual([]);
  });

  it('FL-1478: titles an import’s photos by where they came from, not as a computer upload', () => {
    const $t = ((key: string, options?: { values?: Record<string, unknown> }) =>
      `${key}:${JSON.stringify(options?.values ?? {})}`) as never;
    expect(uploadRunTitle(upload({ origin: 'import', label: 'Google Photos', itemCount: 180 }), $t)).toBe(
      'frameleaf_activity_arrival_from:{"count":180,"name":"Google Photos"}',
    );
    expect(uploadRunTitle(upload({ kind: 'library_scan', origin: 'library', label: null }), $t)).toBeNull();
  });
});
