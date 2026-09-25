import React, { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "./App";
import { Icon } from "./Icon";
import { media as libraryMedia } from "./media";
import { destinationName, formatBytes, shortTimecode } from "./studio-project.mjs";
import {
  CLOUD_STORAGE_KEY,
  advanceBackupRun,
  cloudAdmission,
  cloudJobs as cloudBatches,
  formatUsd,
  loadCloudState,
  saveCloudState,
} from "./frameleaf-cloud-data.mjs";
import {
  billingFormula,
  estimateRange,
  isCloudDestination,
  placeHold,
  settlementBreakdown,
  spentSoFar,
} from "./cloud-jobs.mjs";
import { JOBS_STORAGE_KEY, createJobsState, parseJobsState, serializeJobsState } from "./jobs-data.mjs";
import {
  FILTERS,
  STAGE_LABEL,
  STAGE_TONE,
  advanceBackgroundQueues,
  advanceJobs,
  cloudStartNote,
  groupJobs,
  isInProgress,
  isMoving,
  jobStatusLine,
  matchesFilter,
  movingCount,
  progressLabel,
  queuePositions,
  resumeStatus,
  stageAnnouncements,
  stageOf,
  summariseBackgroundQueues,
  summariseCloudWork,
  summariseUploads,
} from "./activity-feed.mjs";
import "./activity.css";

const OFFLINE_TICKS_BEFORE_CLOUD_FAILS = 5;
const STAGE_HINT = {
  queued: "Waiting for their turn",
  starting: "Getting a worker ready",
  running: "Working now",
  paused: "Stopped until you resume",
};

const jobAssetId = (job) => job.assetId || job.snapshot?.assetId || null;
const jobTitle = (job) => job.name || job.project?.name || "Untitled";
const jobKindIcon = (job) => (job.kind === "Export" ? "mdiExportVariant" : "mdiAutoFix");

/** Same-tab signal that the background queues moved (storage events only reach other tabs). */
export const JOBS_TICK_EVENT = "frameleaf-jobs-tick";

/** One second of server-side work: background queues and a cloud backup run, saved to their storage keys. */
function tickBackground(now) {
  try {
    const state = parseJobsState(localStorage.getItem(JOBS_STORAGE_KEY));
    const next = advanceBackgroundQueues(state, now);
    if (next !== state) {
      localStorage.setItem(JOBS_STORAGE_KEY, serializeJobsState(next));
      dispatchEvent(new CustomEvent(JOBS_TICK_EVENT, { detail: next }));
    }
  } catch {
    // Blocked storage: background rows stay as they are.
  }
  const cloud = loadCloudState();
  const nextCloud = advanceBackupRun(cloud, now);
  if (nextCloud !== cloud) saveCloudState(nextCloud);
}

/**
 * The shared one-second tick: walks jobs Queued → Starting → Running → Done
 * and moves the server's background queues and cloud backup runs. App runs it
 * while Activity is closed; Activity runs its own so it can simulate a lost
 * connection.
 */
export function useJobSimulation(setJobs, enabled = true) {
  useEffect(() => {
    if (!enabled) return undefined;
    const timer = setInterval(() => {
      const now = Date.now();
      setJobs((items) => advanceJobs(items, now));
      tickBackground(now);
    }, 1000);
    return () => clearInterval(timer);
  }, [enabled, setJobs]);
}

/** The Background work page's saved queues and any Frameleaf Cloud work, kept in sync with storage. */
function readBackgroundWork() {
  let state;
  try {
    state = parseJobsState(localStorage.getItem(JOBS_STORAGE_KEY));
  } catch {
    state = createJobsState();
  }
  return [...summariseBackgroundQueues(state), ...summariseCloudWork(loadCloudState(), cloudBatches)];
}

function useBackgroundWork() {
  const [rows, setRows] = useState(readBackgroundWork);
  useEffect(() => {
    const sync = (event) => {
      if (event.type === "storage" && event.key !== null && ![JOBS_STORAGE_KEY, CLOUD_STORAGE_KEY].includes(event.key))
        return;
      setRows(readBackgroundWork());
    };
    addEventListener("storage", sync);
    addEventListener("frameleaf-cloud-change", sync);
    addEventListener(JOBS_TICK_EVENT, sync);
    return () => {
      removeEventListener("storage", sync);
      removeEventListener("frameleaf-cloud-change", sync);
      removeEventListener(JOBS_TICK_EVENT, sync);
    };
  }, []);
  return rows;
}

/** Estimated, so-far and settled cost of a Frameleaf Cloud job. */
function CloudCost({ job }) {
  const { cloud } = job;
  const ended = ["completed", "cancelled", "failed"].includes(job.status);
  const facts = [
    ["Model", cloud.modelName],
    ["Estimated", estimateRange(cloud)],
    cloud.rate ? ["Billed as", billingFormula(cloud)] : null,
    ended
      ? [
          "Settled",
          cloud.settled
            ? job.status === "failed"
              ? "No charge"
              : `${formatUsd(cloud.chargedUsd ?? 0)}${
                  cloud.rate ? ` · ${settlementBreakdown(job, job.status === "cancelled" ? job.progress : 100)}` : ""
                }`
            : "Settling…",
        ]
      : job.status === "queued"
        ? ["So far", "Nothing yet · billing starts when a worker starts"]
        : ["So far", `${formatUsd(spentSoFar(job))}${cloud.rate ? ` · ${settlementBreakdown(job, job.progress)}` : ""}`],
    ended ? null : ["Held", formatUsd(cloud.hold)],
  ].filter(Boolean);
  return (
    <dl className="fla-cost" aria-label="Frameleaf Cloud cost">
      {facts.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Compact topbar pill: a spinner and the number of jobs in progress. Hidden when idle. */
export function ActivityIndicator({ jobs = [], onClick }) {
  const count = movingCount(jobs);
  if (!count) return null;
  const label = progressLabel(jobs);
  return (
    <button
      type="button"
      className="fla-indicator"
      onClick={onClick}
      aria-label={`${label}. Open Activity.`}
      title={label}
    >
      <span className="fla-spinner" aria-hidden="true" />
      <span className="fla-indicator-count">{count}</span>
      <span className="fla-indicator-word">{count === 1 ? "job" : "jobs"}</span>
    </button>
  );
}

function StageChip({ stage, moving }) {
  const tone = STAGE_TONE[stage] || "neutral";
  return (
    <span className={`fla-chip fla-chip--${tone}`}>
      {moving && <i className="fla-dot" aria-hidden="true" />}
      {STAGE_LABEL[stage] || stage}
    </span>
  );
}

function JobCard({ job, asset, online, ahead, actions }) {
  const stage = stageOf(job.status);
  const tone = STAGE_TONE[stage] || "neutral";
  const title = jobTitle(job);
  const progress = Math.round(job.progress || 0);
  const settings = job.settings || {};
  const meta = [
    job.kind + (job.preview ? " · 5-second preview" : ""),
    destinationName(job.destination),
    settings.resolution || (settings.upscale ? `${settings.upscale}× upscale` : null),
    settings.mode || settings.format || null,
  ]
    .filter(Boolean)
    .join(" · ");
  const status = jobStatusLine(job, {
    online,
    ahead,
    durationSeconds: asset?.type === "video" ? asset.duration : 0,
    sizeText: job.estimate?.sizeBytes ? formatBytes(job.estimate.sizeBytes) : "",
  });
  return (
    <article className={`fla-job is-${tone} is-stage-${stage}`} aria-labelledby={`fla-job-${job.id}`}>
      <div className="fla-thumb">
        {asset ? <img src={asset.image} alt="" /> : <Icon name={jobKindIcon(job)} size={22} />}
        {asset?.type === "video" && <span className="fla-thumb-badge">{shortTimecode(asset.duration)}</span>}
      </div>
      <div className="fla-body">
        <div className="fla-row">
          <h3 id={`fla-job-${job.id}`}>{title}</h3>
          <StageChip stage={stage} moving={isMoving(job) && online} />
        </div>
        <p className="fla-meta">{meta}</p>
        {job.cloud && <CloudCost job={job} />}
        {stage === "starting" ? (
          <div className="fla-progress is-indeterminate" role="progressbar" aria-label={`${title}: starting`}>
            <span />
          </div>
        ) : stage !== "queued" ? (
          <div
            className="fla-progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress}
            aria-label={`${title} progress`}
          >
            <span style={{ width: `${progress}%` }} />
          </div>
        ) : null}
        <p className="fla-status">{status}</p>
        {stage === "starting" && job.cloud && <p className="fla-note">{cloudStartNote(job)}</p>}
      </div>
      <div className="fla-actions">{actions}</div>
    </article>
  );
}

function BackgroundRow({ row, onOpen }) {
  const tone = STAGE_TONE[row.stage] || "neutral";
  return (
    <li>
      <button
        type="button"
        className={`fla-bg is-${tone}`}
        onClick={() => onOpen?.(row.target)}
        aria-label={`${row.title}: ${row.detail}. ${row.where}. Open ${row.target.label}.`}
      >
        <span className="fla-bg-icon" aria-hidden="true">
          <Icon name={row.icon} size={18} />
        </span>
        <span className="fla-bg-body">
          <span className="fla-bg-title">{row.title}</span>
          <span className="fla-bg-detail">
            {row.detail} · {row.where}
          </span>
          {row.progress !== null && (
            <span className="fla-bg-bar" aria-hidden="true">
              <span style={{ width: `${row.progress}%` }} />
            </span>
          )}
        </span>
        <span className="fla-bg-link" aria-hidden="true">
          {row.target.label}
          <Icon name="mdiChevronRight" size={16} />
        </span>
      </button>
    </li>
  );
}

export function Processing({
  jobs = [],
  setJobs,
  openStudio,
  assets = libraryMedia,
  onOpenAsset,
  onOpenSettings,
  uploads = [],
  onOpenUploads,
  notify,
}) {
  const [online, setOnline] = useState(true);
  const [filter, setFilter] = useState("All");
  const [announcement, setAnnouncement] = useState("");
  const offlineTicks = useRef(0);
  const previous = useRef(new Map());
  const assetMap = useMemo(() => new Map(assets.map((asset) => [asset.id, asset])), [assets]);
  const serverWork = useBackgroundWork();
  const background = useMemo(() => [...summariseUploads(uploads), ...serverWork], [uploads, serverWork]);
  const openRow = (target) =>
    target.kind === "uploads" ? onOpenUploads?.() : onOpenSettings?.(target.area, target.section);

  useJobSimulation(setJobs, online);
  useEffect(() => {
    if (online) {
      offlineTicks.current = 0;
      return undefined;
    }
    const timer = setInterval(() => {
      offlineTicks.current += 1;
      if (offlineTicks.current === OFFLINE_TICKS_BEFORE_CLOUD_FAILS)
        setJobs((items) =>
          items.map((job) =>
            isMoving(job) && isCloudDestination(job.destination)
              ? {
                  ...job,
                  status: "failed",
                  error:
                    "Connection to Frameleaf Cloud was lost. The job was not moved to another worker and nothing was charged",
                }
              : job,
          ),
        );
    }, 1000);
    return () => clearInterval(timer);
  }, [online, setJobs]);

  useEffect(() => {
    const message = stageAnnouncements(previous.current, jobs, jobTitle);
    if (message) setAnnouncement(message);
    previous.current = new Map(jobs.map((job) => [job.id, job.status]));
  }, [jobs]);

  const change = (id, patch) => setJobs((items) => items.map((job) => (job.id === id ? { ...job, ...patch } : job)));
  const remove = (id) => setJobs((items) => items.filter((job) => job.id !== id));
  const clearFinished = () => setJobs((items) => items.filter(isInProgress));
  /** A cloud retry is a new run: it needs admission again and places a fresh hold. */
  const retry = (job) => {
    const restart = { status: "queued", progress: 0, stageStartedAt: Date.now(), error: undefined };
    if (!job.cloud) return change(job.id, restart);
    const cloud = loadCloudState();
    const refusal = cloudAdmission(cloud, { p50: job.cloud.p50, p90: job.cloud.p90, hold: job.cloud.hold });
    if (refusal) {
      notify?.(`${refusal} The job stays stopped.`);
      return;
    }
    saveCloudState(placeHold(cloud, job.cloud.hold));
    change(job.id, {
      ...restart,
      cloud: { ...job.cloud, settled: false, chargedUsd: null, consentedAt: new Date().toISOString() },
    });
  };
  const openResult = (job) => {
    const assetId = jobAssetId(job);
    if (onOpenAsset && assetId && assetMap.has(assetId)) onOpenAsset(assetId);
    else notify?.(`${jobTitle(job)} is in your library.`);
  };

  const { groups, recent, counts, filterCounts } = groupJobs(jobs);
  const positions = queuePositions(jobs);
  const showProgress = filter === "All" || filter === "In progress";
  const showRecent = filter !== "In progress";
  const recentVisible = recent.filter((job) => matchesFilter(job, filter));
  const busyServer = background.length;
  const summary =
    [
      counts.queued ? `${counts.queued} queued` : null,
      counts.starting ? `${counts.starting} starting` : null,
      counts.running ? `${counts.running} running` : null,
      counts.paused ? `${counts.paused} paused` : null,
      counts.done ? `${counts.done} done` : null,
      counts.failed + counts.cancelled ? `${counts.failed + counts.cancelled} stopped` : null,
      busyServer ? `${busyServer} background ${busyServer === 1 ? "task" : "tasks"} busy` : null,
    ]
      .filter(Boolean)
      .join(" · ") || "Nothing in progress";
  const nothingToShow =
    (showProgress ? counts.inProgress + busyServer : 0) + (showRecent ? recentVisible.length : 0) === 0;

  const actionsFor = (job) => {
    const stage = stageOf(job.status);
    const title = jobTitle(job);
    return (
      <>
        {isMoving(job) && (
          <Button icon="mdiPause" aria-label={`Pause ${title}`} onClick={() => change(job.id, { status: "paused" })}>
            Pause
          </Button>
        )}
        {stage === "paused" && (
          <Button
            icon="mdiPlay"
            aria-label={`Resume ${title}`}
            onClick={() => change(job.id, { status: resumeStatus(job), stageStartedAt: Date.now() })}
          >
            Resume
          </Button>
        )}
        {isInProgress(job) && (
          <Button icon="mdiCancel" aria-label={`Cancel ${title}`} onClick={() => change(job.id, { status: "cancelled" })}>
            Cancel
          </Button>
        )}
        {stage === "done" && (
          <Button icon="mdiOpenInApp" primary onClick={() => openResult(job)}>
            Open result
          </Button>
        )}
        {(stage === "failed" || stage === "cancelled") && (
          <Button icon="mdiRefresh" aria-label={`Retry ${title}`} onClick={() => retry(job)}>
            {job.cloud ? `Retry · hold ${formatUsd(job.cloud.hold)}` : "Retry"}
          </Button>
        )}
        {!isInProgress(job) && (
          <Button icon="mdiClose" aria-label={`Remove ${title} from the list`} onClick={() => remove(job.id)} />
        )}
      </>
    );
  };
  const card = (job) => (
    <JobCard
      key={job.id}
      job={job}
      asset={assetMap.get(jobAssetId(job))}
      online={online}
      ahead={positions.get(job.id)}
      actions={actionsFor(job)}
    />
  );

  return (
    <main className="fla" aria-label="Activity">
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
      <div className="fla-head">
        <div className="fla-head-text">
          <p className="eyebrow">Processing</p>
          <h1>Activity</h1>
          <p className="fla-intro">
            Activity shows your edits, exports and AI jobs, and your server’s background work (imports, thumbnails,
            faces, search, descriptions, backups and Frameleaf Cloud jobs), from waiting to done.
          </p>
          <p className="fla-summary">{summary}</p>
        </div>
        <div className="fla-head-actions">
          <div className="fla-filters" role="group" aria-label="Filter activity">
            {FILTERS.map((name) => (
              <button
                key={name}
                type="button"
                className={filter === name ? "is-on" : ""}
                aria-pressed={filter === name}
                onClick={() => setFilter(name)}
              >
                {name}
                {filterCounts[name] > 0 && <b>{filterCounts[name]}</b>}
              </button>
            ))}
          </div>
          {recent.length > 0 && (
            <Button icon="mdiCheckAll" onClick={clearFinished}>
              Clear finished
            </Button>
          )}
        </div>
      </div>

      {!online && (
        <div className="fla-offline" role="status">
          <Icon name="mdiWifiOff" size={18} />
          <span>Connection to your server was lost. Local jobs wait; cloud jobs fail after a short grace period.</span>
          <span className="grow" />
          <Button icon="mdiWifi" onClick={() => setOnline(true)}>
            Reconnect
          </Button>
        </div>
      )}

      {nothingToShow && (
        <div className="fla-empty">
          <Icon name={filter === "Failed" ? "mdiCheckCircleOutline" : "mdiProgressClock"} size={36} />
          <h2>
            {filter === "Done"
              ? "No finished jobs yet"
              : filter === "Failed"
                ? "Nothing needs attention"
                : "Nothing in progress"}
          </h2>
          <p>
            {showProgress
              ? "When you export, upscale or restore, or your server imports, makes thumbnails, finds faces or backs up, the work shows here from queued to done."
              : "Jobs move here as they finish."}
          </p>
          {showProgress && (
            <Button icon="mdiMovieEditOutline" onClick={openStudio}>
              Open Studio
            </Button>
          )}
        </div>
      )}

      {showProgress && counts.inProgress + busyServer > 0 && (
        <section className="fla-section" aria-labelledby="fla-in-progress">
          <h2 id="fla-in-progress" className="fla-section-title">
            In progress <span className="fla-count">{counts.inProgress + busyServer}</span>
          </h2>
          {counts.inProgress > 0 && (
            <p className="fla-stage-tally">
              Your jobs:{" "}
              {["queued", "starting", "running", "paused"]
                .filter((stage) => stage !== "paused" || counts.paused)
                .map((stage) => `${counts[stage]} ${STAGE_LABEL[stage].toLowerCase()}`)
                .join(" · ")}
            </p>
          )}
          {["queued", "starting", "running", "paused"].map((stage) =>
            groups[stage].length ? (
              <div className="fla-group" key={stage} role="group" aria-labelledby={`fla-stage-${stage}`}>
                <h3 id={`fla-stage-${stage}`} className="fla-group-title">
                  {STAGE_LABEL[stage]} <span className="fla-count">{groups[stage].length}</span>
                  <span className="fla-group-hint">{STAGE_HINT[stage]}</span>
                </h3>
                <div className="fla-list">{groups[stage].map(card)}</div>
              </div>
            ) : null,
          )}
          {busyServer > 0 && (
            <div className="fla-group" role="group" aria-labelledby="fla-stage-server">
              <h3 id="fla-stage-server" className="fla-group-title">
                Background work <span className="fla-count">{busyServer}</span>
                <span className="fla-group-hint">Read-only here · pause, retry and limits live in Settings → Background work</span>
              </h3>
              <ul className="fla-bg-list">
                {background.map((row) => (
                  <BackgroundRow key={row.id} row={row} onOpen={openRow} />
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {showRecent && recentVisible.length > 0 && (
        <section className="fla-section" aria-labelledby="fla-recent">
          <h2 id="fla-recent" className="fla-section-title">
            Recent <span className="fla-count">{recentVisible.length}</span>
          </h2>
          <div className="fla-list">{recentVisible.map(card)}</div>
        </section>
      )}

      <div className="fla-footer">
        <span className="muted">Jobs keep going when you leave this page.</span>
        <span className="grow" />
        {online ? (
          <button type="button" className="fla-quiet" onClick={() => setOnline(false)}>
            Simulate a disconnect
          </button>
        ) : (
          <button type="button" className="fla-quiet" onClick={() => setOnline(true)}>
            Reconnect
          </button>
        )}
      </div>
    </main>
  );
}
