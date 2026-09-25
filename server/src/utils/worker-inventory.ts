import type { JobRepository } from 'src/repositories/job.repository.js';
import { MlWorkload, QueueName } from 'src/enum.js';

/**
 * Library analysis and the queues it runs on (FL-72).
 *
 * Each library workload is routed to exactly one destination, and these are the queues whose
 * jobs make that workload's requests, so a workload's backlog is the work waiting for its routed
 * destination. Facial recognition (clustering) and duplicate detection (vector search) run in the
 * database and are not listed.
 */
export const LIBRARY_ANALYSIS_QUEUES: Readonly<Record<MlWorkload, readonly QueueName[]>> = {
  [MlWorkload.Face]: [QueueName.FaceDetection],
  [MlWorkload.Clip]: [QueueName.SmartSearch, QueueName.VideoDuplicateDetection],
  [MlWorkload.Ocr]: [QueueName.Ocr],
  [MlWorkload.Enrichment]: [QueueName.ImageDescription, QueueName.NsfwDetection],
  [MlWorkload.RestorationFaithful]: [],
  [MlWorkload.RestorationCreative]: [],
  [MlWorkload.StudioAi]: [],
  [MlWorkload.Upscale]: [],
  [MlWorkload.Interpolation]: [],
  [MlWorkload.StudioRender]: [],
  [MlWorkload.PetRecognition]: [QueueName.PetRecognition],
};

/** Every queue that carries library-analysis requests, once each. */
export const ALL_LIBRARY_ANALYSIS_QUEUES: readonly QueueName[] = [
  ...new Set(Object.values(LIBRARY_ANALYSIS_QUEUES).flat()),
];

export type QueueBacklog = { queue: QueueName; active: number; waiting: number; paused: boolean };

/**
 * Active and waiting jobs on each queue. A paused queue reports its jobs but counts as no backlog
 * for the purpose of holding restoration back: an administrator who paused face detection has
 * not asked restoration to wait behind it indefinitely.
 */
export const readQueueBacklogs = async (
  jobRepository: Pick<JobRepository, 'getJobCounts' | 'isPaused'>,
  queues: readonly QueueName[],
): Promise<QueueBacklog[]> => {
  const result: QueueBacklog[] = [];
  for (const queue of queues) {
    const [counts, paused] = await Promise.all([jobRepository.getJobCounts(queue), jobRepository.isPaused(queue)]);
    result.push({ queue, active: counts.active ?? 0, waiting: (counts.waiting ?? 0) + (counts.paused ?? 0), paused });
  }
  return result;
};

/** Jobs library analysis still has to run, not counting paused queues. */
export const libraryAnalysisBacklog = (backlogs: readonly QueueBacklog[]): number => {
  let total = 0;
  for (const entry of backlogs) {
    if (!entry.paused) {
      total += entry.active + entry.waiting;
    }
  }
  return total;
};
