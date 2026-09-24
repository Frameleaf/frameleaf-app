import React, { useEffect, useRef, useState } from "react";
import { Button, Dialog } from "./App";
import { Icon } from "./Icon";
import {
  JOBS_STORAGE_KEY,
  JOB_OWNERS,
  QUEUE_CATALOG,
  MANUAL_JOBS,
  createJobsState,
  parseJobsState,
  serializeJobsState,
  queueById,
  jobTitle,
  normalizeJobScope,
  queueCounts,
  queueStatus,
  selectJobs,
  featureDisabled,
  concurrencyValue,
  validateConcurrency,
  reviewJobsAction,
  applyJobsAction,
} from "./jobs-data.mjs";
import "./jobs-manager.css";
import {
  RUNPOD_STORAGE_KEY,
  RUNPOD_GPUS,
  SMART_ALBUM_KINDS,
  createRunPodState,
  parseRunPodState,
  runPodActionReview,
  applyRunPodAction,
  descriptionHardwarePreset,
} from "./jobs-data.mjs";

const number = (value) => new Intl.NumberFormat("en-CA").format(value);
const ownerName = (id) =>
  JOB_OWNERS.find((owner) => owner.id === id)?.name || "Selected account";
const destinationName = (id) =>
  ({ local: "Local / LAN", runpod: "RunPod", server: "Server" })[id];
const timestamp = (value) =>
  new Intl.DateTimeFormat("en-CA", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
const readState = () => {
  try {
    return parseJobsState(localStorage.getItem(JOBS_STORAGE_KEY));
  } catch {
    return createJobsState();
  }
};
const tabs = [
  { id: "active", label: "Active" },
  { id: "waiting", label: "Waiting" },
  { id: "failed", label: "Failed" },
  { id: "history", label: "History" },
];
function Status({ value }) {
  return (
    <span className={`jm-status jm-status-${value}`}>
      <i />
      {{
        active: "Processing",
        waiting: "Waiting",
        paused: "Paused",
        delayed: "Scheduled",
        failed: "Needs attention",
        completed: "Completed",
        idle: "Idle",
      }[value] || value}
    </span>
  );
}
function Metric({ label, value, icon, warning }) {
  return (
    <div className={warning ? "jm-metric warning" : "jm-metric"}>
      <Icon name={icon} />
      <div>
        <span>{label}</span>
        <strong>{number(value)}</strong>
      </div>
    </div>
  );
}

export function JobsManager({
  settings = {},
  draft = settings,
  onSettingChange,
  onNavigate,
  scope,
  onScopeChange,
}) {
  const [state, setState] = useState(readState);
  const [review, setReview] = useState(null);
  const [detail, setDetail] = useState(null);
  const [manual, setManual] = useState(false);
  const [concurrency, setConcurrency] = useState(false);
  const [enrichment, setEnrichment] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [page, setPage] = useState(1);
  const scopeRef = useRef();
  const main = useRef(null);
  const view =
    scope !== undefined && scope !== scopeRef.current
      ? { ...state.view, owner: normalizeJobScope(scope) }
      : state.view;
  const queue = queueById(view.queueId);
  const counts = queueCounts(state, view.queueId, view.owner);
  const allCounts = queueCounts(state, view.queueId);
  const pendingChanges = QUEUE_CATALOG.filter(
    (item) =>
      !item.fixed &&
      String(concurrencyValue(item, settings)) !==
        String(concurrencyValue(item, draft)),
  ).length;
  const paused = QUEUE_CATALOG.filter(
    (item) => state.queues[item.id].paused,
  ).length;
  function persist(next) {
    try {
      const latest = parseJobsState(localStorage.getItem(JOBS_STORAGE_KEY));
      if (latest.revision !== state.revision) {
        setState(latest);
        setReview(null);
        setDetail(null);
        setError(
          "Activity changed in another tab. Review the latest state before continuing.",
        );
        return false;
      }
      localStorage.setItem(JOBS_STORAGE_KEY, serializeJobsState(next));
      setState(next);
      setError("");
      return true;
    } catch {
      setError(
        "Device storage is unavailable. This change has not been saved.",
      );
      return false;
    }
  }
  function updateView(next) {
    if (persist({ ...state, view: { ...view, ...next } })) {
      setPage(1);
      if (next.owner !== undefined) onScopeChange?.(next.owner);
    }
  }
  useEffect(() => {
    if (scope === scopeRef.current) return;
    scopeRef.current = scope;
    if (scope !== undefined)
      setState((previous) => ({
        ...previous,
        view: { ...previous.view, owner: normalizeJobScope(scope) },
      }));
  }, [scope]);
  useEffect(() => {
    const sync = (event) => {
      if (event.key !== JOBS_STORAGE_KEY && event.key !== null) return;
      const next = parseJobsState(event.newValue);
      setState(next);
      setReview(null);
      setDetail(null);
      setPage(1);
      setNotice("Activity was updated in another tab.");
    };
    addEventListener("storage", sync);
    return () => removeEventListener("storage", sync);
  }, []);
  useEffect(() => {
    setDetail(null);
    setPage(1);
  }, [view.owner, view.queueId, view.tab, view.query]);
  function request(action) {
    const summary = reviewJobsAction(state, action, settings);
    if (summary.error) {
      setNotice(summary.error);
      return;
    }
    setReview({ action, summary });
  }
  function confirm(confirmed) {
    try {
      const next = applyJobsAction(
        state,
        review.action,
        {
          id: crypto.randomUUID(),
          at: new Date().toISOString(),
          expectedRevision: review.summary.revision,
          confirmed,
        },
        settings,
      );
      if (persist(next)) {
        setReview(null);
        setManual(false);
        setNotice(`${review.summary.title}: activity updated on this device.`);
      }
    } catch (cause) {
      setError(cause.message);
      setReview(null);
    }
  }
  function openQueue(id) {
    updateView({ queueId: id, query: "", tab: "active" });
    main.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }
  const visibleQueues = QUEUE_CATALOG.filter((item) => {
    const status = queueStatus(state, item.id);
    const terms = view.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return (
      (view.category === "all" || view.category === item.category) &&
      (view.status === "all" || view.status === status) &&
      terms.every((term) =>
        `${item.title} ${item.description} ${item.id}`
          .toLowerCase()
          .includes(term),
      )
    );
  });
  const jobs = selectJobs(state, { ...view });
  const scopedHistory = state.history.filter(
    (item) => view.queueId === "all" || item.queueId === view.queueId,
  );
  const pageSize = 12;
  const shownJobs = jobs.slice(0, page * pageSize);
  const selectedJob = state.jobs.find(
    (job) =>
      job.id === detail && (view.owner === "all" || job.ownerId === view.owner),
  );
  const newJobCount = state.jobs.filter(
    (job) => job.ownerId === "system" && job.id.startsWith("job-"),
  ).length;
  return (
    <section className="jobs-manager" aria-label="Job management" ref={main}>
      <header className="jm-header">
        <div>
          <p className="jm-eyebrow">Compute &amp; jobs</p>
          <h2>{queue ? queue.title : "Queues & jobs"}</h2>
          <p>
            {queue
              ? queue.description
              : "Keep indexing moving, resolve failures, and balance work across your server."}
          </p>
        </div>
        <div className="jm-header-actions">
          {queue && (
            <Button
              icon="mdiArrowLeft"
              onClick={() => updateView({ queueId: "all", query: "" })}
            >
              All queues
            </Button>
          )}
          {!!paused && (
            <Button
              icon="mdiPlay"
              onClick={() => request({ type: "resume-all" })}
            >
              Resume {paused} paused
            </Button>
          )}
          <Button icon="mdiTuneVariant" onClick={() => setConcurrency(true)}>
            Concurrency{pendingChanges ? ` · ${pendingChanges} pending` : ""}
          </Button>
          <Button
            icon="mdiImageSearchOutline"
            onClick={() => setEnrichment(true)}
          >
            Enrichment tasks
          </Button>
          <Button primary icon="mdiPlus" onClick={() => setManual(true)}>
            Create job
          </Button>
        </div>
      </header>
      <div className="jm-metrics">
        <Metric label="Processing" value={counts.active} icon="mdiPlay" />
        <Metric
          label="Waiting & scheduled"
          value={counts.pending}
          icon="mdiClockOutline"
        />
        <Metric
          label="Failed"
          value={counts.failed}
          icon="mdiAlertCircleOutline"
          warning={counts.failed > 0}
        />
        <Metric
          label="Completed in activity"
          value={counts.completed}
          icon="mdiCheckCircleOutline"
        />
      </div>
      {error && (
        <div className="jm-message jm-error" role="alert">
          <Icon name="mdiAlertCircleOutline" />
          {error}
          <Button
            onClick={() => setError("")}
            aria-label="Dismiss error"
            icon="mdiClose"
          />
        </div>
      )}
      {notice && (
        <div className="jm-message" role="status">
          <Icon name="mdiCheckCircleOutline" />
          {notice}
          <Button
            onClick={() => setNotice("")}
            aria-label="Dismiss notice"
            icon="mdiClose"
          />
        </div>
      )}
      <div className="jm-filterbar">
        <label className="jm-search">
          <Icon name="mdiMagnify" />
          <span className="jm-sr">
            {queue ? "Search jobs" : "Search queues"}
          </span>
          <input
            type="search"
            maxLength={200}
            placeholder={
              queue ? "Search filenames, job IDs, errors…" : "Find a queue…"
            }
            value={view.query}
            onChange={(event) => updateView({ query: event.target.value })}
          />
        </label>
        <label>
          <span>Account</span>
          <select
            aria-label="Account filter"
            value={view.owner}
            onChange={(event) => updateView({ owner: event.target.value })}
          >
            {JOB_OWNERS.map((owner) => (
              <option key={owner.id} value={owner.id}>
                {owner.name}
              </option>
            ))}
            {!JOB_OWNERS.some((owner) => owner.id === view.owner) && (
              <option value={view.owner}>Selected account</option>
            )}
          </select>
        </label>
        {!queue && (
          <>
            <label>
              <span>Category</span>
              <select
                value={view.category}
                onChange={(event) =>
                  updateView({ category: event.target.value })
                }
              >
                <option value="all">All categories</option>
                {["Media", "Intelligence", "Maintenance", "System"].map(
                  (category) => (
                    <option key={category}>{category}</option>
                  ),
                )}
              </select>
            </label>
            <label>
              <span>Status</span>
              <select
                value={view.status}
                onChange={(event) => updateView({ status: event.target.value })}
              >
                {[
                  ["all", "Any status"],
                  ["active", "Processing"],
                  ["paused", "Paused"],
                  ["failed", "Needs attention"],
                  ["idle", "Idle"],
                ].map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
      </div>
      <p className="jm-scope">
        <Icon name="mdiAccountMultipleOutline" />
        Counts and job details: {ownerName(view.owner)}. Queue controls and
        concurrency affect every account.
      </p>
      {state.descriptionDeferred && (
        <div className="jm-message">
          <Icon name="mdiClockOutline" />
          Description regeneration is waiting for your review.
          <Button onClick={() => setEnrichment(true)}>Review reminder</Button>
        </div>
      )}
      {!queue ? (
        <>
          <div
            className="jm-table-wrap"
            tabIndex={0}
            role="region"
            aria-label="Processing queues"
          >
            <table className="jm-queues">
              <thead>
                <tr>
                  <th scope="col">Queue</th>
                  <th scope="col">Status</th>
                  <th scope="col">Active</th>
                  <th scope="col">Waiting</th>
                  <th scope="col">Failed</th>
                  <th scope="col">Workers</th>
                  <th scope="col">
                    <span className="jm-sr">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visibleQueues.map((item) => {
                  const count = queueCounts(state, item.id, view.owner);
                  const disabled = featureDisabled(item, settings);
                  return (
                    <tr key={item.id}>
                      <th scope="row">
                        <button
                          className="jm-queue-name"
                          onClick={() => openQueue(item.id)}
                        >
                          <span className="jm-queue-icon">
                            <Icon name={item.icon} />
                          </span>
                          <span>
                            {item.title}
                            <small>
                              {item.category}
                              {disabled ? " · feature off" : ""}
                            </small>
                          </span>
                        </button>
                      </th>
                      <td>
                        <Status value={queueStatus(state, item.id)} />
                      </td>
                      <td>{number(count.active)}</td>
                      <td>{number(count.pending)}</td>
                      <td>
                        <button
                          className={
                            count.failed ? "jm-error-count" : "jm-count"
                          }
                          disabled={!count.failed}
                          onClick={() =>
                            updateView({
                              queueId: item.id,
                              tab: "failed",
                              query: "",
                            })
                          }
                        >
                          {number(count.failed)}
                        </button>
                      </td>
                      <td>
                        <button
                          className="jm-workers"
                          onClick={() => setConcurrency(true)}
                          aria-label={`${item.title} concurrency ${concurrencyValue(item, draft)}`}
                        >
                          <strong>
                            {concurrencyValue(item, draft) || "—"}
                          </strong>
                          {item.fixed ? (
                            <span>fixed</span>
                          ) : String(concurrencyValue(item, settings)) !==
                            String(concurrencyValue(item, draft)) ? (
                            <span className="jm-pending">pending</span>
                          ) : null}
                        </button>
                      </td>
                      <td>
                        <Button
                          icon={
                            state.queues[item.id].paused
                              ? "mdiPlay"
                              : "mdiPause"
                          }
                          disabled={!item.canPause}
                          title={
                            !item.canPause
                              ? "Essential background work must stay available"
                              : state.queues[item.id].paused
                                ? "Resume queue"
                                : "Pause queue"
                          }
                          aria-label={`${state.queues[item.id].paused ? "Resume" : "Pause"} ${item.title}`}
                          onClick={() =>
                            request({
                              type: state.queues[item.id].paused
                                ? "resume"
                                : "pause",
                              queueId: item.id,
                            })
                          }
                        />
                        <Button
                          icon="mdiChevronRight"
                          aria-label={`Open ${item.title}`}
                          onClick={() => openQueue(item.id)}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!visibleQueues.length && (
              <div className="jm-empty">
                <Icon name="mdiMagnify" />
                <h3>No matching queues</h3>
                <p>
                  Try another name or clear the category and status filters.
                </p>
                <Button
                  onClick={() =>
                    updateView({ query: "", category: "all", status: "all" })
                  }
                >
                  Clear filters
                </Button>
              </div>
            )}
          </div>
          <div className="jm-footer-note">
            <span>
              {visibleQueues.length} of {QUEUE_CATALOG.length} queues ·{" "}
              {newJobCount} tasks added
            </span>
            <Button
              icon="mdiShieldCheckOutline"
              onClick={() => onNavigate?.("care", "")}
            >
              Open Library Care
            </Button>
          </div>
        </>
      ) : (
        <>
          <div className="jm-queue-actions">
            <div>
              <Status value={queueStatus(state, queue.id)} />
              <span>
                {number(allCounts.active)} active across all accounts ·{" "}
                {concurrencyValue(queue, settings)}{" "}
                {Number(concurrencyValue(queue, settings)) === 1
                  ? "worker"
                  : "workers"}
                {queue.fixed ? " · fixed" : ""}
              </span>
            </div>
            <div>
              <Button
                icon={state.queues[queue.id].paused ? "mdiPlay" : "mdiPause"}
                disabled={!queue.canPause}
                onClick={() =>
                  request({
                    type: state.queues[queue.id].paused ? "resume" : "pause",
                    queueId: queue.id,
                  })
                }
              >
                {state.queues[queue.id].paused ? "Resume" : "Pause"}
              </Button>
              {queue.startJob && (
                <Button
                  primary
                  icon="mdiPlay"
                  disabled={
                    !!reviewJobsAction(
                      state,
                      { type: "missing", queueId: queue.id },
                      settings,
                    ).error
                  }
                  title={
                    reviewJobsAction(
                      state,
                      { type: "missing", queueId: queue.id },
                      settings,
                    ).error
                  }
                  onClick={() =>
                    request({ type: "missing", queueId: queue.id })
                  }
                >
                  {queue.runLabel}
                </Button>
              )}
              {queue.canRefresh && (
                <Button
                  disabled={
                    !!reviewJobsAction(
                      state,
                      { type: "refresh", queueId: queue.id },
                      settings,
                    ).error
                  }
                  onClick={() =>
                    request({ type: "refresh", queueId: queue.id })
                  }
                >
                  Refresh faces
                </Button>
              )}
              {queue.canForce && (
                <Button
                  disabled={
                    !!reviewJobsAction(
                      state,
                      { type: "force", queueId: queue.id },
                      settings,
                    ).error
                  }
                  onClick={() => request({ type: "force", queueId: queue.id })}
                >
                  {queue.forceLabel}
                </Button>
              )}
            </div>
          </div>
          {featureDisabled(queue, settings) && (
            <div className="jm-message">
              <Icon name="mdiCogOutline" />
              This feature is off. Enable it before starting a library scan.
              <Button
                onClick={() =>
                  onNavigate?.(
                    "intelligence",
                    queue.id === "ocr"
                      ? "ocr"
                      : queue.id === "imageDescription"
                        ? "descriptions"
                        : queue.id === "nsfwDetection"
                          ? "sensitive-detection"
                          : "smart-search",
                  )
                }
              >
                Feature settings
              </Button>
            </div>
          )}
          <div className="jm-tabs" role="tablist" aria-label="Job state">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                id={`jm-tab-${tab.id}`}
                role="tab"
                aria-selected={view.tab === tab.id}
                aria-controls="jm-jobs-panel"
                tabIndex={view.tab === tab.id ? 0 : -1}
                onKeyDown={(event) => {
                  const index = tabs.findIndex((item) => item.id === view.tab);
                  const next =
                    event.key === "ArrowRight"
                      ? tabs[(index + 1) % tabs.length]
                      : event.key === "ArrowLeft"
                        ? tabs[(index + tabs.length - 1) % tabs.length]
                        : event.key === "Home"
                          ? tabs[0]
                          : event.key === "End"
                            ? tabs.at(-1)
                            : null;
                  if (next) {
                    event.preventDefault();
                    updateView({ tab: next.id });
                    document.getElementById(`jm-tab-${next.id}`)?.focus();
                  }
                }}
                onClick={() => updateView({ tab: tab.id })}
              >
                {tab.label}
                <span>
                  {number(
                    tab.id === "history"
                      ? counts.completed
                      : tab.id === "waiting"
                        ? counts.pending
                        : counts[tab.id],
                  )}
                </span>
              </button>
            ))}
          </div>
          <div className="jm-tab-actions">
            <p>
              {view.tab === "active"
                ? "Active jobs finish even when their queue is paused."
                : view.tab === "waiting"
                  ? "Scheduled jobs remain separate when waiting work is cleared."
                  : view.tab === "failed"
                    ? "Read the error and resolve its cause before retrying."
                    : "Completed work retained in this activity view."}
            </p>
            {view.tab === "failed" && (
              <div>
                <Button
                  icon="mdiRedo"
                  disabled={!allCounts.failed}
                  onClick={() =>
                    request({ type: "retry-failed", queueId: queue.id })
                  }
                >
                  Retry failed
                </Button>
                <Button
                  disabled={!allCounts.failed}
                  onClick={() =>
                    request({ type: "remove-failed", queueId: queue.id })
                  }
                >
                  Remove failed records
                </Button>
              </div>
            )}
            {view.tab === "waiting" && (
              <Button
                disabled={!allCounts.waiting && !allCounts.paused}
                onClick={() =>
                  request({ type: "clear-waiting", queueId: queue.id })
                }
              >
                Clear waiting jobs
              </Button>
            )}
          </div>
          <div
            id="jm-jobs-panel"
            role="tabpanel"
            aria-labelledby={`jm-tab-${view.tab}`}
            tabIndex={0}
            className="jm-table-wrap"
          >
            <table className="jm-jobs">
              <thead>
                <tr>
                  <th scope="col">Job</th>
                  <th scope="col">Account</th>
                  <th scope="col">Worker</th>
                  <th scope="col">Status</th>
                  <th scope="col">Created</th>
                  <th scope="col">
                    <span className="jm-sr">Details</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {shownJobs.map((job) => (
                  <tr key={job.id}>
                    <th scope="row">
                      <button
                        className="jm-job-name"
                        onClick={() => setDetail(job.id)}
                      >
                        {job.asset}
                        <small>{jobTitle(job)}</small>
                        {job.status === "failed" && (
                          <span className="jm-job-error">{job.error}</span>
                        )}
                      </button>
                    </th>
                    <td>{ownerName(job.ownerId)}</td>
                    <td>
                      <span className="jm-destination">
                        <Icon
                          name={
                            job.destination === "runpod"
                              ? "mdiCloudOutline"
                              : "mdiDesktopTowerMonitor"
                          }
                        />
                        {destinationName(job.destination)}
                      </span>
                    </td>
                    <td>
                      <Status value={job.status} />
                      {job.status === "active" && (
                        <progress
                          aria-label={`${job.asset} progress`}
                          value={job.progress}
                          max={100}
                        />
                      )}
                    </td>
                    <td>
                      <time dateTime={job.createdAt}>
                        {timestamp(job.createdAt)}
                      </time>
                    </td>
                    <td>
                      <Button
                        icon="mdiChevronRight"
                        aria-label={`Details for ${job.asset}`}
                        onClick={() => setDetail(job.id)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!jobs.length && (
              <div className="jm-empty">
                <Icon
                  name={
                    view.tab === "failed"
                      ? "mdiCheckCircleOutline"
                      : "mdiClockOutline"
                  }
                />
                <h3>
                  {view.tab === "failed"
                    ? "No failures to review"
                    : `No ${view.tab === "history" ? "completed" : view.tab} jobs here`}
                </h3>
                <p>
                  {view.owner === "all"
                    ? "Choose another state or clear the search."
                    : `No matching jobs for ${ownerName(view.owner)}. Other accounts may still have work in this queue.`}
                </p>
              </div>
            )}
          </div>
          {jobs.length > shownJobs.length && (
            <Button
              className="jm-load-more"
              onClick={() => setPage((value) => value + 1)}
            >
              Show more · {jobs.length - shownJobs.length} remaining
            </Button>
          )}
        </>
      )}
      <details className="jm-history">
        <summary>
          <Icon name="mdiHistory" />
          Queue action history <span>{scopedHistory.length}</span>
        </summary>
        <p>
          Server-wide actions made on this device. These records describe queue
          commands, not completed processing.
        </p>
        {!scopedHistory.length ? (
          <p className="jm-muted">No queue changes recorded yet.</p>
        ) : (
          <ol>
            {scopedHistory.slice(0, 40).map((item) => (
              <li key={item.id}>
                <div>
                  <strong>{item.title}</strong>
                  <span>{item.detail}</span>
                </div>
                <time dateTime={item.at}>{timestamp(item.at)}</time>
              </li>
            ))}
          </ol>
        )}
      </details>
      {review && (
        <ReviewDialog
          review={review.summary}
          close={() => setReview(null)}
          confirm={confirm}
        />
      )}
      {manual && (
        <ManualDialog
          close={() => setManual(false)}
          onSelect={(manualId) => {
            setManual(false);
            if (manualId.startsWith("physical-deduplication-")) {
              onNavigate?.("storage", "deduplication");
              return;
            }
            request({ type: "manual", manualId });
          }}
          settings={settings}
        />
      )}
      {enrichment && (
        <EnrichmentJobDialog
          close={() => setEnrichment(false)}
          onAction={(action) => {
            setEnrichment(false);
            request(action);
          }}
          onSettingChange={onSettingChange}
          onNavigate={onNavigate}
        />
      )}
      {concurrency && (
        <ConcurrencyDialog
          settings={settings}
          draft={draft}
          onChange={onSettingChange}
          close={() => setConcurrency(false)}
          onReview={() => {
            setConcurrency(false);
            onNavigate?.("processing", "queues");
          }}
        />
      )}
      {selectedJob && (
        <Dialog
          title={selectedJob.asset}
          close={() => setDetail(null)}
          actions={
            <Button primary onClick={() => setDetail(null)}>
              Done
            </Button>
          }
        >
          <div className="jm-job-detail">
            <Status value={selectedJob.status} />
            <dl>
              <div>
                <dt>Job</dt>
                <dd>{jobTitle(selectedJob)}</dd>
              </div>
              <div>
                <dt>Account</dt>
                <dd>{ownerName(selectedJob.ownerId)}</dd>
              </div>
              <div>
                <dt>Worker</dt>
                <dd>{destinationName(selectedJob.destination)}</dd>
              </div>
              <div>
                <dt>Attempt</dt>
                <dd>{selectedJob.attempt}</dd>
              </div>
              <div>
                <dt>Created</dt>
                <dd>{timestamp(selectedJob.createdAt)}</dd>
              </div>
            </dl>
            {selectedJob.error && (
              <div className="jm-failure">
                <h3>Last error</h3>
                <p>{selectedJob.error}</p>
                <Button
                  onClick={() => {
                    setDetail(null);
                    onNavigate?.("processing", "workers");
                  }}
                >
                  Check workers
                </Button>
              </div>
            )}
            <details>
              <summary>Optional technical details</summary>
              <dl>
                <div>
                  <dt>Job ID</dt>
                  <dd>
                    <code>{selectedJob.id}</code>
                  </dd>
                </div>
                <div>
                  <dt>Handler</dt>
                  <dd>
                    <code>{selectedJob.name}</code>
                  </dd>
                </div>
              </dl>
              <pre>{selectedJob.details}</pre>
            </details>
          </div>
        </Dialog>
      )}
    </section>
  );
}
function ReviewDialog({ review, close, confirm }) {
  const [ack, setAck] = useState(false);
  return (
    <Dialog
      title={review.title}
      close={close}
      actions={
        <>
          <Button onClick={close}>Keep current state</Button>
          <Button
            primary
            disabled={review.dangerous && !ack}
            onClick={() => confirm(ack)}
          >
            {review.title}
          </Button>
        </>
      }
    >
      <div className="jm-review">
        <p>{review.detail}</p>
        <dl>
          <div>
            <dt>Scope</dt>
            <dd>{review.scope}</dd>
          </div>
          <div>
            <dt>Affected now</dt>
            <dd>
              {number(review.affected)}{" "}
              {review.affected === 1 ? "item" : "items"}
            </dd>
          </div>
        </dl>
        <p className="jm-muted">
          Changing an account filter does not limit a queue command.
        </p>
        {review.dangerous && (
          <label className="jm-confirm">
            <input
              type="checkbox"
              checked={ack}
              onChange={(event) => setAck(event.target.checked)}
            />
            I have reviewed the effect on this queue and all accounts.
          </label>
        )}
      </div>
    </Dialog>
  );
}
function ManualDialog({ close, onSelect }) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState("");
  const matches = MANUAL_JOBS.filter((job) =>
    `${job.title} ${job.description}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const task = MANUAL_JOBS.find((job) => job.id === selected);
  return (
    <Dialog
      wide
      title="Create a maintenance job"
      close={close}
      actions={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button primary disabled={!task} onClick={() => onSelect(selected)}>
            Review job
          </Button>
        </>
      }
    >
      <div className="jm-manual">
        <p>
          Choose a task. Maintenance jobs run across the server; an account
          filter does not narrow their scope.
        </p>
        <label className="jm-search">
          <Icon name="mdiMagnify" />
          <input
            autoFocus
            aria-label="Search maintenance jobs"
            type="search"
            maxLength={200}
            placeholder="Search maintenance tasks…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="jm-manual-list">
          {matches.map((job) => (
            <label
              key={job.id}
              className={selected === job.id ? "selected" : ""}
            >
              <input
                type="radio"
                name="manual-job"
                value={job.id}
                checked={selected === job.id}
                onChange={() => setSelected(job.id)}
              />
              <span>
                <strong>{job.title}</strong>
                <small>{job.description}</small>
                <em>
                  {queueById(job.queueId).title}
                  {job.dangerous ? " · review required" : ""}
                </em>
              </span>
            </label>
          ))}
          {!matches.length && <p>No matching maintenance tasks.</p>}
        </div>
      </div>
    </Dialog>
  );
}
function ConcurrencyDialog({ settings, draft, onChange, close, onReview }) {
  const [search, setSearch] = useState("");
  const queues = QUEUE_CATALOG.filter((queue) =>
    `${queue.title} ${queue.category}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  const pending = QUEUE_CATALOG.filter(
    (queue) =>
      !queue.fixed &&
      String(concurrencyValue(queue, settings)) !==
        String(concurrencyValue(queue, draft)),
  ).length;
  return (
    <Dialog
      wide
      title="Queue concurrency"
      close={close}
      actions={
        <>
          <Button onClick={close}>Done</Button>
          {pending > 0 && (
            <Button primary onClick={onReview}>
              Review {pending} pending settings
            </Button>
          )}
        </>
      }
    >
      <div className="jm-concurrency">
        <p>
          Set simultaneous jobs per server worker. Higher limits can compete for
          CPU, GPU memory, and storage bandwidth.
        </p>
        <div className="jm-message">
          <Icon name="mdiClockOutline" />
          Saved limits control the next jobs admitted. Active jobs continue;
          reducing the limit does not cancel them.
        </div>
        <label className="jm-search">
          <Icon name="mdiMagnify" />
          <input
            type="search"
            maxLength={200}
            aria-label="Find queue concurrency"
            placeholder="Find a queue…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <div className="jm-concurrency-list">
          {queues.map((queue) => {
            const value = concurrencyValue(queue, draft);
            const previous = concurrencyValue(queue, settings);
            const error = queue.fixed ? "" : validateConcurrency(value);
            return (
              <label key={queue.id} className="jm-concurrency-row">
                <span>
                  <strong>{queue.title}</strong>
                  <small>
                    {queue.fixed
                      ? "Fixed at one to keep operations ordered"
                      : `${queue.category} · ${previous} currently saved`}
                  </small>
                </span>
                <span>
                  <input
                    aria-label={`${queue.title} simultaneous jobs`}
                    type="number"
                    min={1}
                    max={1000}
                    step={1}
                    disabled={queue.fixed || !onChange}
                    value={value}
                    aria-invalid={!!error}
                    onChange={(event) =>
                      onChange?.(queue.setting, event.target.value)
                    }
                  />
                  {!queue.fixed && String(value) !== String(previous) && (
                    <small className="jm-pending">Pending</small>
                  )}
                  {error && <small className="jm-input-error">{error}</small>}
                </span>
              </label>
            );
          })}
        </div>
        <p className="jm-muted">
          Concurrency changes join the settings review. They do not change a
          job’s destination or retry a failure.
        </p>
      </div>
    </Dialog>
  );
}

function EnrichmentJobDialog({ close, onAction, onSettingChange, onNavigate }) {
  const [task, setTask] = useState("descriptions");
  const [timing, setTiming] = useState("now");
  const [kind, setKind] = useState("all");
  const [preset, setPreset] = useState("auto");
  const [changed, setChanged] = useState(false);
  function applyPreset() {
    for (const [id, value] of Object.entries(descriptionHardwarePreset(preset)))
      onSettingChange?.(id, value);
    setChanged(true);
  }
  return (
    <Dialog
      title="Enrichment tasks"
      close={close}
      actions={
        <>
          <Button onClick={close}>Cancel</Button>
          {task === "hardware" ? (
            <Button primary disabled={!onSettingChange} onClick={applyPreset}>
              Add preset to settings review
            </Button>
          ) : (
            <Button
              primary
              onClick={() =>
                onAction(
                  task === "descriptions"
                    ? {
                        type:
                          timing === "now"
                            ? "description-requeue"
                            : "description-defer",
                      }
                    : {
                        type: "smart-album",
                        ...(kind === "all" ? {} : { kind }),
                      },
                )
              }
            >
              Review task
            </Button>
          )}
        </>
      }
    >
      <div className="jm-enrichment-form">
        <label>
          Task
          <select
            value={task}
            onChange={(event) => setTask(event.target.value)}
          >
            <option value="descriptions">Regenerate descriptions</option>
            <option value="smart-albums">Re-evaluate smart albums</option>
            <option value="hardware">
              Apply a description hardware preset
            </option>
          </select>
        </label>
        {task === "descriptions" && (
          <>
            <p>
              Use the saved description model and prompt across eligible assets.
              Existing description work prevents a duplicate request.
            </p>
            <label>
              When
              <select
                value={timing}
                onChange={(event) => setTiming(event.target.value)}
              >
                <option value="now">Queue now</option>
                <option value="later">Remind me later</option>
              </select>
            </label>
            <p className="jm-muted">
              All accounts. Pending settings are not applied by this task.
            </p>
          </>
        )}
        {task === "smart-albums" && (
          <>
            <label>
              Categories
              <select
                value={kind}
                onChange={(event) => setKind(event.target.value)}
              >
                <option value="all">All built-in categories</option>
                {SMART_ALBUM_KINDS.map((value) => (
                  <option key={value} value={value}>
                    {value[0].toUpperCase() + value.slice(1)}
                  </option>
                ))}
              </select>
            </label>
            <p>
              Recheck images that already have descriptions. This updates
              category membership without generating new descriptions.
            </p>
            <p className="jm-muted">
              All accounts. An identical category request is not queued twice.
            </p>
          </>
        )}
        {task === "hardware" && (
          <>
            <label>
              Acceleration
              <select
                value={preset}
                onChange={(event) => {
                  setPreset(event.target.value);
                  setChanged(false);
                }}
              >
                <option value="auto">
                  Auto · keep models until hardware is known
                </option>
                <option value="openvino">OpenVINO</option>
                <option value="cuda">CUDA</option>
              </select>
            </label>
            <p>
              {preset === "auto"
                ? "No hardware has been detected here. Auto changes the acceleration preference while retaining your model choices."
                : "The preset selects Qwen2.5-VL 3B, Florence-2 fallback, automatic devices, and the compatible Locked-content model."}
            </p>
            <p className="jm-muted">
              A preset does not verify endpoint compatibility. Model changes
              join the global settings review.
            </p>
            {changed && (
              <div className="jm-message" role="status">
                Preset added to pending settings.
                <Button
                  onClick={() => {
                    close();
                    onNavigate?.(
                      "intelligence",
                      "advanced-description-runtime",
                    );
                  }}
                >
                  Review model settings
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}

const readProvider = () => {
  try {
    return parseRunPodState(localStorage.getItem(RUNPOD_STORAGE_KEY));
  } catch {
    return createRunPodState();
  }
};
const providerStatus = {
  idle: "Not launched",
  provisioning: "Provisioning",
  starting: "Starting",
  running: "GPU running",
  stopping: "Stopping",
  stopped: "Stopped",
  error: "Needs attention",
  "serverless-provisioning": "Creating endpoint",
  "serverless-ready": "Endpoint provisioned",
};
export function RunPodManager({ settings = {}, onNavigate }) {
  const [state, setState] = useState(readProvider);
  const [review, setReview] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [gpuId, setGpuId] = useState(
    RUNPOD_GPUS.some((gpu) => gpu.id === settings.advancedRunPodGpu)
      ? settings.advancedRunPodGpu
      : state.gpuId,
  );
  const [gpuCount, setGpuCount] = useState(state.gpuCount);
  const [hours, setHours] = useState(
    settings.advancedRunPodRuntime ?? state.runtimeHours,
  );
  const mode = settings.advancedRunPodMode || "disabled";
  const resourceMode = state.podId
    ? "pod"
    : state.endpointId
      ? "serverless"
      : mode;
  const enabled = mode !== "disabled" && settings.runpodEnabled !== false;
  const gpu = RUNPOD_GPUS.find((item) => item.id === gpuId);
  const cost =
    gpu && Number.isFinite(Number(hours)) && Number.isFinite(Number(gpuCount))
      ? gpu.rate * Number(hours) * Number(gpuCount)
      : null;
  const launchValid =
    /^[1-8]$/.test(String(gpuCount)) &&
    /^\d+$/.test(String(hours)) &&
    Number(hours) >= 1 &&
    Number(hours) <= 168;
  useEffect(() => {
    const sync = (event) => {
      if (event.key === RUNPOD_STORAGE_KEY || event.key === null) {
        setState(parseRunPodState(event.newValue));
        setReview(null);
        setNotice("Worker activity was updated in another tab.");
      }
    };
    addEventListener("storage", sync);
    return () => removeEventListener("storage", sync);
  }, []);
  function request(type) {
    const action = { type, gpuId, gpuCount, runtimeHours: hours };
    const result = runPodActionReview(state, action);
    if (result.error) {
      setError(result.error);
      return;
    }
    setReview({ action, result, savedMode: mode });
  }
  function confirm(accepted) {
    try {
      if (review.result.cloud && (!enabled || mode !== review.savedMode)) {
        setReview(null);
        throw new Error(
          "Cloud settings changed. Review the saved mode and choose the operation again.",
        );
      }
      const latest = parseRunPodState(localStorage.getItem(RUNPOD_STORAGE_KEY));
      if (latest.revision !== state.revision) {
        setState(latest);
        setReview(null);
        throw new Error(
          "Worker activity changed in another tab. Review its latest state before continuing.",
        );
      }
      const next = applyRunPodAction(state, review.action, {
        id: crypto.randomUUID(),
        at: new Date().toISOString(),
        expectedRevision: review.result.revision,
        confirmed: accepted,
        cloudAcknowledged: accepted,
      });
      localStorage.setItem(RUNPOD_STORAGE_KEY, JSON.stringify(next));
      setState(next);
      setReview(null);
      setError("");
      setNotice(
        review.action.type === "backfill"
          ? "Backfill request prepared for review; no media has been transferred."
          : "Worker activity updated on this device.",
      );
    } catch (cause) {
      setError(cause.message || "The change could not be saved.");
    }
  }
  const can = (type) => !runPodActionReview(state, { type }).error;
  return (
    <section
      className="jobs-manager jm-provider"
      aria-label="RunPod operations"
    >
      <header className="jm-header">
        <div>
          <p className="jm-eyebrow">Compute &amp; jobs</p>
          <h2>RunPod workers</h2>
          <p>
            Manage ordinary ML workers, their lifecycle, and their processing
            scope.
          </p>
        </div>
        <div className="jm-header-actions">
          <Button
            icon="mdiCogOutline"
            onClick={() =>
              onNavigate?.("processing", "advanced-runpod-ordinary")
            }
          >
            Provider settings
          </Button>
          <Button icon="mdiRedo" onClick={() => request("refresh")}>
            Refresh status
          </Button>
        </div>
      </header>
      <div className="jm-provider-state">
        <span className="jm-queue-icon">
          <Icon name="mdiCloudOutline" />
        </span>
        <div>
          <strong>{providerStatus[state.status]}</strong>
          <span>
            {mode === "disabled"
              ? "Cloud processing is disabled"
              : mode === "serverless"
                ? "Serverless ML endpoint"
                : "Managed ML Pod"}{" "}
            · all accounts
          </span>
        </div>
        <span className="jm-status">
          {state.workerReady
            ? "Worker responding"
            : "Model worker not verified"}
        </span>
      </div>
      {!enabled && (
        <div className="jm-message">
          <Icon name="mdiShieldCheckOutline" />
          Choose an ordinary ML mode and enable RunPod in the saved settings
          before launching resources.
        </div>
      )}
      {error && (
        <div className="jm-message jm-error" role="alert">
          {error}
          <Button
            icon="mdiClose"
            aria-label="Dismiss RunPod error"
            onClick={() => setError("")}
          />
        </div>
      )}
      {notice && (
        <div className="jm-message" role="status">
          {notice}
        </div>
      )}
      <div className="jm-provider-grid">
        <article>
          <h3>Resource controls</h3>
          {resourceMode !== "serverless" ? (
            <>
              <div className="jm-launch-fields">
                <label>
                  GPU
                  <select
                    value={gpuId}
                    onChange={(event) => setGpuId(event.target.value)}
                  >
                    {RUNPOD_GPUS.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name} · {item.memory} GB
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  GPUs
                  <input
                    type="number"
                    min={1}
                    max={8}
                    step={1}
                    value={gpuCount}
                    onChange={(event) => setGpuCount(event.target.value)}
                  />
                </label>
                <label>
                  Maximum runtime
                  <input
                    type="number"
                    min={1}
                    max={168}
                    step={1}
                    value={hours}
                    onChange={(event) => setHours(event.target.value)}
                  />
                  <small>hours</small>
                </label>
              </div>
              <div className="jm-cost">
                <span>Illustrative compute estimate</span>
                <strong>
                  {cost === null || !launchValid
                    ? "—"
                    : new Intl.NumberFormat("en-US", {
                        style: "currency",
                        currency: "USD",
                      }).format(cost)}
                </strong>
                <small>
                  {gpu?.rate.toFixed(2)} USD / GPU-hour × {gpuCount || "—"} ×{" "}
                  {hours || "—"} hours. Excludes storage and other provider
                  charges; this is not a spending cap.
                </small>
              </div>
              <div className="jm-provider-buttons">
                <Button
                  primary
                  icon="mdiPlay"
                  disabled={
                    !enabled || mode !== "pod" || !can("launch") || !launchValid
                  }
                  onClick={() => request("launch")}
                >
                  Launch GPU
                </Button>
                <Button
                  disabled={!enabled || !can("resume")}
                  onClick={() => request("resume")}
                >
                  Resume
                </Button>
                <Button disabled={!can("stop")} onClick={() => request("stop")}>
                  Stop
                </Button>
                <Button
                  disabled={!can("terminate")}
                  onClick={() => request("terminate")}
                >
                  Terminate
                </Button>
              </div>
            </>
          ) : (
            <>
              <p>
                Endpoint setup reuses resources owned by this server. A
                provisioned endpoint can still be waiting for its first model
                worker.
              </p>
              <div className="jm-provider-buttons">
                <Button
                  primary
                  disabled={!enabled || !can("setup")}
                  onClick={() =>
                    request(state.endpointId ? "recreate" : "setup")
                  }
                >
                  {state.endpointId ? "Verify endpoint" : "Set up endpoint"}
                </Button>
                <Button
                  disabled={!can("teardown")}
                  onClick={() => request("teardown")}
                >
                  Remove endpoint
                </Button>
              </div>
              <p className="jm-muted">
                Serverless pool, worker limits, and idle settings stay in the
                settings review.
              </p>
            </>
          )}
          <div className="jm-provider-buttons">
            <Button
              icon="mdiCheckCircleOutline"
              onClick={() => request("connect")}
            >
              Check connection
            </Button>
            <Button
              icon="mdiImageSearchOutline"
              disabled={!enabled || !can("backfill")}
              onClick={() => request("backfill")}
            >
              Backfill ML results
            </Button>
            {state.status === "error" && (
              <Button
                disabled={!state.podId && !state.endpointId}
                onClick={() =>
                  request(state.endpointId ? "teardown" : "terminate")
                }
              >
                Clear failed resource
              </Button>
            )}
          </div>
        </article>
        <article>
          <h3>Capabilities & boundaries</h3>
          <dl className="jm-capabilities">
            <div>
              <dt>ML worker</dt>
              <dd>Not verified</dd>
            </div>
            <div>
              <dt>GPU selected for launch</dt>
              <dd>
                {gpu?.name} · {gpu?.memory} GB
              </dd>
            </div>
            <div>
              <dt>Ordinary ML destination</dt>
              <dd>
                {enabled
                  ? "RunPod may take priority when available"
                  : "Local configured endpoints"}
              </dd>
            </div>
            <div>
              <dt>Video restoration</dt>
              <dd>Separate worker and explicit job destination</dd>
            </div>
            <div>
              <dt>Full Studio / HDR / Dolby Vision</dt>
              <dd>Unavailable · compatibility checks required</dd>
            </div>
          </dl>
          <p>
            Launching a worker does not approve it for every model or video
            workload. Local GPUs remain available through configured ML
            endpoints.
          </p>
          <Button onClick={() => onNavigate?.("processing", "workers")}>
            View local workers
          </Button>
        </article>
      </div>
      <details className="jm-history">
        <summary>
          <Icon name="mdiHistory" />
          Provider action history <span>{state.history.length}</span>
        </summary>
        {state.history.length ? (
          <ol>
            {state.history.map((item) => (
              <li key={item.id}>
                <div>
                  <strong>{item.title}</strong>
                  <span>{item.detail}</span>
                </div>
                <time dateTime={item.at}>{timestamp(item.at)}</time>
              </li>
            ))}
          </ol>
        ) : (
          <p>No provider actions recorded.</p>
        )}
      </details>
      {review && (
        <ProviderReview
          review={review.result}
          close={() => setReview(null)}
          confirm={confirm}
        />
      )}
    </section>
  );
}
function ProviderReview({ review, close, confirm }) {
  const [accepted, setAccepted] = useState(false);
  return (
    <Dialog
      title={review.title}
      close={close}
      actions={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button
            primary
            disabled={(review.cloud || review.dangerous) && !accepted}
            onClick={() => confirm(accepted)}
          >
            {review.title}
          </Button>
        </>
      }
    >
      <div className="jm-review">
        <p>{review.detail}</p>
        <p className="jm-muted">
          Applies to this server’s ordinary ML resources. Review active jobs
          before changing worker availability.
        </p>
        {(review.cloud || review.dangerous) && (
          <label className="jm-confirm">
            <input
              type="checkbox"
              checked={accepted}
              onChange={(event) => setAccepted(event.target.checked)}
            />
            {review.cloud
              ? "I choose RunPod and acknowledge that eligible media previews may leave my network and incur charges."
              : "I have reviewed the resource, active requests, and data or cache that will be removed."}
          </label>
        )}
      </div>
    </Dialog>
  );
}
