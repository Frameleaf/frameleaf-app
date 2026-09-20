// Source inventory: server/src/enum.ts, services/queue.service.ts, dtos/config.dto.ts.
export const JOBS_STORAGE_KEY = "frameleaf:jobs-manager:v1";
export const JOBS_LIMITS = Object.freeze({
  jobs: 1000,
  history: 120,
  bytes: 2_000_000,
});
export const JOB_OWNERS = Object.freeze([
  { id: "all", name: "All accounts" },
  { id: "taylor", name: "Taylor" },
  { id: "jamie", name: "Jamie" },
  { id: "emma", name: "Emma" },
  { id: "system", name: "Server" },
]);
const rows = [
  [
    "thumbnailGeneration",
    "Thumbnails",
    "Media",
    3,
    "mdiImageMultipleOutline",
    "Generate image previews and thumbnails.",
    "AssetGenerateThumbnailsQueueAll",
  ],
  [
    "metadataExtraction",
    "Metadata",
    "Media",
    5,
    "mdiCameraOutline",
    "Read capture dates, camera details, location, and embedded metadata.",
    "AssetExtractMetadataQueueAll",
  ],
  [
    "videoConversion",
    "Playback videos",
    "Media",
    1,
    "mdiMovieOpenOutline",
    "Create compatible playback copies from original videos.",
    "AssetEncodeVideoQueueAll",
  ],
  [
    "faceDetection",
    "Face detection",
    "Intelligence",
    2,
    "mdiAccountOutline",
    "Locate faces before matching people.",
    "AssetDetectFacesQueueAll",
  ],
  [
    "facialRecognition",
    "Face recognition",
    "Intelligence",
    1,
    "mdiAccountMultipleOutline",
    "Match detected faces to people.",
    "FacialRecognitionQueueAll",
  ],
  [
    "smartSearch",
    "Visual search",
    "Intelligence",
    2,
    "mdiImageSearchOutline",
    "Index visual content for semantic search.",
    "SmartSearchQueueAll",
  ],
  [
    "duplicateDetection",
    "Photo duplicates",
    "Intelligence",
    1,
    "mdiCompare",
    "Find visually similar photos.",
    "AssetDetectDuplicatesQueueAll",
  ],
  [
    "videoDuplicateDetection",
    "Video duplicates",
    "Intelligence",
    1,
    "mdiMovieOpenOutline",
    "Compare sampled video frames for duplicate detection.",
    "AssetGenerateVideoDuplicateFramesQueueAll",
  ],
  [
    "backgroundTask",
    "Background tasks",
    "System",
    5,
    "mdiServerOutline",
    "Essential cleanup, coordination, and follow-up tasks.",
    null,
  ],
  [
    "storageTemplateMigration",
    "Storage organization",
    "Maintenance",
    1,
    "mdiFolderOutline",
    "Move files according to the configured storage template.",
    "StorageTemplateMigration",
  ],
  [
    "migration",
    "File migration",
    "Maintenance",
    5,
    "mdiFolderMultipleOutline",
    "Migrate generated files into their current storage layout.",
    "FileMigrationQueueAll",
  ],
  [
    "search",
    "Search maintenance",
    "System",
    5,
    "mdiMagnify",
    "Maintain search-related background records.",
    null,
  ],
  [
    "sidecar",
    "Metadata sidecars",
    "Media",
    5,
    "mdiTextBoxSearchOutline",
    "Discover sidecars or synchronize their metadata.",
    "SidecarQueueAll",
  ],
  [
    "library",
    "External libraries",
    "Media",
    5,
    "mdiFolderSearchOutline",
    "Rescan configured external photo libraries.",
    "LibraryScanQueueAll",
  ],
  [
    "notifications",
    "Notifications",
    "System",
    5,
    "mdiBellOutline",
    "Deliver library notifications and messages.",
    null,
  ],
  [
    "backupDatabase",
    "Database backup",
    "Maintenance",
    1,
    "mdiBackupRestore",
    "Create a backup of library records and configuration.",
    "DatabaseBackup",
  ],
  [
    "ocr",
    "Text recognition",
    "Intelligence",
    1,
    "mdiTextBoxSearchOutline",
    "Extract searchable text from images.",
    "OcrQueueAll",
  ],
  [
    "imageEnrichment",
    "Enrichment coordinator",
    "Intelligence",
    2,
    "mdiImageSearchOutline",
    "Schedule enabled descriptions and Locked-content analysis.",
    "EnrichmentCoordinator",
  ],
  [
    "imageDescription",
    "Descriptions & tags",
    "Intelligence",
    2,
    "mdiTextBoxSearchOutline",
    "Describe visual content and generate useful tags.",
    "ImageDescriptionQueueAll",
  ],
  [
    "nsfwDetection",
    "Locked-content detection",
    "Intelligence",
    2,
    "mdiShieldCheckOutline",
    "Identify images to keep Locked.",
    "NsfwDetectionQueueAll",
  ],
  [
    "mediaHealth",
    "Media health",
    "Maintenance",
    2,
    "mdiShieldCheckOutline",
    "Inspect missing or damaged library files.",
    "MediaHealthScanMissing",
  ],
  [
    "workflow",
    "Workflows",
    "System",
    5,
    "mdiTuneVariant",
    "Apply configured actions after library events.",
    null,
  ],
  [
    "integrityCheck",
    "Integrity checks",
    "Maintenance",
    1,
    "mdiShieldCheckOutline",
    "Verify file existence, tracking, and checksums.",
    null,
  ],
  [
    "editor",
    "Media edits",
    "Media",
    2,
    "mdiPencilOutline",
    "Render saved photo and video revisions.",
    null,
  ],
];
const fixed = new Set([
  "facialRecognition",
  "duplicateDetection",
  "storageTemplateMigration",
  "backupDatabase",
]);
const singleRun = new Set([
  "storageTemplateMigration",
  "migration",
  "library",
  "backupDatabase",
]);
export const QUEUE_CATALOG = Object.freeze(
  rows.map(([id, title, category, concurrency, icon, description, startJob]) =>
    Object.freeze({
      id,
      title,
      category,
      concurrency,
      icon,
      description,
      startJob,
      fixed: fixed.has(id),
      canPause: id !== "backgroundTask",
      setting: fixed.has(id)
        ? null
        : id === "thumbnailGeneration"
          ? "thumbnailJobs"
          : id === "videoConversion"
            ? "videoJobs"
            : `queueConcurrency_${id}`,
      canForce: !!startJob && !singleRun.has(id),
      canRefresh: id === "faceDetection",
      runLabel:
        id === "sidecar"
          ? "Discover sidecars"
          : id === "library"
            ? "Rescan libraries"
            : singleRun.has(id)
              ? "Start task"
              : id === "mediaHealth"
                ? "Scan missing"
                : "Run missing",
      forceLabel: ["faceDetection", "facialRecognition"].includes(id)
        ? "Reset & reprocess"
        : id === "sidecar"
          ? "Synchronize all"
          : "Reprocess all",
    }),
  ),
);
export const queueById = (id) => QUEUE_CATALOG.find((queue) => queue.id === id);
export const normalizeJobScope = (value) =>
  typeof value === "string" && value.length > 0 && value.length <= 100
    ? value
    : "all";
const manualRows = [
  [
    "person-cleanup",
    "Clean up unused people",
    "backgroundTask",
    "Remove unused person records.",
  ],
  [
    "tag-cleanup",
    "Clean up unused tags",
    "backgroundTask",
    "Remove unused tag records.",
  ],
  [
    "user-cleanup",
    "Clean up deleted accounts",
    "backgroundTask",
    "Process accounts already scheduled for permanent deletion.",
    true,
  ],
  [
    "memory-cleanup",
    "Clean up old memories",
    "backgroundTask",
    "Remove expired memory records.",
  ],
  [
    "memory-create",
    "Generate memories",
    "backgroundTask",
    "Generate memories for eligible accounts.",
  ],
  [
    "backup-database",
    "Back up the database",
    "backupDatabase",
    "Back up library records; original media needs its own backup.",
  ],
  [
    "best-photos-backfill",
    "Recalculate Best Photos",
    "backgroundTask",
    "Score the library again, including previously scored assets.",
  ],
  [
    "physical-deduplication-dry-run",
    "Review physical deduplication",
    "storageTemplateMigration",
    "Calculate potential shared-file changes without applying them.",
  ],
  [
    "physical-deduplication-apply",
    "Apply physical deduplication",
    "storageTemplateMigration",
    "Apply a previously reviewed physical-deduplication plan.",
    true,
  ],
  [
    "integrity-missing-files",
    "Find missing files",
    "integrityCheck",
    "Scan for database references whose files are missing.",
  ],
  [
    "integrity-untracked-files",
    "Find untracked files",
    "integrityCheck",
    "Scan for files not tracked by library records.",
  ],
  [
    "integrity-checksum-mismatch",
    "Verify checksums",
    "integrityCheck",
    "Compare file contents with recorded checksums.",
  ],
  [
    "integrity-missing-files-refresh",
    "Recheck missing-file findings",
    "integrityCheck",
    "Recheck existing missing-file reports.",
  ],
  [
    "integrity-untracked-files-refresh",
    "Recheck untracked-file findings",
    "integrityCheck",
    "Recheck existing untracked-file reports.",
  ],
  [
    "integrity-checksum-mismatch-refresh",
    "Recheck checksum findings",
    "integrityCheck",
    "Recheck existing checksum reports.",
  ],
  [
    "integrity-missing-files-delete-all",
    "Clear missing-file reports",
    "integrityCheck",
    "Delete reports only. This does not delete original files.",
    true,
  ],
  [
    "integrity-untracked-files-delete-all",
    "Clear untracked-file reports",
    "integrityCheck",
    "Delete reports only. This does not delete original files.",
    true,
  ],
  [
    "integrity-checksum-mismatch-delete-all",
    "Clear checksum reports",
    "integrityCheck",
    "Delete reports only. This does not delete original files.",
    true,
  ],
];
export const MANUAL_JOBS = Object.freeze(
  manualRows.map(([id, title, queueId, description, dangerous = false]) =>
    Object.freeze({ id, title, queueId, description, dangerous }),
  ),
);
const statuses = new Set([
  "active",
  "waiting",
  "paused",
  "delayed",
  "failed",
  "completed",
]);
const ownerIds = new Set(JOB_OWNERS.slice(1).map((owner) => owner.id));
const targets = new Set(["local", "runpod", "server"]);
const plain = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const text = (value, max = 250) =>
  typeof value === "string" && value.length <= max;
const date = (value) =>
  text(value, 30) &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const ids = new Set(QUEUE_CATALOG.map((queue) => queue.id));
const filenames = [
  "Moraine Lake.jpg",
  "Birthday candles.heic",
  "Garden afternoon.jpg",
  "Summer walk.mov",
  "Family dinner.jpg",
  "Coast weekend.mp4",
];
const videoFilenames = [
  "Summer walk.mov",
  "Coast weekend.mp4",
  "Campfire memories.mov",
];
const imageFilenames = filenames.filter((name) => /\.(jpg|heic)$/i.test(name));
export function jobTitle(job) {
  if (job.name === "SmartAlbumReevaluateAll") return "Re-evaluate smart albums";
  return (
    MANUAL_JOBS.find((item) => item.title === job.name)?.title ||
    queueById(job.queueId)?.title ||
    "Background task"
  );
}
export function createJobsState() {
  const jobs = [];
  const activeQueues = new Set([
    "thumbnailGeneration",
    "metadataExtraction",
    "videoConversion",
    "imageDescription",
    "smartSearch",
  ]);
  const failedQueues = new Set([
    "videoConversion",
    "imageDescription",
    "ocr",
    "sidecar",
  ]);
  for (const [index, queue] of QUEUE_CATALOG.entries()) {
    const work = activeQueues.has(queue.id)
      ? ["active", "waiting", "waiting", "delayed", "completed"]
      : ["completed"];
    if (failedQueues.has(queue.id)) work.push("failed", "failed");
    if (queue.id === "mediaHealth") work.push("paused", "paused");
    work.forEach((status, n) => {
      const ownerId =
        queue.category === "System" ||
        ["backupDatabase", "storageTemplateMigration", "migration"].includes(
          queue.id,
        )
          ? "system"
          : ["taylor", "jamie", "emma"][(index + n) % 3];
      const error =
        status !== "failed"
          ? ""
          : queue.id === "videoConversion"
            ? "Hardware encoder could not initialize. Check the selected acceleration device and available memory."
            : queue.id === "sidecar"
              ? "Source folder is unavailable. Reconnect the volume before retrying."
              : "The ML endpoint did not respond before the request timeout. Check worker status and model availability.";
      jobs.push({
        id: `sample-${queue.id}-${n}`,
        queueId: queue.id,
        ownerId,
        name: queue.startJob || queue.title,
        asset:
          ownerId === "system"
            ? "Server task"
            : ["videoConversion", "videoDuplicateDetection"].includes(queue.id)
              ? videoFilenames[(index + n) % videoFilenames.length]
              : imageFilenames[(index + n) % imageFilenames.length],
        status,
        destination:
          queue.category === "Intelligence"
            ? n === 5
              ? "runpod"
              : "local"
            : "server",
        createdAt: new Date(
          Date.UTC(2026, 8, 19, 13, 40 - index, n * 7),
        ).toISOString(),
        updatedAt: "2026-09-19T14:00:00.000Z",
        attempt: status === "failed" ? 2 : 1,
        progress:
          status === "completed"
            ? 100
            : status === "active"
              ? 35 + (index % 4) * 12
              : 0,
        error,
        details: JSON.stringify(
          {
            source: "library",
            assetId:
              ownerId === "system"
                ? undefined
                : `${ownerId}-asset-${index}-${n}`,
          },
          null,
          2,
        ),
      });
    });
  }
  return {
    version: 1,
    revision: 0,
    descriptionDeferred: false,
    queues: Object.fromEntries(
      QUEUE_CATALOG.map((queue) => [
        queue.id,
        { paused: queue.id === "mediaHealth" },
      ]),
    ),
    jobs,
    history: [],
    view: {
      queueId: "all",
      tab: "active",
      owner: "all",
      query: "",
      category: "all",
      status: "all",
    },
  };
}
function parseJob(value) {
  if (
    !plain(value) ||
    !text(value.id, 128) ||
    !value.id ||
    !ids.has(value.queueId) ||
    !ownerIds.has(value.ownerId) ||
    !statuses.has(value.status) ||
    !targets.has(value.destination) ||
    !date(value.createdAt) ||
    !date(value.updatedAt) ||
    !text(value.name) ||
    !text(value.asset) ||
    !text(value.error, 4000) ||
    !text(value.details, 6000) ||
    !integer(value.attempt) ||
    value.attempt > 1000 ||
    !integer(value.progress) ||
    value.progress > 100
  )
    return null;
  return Object.fromEntries(
    [
      "id",
      "queueId",
      "ownerId",
      "name",
      "asset",
      "status",
      "destination",
      "createdAt",
      "updatedAt",
      "attempt",
      "progress",
      "error",
      "details",
    ].map((key) => [key, value[key]]),
  );
}
function unique(values, limit, parse) {
  const seen = new Set();
  const result = [];
  for (const value of values.slice(0, limit)) {
    const item = parse(value);
    if (item && !seen.has(item.id)) {
      seen.add(item.id);
      result.push(item);
    }
  }
  return result;
}
export function parseJobsState(raw) {
  const fallback = createJobsState();
  let source = raw;
  if (typeof raw === "string") {
    if (raw.length > JOBS_LIMITS.bytes) return fallback;
    try {
      source = JSON.parse(raw);
    } catch {
      return fallback;
    }
  }
  if (
    !plain(source) ||
    source.version !== 1 ||
    !integer(source.revision) ||
    !Array.isArray(source.jobs) ||
    !Array.isArray(source.history)
  )
    return fallback;
  const queues = Object.fromEntries(
    QUEUE_CATALOG.map((queue) => [
      queue.id,
      { paused: queue.canPause && source.queues?.[queue.id]?.paused === true },
    ]),
  );
  const jobs = unique(source.jobs, JOBS_LIMITS.jobs, parseJob).map((job) => ({
    ...job,
    asset:
      fallback.jobs.find(
        (fixture) => fixture.id === job.id && fixture.queueId === job.queueId,
      )?.asset ?? job.asset,
    status:
      job.status === "paused" && !queues[job.queueId].paused
        ? "waiting"
        : job.status === "waiting" && queues[job.queueId].paused
          ? "paused"
          : job.status,
  }));
  const history = unique(source.history, JOBS_LIMITS.history, (value) =>
    plain(value) &&
    text(value.id, 128) &&
    value.id &&
    text(value.title) &&
    text(value.detail, 1000) &&
    date(value.at) &&
    (value.queueId === "all" || ids.has(value.queueId))
      ? {
          id: value.id,
          title: value.title,
          detail: value.detail,
          at: value.at,
          queueId: value.queueId,
        }
      : null,
  );
  const rawView = plain(source.view) ? source.view : {};
  const view = {
    queueId:
      rawView.queueId === "all" || ids.has(rawView.queueId)
        ? rawView.queueId
        : "all",
    tab: ["active", "waiting", "failed", "history"].includes(rawView.tab)
      ? rawView.tab
      : "active",
    owner: normalizeJobScope(rawView.owner),
    query: text(rawView.query, 200) ? rawView.query : "",
    category: [
      "all",
      ...new Set(QUEUE_CATALOG.map((queue) => queue.category)),
    ].includes(rawView.category)
      ? rawView.category
      : "all",
    status: ["all", "active", "paused", "failed", "idle"].includes(
      rawView.status,
    )
      ? rawView.status
      : "all",
  };
  return {
    version: 1,
    revision: source.revision,
    descriptionDeferred: source.descriptionDeferred === true,
    queues,
    jobs,
    history,
    view,
  };
}
export function serializeJobsState(state) {
  const result = JSON.stringify(state);
  if (result.length > JOBS_LIMITS.bytes)
    throw new Error(
      "Saved activity is too large for this device. Clear older action history first.",
    );
  return result;
}
export function queueCounts(state, queueId = "all", owner = "all") {
  const count = {
    active: 0,
    waiting: 0,
    paused: 0,
    delayed: 0,
    failed: 0,
    completed: 0,
  };
  for (const job of state.jobs)
    if (
      (queueId === "all" || job.queueId === queueId) &&
      (owner === "all" || job.ownerId === owner)
    )
      count[job.status]++;
  return { ...count, pending: count.waiting + count.paused + count.delayed };
}
export function queueStatus(state, queueId) {
  if (state.queues[queueId]?.paused) return "paused";
  const count = queueCounts(state, queueId);
  return count.active
    ? "active"
    : count.failed
      ? "failed"
      : count.waiting
        ? "waiting"
        : "idle";
}
export function selectJobs(
  state,
  { queueId = "all", owner = "all", tab = "active", query = "" } = {},
) {
  const included =
    {
      active: ["active"],
      waiting: ["waiting", "paused", "delayed"],
      failed: ["failed"],
      history: ["completed"],
    }[tab] || [];
  const terms = String(query).trim().toLowerCase().split(/\s+/).filter(Boolean);
  return state.jobs
    .filter(
      (job) =>
        (queueId === "all" || job.queueId === queueId) &&
        (owner === "all" || job.ownerId === owner) &&
        included.includes(job.status) &&
        terms.every((term) =>
          `${job.asset} ${job.name} ${job.id} ${job.error}`
            .toLowerCase()
            .includes(term),
        ),
    )
    .sort(
      (a, b) =>
        b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
    );
}
export function featureDisabled(queue, settings = {}) {
  if (queue.id === "imageEnrichment")
    return (
      settings.descriptions === false && settings.sensitiveDetect === false
    );
  if (
    queue.id === "duplicateDetection" ||
    queue.id === "videoDuplicateDetection"
  )
    return (
      settings.smartSearch === false ||
      settings.DuplicateDetection === false ||
      (queue.id === "videoDuplicateDetection" &&
        settings.VideoDuplicate === false)
    );
  const key = {
    smartSearch: "smartSearch",
    faceDetection: "faceRecognition",
    facialRecognition: "faceRecognition",
    ocr: "ocr",
    imageDescription: "descriptions",
    nsfwDetection: "sensitiveDetect",
  }[queue.id];
  return !!key && settings[key] === false;
}
export function concurrencyValue(queue, settings = {}) {
  return queue.fixed ? 1 : (settings[queue.setting] ?? queue.concurrency);
}
export function validateConcurrency(value) {
  return (typeof value === "number" || typeof value === "string") &&
    /^\d+$/.test(String(value)) &&
    Number.isSafeInteger(Number(value)) &&
    Number(value) >= 1 &&
    Number(value) <= 1000
    ? ""
    : "Enter a whole number from 1 to 1,000.";
}
const titleFor = {
  pause: "Pause queue",
  resume: "Resume queue",
  "clear-waiting": "Clear waiting jobs",
  "remove-failed": "Remove failed records",
  "retry-failed": "Retry failed jobs",
  missing: "Run missing",
  force: "Reprocess all",
  refresh: "Refresh face detection",
  "resume-all": "Resume paused queues",
};
export function reviewJobsAction(state, action, settings = {}) {
  const queue = queueById(action.queueId);
  const count = queue ? queueCounts(state, queue.id) : null;
  const manual = MANUAL_JOBS.find((job) => job.id === action.manualId);
  let error = "";
  let detail = "";
  let affected = 0;
  let title = titleFor[action.type] || "Create job";
  let dangerous = false;
  if (
    action.type === "description-defer" ||
    action.type === "description-requeue"
  ) {
    title =
      action.type === "description-defer"
        ? "Remind me to regenerate descriptions"
        : "Regenerate descriptions";
    detail =
      action.type === "description-defer"
        ? "Keep a reminder to rerun descriptions after reviewing the saved model and prompt."
        : "Queue a full description pass for eligible assets using the saved settings. Existing active or waiting description work prevents a duplicate request.";
    affected = action.type === "description-defer" ? 0 : 1;
    if (settings.descriptions === false)
      error = "Enable descriptions before scheduling this task.";
    else if (
      action.type === "description-requeue" &&
      state.jobs.some(
        (job) =>
          job.queueId === "imageDescription" &&
          ["active", "waiting", "paused"].includes(job.status),
      )
    )
      error =
        "Description work is already active or waiting. Keep a reminder to revisit this change later.";
  } else if (action.type === "smart-album") {
    title = "Re-evaluate smart albums";
    affected = 1;
    detail = action.kind
      ? `Recheck described images against the ${action.kind} category.`
      : "Recheck described images against all built-in smart-album categories.";
    if (action.kind !== undefined && !SMART_ALBUM_KINDS.includes(action.kind))
      error = "Choose an available smart-album category.";
    else if (
      state.jobs.some(
        (job) =>
          job.name === "SmartAlbumReevaluateAll" &&
          ["active", "waiting", "paused"].includes(job.status) &&
          job.details ===
            JSON.stringify(action.kind ? { kind: action.kind } : {}, null, 2),
      )
    )
      error = "A re-evaluation with this category scope is already queued.";
  } else if (action.type === "manual") {
    if (!manual) error = "Choose an available task.";
    else {
      title = manual.title;
      detail = manual.description;
      affected = 1;
      dangerous = manual.dangerous;
      if (manual.id === "physical-deduplication-apply")
        error =
          "Open Storage → File reuse to review a completed deduplication plan before applying it.";
    }
  } else if (action.type === "resume-all") {
    affected = QUEUE_CATALOG.filter(
      (item) => state.queues[item.id].paused && item.canPause,
    ).length;
    detail =
      "Resume paused queues for every account. Existing active work continues.";
    if (!affected) error = "No queues are paused.";
  } else if (!queue) error = "Choose an available queue.";
  else if (action.type === "pause") {
    if (!queue.canPause) error = "Essential background tasks cannot be paused.";
    else if (state.queues[queue.id].paused)
      error = "This queue is already paused.";
    affected = count.waiting;
    detail =
      "Stop taking new work. Active jobs continue; delayed jobs keep their schedule.";
  } else if (action.type === "resume") {
    if (!state.queues[queue.id].paused)
      error = "This queue is already running.";
    affected = count.paused;
    detail =
      "Allow waiting work to start, using the current concurrency limit.";
  } else if (action.type === "clear-waiting") {
    affected = count.waiting + count.paused;
    dangerous = true;
    detail =
      "Remove waiting jobs from this queue. Active, delayed, and failed jobs remain. Original files are not deleted.";
    if (!affected) error = "There are no waiting jobs to clear.";
  } else if (action.type === "remove-failed") {
    affected = count.failed;
    dangerous = true;
    detail =
      "Remove failed job records and their error details. Waiting, delayed, and active jobs remain. Original files are not deleted.";
    if (!affected) error = "There are no failed records to remove.";
  } else if (action.type === "retry-failed") {
    affected = count.failed;
    detail =
      "Put failed jobs back in the queue with their saved inputs and destination. Resolve the reported problem first.";
    if (!affected) error = "There are no failed jobs to retry.";
    else if (
      state.jobs.some(
        (job) =>
          job.queueId === queue.id &&
          job.status === "failed" &&
          job.attempt >= 1000,
      )
    )
      error =
        "An item reached the retry limit. Review its error before creating new work.";
  } else if (["missing", "force", "refresh"].includes(action.type)) {
    if (
      !queue.startJob ||
      (action.type === "force" && !queue.canForce) ||
      (action.type === "refresh" && !queue.canRefresh)
    )
      error = "This action is not available for this queue.";
    else if (featureDisabled(queue, settings))
      error = "Enable this feature before starting a library scan.";
    else if (
      count.active ||
      count.waiting ||
      count.paused ||
      state.queues[queue.id].paused
    )
      error =
        "Wait for this queue to finish, or clear its waiting work and resume it first.";
    affected = 1;
    title =
      action.type === "missing"
        ? queue.runLabel
        : action.type === "force"
          ? queue.forceLabel
          : "Refresh face detection";
    dangerous = action.type === "force";
    detail =
      action.type === "force" &&
      ["faceDetection", "facialRecognition"].includes(queue.id)
        ? "Reset generated face results and reprocess the library. Review the effect on face assignments before continuing."
        : action.type === "force"
          ? "Queue a library-wide scan including previously processed assets. This can require substantial processing time."
          : action.type === "refresh"
            ? "Refresh face results without requesting a complete reset."
            : "Queue one coordinator task to find eligible work across the library.";
  } else error = "This action is not available.";
  return {
    title,
    detail,
    affected,
    dangerous,
    error,
    queueId: action.type.startsWith("description-")
      ? "imageDescription"
      : action.type === "smart-album"
        ? "backgroundTask"
        : manual?.queueId || queue?.id || "all",
    revision: state.revision,
    scope: "All accounts",
  };
}
export function applyJobsAction(
  state,
  action,
  { id, at, expectedRevision, confirmed = false } = {},
  settings = {},
) {
  const review = reviewJobsAction(state, action, settings);
  if (review.error) throw new Error(review.error);
  if (expectedRevision !== state.revision)
    throw new Error(
      "The queue changed. Review the latest counts before continuing.",
    );
  if (review.dangerous && !confirmed)
    throw new Error("Review and confirm this action first.");
  if (
    !text(id, 120) ||
    !id ||
    !date(at) ||
    state.revision >= Number.MAX_SAFE_INTEGER
  )
    throw new Error("The action could not be recorded.");
  if (state.history.some((item) => item.id === id)) return state;
  const next = {
    ...state,
    revision: state.revision + 1,
    queues: structuredClone(state.queues),
    jobs: state.jobs.map((job) => ({ ...job })),
  };
  const same = (job) => job.queueId === action.queueId;
  if (action.type === "description-defer") next.descriptionDeferred = true;
  else if (action.type === "pause" || action.type === "resume") {
    const paused = action.type === "pause";
    next.queues[action.queueId].paused = paused;
    next.jobs = next.jobs.map((job) =>
      same(job) && job.status === (paused ? "waiting" : "paused")
        ? { ...job, status: paused ? "paused" : "waiting", updatedAt: at }
        : job,
    );
  } else if (action.type === "resume-all") {
    for (const queue of QUEUE_CATALOG) next.queues[queue.id].paused = false;
    next.jobs = next.jobs.map((job) =>
      job.status === "paused"
        ? { ...job, status: "waiting", updatedAt: at }
        : job,
    );
  } else if (action.type === "clear-waiting")
    next.jobs = next.jobs.filter(
      (job) => !(same(job) && ["waiting", "paused"].includes(job.status)),
    );
  else if (action.type === "remove-failed")
    next.jobs = next.jobs.filter(
      (job) => !(same(job) && job.status === "failed"),
    );
  else if (action.type === "retry-failed")
    next.jobs = next.jobs.map((job) =>
      same(job) && job.status === "failed"
        ? {
            ...job,
            status: next.queues[job.queueId].paused ? "paused" : "waiting",
            attempt: job.attempt + 1,
            progress: 0,
            updatedAt: at,
          }
        : job,
    );
  else {
    if (next.jobs.length >= JOBS_LIMITS.jobs)
      throw new Error(
        "The activity list is full. Remove older failed records before creating more work.",
      );
    const queue = queueById(review.queueId);
    const manual = MANUAL_JOBS.find((item) => item.id === action.manualId);
    if (action.type === "description-requeue") next.descriptionDeferred = false;
    next.jobs.push({
      id: `job-${id}`,
      queueId: queue.id,
      ownerId: "system",
      name:
        action.type === "smart-album"
          ? "SmartAlbumReevaluateAll"
          : manual?.title || queue.startJob,
      asset: "Library-wide task",
      status: next.queues[queue.id].paused ? "paused" : "waiting",
      destination: "server",
      createdAt: at,
      updatedAt: at,
      attempt: 1,
      progress: 0,
      error: "",
      details: JSON.stringify(
        action.type === "manual"
          ? { manualJob: action.manualId }
          : action.type === "smart-album"
            ? action.kind
              ? { kind: action.kind }
              : {}
            : action.type === "description-requeue"
              ? {}
              : {
                  mode: action.type,
                  force:
                    action.type === "refresh"
                      ? undefined
                      : action.type === "force",
                },
        null,
        2,
      ),
    });
  }
  next.history = [
    {
      id,
      title: review.title,
      detail: `${queueById(review.queueId)?.title || "Server"} · ${review.affected} ${review.affected === 1 ? "item" : "items"} · all accounts`,
      at,
      queueId: review.queueId,
    },
    ...state.history,
  ].slice(0, JOBS_LIMITS.history);
  return next;
}

export const RUNPOD_STORAGE_KEY = "frameleaf:runpod-manager:v1";
export const SMART_ALBUM_KINDS = Object.freeze([
  "documents",
  "food",
  "nature",
  "pets",
  "screenshots",
  "travel",
]);
export const RUNPOD_GPUS = Object.freeze([
  { id: "NVIDIA RTX A5000", name: "RTX A5000", memory: 24, rate: 0.29 },
  { id: "NVIDIA RTX A6000", name: "RTX A6000", memory: 48, rate: 0.49 },
  { id: "NVIDIA A100 80GB PCIe", name: "A100 80 GB", memory: 80, rate: 1.19 },
]);
export function descriptionHardwarePreset(acceleration, detected) {
  if (!["auto", "openvino", "cuda"].includes(acceleration))
    throw new Error("Choose Auto, OpenVINO, or CUDA.");
  const changes = { advancedDescriptionAcceleration: acceleration };
  const resolved = acceleration === "auto" ? detected : acceleration;
  if (["openvino", "cuda"].includes(resolved))
    Object.assign(changes, {
      descriptionModel: "Qwen/Qwen2.5-VL-3B-Instruct",
      advancedDescriptionFallback: "microsoft/Florence-2-base-ft",
      advancedDescriptionDevice: "AUTO",
      advancedSensitiveModel: "onnx-community/nsfw_image_detection-ONNX",
      advancedSensitiveDevice: "AUTO",
    });
  return changes;
}
export function createRunPodState() {
  return {
    version: 1,
    revision: 0,
    status: "idle",
    mode: "pod",
    podId: null,
    endpointId: null,
    workerReady: false,
    cloudAcknowledged: false,
    gpuId: RUNPOD_GPUS[0].id,
    gpuCount: 1,
    runtimeHours: 4,
    history: [],
    lastRequest: null,
  };
}
const providerStatuses = new Set([
  "idle",
  "provisioning",
  "starting",
  "running",
  "stopping",
  "stopped",
  "error",
  "serverless-provisioning",
  "serverless-ready",
]);
export function parseRunPodState(raw) {
  const fallback = createRunPodState();
  let source = raw;
  if (typeof raw === "string") {
    if (raw.length > 200_000) return fallback;
    try {
      source = JSON.parse(raw);
    } catch {
      return fallback;
    }
  }
  if (
    !plain(source) ||
    source.version !== 1 ||
    !integer(source.revision) ||
    !providerStatuses.has(source.status) ||
    !["pod", "serverless"].includes(source.mode) ||
    !Array.isArray(source.history)
  )
    return fallback;
  const podId =
    source.podId === null
      ? null
      : text(source.podId, 128)
        ? source.podId
        : null;
  const endpointId =
    source.endpointId === null
      ? null
      : text(source.endpointId, 128)
        ? source.endpointId
        : null;
  const status =
    (source.mode === "pod" && source.status.startsWith("serverless")) ||
    (source.mode === "serverless" &&
      ["provisioning", "starting", "running", "stopping", "stopped"].includes(
        source.status,
      ))
      ? "error"
      : source.status;
  return {
    ...fallback,
    revision: source.revision,
    status,
    mode: source.mode,
    podId,
    endpointId,
    workerReady:
      source.workerReady === true &&
      ["running", "serverless-ready"].includes(status),
    cloudAcknowledged: source.cloudAcknowledged === true,
    gpuId: RUNPOD_GPUS.some((gpu) => gpu.id === source.gpuId)
      ? source.gpuId
      : fallback.gpuId,
    gpuCount:
      integer(source.gpuCount) && source.gpuCount >= 1 && source.gpuCount <= 8
        ? source.gpuCount
        : 1,
    runtimeHours:
      integer(source.runtimeHours) &&
      source.runtimeHours >= 1 &&
      source.runtimeHours <= 168
        ? source.runtimeHours
        : 4,
    history: unique(source.history, 60, (value) =>
      plain(value) &&
      text(value.id, 128) &&
      value.id &&
      text(value.title) &&
      text(value.detail, 1000) &&
      date(value.at)
        ? {
            id: value.id,
            title: value.title,
            detail: value.detail,
            at: value.at,
          }
        : null,
    ),
    lastRequest:
      plain(source.lastRequest) &&
      text(source.lastRequest.action, 100) &&
      text(source.lastRequest.payload, 4000)
        ? {
            action: source.lastRequest.action,
            payload: source.lastRequest.payload,
          }
        : null,
  };
}
export function runPodActionReview(state, action) {
  const { type } = action;
  let error = "";
  let title = "";
  let detail = "";
  let cloud = false;
  let dangerous = false;
  if (type === "launch") {
    title = "Launch managed GPU";
    cloud = true;
    detail =
      "Start a billed GPU worker. Ordinary ML may send image previews to RunPod after the worker becomes available. Existing video-restoration jobs keep their selected destination.";
    if (
      !["idle", "error"].includes(state.status) ||
      state.podId ||
      state.endpointId
    )
      error =
        "Stop and remove existing resources before launching a new worker.";
  } else if (type === "resume") {
    title = "Resume managed GPU";
    cloud = true;
    detail =
      "Restart the stopped worker and reuse its cached models. GPU billing resumes.";
    if (state.status !== "stopped" || !state.podId)
      error = "A stopped managed worker is required.";
  } else if (type === "stop") {
    title = "Stop managed GPU";
    dangerous = true;
    detail =
      "Stop compute while retaining the model-cache volume. Active ordinary ML requests can fail; review jobs first. Retained storage may still be billed.";
    if (
      !["running", "provisioning", "starting"].includes(state.status) ||
      !state.podId
    )
      error = "There is no running managed worker to stop.";
  } else if (type === "terminate") {
    title = "Terminate managed GPU";
    dangerous = true;
    detail =
      "Destroy the managed worker and its persistent model-cache volume. The next launch starts with an empty cache.";
    if (!state.podId) error = "There is no managed worker to terminate.";
  } else if (type === "setup" || type === "recreate") {
    title =
      type === "setup" ? "Set up serverless ML" : "Verify serverless endpoint";
    cloud = true;
    detail =
      "Create or reuse this server’s endpoint and template. Existing owned resources are reused; this is not a forced replacement. Workers may cold-start when a request arrives.";
    if (state.podId)
      error = "Remove the managed Pod before setting up serverless ML.";
  } else if (type === "teardown") {
    title = "Remove serverless endpoint";
    dangerous = true;
    detail =
      "Remove the endpoint and template owned by this server. Requests using that endpoint can fail. Other provider resources remain untouched.";
    if (!state.endpointId) error = "There is no serverless endpoint to remove.";
  } else if (type === "backfill") {
    title = "Backfill ML results";
    cloud = true;
    detail =
      "Queue visual search, face detection, duplicate detection, OCR, descriptions, and Locked-content analysis across all accounts. This can incur GPU charges.";
    if (!["running", "serverless-ready"].includes(state.status))
      error = "Launch a managed GPU or set up serverless ML first.";
  } else if (type === "clear") {
    title = "Clear unavailable worker state";
    dangerous = true;
    detail =
      "Clear local status only after the provider confirms the resource no longer exists. This does not stop a running resource or its charges.";
    error =
      "Provider confirmation is required before clearing resource references.";
  } else if (type === "refresh") {
    title = "Refresh worker status";
    detail =
      "Refresh the displayed lifecycle state. A running GPU or provisioned endpoint does not qualify a model, Studio renderer, HDR, or Dolby Vision.";
  } else if (type === "connect") {
    title = "Check provider connection";
    detail =
      "Check whether the configured provider credential can manage resources. No key is displayed or stored here.";
  } else error = "Choose an available provider action.";
  return { title, detail, error, cloud, dangerous, revision: state.revision };
}
export function applyRunPodAction(
  state,
  action,
  {
    id,
    at,
    expectedRevision,
    confirmed = false,
    cloudAcknowledged = false,
  } = {},
) {
  const review = runPodActionReview(state, action);
  if (review.error) throw new Error(review.error);
  if (state.revision !== expectedRevision)
    throw new Error("Worker state changed. Review it again.");
  if (review.dangerous && !confirmed)
    throw new Error("Confirm the resource change.");
  if (review.cloud && !cloudAcknowledged)
    throw new Error(
      "Explicitly choose RunPod and acknowledge cloud processing.",
    );
  if (!text(id, 120) || !id || !date(at))
    throw new Error("The action could not be recorded.");
  const next = { ...state, revision: state.revision + 1, workerReady: false };
  let payload = {};
  if (action.type === "launch") {
    const gpu = RUNPOD_GPUS.find((item) => item.id === action.gpuId);
    const count = Number(action.gpuCount);
    const runtime = Number(action.runtimeHours);
    if (
      !gpu ||
      !Number.isInteger(count) ||
      count < 1 ||
      count > 8 ||
      !Number.isInteger(runtime) ||
      runtime < 1 ||
      runtime > 168
    )
      throw new Error("Choose a GPU, 1–8 GPUs, and 1–168 runtime hours.");
    Object.assign(next, {
      mode: "pod",
      status: "provisioning",
      podId: `sample-pod-${id}`,
      endpointId: null,
      gpuId: gpu.id,
      gpuCount: count,
      runtimeHours: runtime,
      cloudAcknowledged: true,
    });
    payload = {
      gpuTypeId: gpu.id,
      gpuCount: count,
      maxRuntimeHours: runtime,
      acknowledgeDataPrivacy: true,
    };
  } else if (action.type === "resume") {
    next.status = "starting";
    next.cloudAcknowledged = true;
  } else if (action.type === "stop") next.status = "stopping";
  else if (action.type === "terminate" || action.type === "teardown")
    Object.assign(next, {
      status: "idle",
      podId: null,
      endpointId: null,
      cloudAcknowledged: false,
    });
  else if (action.type === "setup" || action.type === "recreate")
    Object.assign(next, {
      mode: "serverless",
      status: state.endpointId ? "serverless-ready" : "serverless-provisioning",
      endpointId: state.endpointId || `sample-endpoint-${id}`,
      cloudAcknowledged: true,
    });
  else if (action.type === "refresh")
    next.status =
      {
        provisioning: "running",
        starting: "running",
        stopping: "stopped",
        "serverless-provisioning": "serverless-ready",
      }[state.status] || state.status;
  next.lastRequest = {
    action: action.type,
    payload: JSON.stringify(payload, null, 2),
  };
  next.history = [
    {
      id,
      title: review.title,
      detail:
        action.type === "backfill"
          ? "Backfill request prepared for all accounts."
          : review.detail,
      at,
    },
    ...state.history,
  ].slice(0, 60);
  return next;
}
