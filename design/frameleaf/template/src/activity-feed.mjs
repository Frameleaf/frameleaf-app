// Activity feed helpers: the stage model for edits, exports and AI jobs, the
// one-second simulation that walks them Queued → Starting → Running → Done,
// and read-only summaries of the server's background queues and cloud work.
// Pure functions only; Activity.jsx owns rendering and timers.

import { QUEUE_CATALOG, queueById, queueCounts } from "./jobs-data.mjs";

/** Stage order shown in the In progress section. */
export const PROGRESS_STAGES = Object.freeze(["queued", "starting", "running", "paused"]);
export const FINISHED_STAGES = Object.freeze(["done", "failed", "cancelled"]);
export const STAGE_LABEL = Object.freeze({
  queued: "Queued",
  starting: "Starting",
  running: "Running",
  paused: "Paused",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
});
export const STAGE_TONE = Object.freeze({
  queued: "neutral",
  starting: "info",
  running: "info",
  paused: "warning",
  done: "success",
  failed: "danger",
  cancelled: "neutral",
});
/** Stages that are still moving (paused is in progress but not moving). */
const MOVING = new Set(["queued", "starting", "running"]);
const BUSY = new Set(["preparing", "rendering", "validating"]);

export const FILTERS = Object.freeze(["All", "In progress", "Done", "Failed"]);

/** A queued job stays visibly queued for at least this many seconds. */
export const MIN_QUEUED_SECONDS = 2;
/** Seconds spent getting a worker ready. */
export const START_SECONDS = Object.freeze({ local: 3, cloud: 8 });

/** Stored job status → the stage a person sees. */
export function stageOf(status) {
  switch (status) {
    case "queued":
      return "queued";
    case "preparing":
      return "starting";
    case "rendering":
    case "validating":
      return "running";
    case "paused":
      return "paused";
    case "completed":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return "paused";
  }
}

export const isCloudJob = (job) => job?.destination === "cloud" || job?.destination === "runpod" || !!job?.cloud;
export const isInProgress = (job) => PROGRESS_STAGES.includes(stageOf(job?.status));
export const isMoving = (job) => MOVING.has(stageOf(job?.status));

/** Jobs of the same kind on the same side (this server or Frameleaf Cloud) run one at a time. */
export const laneOf = (job) => `${job.kind || "Job"}|${isCloudJob(job) ? "cloud" : "local"}`;

/** Simulated progress per second, in percent. */
export function rateFor(job) {
  return job.kind === "Export" ? 9 : job.preview ? 14 : 5;
}

/** Seconds a job needs to get its worker ready. */
export const startSecondsFor = (job) => (isCloudJob(job) ? START_SECONDS.cloud : START_SECONDS.local);

/** What the running step is called for each kind of work. */
export function stepLabel(job) {
  if (job.status === "validating") return "Checking output";
  const kind = String(job.kind || "");
  if (kind === "Export") return "Rendering";
  if (/upscale/i.test(kind)) return "Upscaling";
  if (/restor/i.test(kind)) return "Restoring";
  if (/thumbnail/i.test(kind)) return "Making thumbnails";
  if (/metadata/i.test(kind)) return "Reading metadata";
  if (/video/i.test(kind)) return "Encoding video";
  if (/face/i.test(kind)) return "Finding faces";
  if (/describe/i.test(kind)) return "Describing";
  if (/sensitiv/i.test(kind)) return "Checking content";
  return "Processing";
}

/** Oldest-first order: the list itself is newest first. */
const oldestFirst = (jobs) => jobs.map((job, index) => ({ job, index })).reverse();

/**
 * How many jobs are ahead of each queued job in its lane (running or starting
 * ones count, as do older queued ones). Map id → number.
 */
export function queuePositions(jobs = []) {
  const busy = new Map();
  const waiting = new Map();
  const positions = new Map();
  for (const { job } of oldestFirst(jobs)) {
    const lane = laneOf(job);
    if (BUSY.has(job.status)) busy.set(lane, (busy.get(lane) || 0) + 1);
  }
  for (const { job } of oldestFirst(jobs)) {
    if (job.status !== "queued") continue;
    const lane = laneOf(job);
    const before = waiting.get(lane) || 0;
    positions.set(job.id, (busy.get(lane) || 0) + before);
    waiting.set(lane, before + 1);
  }
  return positions;
}

/**
 * One simulated second at `now` (ms). Queued jobs wait at least
 * MIN_QUEUED_SECONDS and until their lane is free; starting takes
 * START_SECONDS; running adds progress, switches to "Checking output" at 85%
 * and finishes at 100%. Stage start times (`stageStartedAt`) are saved with
 * the job so a reload keeps its place. Returns the same array when nothing moved.
 */
export function advanceJobs(jobs = [], now = Date.now()) {
  if (!jobs.some(isMoving)) return jobs;
  const busy = new Set(jobs.filter((job) => BUSY.has(job.status)).map(laneOf));
  const next = [...jobs];
  for (const { job, index } of oldestFirst(jobs)) {
    if (!isMoving(job)) continue;
    const since = Number.isFinite(job.stageStartedAt) ? job.stageStartedAt : null;
    const elapsed = since === null ? 0 : (now - since) / 1000;
    if (job.status === "queued") {
      const lane = laneOf(job);
      if (since !== null && elapsed >= MIN_QUEUED_SECONDS && !busy.has(lane)) {
        busy.add(lane);
        next[index] = { ...job, status: "preparing", stageStartedAt: now, error: undefined };
      } else if (since === null) next[index] = { ...job, stageStartedAt: now };
    } else if (job.status === "preparing") {
      if (since === null) next[index] = { ...job, stageStartedAt: now };
      else if (elapsed >= startSecondsFor(job))
        next[index] = {
          ...job,
          status: "rendering",
          stageStartedAt: now,
          progress: Math.max(1, Number(job.progress) || 0),
        };
    } else {
      const progress = Math.min(100, (Number(job.progress) || 0) + rateFor(job));
      const status = progress >= 100 ? "completed" : progress >= 85 ? "validating" : "rendering";
      next[index] = {
        ...job,
        progress,
        status,
        stageStartedAt: status === job.status && since !== null ? since : now,
        error: undefined,
      };
    }
  }
  return next;
}

/** Status to resume a paused job with: back to running when work had begun. */
export const resumeStatus = (job) => ((Number(job.progress) || 0) > 0 ? "rendering" : "queued");

/** Seconds left for a running job, from its simulated rate. */
export function secondsLeft(job) {
  const progress = Math.max(0, Math.min(100, Number(job.progress) || 0));
  return Math.ceil((100 - progress) / rateFor(job));
}

/** Units of work done so far: items for counted cloud work, seconds for video. */
export function itemsProgress(job, durationSeconds = 0) {
  const share = Math.max(0, Math.min(100, Number(job.progress) || 0)) / 100;
  const label = String(job.cloud?.quantityLabel || "");
  const counted = /item/.test(label) ? Math.round(Number(job.cloud.quantity) || 0) : 0;
  if (counted > 1) return { done: Math.floor(counted * share), total: counted, unit: "items" };
  const seconds = Math.round(Number(durationSeconds) || 0);
  if (seconds > 0) return { done: Math.floor(seconds * share), total: seconds, unit: "seconds" };
  return null;
}

const plural = (count, word) => `${count.toLocaleString("en-US")} ${word}${count === 1 ? "" : "s"}`;
const clock = (seconds) => {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total} s`;
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return rest ? `${minutes} min ${rest} s` : `${minutes} min`;
};

/** Where a starting job is getting ready. */
export function startingText(job) {
  return isCloudJob(job)
    ? "Starting a Frameleaf Cloud worker · loading the model"
    : "Starting on this server";
}

/** The start-fee and cold-start note shown while a cloud worker starts. */
export function cloudStartNote(job) {
  if (!isCloudJob(job)) return "";
  const cloud = job.cloud || {};
  const workers = Math.max(1, Number(cloud.workers) || 1);
  const fee = Number(cloud.startFee) > 0 ? `$${Number(cloud.startFee).toFixed(2)} start fee` : "start fee";
  const who = workers > 1 ? `${fee} per worker (${workers} workers)` : `The ${fee}`;
  return `${who} covers starting the worker and loading the model. A cold start can take up to a minute; GPU time is billed only once work begins.`;
}

/**
 * One line of status for a job. Stage words are always spelled out so status
 * never depends on colour.
 */
export function jobStatusLine(job, { online = true, ahead, durationSeconds = 0, sizeText = "" } = {}) {
  const stage = stageOf(job.status);
  const progress = Math.round(Number(job.progress) || 0);
  if (stage === "done") return `Done${sizeText ? ` · ${sizeText}` : ""}`;
  if (stage === "failed") return `Failed · ${job.error || "The worker stopped responding"}`;
  if (stage === "cancelled") return `Cancelled at ${progress}%`;
  if (stage === "paused") return `Paused at ${progress}% · resume to continue`;
  if (!online) return `Waiting for connection · ${progress}%`;
  if (stage === "queued") {
    const turn = Number.isInteger(ahead)
      ? ahead === 0
        ? "next up"
        : `${ahead} ahead`
      : "";
    return `Waiting for its turn${turn ? ` · ${turn}` : ""}`;
  }
  if (stage === "starting") return startingText(job);
  const parts = [stepLabel(job), `${progress}%`];
  const items = itemsProgress(job, durationSeconds);
  if (items)
    parts.push(
      items.unit === "items"
        ? `${items.done.toLocaleString("en-US")} of ${plural(items.total, "item")}`
        : `${clock(items.done)} of ${clock(items.total)}`,
    );
  parts.push(`about ${clock(secondsLeft(job))} left`);
  return parts.join(" · ");
}

export function matchesFilter(job, filter) {
  const stage = stageOf(job.status);
  return (
    filter === "All" ||
    (filter === "In progress" && PROGRESS_STAGES.includes(stage)) ||
    (filter === "Done" && stage === "done") ||
    (filter === "Failed" && (stage === "failed" || stage === "cancelled"))
  );
}

/**
 * In progress jobs grouped by stage (oldest first, the order they run in) and
 * finished ones for Recent (newest first), with counts per stage and filter.
 */
export function groupJobs(jobs = []) {
  const groups = { queued: [], starting: [], running: [], paused: [] };
  const recent = [];
  for (const { job } of oldestFirst(jobs)) {
    const stage = stageOf(job.status);
    if (groups[stage]) groups[stage].push(job);
  }
  for (const job of jobs) if (FINISHED_STAGES.includes(stageOf(job.status))) recent.push(job);
  const counts = {
    queued: groups.queued.length,
    starting: groups.starting.length,
    running: groups.running.length,
    paused: groups.paused.length,
    done: jobs.filter((job) => stageOf(job.status) === "done").length,
    failed: jobs.filter((job) => stageOf(job.status) === "failed").length,
    cancelled: jobs.filter((job) => stageOf(job.status) === "cancelled").length,
  };
  counts.inProgress = counts.queued + counts.starting + counts.running + counts.paused;
  const filterCounts = Object.fromEntries(
    FILTERS.map((name) => [name, jobs.filter((job) => matchesFilter(job, name)).length]),
  );
  return { groups, recent, counts, filterCounts };
}

/** "3 jobs in progress · 1 queued, 1 starting, 1 running" for the topbar. */
export function progressLabel(jobs = []) {
  const { counts } = groupJobs(jobs);
  const moving = counts.queued + counts.starting + counts.running;
  if (!moving) return "";
  const detail = ["queued", "starting", "running"]
    .filter((stage) => counts[stage])
    .map((stage) => `${counts[stage]} ${stage}`)
    .join(", ");
  return `${plural(moving, "job")} in progress · ${detail}`;
}

/** Moving jobs only (paused ones are not progressing). */
export const movingCount = (jobs = []) => jobs.filter(isMoving).length;

const ANNOUNCE = {
  queued: "is queued",
  starting: "is starting",
  running: "started",
  paused: "paused",
  done: "finished",
  failed: "failed",
  cancelled: "was cancelled",
};

/**
 * Polite live-region text for stage changes since the previous render.
 * `previous` maps id → status; new jobs announce as queued.
 */
export function stageAnnouncements(previous, jobs = [], title = (job) => job.name || "Untitled") {
  if (!(previous instanceof Map) || previous.size === 0 && jobs.length === 0) return "";
  const messages = [];
  for (const job of jobs) {
    const before = previous.get(job.id);
    const stage = stageOf(job.status);
    if (before === undefined) {
      if (previous.size && stage === "queued") messages.push(`${job.kind || "Job"} of ${title(job)} ${ANNOUNCE.queued}`);
      continue;
    }
    if (stageOf(before) !== stage) messages.push(`${job.kind || "Job"} of ${title(job)} ${ANNOUNCE[stage]}`);
  }
  return messages.length ? `${messages.join(". ")}.` : "";
}

// ------------------------------------------------------- background server work

const BACKGROUND_TITLES = {
  library: "Library scan",
  imageDescription: "Descriptions & tags",
  smartSearch: "Search indexing",
  backupDatabase: "Database backup",
};

const pct = (values) =>
  values.length ? Math.round(values.reduce((total, value) => total + value, 0) / values.length) : 0;

/**
 * Busy Background work queues as read-only rows, split by where the work runs so
 * Frameleaf Cloud description batches show separately. Idle, failed-only and
 * finished queues are left out.
 */
export function summariseBackgroundQueues(state, catalog = QUEUE_CATALOG) {
  if (!state || !Array.isArray(state.jobs)) return [];
  const rows = [];
  for (const queue of catalog) {
    const paused = state.queues?.[queue.id]?.paused === true;
    for (const side of ["local", "cloud"]) {
      const jobs = state.jobs.filter(
        (job) => job.queueId === queue.id && (side === "cloud") === (job.destination === "cloud"),
      );
      if (!jobs.length) continue;
      const count = queueCounts({ jobs }, queue.id);
      const running = count.active;
      const waiting = count.waiting + count.delayed + count.paused;
      if (!running && !waiting) continue;
      const stage = paused ? "paused" : running ? "running" : "queued";
      const progress = pct(jobs.filter((job) => job.status === "active").map((job) => Number(job.progress) || 0));
      const title = `${BACKGROUND_TITLES[queue.id] || queue.title}${side === "cloud" ? " on Frameleaf Cloud" : ""}`;
      const parts = [STAGE_LABEL[stage]];
      if (waiting) parts.push(`${waiting.toLocaleString("en-US")} waiting`);
      if (running) parts.push(`${running.toLocaleString("en-US")} running`);
      if (running && !paused) parts.push(`${progress}%`);
      rows.push({
        id: `queue-${queue.id}-${side}`,
        queueId: queue.id,
        title,
        icon: side === "cloud" ? "mdiCloudOutline" : queue.icon || "mdiCogOutline",
        stage,
        running,
        waiting,
        progress: running ? progress : null,
        where: side === "cloud" ? "Frameleaf Cloud" : "This server",
        detail: parts.join(" · "),
        target: { area: "processing", section: "queues", label: "Background work" },
      });
    }
  }
  return rows;
}

/**
 * Frameleaf Cloud work that is not a personal job: running cloud batches
 * (when cloud processing is on), and a cloud backup or restore run when the
 * cloud state reports one.
 */
export function summariseCloudWork(cloudState, cloudJobList = []) {
  if (!cloudState) return [];
  const rows = [];
  if (cloudState.processing?.enabled) {
    for (const job of cloudJobList) {
      if (!["running", "queued", "starting"].includes(job.status)) continue;
      const stage = job.status === "starting" ? "starting" : job.status === "queued" ? "queued" : "running";
      rows.push({
        id: `cloud-${job.id}`,
        title: job.title,
        icon: "mdiCloudOutline",
        stage,
        running: stage === "running" ? 1 : 0,
        waiting: stage === "queued" ? 1 : 0,
        progress: Number.isFinite(job.progress) ? Math.round(job.progress) : null,
        where: "Frameleaf Cloud",
        detail: [
          STAGE_LABEL[stage],
          Number.isFinite(job.progress) ? `${Math.round(job.progress)}%` : null,
          Number.isFinite(job.heldUsd) ? `$${job.heldUsd.toFixed(2)} held` : null,
        ]
          .filter(Boolean)
          .join(" · "),
        target: { area: "cloud", section: "cloud-processing", label: "Frameleaf Cloud" },
      });
    }
  }
  const run = cloudState.backup?.run;
  if (cloudState.backup?.configured && run && ["queued", "starting", "running"].includes(run.status)) {
    const progress = run.status === "running" && Number.isFinite(run.progress) ? Math.round(run.progress) : null;
    rows.push({
      id: "cloud-backup-run",
      title: "Cloud backup",
      icon: "mdiCloudUploadOutline",
      stage: run.status,
      running: run.status === "running" ? 1 : 0,
      waiting: run.status === "queued" ? 1 : 0,
      progress,
      where: "Frameleaf Cloud",
      detail: [
        STAGE_LABEL[run.status],
        run.status === "running" && progress !== null ? `${progress}%` : null,
        run.status === "running" && Number(run.uploaded) > 0
          ? `${Number(run.uploaded).toLocaleString("en-US")} new or changed files uploaded`
          : null,
      ]
        .filter(Boolean)
        .join(" · "),
      target: { area: "cloud", section: "cloud-backup", label: "Cloud backup" },
    });
  }
  const restore = cloudState.backup?.restoreRun;
  if (restore && ["queued", "running"].includes(restore.status)) {
    const progress = restore.status === "running" && Number.isFinite(restore.progress) ? Math.round(restore.progress) : null;
    const files = Number(restore.files) || 1;
    rows.push({
      id: "cloud-restore-run",
      title: restore.title || "Restore from backup",
      icon: "mdiBackupRestore",
      stage: restore.status,
      running: restore.status === "running" ? 1 : 0,
      waiting: restore.status === "queued" ? 1 : 0,
      progress,
      where: "Frameleaf Cloud",
      detail: [
        STAGE_LABEL[restore.status],
        progress !== null ? `${progress}%` : null,
        Array.isArray(restore.steps) && restore.steps.length
          ? restore.steps[Math.min(restore.steps.length - 1, Math.floor(((progress ?? 0) / 100) * restore.steps.length))]
          : `${files.toLocaleString("en-US")} ${files === 1 ? "file" : "files"}, each checked against its fingerprint`,
      ]
        .filter(Boolean)
        .join(" · "),
      target: { area: "cloud", section: "cloud-backup", label: "Cloud backup" },
    });
  }
  return rows;
}

/** Deterministic 0..n-1 from an id, so the simulation is repeatable. */
function hashOf(id, n) {
  let hash = 0;
  for (const char of String(id)) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % n;
}

/**
 * One simulated second of the server's background queues: running jobs gain
 * 1–3%, finish at 100%, and free slots pull the oldest waiting job (then a
 * delayed one) up to the queue's concurrency. Paused queues and empty queues
 * stay still. Returns the same state when nothing moved; the revision is left
 * alone so the Background work page's own edits still apply.
 */
export function advanceBackgroundQueues(state, now = Date.now()) {
  if (!state || !Array.isArray(state.jobs)) return state;
  const at = new Date(now).toISOString();
  let changed = false;
  const jobs = state.jobs.map((job) => {
    if (job.status !== "active" || state.queues?.[job.queueId]?.paused) return job;
    changed = true;
    const progress = Math.min(100, (Number(job.progress) || 0) + 1 + hashOf(job.id, 3));
    return progress >= 100
      ? { ...job, status: "completed", progress: 100, updatedAt: at }
      : { ...job, progress, updatedAt: at };
  });
  const byQueue = new Map();
  jobs.forEach((job, index) => {
    if (!byQueue.has(job.queueId)) byQueue.set(job.queueId, []);
    byQueue.get(job.queueId).push(index);
  });
  for (const [queueId, indexes] of byQueue) {
    if (state.queues?.[queueId]?.paused) continue;
    const limit = Math.max(1, Number(queueById(queueId)?.concurrency) || 1);
    let active = indexes.filter((index) => jobs[index].status === "active").length;
    const candidates = ["waiting", "delayed"].flatMap((status) =>
      indexes
        .filter((index) => jobs[index].status === status)
        .sort((a, b) => jobs[a].createdAt.localeCompare(jobs[b].createdAt)),
    );
    for (const index of candidates) {
      if (active >= limit) break;
      jobs[index] = { ...jobs[index], status: "active", progress: 0, updatedAt: at };
      active += 1;
      changed = true;
    }
  }
  return changed ? { ...state, jobs } : state;
}

/** Files uploading from this browser as one In progress row. */
export function summariseUploads(uploads = []) {
  const uploading = uploads.filter((item) => item.status === "uploading");
  const waiting = uploads.filter((item) => item.status === "queued");
  if (!uploading.length && !waiting.length) return [];
  const active = [...uploading, ...waiting];
  const progress = pct(active.map((item) => Number(item.progress) || 0));
  const stage = uploading.length ? "running" : "queued";
  const parts = [STAGE_LABEL[stage]];
  if (waiting.length) parts.push(`${waiting.length.toLocaleString("en-US")} waiting`);
  if (uploading.length) parts.push(`${uploading.length.toLocaleString("en-US")} uploading`, `${progress}%`);
  return [
    {
      id: "uploads",
      title: "Imports",
      icon: "mdiUploadOutline",
      stage,
      running: uploading.length,
      waiting: waiting.length,
      progress: uploading.length ? progress : null,
      where: "From this browser",
      detail: parts.join(" · "),
      target: { kind: "uploads", label: "Uploads" },
    },
  ];
}
