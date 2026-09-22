import React, { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "./App";
import { Icon } from "./Icon";
import { media as libraryMedia } from "./media";
import { destinationName, formatBytes, formatSeconds, shortTimecode } from "./studio-project.mjs";
import "./activity.css";

const RUNNING = ["queued", "preparing", "rendering", "validating"];
const ACTIVE = [...RUNNING, "paused"];
const FILTERS = ["All", "Running", "Done", "Failed"];
const STATUS_LABEL = {
  queued: "Queued",
  preparing: "Preparing",
  rendering: "Rendering",
  validating: "Checking output",
  paused: "Paused",
  completed: "Done",
  cancelled: "Cancelled",
  failed: "Failed",
};
const STATUS_TONE = {
  queued: "neutral",
  preparing: "info",
  rendering: "info",
  validating: "info",
  paused: "warning",
  completed: "success",
  cancelled: "neutral",
  failed: "danger",
};
const OFFLINE_TICKS_BEFORE_CLOUD_FAILS = 5;

const isRunning = (job) => RUNNING.includes(job.status);
/** Simulated progress per second, in percent. */
const rateFor = (job) => (job.kind === "Export" ? 9 : job.preview ? 14 : 5);
const matchesFilter = (job, filter) =>
  filter === "All" ||
  (filter === "Running" && ACTIVE.includes(job.status)) ||
  (filter === "Done" && job.status === "completed") ||
  (filter === "Failed" && ["failed", "cancelled"].includes(job.status));
const jobAssetId = (job) => job.assetId || job.snapshot?.assetId || null;
const jobTitle = (job) => job.name || job.project?.name || "Untitled";
const jobKindIcon = (job) => (job.kind === "Export" ? "mdiExportVariant" : "mdiAutoFix");

function statusText(job, online) {
  const label = STATUS_LABEL[job.status] || job.status;
  const progress = Math.round(job.progress || 0);
  if (job.status === "completed") {
    const size = job.estimate?.sizeBytes ? ` · ${formatBytes(job.estimate.sizeBytes)}` : "";
    return `${label}${size}`;
  }
  if (job.status === "failed") return `${label} · ${job.error || "The worker stopped responding"}`;
  if (job.status === "cancelled") return `${label} at ${progress}%`;
  if (job.status === "paused") return `${label} at ${progress}%`;
  if (!online) return `Waiting for connection · ${progress}%`;
  const remaining = Math.ceil((100 - progress) / rateFor(job));
  return `${label} · ${progress}% · about ${formatSeconds(remaining)} left`;
}

/** Compact topbar pill: a spinner and the number of running jobs. Hidden when idle. */
export function ActivityIndicator({ jobs = [], onClick }) {
  const running = jobs.filter(isRunning);
  if (!running.length) return null;
  const progress = Math.round(running.reduce((total, job) => total + (job.progress || 0), 0) / running.length);
  return (
    <button
      type="button"
      className="fla-indicator"
      onClick={onClick}
      aria-label={`${running.length} ${running.length === 1 ? "job" : "jobs"} running, ${progress}% done. Open Activity.`}
      title="Open Activity"
    >
      <span className="fla-spinner" aria-hidden="true" />
      <span className="fla-indicator-count">{running.length}</span>
    </button>
  );
}

export function Processing({ jobs = [], setJobs, openStudio, assets = libraryMedia, onOpenAsset, notify }) {
  const [online, setOnline] = useState(true);
  const [filter, setFilter] = useState("All");
  const [announcement, setAnnouncement] = useState("");
  const offlineTicks = useRef(0);
  const previous = useRef(new Map());
  const assetMap = useMemo(() => new Map(assets.map((asset) => [asset.id, asset])), [assets]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (!online) {
        offlineTicks.current += 1;
        if (offlineTicks.current === OFFLINE_TICKS_BEFORE_CLOUD_FAILS)
          setJobs((items) =>
            items.map((job) =>
              isRunning(job) && job.destination === "runpod"
                ? { ...job, status: "failed", error: "Connection to RunPod was lost" }
                : job,
            ),
          );
        return;
      }
      offlineTicks.current = 0;
      setJobs((items) =>
        items.map((job) => {
          if (!isRunning(job)) return job;
          const progress = Math.min(100, (job.progress || 0) + rateFor(job));
          const status =
            progress >= 100 ? "completed" : progress >= 85 ? "validating" : progress >= 8 ? "rendering" : "preparing";
          return { ...job, progress, status, error: undefined };
        }),
      );
    }, 1000);
    return () => clearInterval(timer);
  }, [online, setJobs]);

  useEffect(() => {
    const finished = jobs.filter(
      (job) => job.status === "completed" && previous.current.get(job.id) && previous.current.get(job.id) !== "completed",
    );
    const failed = jobs.filter(
      (job) => job.status === "failed" && previous.current.get(job.id) && previous.current.get(job.id) !== "failed",
    );
    if (finished.length) setAnnouncement(`${finished[0].kind} of ${jobTitle(finished[0])} finished.`);
    else if (failed.length) setAnnouncement(`${failed[0].kind} of ${jobTitle(failed[0])} failed.`);
    previous.current = new Map(jobs.map((job) => [job.id, job.status]));
  }, [jobs]);

  const change = (id, patch) => setJobs((items) => items.map((job) => (job.id === id ? { ...job, ...patch } : job)));
  const remove = (id) => setJobs((items) => items.filter((job) => job.id !== id));
  const clearFinished = () => setJobs((items) => items.filter((job) => ACTIVE.includes(job.status)));
  const openResult = (job) => {
    const assetId = jobAssetId(job);
    if (onOpenAsset && assetId && assetMap.has(assetId)) onOpenAsset(assetId);
    else notify?.(`${jobTitle(job)} is in your library.`);
  };

  const counts = Object.fromEntries(FILTERS.map((name) => [name, jobs.filter((job) => matchesFilter(job, name)).length]));
  const visible = jobs.filter((job) => matchesFilter(job, filter));
  const running = counts.Running;
  const summary = jobs.length
    ? [running ? `${running} running` : null, counts.Done ? `${counts.Done} done` : null, counts.Failed ? `${counts.Failed} needing attention` : null]
        .filter(Boolean)
        .join(" · ") || "Nothing running"
    : "Nothing running";

  return (
    <main className="fla" aria-label="Activity">
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
      <div className="fla-head">
        <div>
          <p className="eyebrow">Processing</p>
          <h1>Activity</h1>
          <p className="fla-summary">{summary}</p>
        </div>
        <div className="fla-head-actions">
          <div className="fla-filters" role="group" aria-label="Filter jobs">
            {FILTERS.map((name) => (
              <button
                key={name}
                type="button"
                className={filter === name ? "is-on" : ""}
                aria-pressed={filter === name}
                onClick={() => setFilter(name)}
              >
                {name}
                {counts[name] > 0 && <b>{counts[name]}</b>}
              </button>
            ))}
          </div>
          {jobs.some((job) => !ACTIVE.includes(job.status)) && (
            <Button icon="mdiCheckAll" onClick={clearFinished}>
              Clear finished
            </Button>
          )}
        </div>
      </div>

      {!online && (
        <div className="fla-offline" role="status">
          <Icon name="mdiWifiOff" size={18} />
          <span>
            Connection to your server was lost. Local jobs wait; cloud jobs fail after a short grace period.
          </span>
          <span className="grow" />
          <Button icon="mdiWifi" onClick={() => setOnline(true)}>
            Reconnect
          </Button>
        </div>
      )}

      {!visible.length && (
        <div className="fla-empty">
          <Icon name={filter === "Failed" ? "mdiCheckCircleOutline" : "mdiProgressClock"} size={36} />
          <h2>
            {filter === "All"
              ? "Nothing processing"
              : filter === "Running"
                ? "Nothing running"
                : filter === "Done"
                  ? "No finished jobs yet"
                  : "Nothing needs attention"}
          </h2>
          <p>
            {filter === "All" || filter === "Running"
              ? "Exports and restorations you start in Studio show up here with live progress."
              : "Jobs move here as they finish."}
          </p>
          {(filter === "All" || filter === "Running") && (
            <Button icon="mdiMovieEditOutline" onClick={openStudio}>
              Open Studio
            </Button>
          )}
        </div>
      )}

      <div className="fla-list">
        {visible.map((job) => {
          const asset = assetMap.get(jobAssetId(job));
          const tone = STATUS_TONE[job.status] || "neutral";
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
          return (
            <article className={`fla-job is-${tone}`} key={job.id} aria-labelledby={`fla-job-${job.id}`}>
              <div className="fla-thumb">
                {asset ? <img src={asset.image} alt="" /> : <Icon name={jobKindIcon(job)} size={22} />}
                {asset?.type === "video" && <span className="fla-thumb-badge">{shortTimecode(asset.duration)}</span>}
              </div>
              <div className="fla-body">
                <div className="fla-row">
                  <h3 id={`fla-job-${job.id}`}>{title}</h3>
                  <span className={`fla-chip fla-chip--${tone}`}>
                    {isRunning(job) && online && <i className="fla-dot" aria-hidden="true" />}
                    {STATUS_LABEL[job.status] || job.status}
                  </span>
                </div>
                <p className="fla-meta">{meta}</p>
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
                <p className="fla-status">{statusText(job, online)}</p>
              </div>
              <div className="fla-actions">
                {isRunning(job) && (
                  <Button icon="mdiPause" onClick={() => change(job.id, { status: "paused" })}>
                    Pause
                  </Button>
                )}
                {job.status === "paused" && (
                  <Button icon="mdiPlay" onClick={() => change(job.id, { status: progress >= 8 ? "rendering" : "queued" })}>
                    Resume
                  </Button>
                )}
                {ACTIVE.includes(job.status) && (
                  <Button icon="mdiCancel" onClick={() => change(job.id, { status: "cancelled" })}>
                    Cancel
                  </Button>
                )}
                {job.status === "completed" && (
                  <Button icon="mdiOpenInApp" primary onClick={() => openResult(job)}>
                    Open result
                  </Button>
                )}
                {["failed", "cancelled"].includes(job.status) && (
                  <Button icon="mdiRefresh" onClick={() => change(job.id, { status: "queued", progress: 0, error: undefined })}>
                    Retry
                  </Button>
                )}
                {!ACTIVE.includes(job.status) && (
                  <Button icon="mdiClose" aria-label={`Remove ${title} from the list`} onClick={() => remove(job.id)} />
                )}
              </div>
            </article>
          );
        })}
      </div>

      <div className="fla-footer">
        <span className="muted">Jobs run on your server and keep going when you leave this page.</span>
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
