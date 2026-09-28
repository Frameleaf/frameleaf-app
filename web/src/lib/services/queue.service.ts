import {
  emptyQueue,
  getQueue,
  QueueCommand,
  QueueName,
  runQueueCommandLegacy,
  updateQueue,
  type QueueResponseDto,
  retryFailedQueueJobs,
} from '@immich/sdk';
import { type IconLike } from '@immich/ui';
import {
  mdiContentDuplicate,
  mdiDatabaseOutline,
  mdiFaceRecognition,
  mdiFileCheckOutline,
  mdiFileJpgBox,
  mdiFileXmlBox,
  mdiFolderMove,
  mdiImageSearch,
  mdiImageBrokenVariant,
  mdiLibraryShelves,
  mdiOcr,
  mdiPaw,
  mdiPencil,
  mdiStateMachine,
  mdiShieldSearch,
  mdiTable,
  mdiTagFaces,
  mdiTextBoxSearchOutline,
  mdiTrayFull,
  mdiVideo,
} from '@mdi/js';
import type { MessageFormatter } from 'svelte-i18n';
import { eventManager } from '$lib/managers/event-manager.svelte';

type QueueItem = {
  icon: IconLike;
  title: string;
  subtitle?: string;
};

/*
 * Queue commands (FL-71). The Job manager (`JobsManager.svelte`) sends every one of them through
 * its review, including from the command palette; these only talk to the server and announce the
 * queue's new state.
 */

export const handlePauseQueue = async (queue: Pick<QueueResponseDto, 'name'>) => {
  const response = await updateQueue({ name: queue.name, queueUpdateDto: { isPaused: true } });
  eventManager.emit('QueueUpdate', response);
};

export const handleResumeQueue = async (queue: Pick<QueueResponseDto, 'name'>) => {
  const response = await updateQueue({ name: queue.name, queueUpdateDto: { isPaused: false } });
  eventManager.emit('QueueUpdate', response);
};

/** Removes the queue's waiting jobs; active, delayed and failed jobs remain. */
export const handleClearWaitingJobs = async (queue: Pick<QueueResponseDto, 'name'>) => {
  await emptyQueue({ name: queue.name, queueDeleteDto: { failed: false } });
  eventManager.emit('QueueUpdate', await getQueue({ name: queue.name }));
};

/**
 * Removes the queue's failed job records (at most 1,000 per request); waiting, delayed and active
 * jobs remain. Only the queue command clears failed jobs alone: `emptyQueue` with `failed` also
 * drains the waiting jobs.
 */
export const handleClearFailedJobs = async (queue: Pick<QueueResponseDto, 'name'>) => {
  await runQueueCommandLegacy({
    name: queue.name,
    queueCommandDto: { command: QueueCommand.ClearFailed, force: false },
  });
  eventManager.emit('QueueUpdate', await getQueue({ name: queue.name }));
};

/** FL-71 "Retry failed" (`JobsManager.jsx` 715-727): every failed job goes back in the queue. */
export const handleRetryFailedJobs = async (queue: Pick<QueueResponseDto, 'name'>) => {
  await retryFailedQueueJobs({ name: queue.name });
  eventManager.emit('QueueUpdate', await getQueue({ name: queue.name }));
};

export const asQueueItem = ($t: MessageFormatter, queue: { name: QueueName }): QueueItem => {
  // The Job manager's own titles and categories are in $lib/frameleaf/job-queues (FL-71).
  const items: Record<QueueName, QueueItem> = {
    [QueueName.ThumbnailGeneration]: {
      icon: mdiFileJpgBox,
      title: $t('admin.thumbnail_generation_job'),
      subtitle: $t('admin.thumbnail_generation_job_description'),
    },
    [QueueName.MetadataExtraction]: {
      icon: mdiTable,
      title: $t('admin.metadata_extraction_job'),
      subtitle: $t('admin.metadata_extraction_job_description'),
    },
    [QueueName.Library]: {
      icon: mdiLibraryShelves,
      title: $t('external_libraries'),
      subtitle: $t('admin.library_tasks_description'),
    },
    [QueueName.Sidecar]: {
      title: $t('admin.sidecar_job'),
      icon: mdiFileXmlBox,
      subtitle: $t('admin.sidecar_job_description'),
    },
    [QueueName.SmartSearch]: {
      icon: mdiImageSearch,
      title: $t('admin.machine_learning_smart_search'),
      subtitle: $t('admin.smart_search_job_description'),
    },
    [QueueName.DuplicateDetection]: {
      icon: mdiContentDuplicate,
      title: $t('admin.machine_learning_duplicate_detection'),
      subtitle: $t('admin.duplicate_detection_job_description'),
    },
    [QueueName.VideoDuplicateDetection]: {
      icon: mdiVideo,
      title: $t('admin.enhanced_video_duplicate_detection'),
      subtitle: $t('admin.enhanced_video_duplicate_detection_job_description'),
    },
    [QueueName.MediaHealth]: {
      icon: mdiImageBrokenVariant,
      title: $t('admin.media_health_job'),
      subtitle: $t('admin.media_health_job_description'),
    },
    [QueueName.FaceDetection]: {
      icon: mdiFaceRecognition,
      title: $t('admin.face_detection'),
      subtitle: $t('admin.face_detection_description'),
    },
    [QueueName.FacialRecognition]: {
      icon: mdiTagFaces,
      title: $t('admin.machine_learning_facial_recognition'),
      subtitle: $t('admin.facial_recognition_job_description'),
    },
    [QueueName.Ocr]: {
      icon: mdiOcr,
      title: $t('admin.machine_learning_ocr'),
      subtitle: $t('admin.ocr_job_description'),
    },
    [QueueName.ImageEnrichment]: {
      icon: mdiImageSearch,
      title: $t('admin.machine_learning_image_enrichment'),
      subtitle: $t('admin.image_enrichment_job_description'),
    },
    [QueueName.ImageDescription]: {
      icon: mdiTextBoxSearchOutline,
      title: $t('admin.machine_learning_image_description'),
      subtitle: $t('admin.image_description_job_description'),
    },
    [QueueName.NsfwDetection]: {
      icon: mdiShieldSearch,
      title: $t('admin.machine_learning_nsfw_detection'),
      subtitle: $t('admin.nsfw_detection_job_description'),
    },
    [QueueName.VideoConversion]: {
      icon: mdiVideo,
      title: $t('admin.video_conversion_job'),
      subtitle: $t('admin.video_conversion_job_description'),
    },
    [QueueName.StorageTemplateMigration]: {
      icon: mdiFolderMove,
      title: $t('admin.storage_template_migration'),
    },
    [QueueName.Migration]: {
      icon: mdiFolderMove,
      title: $t('admin.migration_job'),
      subtitle: $t('admin.migration_job_description'),
    },
    [QueueName.BackgroundTask]: {
      icon: mdiTrayFull,
      title: $t('admin.background_task_job'),
    },
    [QueueName.Search]: {
      icon: '',
      title: $t('search'),
    },
    [QueueName.Notifications]: {
      icon: '',
      title: $t('notifications'),
    },
    [QueueName.BackupDatabase]: {
      icon: mdiDatabaseOutline,
      title: $t('admin.backup_database'),
    },
    [QueueName.Workflow]: {
      icon: mdiStateMachine,
      title: $t('workflows'),
    },
    [QueueName.IntegrityCheck]: {
      icon: mdiFileCheckOutline,
      title: $t('integrity_checks'),
    },
    [QueueName.Editor]: {
      icon: mdiPencil,
      title: $t('editor'),
    },
    [QueueName.PetRecognition]: {
      icon: mdiPaw,
      title: $t('frameleaf_jobs_queue_pet_recognition'),
      subtitle: $t('frameleaf_jobs_queue_pet_recognition_description'),
    },
  };

  return items[queue.name];
};
