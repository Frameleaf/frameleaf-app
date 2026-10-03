// Getting Ready: "Combining duplicate files" (FL-326, spec §5.1). The one-time
// universal storage migration after an upgrade: the server keeps one file per
// checksum and size, relinks missing originals to exact verified copies, and
// moves the extra copies to the file trash. The status mirrors the server's
// `GET /server/storage-migration`; the demo advances it on a timer.

export const STORAGE_MIGRATION_STAGES = Object.freeze([
  {
    id: "checking",
    title: "Checking files",
    detail: "Looking for every original on disk",
  },
  {
    id: "relinking",
    title: "Relinking missing files",
    detail: "Only exact, verified copies are relinked",
  },
  {
    id: "linking",
    title: "Linking duplicate groups",
    detail: "Each photo or video keeps one file on the server",
  },
  {
    id: "trashing",
    title: "Moving extra copies to the file trash",
    detail: "An administrator empties it in Library Care",
  },
]);

const ORDER = STORAGE_MIGRATION_STAGES.map(({ id }) => id);

const stage = (done, total) => ({ done, total });

/** A sample library in the middle of nothing yet: 48,210 files, a few missing. */
export function createStorageMigrationDemo({ toReview = 2 } = {}) {
  return {
    stage: "checking",
    required: true,
    background: false,
    showInGettingReady: true,
    stages: {
      checking: stage(0, 48210),
      relinking: stage(0, 9 + toReview),
      linking: stage(0, 3120),
      trashing: stage(0, 3480),
    },
    relinked: 0,
    toReview: 0,
    plannedReview: toReview,
    skipped: 0,
    bytesFreed: 0,
    estimatedSecondsLeft: null,
    startedAt: "2026-10-03T12:00:00.000Z",
    finishedAt: null,
  };
}

const RATES = { checking: 4000, relinking: 2, linking: 260, trashing: 290 };
const AVERAGE_COPY_BYTES = 6.2 * 1024 ** 2;

/** The demo's next tick: the current stage moves on by its rate; a finished stage hands over. */
export function advanceStorageMigrationDemo(status, ms) {
  if (status.stage === "done") return status;
  const current = status.stage;
  const { done, total } = status.stages[current];
  const nextDone = Math.min(total, done + Math.max(1, Math.round((RATES[current] * ms) / 1000)));
  const next = {
    ...status,
    stages: { ...status.stages, [current]: stage(nextDone, total) },
  };
  if (current === "relinking") {
    const settled = nextDone - done;
    const reviewLeft = Math.max(0, (status.plannedReview ?? 0) - status.toReview);
    const review = Math.min(settled, reviewLeft, Math.max(0, nextDone - (total - reviewLeft)));
    next.toReview = status.toReview + review;
    next.relinked = status.relinked + settled - review;
  }
  if (current === "trashing") {
    next.bytesFreed = Math.round(nextDone * AVERAGE_COPY_BYTES);
  }
  if (nextDone >= total) {
    const following = ORDER[ORDER.indexOf(current) + 1] ?? "done";
    next.stage = following;
    if (following === "done") {
      next.finishedAt = "2026-10-03T12:09:00.000Z";
      next.showInGettingReady = false;
    }
  }
  const remaining = ORDER.slice(ORDER.indexOf(next.stage) === -1 ? ORDER.length : ORDER.indexOf(next.stage)).reduce(
    (sum, id) => sum + (next.stages[id].total - next.stages[id].done) / RATES[id],
    0,
  );
  next.estimatedSecondsLeft = next.stage === "done" ? null : Math.ceil(remaining);
  return next;
}

export function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const rounded = value < 10 && unit > 0 ? Math.round(value * 10) / 10 : Math.round(value);
  return `${rounded} ${units[unit]}`;
}

export function formatTimeLeft(seconds) {
  if (seconds === null || seconds === undefined) return null;
  if (seconds < 60) return "Less than a minute left";
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `About ${minutes} minute${minutes === 1 ? "" : "s"} left`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `About ${hours} hour${hours === 1 ? "" : "s"}${rest ? ` ${rest} minute${rest === 1 ? "" : "s"}` : ""} left`;
}

const number = (value) => value.toLocaleString("en-US");

/**
 * What the step shows. Working: staged tasks (X of Y), the relink line, space
 * freed and time left, and no Continue. Done or "Finished with N files to
 * review": Continue. Sent to the background: Continue, the rest in Library Care.
 */
export function storageMigrationView(status) {
  const index = status.stage === "done" ? ORDER.length : Math.max(0, ORDER.indexOf(status.stage));
  const tasks = STORAGE_MIGRATION_STAGES.map(({ id, title, detail }, position) => {
    const { done, total } = status.stages[id];
    return {
      id,
      title,
      detail,
      status: position < index ? "done" : position === index ? "running" : "queued",
      done,
      total,
      progressLabel: `${number(done)} of ${number(total)}`,
      percent: total > 0 ? Math.floor((done / total) * 100) : position < index ? 100 : 0,
    };
  });
  const current = tasks[index];
  const percent =
    status.stage === "done"
      ? 100
      : Math.floor(((index + (current && current.total > 0 ? current.done / current.total : 0)) / ORDER.length) * 100);
  const toReview = status.toReview;
  const view = {
    tasks,
    percent,
    relinkLine: `${number(status.relinked)} relinked, ${number(toReview)} to review`,
    freedLabel: formatBytes(status.bytesFreed),
    timeLeftLabel: formatTimeLeft(status.estimatedSecondsLeft),
    toReview,
  };
  if (status.stage === "done") {
    return toReview > 0
      ? {
          ...view,
          kind: "review",
          canContinue: true,
          title: `Finished with ${number(toReview)} file${toReview === 1 ? "" : "s"} to review in Library Care`,
        }
      : { ...view, kind: "done", canContinue: true, title: "Done" };
  }
  if (status.background) {
    return { ...view, kind: "background", canContinue: true, title: "Combining duplicate files in the background" };
  }
  return { ...view, kind: "working", canContinue: false, title: "Combining duplicate files" };
}
