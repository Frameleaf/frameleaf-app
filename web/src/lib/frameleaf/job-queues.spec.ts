import { JobName, ManualJobName, QueueName, type QueueResponseDto, type ServerFeaturesDto } from '@immich/sdk';
import en from '../../../../i18n/en.json';
import {
  isValidConcurrency,
  jobNameKey,
  MANUAL_JOBS,
  manualJobKey,
  isFeatureOff,
  JOB_QUEUES,
  jobCounts,
  jobQueue,
  jobQueueStatus,
  matchesQueueFilters,
  searchTerms,
  startBlocked,
  sumJobCounts,
} from './job-queues';

const queue = (name: QueueName, statistics: Partial<QueueResponseDto['statistics']> = {}, isPaused = false) => ({
  name,
  isPaused,
  statistics: { active: 0, completed: 0, delayed: 0, failed: 0, paused: 0, waiting: 0, ...statistics },
});

const flags = (overrides: Partial<ServerFeaturesDto> = {}) =>
  ({
    facialRecognition: true,
    smartSearch: true,
    duplicateDetection: true,
    ocr: true,
    sidecar: true,
    imageDescription: false,
    nsfwDetection: false,
    ...overrides,
  }) as ServerFeaturesDto;

describe('Job manager queue catalogue (FL-71)', () => {
  it('describes every production queue once', () => {
    const names = JOB_QUEUES.map(({ name }) => name);
    expect(new Set(names).size).toBe(names.length);
    expect([...names].sort()).toEqual(Object.values(QueueName).sort());
  });

  it('keeps the old queue page start commands', () => {
    expect(jobQueue(QueueName.FaceDetection)).toMatchObject({ run: 'missing', force: 'reset', refresh: true });
    expect(jobQueue(QueueName.Library)).toMatchObject({ run: 'rescan' });
    expect(jobQueue(QueueName.Library)?.force).toBeUndefined();
    expect(jobQueue(QueueName.Sidecar)).toMatchObject({ run: 'discover', force: 'synchronize' });
    expect(jobQueue(QueueName.StorageTemplateMigration)).toMatchObject({ run: 'task' });
    expect(jobQueue(QueueName.BackgroundTask)).toMatchObject({ canPause: false });
    expect(jobQueue(QueueName.BackgroundTask)?.run).toBeUndefined();
  });

  it('counts waiting, paused and delayed jobs as waiting & scheduled', () => {
    expect(jobCounts(queue(QueueName.Ocr, { waiting: 2, paused: 3, delayed: 4 }).statistics)).toMatchObject({
      pending: 9,
      paused: 3,
    });
    expect(
      sumJobCounts([
        queue(QueueName.Ocr, { active: 1, failed: 2, completed: 5 }),
        queue(QueueName.Library, { active: 2, waiting: 1 }),
      ]),
    ).toEqual({ active: 3, pending: 1, failed: 2, completed: 5, paused: 0 });
  });

  it('reports a queue as paused, processing, needing attention, waiting or idle', () => {
    expect(jobQueueStatus(queue(QueueName.Ocr, { active: 1 }, true))).toBe('paused');
    expect(jobQueueStatus(queue(QueueName.Ocr, { active: 1, failed: 1 }))).toBe('active');
    expect(jobQueueStatus(queue(QueueName.Ocr, { failed: 1, waiting: 1 }))).toBe('failed');
    expect(jobQueueStatus(queue(QueueName.Ocr, { delayed: 1 }))).toBe('waiting');
    expect(jobQueueStatus(queue(QueueName.Ocr))).toBe('idle');
  });

  it('refuses a start while the feature is off or the queue is busy', () => {
    const ocr = jobQueue(QueueName.Ocr)!;
    expect(startBlocked(queue(QueueName.Ocr), ocr, flags())).toBe('');
    expect(startBlocked(queue(QueueName.Ocr), ocr, flags({ ocr: false }))).toBe('feature-off');
    expect(startBlocked(queue(QueueName.Ocr, { waiting: 1 }), ocr, flags())).toBe('busy');
    expect(startBlocked(queue(QueueName.Ocr, {}, true), ocr, flags())).toBe('busy');
    expect(startBlocked(queue(QueueName.Ocr, { paused: 1 }), ocr, flags())).toBe('busy');
    // Scheduled (delayed) jobs keep their schedule and do not block a start, as in the template.
    expect(startBlocked(queue(QueueName.Ocr, { delayed: 4 }), ocr, flags())).toBe('');
  });

  it('treats the enrichment coordinator as off only when both of its features are off', () => {
    const coordinator = jobQueue(QueueName.ImageEnrichment)!;
    expect(isFeatureOff(coordinator, flags())).toBe(true);
    expect(isFeatureOff(coordinator, flags({ nsfwDetection: true }))).toBe(false);
    expect(isFeatureOff(jobQueue(QueueName.ThumbnailGeneration)!, flags())).toBe(false);
  });

  it('filters queues by words, category and status', () => {
    const ocr = jobQueue(QueueName.Ocr)!;
    const busy = queue(QueueName.Ocr, { active: 1 });
    const filters = { title: 'Text recognition', description: 'Extract searchable text from images.' };
    expect(
      matchesQueueFilters(busy, ocr, {
        ...filters,
        terms: searchTerms(' TEXT  images '),
        category: 'all',
        status: 'all',
      }),
    ).toBe(true);
    expect(matchesQueueFilters(busy, ocr, { ...filters, terms: [], category: 'media', status: 'all' })).toBe(false);
    expect(matchesQueueFilters(busy, ocr, { ...filters, terms: [], category: 'intelligence', status: 'idle' })).toBe(
      false,
    );
    expect(matchesQueueFilters(busy, ocr, { ...filters, terms: ['faces'], category: 'all', status: 'all' })).toBe(
      false,
    );
  });

  it('names every job handler and maintenance task in the customer language', () => {
    const messages = en as unknown as Record<string, string>;
    for (const name of Object.values(JobName)) {
      expect(messages[jobNameKey(name)], name).toBeTruthy();
    }
    for (const job of MANUAL_JOBS) {
      expect(messages[manualJobKey(job.name)], job.name).toBeTruthy();
      expect(messages[`${manualJobKey(job.name)}_description`], job.name).toBeTruthy();
    }
    // The old Create job list's tasks all stay available.
    for (const name of [
      ManualJobName.PersonCleanup,
      ManualJobName.TagCleanup,
      ManualJobName.UserCleanup,
      ManualJobName.MemoryCleanup,
      ManualJobName.MemoryCreate,
      ManualJobName.BackupDatabase,
      ManualJobName.BestPhotosBackfill,
      ManualJobName.AnalyticsCollect,
      ManualJobName.IntegrityMissingFiles,
      ManualJobName.IntegrityUntrackedFiles,
      ManualJobName.IntegrityChecksumMismatch,
      ManualJobName.IntegrityMissingFilesRefresh,
      ManualJobName.IntegrityUntrackedFilesRefresh,
      ManualJobName.IntegrityChecksumMismatchRefresh,
    ]) {
      expect(
        MANUAL_JOBS.some((job) => job.name === name),
        name,
      ).toBe(true);
    }
  });

  it('accepts whole-number concurrency from 1 to 1,000', () => {
    expect([1, '1000', 250].every((value) => isValidConcurrency(value))).toBe(true);
    expect([0, 1001, '1.5', '', 'ten', null, -1].some((value) => isValidConcurrency(value))).toBe(false);
  });
});
