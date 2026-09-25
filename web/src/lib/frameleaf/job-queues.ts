/**
 * The Job manager's queue catalogue (FL-71), ported from the design template's `QUEUE_CATALOG`
 * (`design/frameleaf/template/src/jobs-data.mjs`): each production queue's title, category and
 * icon, and which of the server's queue commands it offers. Counts, pause state and jobs come from
 * the server (`getQueues`, `getQueueJobs`); nothing here is sample data.
 *
 * The start commands are the ones the server's `QueueCommand.Start` handler accepts for the queue
 * (`server/src/services/queue.service.ts`): "run" starts with `force: false` (missing work), "force"
 * with `force: true` (reprocess everything) and "refresh" with no force (face detection only).
 */
import {
  JobName,
  ManualJobName,
  QueueJobStatus,
  QueueName,
  type QueueResponseDto,
  type QueueStatisticsDto,
  type ServerFeaturesDto as FeatureFlags,
} from '@immich/sdk';
import {
  mdiAccountMultipleOutline,
  mdiAccountOutline,
  mdiBackupRestore,
  mdiBellOutline,
  mdiCameraOutline,
  mdiCompare,
  mdiFolderMultipleOutline,
  mdiFolderOutline,
  mdiFolderSearchOutline,
  mdiImageMultipleOutline,
  mdiImageSearchOutline,
  mdiMagnify,
  mdiMovieOpenOutline,
  mdiPawOutline,
  mdiPencilOutline,
  mdiServerOutline,
  mdiShieldCheckOutline,
  mdiTextBoxSearchOutline,
  mdiTuneVariant,
} from '@mdi/js';

export type JobQueueCategory = 'media' | 'intelligence' | 'maintenance' | 'system';
export const JOB_QUEUE_CATEGORIES: readonly JobQueueCategory[] = ['media', 'intelligence', 'maintenance', 'system'];

/** A queue's state as the template shows it: paused first, then processing, failures, waiting work. */
export type JobQueueStatus = 'active' | 'paused' | 'failed' | 'waiting' | 'idle';
export const JOB_QUEUE_STATUSES: readonly JobQueueStatus[] = ['active', 'paused', 'failed', 'idle'];

/** Where the settings that switch a queue's feature on live (`commandCenterUrl(area, section)`). */
type FeatureSettings = { flag: keyof FeatureFlags | ((flags: FeatureFlags) => boolean); section: string };

export type JobQueueDefinition = {
  name: QueueName;
  /** The i18n key stem: `frameleaf_jobs_queue_<key>` (title) and `…_description`. */
  key: string;
  category: JobQueueCategory;
  icon: string;
  /** "Run missing" (or the queue's own wording): start with `force: false`. */
  run?: 'missing' | 'rescan' | 'discover' | 'scan' | 'task';
  /** "Reprocess all" (or the queue's own wording): start with `force: true`. */
  force?: 'reprocess' | 'reset' | 'synchronize';
  /** Face detection's "Refresh faces": start without `force`. */
  refresh?: boolean;
  /** The server refuses to pause the background task queue. */
  canPause: boolean;
  /** The feature this queue serves; while it is off the start commands are unavailable. */
  feature?: FeatureSettings;
};

const ml = (flag: keyof FeatureFlags): FeatureSettings => ({ flag, section: 'machine-learning' });

/** In the template's order. */
export const JOB_QUEUES: readonly JobQueueDefinition[] = Object.freeze([
  {
    name: QueueName.ThumbnailGeneration,
    key: 'thumbnail_generation',
    category: 'media',
    icon: mdiImageMultipleOutline,
    run: 'missing',
    force: 'reprocess',
    canPause: true,
  },
  {
    name: QueueName.MetadataExtraction,
    key: 'metadata_extraction',
    category: 'media',
    icon: mdiCameraOutline,
    run: 'missing',
    force: 'reprocess',
    canPause: true,
  },
  {
    name: QueueName.VideoConversion,
    key: 'video_conversion',
    category: 'media',
    icon: mdiMovieOpenOutline,
    run: 'missing',
    force: 'reprocess',
    canPause: true,
  },
  {
    name: QueueName.FaceDetection,
    key: 'face_detection',
    category: 'intelligence',
    icon: mdiAccountOutline,
    run: 'missing',
    force: 'reset',
    refresh: true,
    canPause: true,
    feature: ml('facialRecognition'),
  },
  {
    name: QueueName.FacialRecognition,
    key: 'facial_recognition',
    category: 'intelligence',
    icon: mdiAccountMultipleOutline,
    run: 'missing',
    force: 'reset',
    canPause: true,
    feature: ml('facialRecognition'),
  },
  {
    name: QueueName.SmartSearch,
    key: 'smart_search',
    category: 'intelligence',
    icon: mdiImageSearchOutline,
    run: 'missing',
    force: 'reprocess',
    canPause: true,
    feature: ml('smartSearch'),
  },
  {
    name: QueueName.DuplicateDetection,
    key: 'duplicate_detection',
    category: 'intelligence',
    icon: mdiCompare,
    run: 'missing',
    force: 'reprocess',
    canPause: true,
    feature: ml('duplicateDetection'),
  },
  {
    name: QueueName.VideoDuplicateDetection,
    key: 'video_duplicate_detection',
    category: 'intelligence',
    icon: mdiMovieOpenOutline,
    run: 'missing',
    force: 'reprocess',
    canPause: true,
    feature: ml('duplicateDetection'),
  },
  {
    name: QueueName.BackgroundTask,
    key: 'background_task',
    category: 'system',
    icon: mdiServerOutline,
    canPause: false,
  },
  {
    name: QueueName.StorageTemplateMigration,
    key: 'storage_template_migration',
    category: 'maintenance',
    icon: mdiFolderOutline,
    run: 'task',
    canPause: true,
  },
  {
    name: QueueName.Migration,
    key: 'migration',
    category: 'maintenance',
    icon: mdiFolderMultipleOutline,
    run: 'task',
    canPause: true,
  },
  { name: QueueName.Search, key: 'search', category: 'system', icon: mdiMagnify, canPause: true },
  {
    name: QueueName.Sidecar,
    key: 'sidecar',
    category: 'media',
    icon: mdiTextBoxSearchOutline,
    run: 'discover',
    force: 'synchronize',
    canPause: true,
    feature: { flag: 'sidecar', section: 'metadata' },
  },
  {
    name: QueueName.Library,
    key: 'library',
    category: 'media',
    icon: mdiFolderSearchOutline,
    run: 'rescan',
    canPause: true,
  },
  { name: QueueName.Notifications, key: 'notifications', category: 'system', icon: mdiBellOutline, canPause: true },
  {
    name: QueueName.BackupDatabase,
    key: 'backup_database',
    category: 'maintenance',
    icon: mdiBackupRestore,
    run: 'task',
    canPause: true,
  },
  {
    name: QueueName.Ocr,
    key: 'ocr',
    category: 'intelligence',
    icon: mdiTextBoxSearchOutline,
    run: 'missing',
    force: 'reprocess',
    canPause: true,
    feature: ml('ocr'),
  },
  {
    name: QueueName.ImageEnrichment,
    key: 'image_enrichment',
    category: 'intelligence',
    icon: mdiImageSearchOutline,
    run: 'missing',
    force: 'reprocess',
    canPause: true,
    // The coordinator schedules descriptions and Locked-content analysis; the server refuses it when both are off.
    feature: { flag: (flags) => flags.imageDescription || flags.nsfwDetection, section: 'machine-learning' },
  },
  {
    name: QueueName.ImageDescription,
    key: 'image_description',
    category: 'intelligence',
    icon: mdiTextBoxSearchOutline,
    run: 'missing',
    force: 'reprocess',
    canPause: true,
    feature: ml('imageDescription'),
  },
  {
    name: QueueName.NsfwDetection,
    key: 'nsfw_detection',
    category: 'intelligence',
    icon: mdiShieldCheckOutline,
    run: 'missing',
    force: 'reprocess',
    canPause: true,
    feature: ml('nsfwDetection'),
  },
  {
    name: QueueName.MediaHealth,
    key: 'media_health',
    category: 'maintenance',
    icon: mdiShieldCheckOutline,
    run: 'scan',
    force: 'reprocess',
    canPause: true,
  },
  { name: QueueName.Workflow, key: 'workflow', category: 'system', icon: mdiTuneVariant, canPause: true },
  {
    name: QueueName.IntegrityCheck,
    key: 'integrity_check',
    category: 'maintenance',
    icon: mdiShieldCheckOutline,
    canPause: true,
  },
  { name: QueueName.Editor, key: 'editor', category: 'media', icon: mdiPencilOutline, canPause: true },
  {
    // FL-58: pet recognition reads the CLIP data smart search stores, so it follows that switch.
    name: QueueName.PetRecognition,
    key: 'pet_recognition',
    category: 'intelligence',
    icon: mdiPawOutline,
    run: 'task',
    canPause: true,
    feature: ml('smartSearch'),
  },
]);

export const jobQueue = (name: QueueName | undefined) => JOB_QUEUES.find((queue) => queue.name === name);

export const isFeatureOff = (queue: JobQueueDefinition, flags: FeatureFlags) => {
  if (!queue.feature) {
    return false;
  }
  const { flag } = queue.feature;
  return !(typeof flag === 'function' ? flag(flags) : flags[flag]);
};

/** The template's four metrics, for one queue or summed over several. */
export type JobCounts = { active: number; pending: number; failed: number; completed: number; paused: number };

export const jobCounts = (statistics: QueueStatisticsDto): JobCounts => ({
  active: statistics.active,
  pending: statistics.waiting + statistics.paused + statistics.delayed,
  failed: statistics.failed,
  completed: statistics.completed,
  paused: statistics.paused,
});

export const sumJobCounts = (queues: readonly QueueResponseDto[]): JobCounts => {
  const total: JobCounts = { active: 0, pending: 0, failed: 0, completed: 0, paused: 0 };
  for (const queue of queues) {
    const counts = jobCounts(queue.statistics);
    total.active += counts.active;
    total.pending += counts.pending;
    total.failed += counts.failed;
    total.completed += counts.completed;
    total.paused += counts.paused;
  }
  return total;
};

export const jobQueueStatus = (queue: QueueResponseDto): JobQueueStatus => {
  if (queue.isPaused) {
    return 'paused';
  }
  const counts = jobCounts(queue.statistics);
  if (counts.active > 0) {
    return 'active';
  }
  if (counts.failed > 0) {
    return 'failed';
  }
  return counts.pending > 0 ? 'waiting' : 'idle';
};

/** Why a start command cannot be requested now, as the template's review reports it; empty when it can. */
export const startBlocked = (queue: QueueResponseDto, definition: JobQueueDefinition, flags: FeatureFlags) => {
  if (isFeatureOff(definition, flags)) {
    return 'feature-off' as const;
  }
  // As the template's review (`jobs-data.mjs`): active, waiting or paused work, or a paused queue,
  // blocks a start; delayed (scheduled) jobs keep their schedule and do not.
  const { active, waiting, paused } = queue.statistics;
  if (queue.isPaused || active > 0 || waiting > 0 || paused > 0) {
    return 'busy' as const;
  }
  return '' as const;
};

/** The job-state tabs of one queue and the server statuses each lists. */
export type JobTab = 'active' | 'waiting' | 'failed' | 'history';
export const JOB_TABS: readonly JobTab[] = ['active', 'waiting', 'failed', 'history'];
export const JOB_TAB_STATUSES: Record<JobTab, QueueJobStatus[]> = {
  active: [QueueJobStatus.Active],
  waiting: [QueueJobStatus.Waiting, QueueJobStatus.Paused, QueueJobStatus.Delayed],
  failed: [QueueJobStatus.Failed],
  history: [QueueJobStatus.Completed],
};
export const jobTabCount = (tab: JobTab, counts: JobCounts) =>
  ({ active: counts.active, waiting: counts.pending, failed: counts.failed, history: counts.completed })[tab];

export const isJobTab = (value: string | null | undefined): value is JobTab => JOB_TABS.includes(value as JobTab);

/** Whether a queue matches the Job manager's search, category and status filters. */
export const matchesQueueFilters = (
  queue: QueueResponseDto,
  definition: JobQueueDefinition,
  filters: { terms: string[]; title: string; description: string; category: string; status: string },
) =>
  (filters.category === 'all' || filters.category === definition.category) &&
  (filters.status === 'all' || filters.status === jobQueueStatus(queue)) &&
  filters.terms.every((term) =>
    `${filters.title} ${filters.description} ${definition.name}`.toLowerCase().includes(term),
  );

export const searchTerms = (query: string) => query.trim().toLowerCase().split(/\s+/).filter(Boolean);

/** A queue's concurrency limit, as the settings take it (the template's `validateConcurrency`). */
export const CONCURRENCY_MIN = 1;
export const CONCURRENCY_MAX = 1000;
export const isValidConcurrency = (value: unknown) =>
  (typeof value === 'number' || typeof value === 'string') &&
  /^\d+$/.test(String(value)) &&
  Number.isSafeInteger(Number(value)) &&
  Number(value) >= CONCURRENCY_MIN &&
  Number(value) <= CONCURRENCY_MAX;

/** How many failed records one "Remove failed records" clears (the server cleans at most 1,000 at a time). */
export const FAILED_CLEAN_LIMIT = 1000;

/**
 * The template's maintenance tasks (`MANUAL_JOBS` in `jobs-data.mjs`) on the server's manual jobs,
 * with the queue each runs in. Dangerous tasks need the review's acknowledgement; physical
 * deduplication opens its Storage page instead of running from here. "Collect library analytics"
 * is production's own task, kept from the old Create job list.
 */
export type ManualJobDefinition = {
  name: ManualJobName;
  queue: QueueName;
  dangerous?: boolean;
  /** Opens Storage → Physical deduplication, where a plan is prepared and reviewed. */
  opensDeduplication?: boolean;
};

export const MANUAL_JOBS: readonly ManualJobDefinition[] = Object.freeze([
  { name: ManualJobName.PersonCleanup, queue: QueueName.BackgroundTask },
  { name: ManualJobName.TagCleanup, queue: QueueName.BackgroundTask },
  { name: ManualJobName.UserCleanup, queue: QueueName.BackgroundTask, dangerous: true },
  { name: ManualJobName.MemoryCleanup, queue: QueueName.BackgroundTask },
  { name: ManualJobName.MemoryCreate, queue: QueueName.BackgroundTask },
  { name: ManualJobName.BackupDatabase, queue: QueueName.BackupDatabase },
  { name: ManualJobName.BestPhotosBackfill, queue: QueueName.BackgroundTask },
  { name: ManualJobName.AnalyticsCollect, queue: QueueName.BackgroundTask },
  {
    name: ManualJobName.PhysicalDeduplicationDryRun,
    queue: QueueName.StorageTemplateMigration,
    opensDeduplication: true,
  },
  {
    name: ManualJobName.PhysicalDeduplicationApply,
    queue: QueueName.StorageTemplateMigration,
    dangerous: true,
    opensDeduplication: true,
  },
  { name: ManualJobName.IntegrityMissingFiles, queue: QueueName.IntegrityCheck },
  { name: ManualJobName.IntegrityUntrackedFiles, queue: QueueName.IntegrityCheck },
  { name: ManualJobName.IntegrityChecksumMismatch, queue: QueueName.IntegrityCheck },
  { name: ManualJobName.IntegrityMissingFilesRefresh, queue: QueueName.IntegrityCheck },
  { name: ManualJobName.IntegrityUntrackedFilesRefresh, queue: QueueName.IntegrityCheck },
  { name: ManualJobName.IntegrityChecksumMismatchRefresh, queue: QueueName.IntegrityCheck },
  { name: ManualJobName.IntegrityMissingFilesDeleteAll, queue: QueueName.IntegrityCheck, dangerous: true },
  { name: ManualJobName.IntegrityUntrackedFilesDeleteAll, queue: QueueName.IntegrityCheck, dangerous: true },
  { name: ManualJobName.IntegrityChecksumMismatchDeleteAll, queue: QueueName.IntegrityCheck, dangerous: true },
]);

const snake = (value: string) =>
  value
    .replaceAll(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replaceAll(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .replaceAll('-', '_')
    .toLowerCase();

/** The i18n key stem of a manual task: `frameleaf_jobs_manual_<name>` and `…_description`. */
export const manualJobKey = (name: ManualJobName) => `frameleaf_jobs_manual_${snake(name)}`;

/** The i18n key of a job handler's customer-facing name (`frameleaf_jobs_name_<name>`). */
export const jobNameKey = (name: JobName) => `frameleaf_jobs_name_${snake(name)}`;
