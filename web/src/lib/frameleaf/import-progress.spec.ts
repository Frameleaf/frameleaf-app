import { QueueName, type DurableJobRun, type DurableQueueRun, type DurableRunningJobs } from '@frameleaf/sdk';
import { describe, expect, it } from 'vitest';
import { durableRun } from '$lib/__mocks__/durable-runs.mock';
import { importProgress, LARGE_IMPORT } from '$lib/frameleaf/import-progress';
import { runHeadline } from '$lib/frameleaf/run-headline';

const NOW = Date.parse('2026-11-10T10:10:00.000Z');
const thumbnails = (patch: Partial<DurableQueueRun> = {}): DurableQueueRun => ({
  name: QueueName.ThumbnailGeneration,
  isPaused: false,
  canPause: true,
  active: 4,
  waiting: 9210,
  processed: 7103,
  total: 16_317,
  startedAt: '2026-11-10T10:00:00.000Z',
  ...patch,
});
const stageTotals = { ...durableRun().stageTotals, paused: 0, failed: 0, needsAttention: 0 };
const scanRun = (patch: Partial<DurableJobRun> = {}): DurableJobRun =>
  durableRun({
    id: 'scan-1',
    kind: 'library_scan',
    total: 16_317,
    completed: 7000,
    active: 4,
    failed: 0,
    needsAttention: 0,
    waiting: 9313,
    reasons: [],
    stageTotals,
    pausedQueues: [],
    ...patch,
  }) as DurableJobRun;
const summary = (patch: Partial<DurableRunningJobs>): DurableRunningJobs => ({
  operations: [],
  memoryExports: [],
  queues: [],
  canManageQueues: true,
  canReadJobRuns: true,
  durableRuns: [],
  ...patch,
});

/** FL-1409 (M5): the progress line for any large import. */
describe('importProgress (FL-1409)', () => {
  it('counts the photos a large upload has ready, and about how long is left', () => {
    const line = importProgress(summary({ queues: [thumbnails()] }), NOW);
    expect(line).toMatchObject({ ready: { done: 7103, total: 16_317 } });
    expect(line?.scan).toBeUndefined();
    expect(line?.stopped).toBeUndefined();
    // 7,103 in ten minutes: the 9,214 left take about thirteen more.
    expect(Math.round(line!.etaSeconds! / 60)).toBe(13);
  });

  it('says nothing for a handful of photos, or to anyone the server sends no queues', () => {
    const few = thumbnails({ waiting: 20, processed: 30, total: 54 });
    expect(importProgress(summary({ queues: [few] }), NOW)).toBeNull();
    expect(importProgress(summary({ queues: [thumbnails()], canManageQueues: false }), NOW)).toBeNull();
    expect(importProgress(null, NOW)).toBeNull();
    expect(LARGE_IMPORT).toBe(500);
  });

  it('names an external-library scan when the viewer’s own jobs do', () => {
    const operations = [{ id: 'scan-1', label: 'Family archive' }] as DurableRunningJobs['operations'];
    const named = importProgress(summary({ queues: [thumbnails()], durableRuns: [scanRun()], operations }), NOW);
    expect(named?.scan).toEqual({ name: 'Family archive' });
    const unnamed = importProgress(summary({ queues: [thumbnails()], durableRuns: [scanRun()] }), NOW);
    expect(unnamed?.scan).toEqual({ name: null });
  });

  it('says a paused scan in its Recent work card’s words, with the card’s Resume', () => {
    const run = scanRun({ active: 0, reasons: ['queue_paused'], pausedQueues: [QueueName.ThumbnailGeneration] });
    const queue = thumbnails({ isPaused: true, active: 0 });
    const line = importProgress(summary({ queues: [queue], durableRuns: [run] }), NOW);
    expect(line?.stopped).toMatchObject({
      status: runHeadline(run).status,
      why: runHeadline(run).why,
      action: 'resume',
      queues: [QueueName.ThumbnailGeneration],
    });
    expect(line?.etaSeconds).toBeNull();
    expect(line?.ready).toEqual({ done: 7103, total: 16_317 });
  });

  it('says Waiting for a drive and names the library, with no time left', () => {
    const run = scanRun({ active: 0, reasons: ['source-unavailable'], unreachableLibraries: ['Family archive'] });
    const line = importProgress(summary({ queues: [thumbnails({ active: 0 })], durableRuns: [run] }), NOW);
    expect(line?.stopped).toMatchObject({
      status: 'frameleaf_job_runs_status_waiting_drive',
      why: 'frameleaf_job_runs_why_drive',
      values: { name: 'Family archive' },
      action: null,
    });
    expect(line?.etaSeconds).toBeNull();
  });

  it('keeps counting while thumbnails are being made, whatever else the scan waits on', () => {
    // Faces wait on a paused queue, but the photos are still getting ready.
    const run = scanRun({ reasons: ['queue_paused'], pausedQueues: [QueueName.FaceDetection] });
    const line = importProgress(summary({ queues: [thumbnails()], durableRuns: [run] }), NOW);
    expect(line?.stopped).toBeUndefined();
    expect(line?.etaSeconds).not.toBeNull();
  });

  it('says a paused upload is paused, and when work saved for the night starts', () => {
    const paused = importProgress(summary({ queues: [thumbnails({ isPaused: true, active: 0 })] }), NOW);
    expect(paused?.stopped).toMatchObject({ status: 'frameleaf_job_runs_state_paused', action: 'resume' });

    const night = thumbnails({ active: 0, heldForNight: true, resumesAt: '2026-11-10T23:00:00.000Z' });
    const held = importProgress(summary({ queues: [night] }), NOW);
    expect(held?.tonight).toEqual({ startsAt: '2026-11-10T23:00:00.000Z' });
    expect(held?.stopped).toBeUndefined();
  });

  // FL-1457: Activity's "moving" rule. A poll between two thumbnail jobs (none active for a moment) keeps the time left.
  it('keeps the time left while photos wait between two thumbnail jobs', () => {
    const line = importProgress(summary({ queues: [thumbnails({ active: 0 })] }), NOW);
    expect(line?.stopped).toBeUndefined();
    expect(Math.round(line!.etaSeconds! / 60)).toBe(13);
  });

  // FL-1457: work that can't go on by itself stops the line, in the run's own words, as Activity says.
  it.each([
    ['waits for another step', { reasons: ['dependency_wait'] }, 'frameleaf_job_runs_state_blocked'],
    ['lost its worker', { reasons: ['worker_unavailable'] }, 'frameleaf_job_runs_state_unavailable'],
  ] as const)('says a scan that %s is stopped, with no time left', (_, patch, status) => {
    const run = scanRun({ active: 0, reasons: [...patch.reasons] });
    const line = importProgress(summary({ queues: [thumbnails({ active: 0 })], durableRuns: [run] }), NOW);
    expect(line?.stopped).toMatchObject({ status });
    expect(line?.etaSeconds).toBeNull();
  });

  it('shows a scan that is still reading its folder before any thumbnail waits', () => {
    const run = scanRun({ enumerationDone: false, total: 900 });
    expect(importProgress(summary({ durableRuns: [run] }), NOW)).toMatchObject({ found: 900, scan: { name: null } });
    // Folder read and thumbnails made: what is left is Activity's to show.
    expect(importProgress(summary({ durableRuns: [scanRun()] }), NOW)).toBeNull();
  });
});

describe('importProgress names uploads (FL-1459)', () => {
  it("names a large upload by its phone's name", () => {
    const upload = scanRun({ id: 'upload-1', kind: 'upload', origin: 'phone', label: 'Pixel 8', itemCount: 1240 });
    expect(importProgress(summary({ queues: [thumbnails()], durableRuns: [upload] }), NOW)).toMatchObject({
      upload: { name: 'Pixel 8' },
    });
  });

  it('names no device when two large uploads share the counts', () => {
    const one = scanRun({ id: 'upload-1', kind: 'upload', origin: 'phone', label: 'Pixel 8', itemCount: 1240 });
    const two = scanRun({ id: 'upload-2', kind: 'upload', origin: 'phone', label: 'iPad', itemCount: 900 });
    const line = importProgress(summary({ queues: [thumbnails()], durableRuns: [one, two] }), NOW);
    expect(line?.upload).toBeUndefined();
    expect(line?.ready).toBeDefined();
  });

  it('names no device when a small upload from another one shares the counts', () => {
    const large = scanRun({ id: 'upload-1', kind: 'upload', origin: 'phone', label: 'Pixel 8', itemCount: 1000 });
    const small = scanRun({ id: 'upload-2', kind: 'upload', origin: 'computer', label: 'Chrome', itemCount: 100 });
    expect(
      importProgress(summary({ queues: [thumbnails()], durableRuns: [large, small] }), NOW)?.upload,
    ).toBeUndefined();
  });
});
