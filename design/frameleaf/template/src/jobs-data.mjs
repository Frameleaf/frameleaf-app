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
    "Photo detail files",
    "Media",
    5,
    "mdiTextBoxSearchOutline",
    "Find and read the small detail files saved next to photos.",
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
          ? "Find detail files"
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
    "Score the whole library again, including photos already scored.",
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
// "runpod" is the retired destination id; saved jobs are read as Frameleaf Cloud.
const targets = new Set(["local", "cloud", "server"]);
const destinationId = (value) => (value === "runpod" ? "cloud" : value);
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
              : "The AI computer didn't answer in time. Check that it's on and has the model installed.";
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
              ? "cloud"
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
function parseJob(input) {
  const value = plain(input)
    ? { ...input, destination: destinationId(input.destination) }
    : input;
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
  pause: "Pause this work",
  resume: "Resume this work",
  "clear-waiting": "Clear waiting jobs",
  "remove-failed": "Remove failed records",
  "retry-failed": "Retry failed jobs",
  missing: "Run missing",
  force: "Reprocess all",
  refresh: "Refresh face detection",
  "resume-all": "Resume all paused work",
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
        : "Write captions for the whole library again with your saved settings. Nothing is added if captions are already being written.";
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
      error = "This category is already waiting to be re-checked.";
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
      "Resume paused work for everyone. Running work continues.";
    if (!affected) error = "Nothing is paused.";
  } else if (!queue) error = "Choose a kind of work.";
  else if (action.type === "pause") {
    if (!queue.canPause) error = "Essential background tasks cannot be paused.";
    else if (state.queues[queue.id].paused)
      error = "This work is already paused.";
    affected = count.waiting;
    detail =
      "Stop taking new work. Active jobs continue; delayed jobs keep their schedule.";
  } else if (action.type === "resume") {
    if (!state.queues[queue.id].paused)
      error = "This work is already running.";
    affected = count.paused;
    detail =
      "Let waiting work start, up to the number that can run at once.";
  } else if (action.type === "clear-waiting") {
    affected = count.waiting + count.paused;
    dangerous = true;
    detail =
      "Remove jobs that haven't started. Running, delayed and failed jobs stay. Your photos are not deleted.";
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
      "Try failed jobs again, on the same computer. Fix the reported problem first.";
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
      error = "This isn't available for this kind of work.";
    else if (featureDisabled(queue, settings))
      error = "Enable this feature before starting a library scan.";
    else if (
      count.active ||
      count.waiting ||
      count.paused ||
      state.queues[queue.id].paused
    )
      error =
        "Wait for this work to finish, or clear what's waiting and resume it first.";
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
          ? "Scan the whole library again, including photos already processed. This can require substantial processing time."
          : action.type === "refresh"
            ? "Refresh face results without requesting a complete reset."
            : "Look through the library for anything that still needs doing.";
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
      "Things changed. Check the latest numbers before continuing.",
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

export const SMART_ALBUM_KINDS = Object.freeze([
  "documents",
  "food",
  "nature",
  "pets",
  "screenshots",
  "travel",
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
