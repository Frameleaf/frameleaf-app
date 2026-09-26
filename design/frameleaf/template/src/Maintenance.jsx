import React, { useEffect, useMemo, useRef, useState } from "react";
import { Button, Dialog } from "./App";
import { Icon } from "./Icon";
import { pageSummary, paginate } from "./search.mjs";
import {
  MAINTENANCE_KEY,
  advanceBackup,
  advanceIntegrityCheck,
  advanceRestore,
  backupFileName,
  backupKinds,
  beginBackup,
  beginRestore,
  checkStatusLabel,
  deleteBackup,
  deleteReport,
  endMaintenance,
  filterFindings,
  finishRestore,
  formatBytes,
  integrityCheckTypes,
  parseMaintenanceState,
  postRestoreChecklist,
  reportFileName,
  reportToCsv,
  reportToText,
  restoreConsequences,
  restoreSteps,
  runAllIntegrityChecks,
  runIntegrityCheck,
  serializeMaintenance,
  severities,
  severityLabels,
  startMaintenance,
  toggleChecklistItem,
} from "./maintenance-data.mjs";
import "./maintenance.css";

const when = (value) =>
  value
    ? new Intl.DateTimeFormat("en", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(value))
    : "—";
const storage = () => (typeof localStorage === "undefined" ? null : localStorage);
function load() {
  try {
    return parseMaintenanceState(storage()?.getItem(MAINTENANCE_KEY));
  } catch {
    return parseMaintenanceState(null);
  }
}
function download(name, data, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const typeFor = (id) => integrityCheckTypes.find((type) => type.id === id);
const checkTone = (status) =>
  ({ passed: "is-ok", issues: "is-issue", failed: "is-error", running: "is-running" })[
    status
  ] || "";

/**
 * Maintenance area. section: "mode" | "backups" | "integrity".
 * onNavigate(area, section): open another command-center page.
 */
export function Maintenance({ section = "mode", onNavigate }) {
  const [state, setState] = useState(load);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState(null);
  const [saveError, setSaveError] = useState("");
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    try {
      storage()?.setItem(MAINTENANCE_KEY, serializeMaintenance(state));
      setSaveError("");
    } catch {
      setSaveError(
        "Device storage is unavailable. Maintenance changes will not survive a reload.",
      );
    }
  }, [state]);

  const runningBackup = state.backups.find((backup) => backup.status === "running");
  const runningChecks = Object.entries(state.checks)
    .filter(([, check]) => check.status === "running")
    .map(([type]) => type);
  const restoring = state.restore?.status === "running";
  useEffect(() => {
    if (!runningBackup) return;
    const timer = setInterval(() => {
      setState((current) => advanceBackup(current, runningBackup.id, 9));
    }, 500);
    return () => clearInterval(timer);
  }, [runningBackup?.id]);
  useEffect(() => {
    if (!runningChecks.length) return;
    const timer = setInterval(() => {
      setState((current) =>
        runningChecks.reduce(
          (next, type, index) =>
            advanceIntegrityCheck(next, type, 7 + index * 2, new Date().toISOString()),
          current,
        ),
      );
    }, 450);
    return () => clearInterval(timer);
  }, [runningChecks.join(",")]);
  useEffect(() => {
    if (!restoring) return;
    const timer = setInterval(() => {
      setState((current) => advanceRestore(current, new Date().toISOString()));
    }, 1500);
    return () => clearInterval(timer);
  }, [restoring]);
  useEffect(() => {
    if (state.restore?.status === "restored")
      setNotice("Database restored. Work through the checklist, then end maintenance mode.");
  }, [state.restore?.status]);

  function commit(update, message) {
    try {
      const next = update(stateRef.current);
      // Keep the ref current so several commits in one handler chain correctly.
      stateRef.current = next;
      setState(next);
      setError("");
      if (message) setNotice(message);
      return true;
    } catch (failure) {
      setError(failure.message);
      return false;
    }
  }
  const now = () => new Date().toISOString();

  const modeCard = (
    <section className="mt-card" aria-labelledby="mt-mode-title">
      <div className="mt-card-title">
        <div>
          <h2 id="mt-mode-title">Maintenance mode</h2>
          <p>
            While maintenance mode is on, everyone except administrators sees
            the maintenance page instead of their library. Uploads and mobile
            backups pause until it ends.
          </p>
        </div>
        <span className={`mt-status ${state.mode.active ? "is-on" : ""}`}>
          {state.mode.active ? "On" : "Off"}
        </span>
      </div>
      <div className="mt-mode">
        <div>
          <dl className="mt-facts">
            <dt>Status</dt>
            <dd>
              {state.mode.active
                ? `On since ${when(state.mode.startedAt)}`
                : state.mode.endedAt
                  ? `Off · last ended ${when(state.mode.endedAt)}`
                  : "Off"}
            </dd>
            {state.mode.active && (
              <>
                <dt>Reason</dt>
                <dd>{state.mode.reason || "No reason recorded"}</dd>
              </>
            )}
            <dt>Administrators</dt>
            <dd>Keep full access, including this command center.</dd>
            <dt>Everyone else</dt>
            <dd>Sees the maintenance page and is signed out of sessions.</dd>
          </dl>
          <div className="mt-actions" style={{ marginTop: 16 }}>
            {state.mode.active ? (
              <Button
                primary
                icon="mdiCheck"
                disabled={restoring}
                onClick={() =>
                  commit(
                    (current) => endMaintenance(current, now()),
                    "Maintenance mode ended. Everyone can sign in again.",
                  )
                }
              >
                End maintenance
              </Button>
            ) : (
              <Button
                icon="mdiWrenchOutline"
                onClick={() => setDialog({ kind: "start", reason: "" })}
              >
                Start maintenance
              </Button>
            )}
            {section !== "backups" && (
              <Button onClick={() => onNavigate?.("maintenance", "backups")}>
                Database backups
              </Button>
            )}
            {section !== "integrity" && (
              <Button onClick={() => onNavigate?.("maintenance", "integrity")}>
                Integrity checks
              </Button>
            )}
          </div>
          {restoring && (
            <p className="mt-note">
              Maintenance mode stays on until the restore finishes.
            </p>
          )}
        </div>
        <div className="mt-preview" aria-label="What people see during maintenance">
          <Icon name="mdiWrenchOutline" size={28} />
          <strong>Frameleaf is being looked after</strong>
          <p>
            Your photos are safe. The library will be back shortly. Uploads and
            backups continue automatically once maintenance ends.
          </p>
          <small>Maintenance page shown to signed-out members</small>
        </div>
      </div>
    </section>
  );

  const restore = state.restore;
  const restoreBackup = restore && state.backups.find((backup) => backup.id === restore.backupId);
  const restoreCard = restore && (
    <section className="mt-card" aria-labelledby="mt-restore-title" aria-live="polite">
      <div className="mt-card-title">
        <div>
          <h2 id="mt-restore-title">
            {restore.status === "restored" ? "Restored" : "Restoring a backup"}
          </h2>
          <p>
            {restoreBackup
              ? `${backupKinds[restoreBackup.kind]} backup from ${when(restoreBackup.createdAt)} · ${formatBytes(restoreBackup.sizeBytes)}`
              : "Backup"}
          </p>
        </div>
        <span className={`mt-status ${restore.status === "restored" ? "is-ok" : "is-running"}`}>
          {restore.status === "restored" ? "Complete" : `Step ${Math.min(restore.step + 1, restoreSteps.length)} of ${restoreSteps.length}`}
        </span>
      </div>
      <ol className="mt-steps">
        {restoreSteps.map((step, index) => {
          const done = restore.step > index;
          const active = restore.step === index && restore.status === "running";
          return (
            <li
              key={step.id}
              className={done ? "is-done" : active ? "is-active" : "is-pending"}
              aria-current={active ? "step" : undefined}
            >
              <span>{done ? <Icon name="mdiCheck" size={14} /> : index + 1}</span>
              <span>
                <strong>{step.title}</strong>
                {step.detail}
                {active && <progress aria-label={`${step.title} in progress`} />}
              </span>
            </li>
          );
        })}
      </ol>
      {restore.status === "restored" && state.lastRestore && (
        <>
          <p className="mt-note">
            Finished {when(restore.finishedAt)}. Before ending maintenance mode:
          </p>
          <div className="mt-checklist">
            {postRestoreChecklist.map((item) => {
              const done = state.lastRestore.checklist.includes(item.id);
              return (
                <label key={item.id}>
                  <input
                    type="checkbox"
                    checked={done}
                    onChange={() =>
                      commit((current) => toggleChecklistItem(current, item.id))
                    }
                  />
                  <span className={done ? "is-done" : ""}>{item.title}</span>
                </label>
              );
            })}
          </div>
          <div className="mt-actions" style={{ marginTop: 14 }}>
            <Button onClick={() => onNavigate?.("maintenance", "integrity")}>
              Run integrity checks
            </Button>
            <Button
              primary
              onClick={() =>
                commit(
                  (current) => {
                    const closed = finishRestore(current);
                    return closed.mode.active
                      ? endMaintenance(closed, now())
                      : closed;
                  },
                  "Maintenance mode ended. Everyone can sign in again.",
                )
              }
            >
              Finish and end maintenance
            </Button>
            <Button onClick={() => commit((current) => finishRestore(current), "Restore closed. Maintenance mode is still on.")}>
              Keep maintenance on
            </Button>
          </div>
        </>
      )}
    </section>
  );

  const backupsCard = (
    <section className="mt-card" aria-labelledby="mt-backups-title">
      <div className="mt-card-title">
        <div>
          <h2 id="mt-backups-title">Database backups</h2>
          <p>
            A backup holds metadata, albums, people, edits and settings. Original
            files are not included; keep their own protected copy.
          </p>
        </div>
        <div className="mt-actions">
          <Button onClick={() => onNavigate?.("backup", "database-backup")}>
            Schedule
          </Button>
          <Button
            primary
            icon="mdiDatabaseOutline"
            disabled={!!runningBackup || restoring}
            onClick={() =>
              commit(
                (current) => beginBackup(current, now(), "manual"),
                "Backup started.",
              )
            }
          >
            Create backup now
          </Button>
        </div>
      </div>
      <div className="mt-list" role="list" aria-label="Backups">
        {state.backups.map((backup) => (
          <div className="mt-row" role="listitem" key={backup.id}>
            <Icon name="mdiDatabaseOutline" size={20} />
            <div className="mt-row-main">
              <strong>{when(backup.createdAt)}</strong>
              <small>
                {backupKinds[backup.kind]} · {backup.note || "—"}
              </small>
              {backup.status === "running" && (
                <progress
                  value={backup.progress}
                  max={100}
                  aria-label={`Backup progress ${backup.progress}%`}
                />
              )}
            </div>
            <div className="mt-row-meta">
              <span className={`mt-status ${backup.status === "complete" ? "is-ok" : backup.status === "failed" ? "is-error" : "is-running"}`}>
                {backup.status === "complete"
                  ? "Complete"
                  : backup.status === "failed"
                    ? "Failed"
                    : `Running · ${backup.progress}%`}
              </span>
              <small>
                {backup.status === "complete" ? formatBytes(backup.sizeBytes) : backup.status === "failed" ? "No file written" : "Writing…"}
              </small>
            </div>
            <div className="mt-actions">
              <Button
                icon="mdiDownload"
                disabled={backup.status !== "complete"}
                aria-label={`Download backup from ${when(backup.createdAt)}`}
                onClick={() => {
                  download(
                    backupFileName(backup),
                    `Frameleaf database backup\ncreated: ${backup.createdAt}\nkind: ${backup.kind}\nsize: ${backup.sizeBytes}\n`,
                    "application/octet-stream",
                  );
                  setNotice("Backup download started.");
                }}
              >
                Download
              </Button>
              <Button
                icon="mdiBackupRestore"
                disabled={backup.status !== "complete" || !!restore || !!runningBackup}
                aria-label={`Restore backup from ${when(backup.createdAt)}`}
                onClick={() => setDialog({ kind: "restore", backupId: backup.id, backupFirst: false })}
              >
                Restore
              </Button>
              <Button
                className="danger"
                icon="mdiDeleteOutline"
                disabled={backup.status === "running" || (restoring && restore.backupId === backup.id)}
                aria-label={`Delete backup from ${when(backup.createdAt)}`}
                onClick={() => setDialog({ kind: "delete-backup", backupId: backup.id })}
              >
                Delete
              </Button>
            </div>
          </div>
        ))}
        {!state.backups.length && <p className="mt-empty">No backups yet.</p>}
      </div>
    </section>
  );

  const reportsById = Object.fromEntries(state.reports.map((report) => [report.id, report]));
  const integrityCard = (
    <section className="mt-card" aria-labelledby="mt-integrity-title">
      <div className="mt-card-title">
        <div>
          <h2 id="mt-integrity-title">Integrity checks</h2>
          <p>
            Checks read the library and never change files. Each run produces a
            report you can review, download or delete.
          </p>
        </div>
        <Button
          primary
          icon="mdiShieldCheckOutline"
          disabled={runningChecks.length === integrityCheckTypes.length || restoring}
          onClick={() =>
            commit(
              (current) => runAllIntegrityChecks(current, now()),
              "Running all integrity checks.",
            )
          }
        >
          Run all checks
        </Button>
      </div>
      <div className="mt-grid">
        {integrityCheckTypes.map((type) => {
          const check = state.checks[type.id];
          const report = check.reportId ? reportsById[check.reportId] : null;
          return (
            <article className="mt-check" key={type.id} aria-label={type.title}>
              <header>
                <Icon name={type.icon} size={20} />
                <strong>{type.title}</strong>
                <span className={`mt-status ${checkTone(check.status)}`}>
                  {checkStatusLabel(check)}
                </span>
              </header>
              <p>{type.description}</p>
              {check.status === "running" && (
                <progress value={check.progress} max={100} aria-label={`${type.title} progress`} />
              )}
              <small>
                {check.lastRun ? `Last run ${when(check.lastRun)}` : "Never run"}
                {report ? ` · ${report.summary.total} findings` : ""}
              </small>
              <div className="mt-actions">
                <Button
                  disabled={check.status === "running" || restoring}
                  onClick={() =>
                    commit(
                      (current) => runIntegrityCheck(current, type.id, now()),
                      `${type.title} check started.`,
                    )
                  }
                >
                  {check.status === "running" ? "Running…" : "Run check"}
                </Button>
                {report && (
                  <Button icon="mdiTableLarge" onClick={() => setDialog({ kind: "report", reportId: report.id })}>
                    View report
                  </Button>
                )}
              </div>
            </article>
          );
        })}
      </div>
      {state.reports.length > 0 && (
        <>
          <h3 style={{ margin: "20px 0 6px", fontSize: 14, fontWeight: 600 }}>Reports</h3>
          <div className="mt-list" role="list" aria-label="Integrity reports">
            {state.reports.map((report) => (
              <div className="mt-row" role="listitem" key={report.id}>
                <Icon name={typeFor(report.type)?.icon || "mdiFileDocumentOutline"} size={20} />
                <div className="mt-row-main">
                  <strong>{typeFor(report.type)?.title}</strong>
                  <small>{when(report.createdAt)} · {report.scanned.toLocaleString("en")} items scanned</small>
                </div>
                <div className="mt-row-meta">
                  <span className="mt-actions">
                    {severities.map((severity) =>
                      report.summary[severity] ? (
                        <span className={`mt-sev ${severity}`} key={severity}>
                          {report.summary[severity]} {severityLabels[severity].toLowerCase()}
                          {report.summary[severity] === 1 ? "" : "s"}
                        </span>
                      ) : null,
                    )}
                    {!report.summary.total && <span className="mt-sev">No findings</span>}
                  </span>
                </div>
                <div className="mt-actions">
                  <Button onClick={() => setDialog({ kind: "report", reportId: report.id })}>
                    Open
                  </Button>
                  <Button
                    className="danger"
                    aria-label={`Delete ${typeFor(report.type)?.title} report from ${when(report.createdAt)}`}
                    onClick={() => setDialog({ kind: "delete-report", reportId: report.id })}
                  >
                    Delete
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );

  return (
    <div className="maintenance">
      {saveError && (
        <p className="mt-error" role="alert">
          {saveError}
        </p>
      )}
      {error && (
        <p className="mt-error" role="alert">
          {error}
        </p>
      )}
      <p className="mt-live" role="status">
        {notice}
      </p>
      {section === "backups" ? (
        <>
          {restoreCard}
          {backupsCard}
          {state.mode.active && modeCard}
        </>
      ) : section === "integrity" ? (
        <>
          {integrityCard}
          {restoring && restoreCard}
        </>
      ) : (
        <>
          {modeCard}
          {restoreCard}
        </>
      )}
      <p className="mt-note">Preview · sample data. Backups and checks are simulated on this device.</p>
      {dialog?.kind === "start" && (
        <Dialog
          title="Start maintenance mode"
          close={() => setDialog(null)}
          actions={
            <>
              <Button onClick={() => setDialog(null)}>Cancel</Button>
              <Button
                primary
                onClick={() => {
                  if (
                    commit(
                      (current) => startMaintenance(current, now(), dialog.reason),
                      "Maintenance mode is on. Members now see the maintenance page.",
                    )
                  )
                    setDialog(null);
                }}
              >
                Start maintenance
              </Button>
            </>
          }
        >
          <p>
            Everyone except administrators will see the maintenance page and be
            signed out. Uploads, mobile backups and shared links pause until you
            end maintenance mode.
          </p>
          <label className="mt-dialog-field">
            Reason shown to administrators (optional)
            <input
              data-initial-focus
              maxLength={200}
              value={dialog.reason}
              placeholder="Replacing the library disk"
              onChange={(event) => setDialog({ ...dialog, reason: event.target.value })}
            />
          </label>
        </Dialog>
      )}
      {dialog?.kind === "delete-backup" && (
        <Dialog
          title="Delete this backup?"
          close={() => setDialog(null)}
          actions={
            <>
              <Button onClick={() => setDialog(null)}>Cancel</Button>
              <Button
                className="danger"
                onClick={() => {
                  if (
                    commit(
                      (current) => deleteBackup(current, dialog.backupId),
                      "Backup deleted.",
                    )
                  )
                    setDialog(null);
                }}
              >
                Delete backup
              </Button>
            </>
          }
        >
          <p>
            The backup from{" "}
            {when(state.backups.find((backup) => backup.id === dialog.backupId)?.createdAt)}{" "}
            will be removed from the backup destination. This cannot be undone.
          </p>
        </Dialog>
      )}
      {dialog?.kind === "restore" && (
        <RestoreDialog
          backup={state.backups.find((backup) => backup.id === dialog.backupId)}
          dialog={dialog}
          setDialog={setDialog}
          onConfirm={() => {
            const ok = commit((current) => {
              let next = current;
              if (dialog.backupFirst)
                next = beginBackup(next, now(), "pre-restore", "Safety copy before restore");
              return beginRestore(next, dialog.backupId, now());
            }, "Restore started. Maintenance mode is on.");
            if (ok) setDialog(null);
          }}
        />
      )}
      {dialog?.kind === "report" && reportsById[dialog.reportId] && (
        <ReportViewer
          report={reportsById[dialog.reportId]}
          close={() => setDialog(null)}
          onDelete={() => {
            if (
              commit(
                (current) => deleteReport(current, dialog.reportId),
                "Report deleted.",
              )
            )
              setDialog(null);
          }}
          onNotice={setNotice}
        />
      )}
      {dialog?.kind === "delete-report" && (
        <Dialog
          title="Delete this report?"
          close={() => setDialog(null)}
          actions={
            <>
              <Button onClick={() => setDialog(null)}>Cancel</Button>
              <Button
                className="danger"
                onClick={() => {
                  if (
                    commit(
                      (current) => deleteReport(current, dialog.reportId),
                      "Report deleted.",
                    )
                  )
                    setDialog(null);
                }}
              >
                Delete report
              </Button>
            </>
          }
        >
          <p>The findings are removed. The check status and last-run time stay.</p>
        </Dialog>
      )}
    </div>
  );
}

function RestoreDialog({ backup, dialog, setDialog, onConfirm }) {
  const [confirm, setConfirm] = useState("");
  if (!backup) return null;
  return (
    <Dialog
      title="Restore this backup?"
      close={() => setDialog(null)}
      actions={
        <>
          <Button onClick={() => setDialog(null)}>Cancel</Button>
          <Button primary disabled={confirm !== "RESTORE"} onClick={onConfirm}>
            Restore backup
          </Button>
        </>
      }
    >
      <p>
        <strong>{backupKinds[backup.kind]} backup</strong> from {when(backup.createdAt)} ·{" "}
        {formatBytes(backup.sizeBytes)}
        {backup.note ? ` · ${backup.note}` : ""}
      </p>
      <ul className="mt-consequences">
        {restoreConsequences.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <p>
        The restore runs in {restoreSteps.length} steps:{" "}
        {restoreSteps.map((step) => step.title.toLowerCase()).join(", ")}.
      </p>
      <label className="mt-dialog-check">
        <input
          type="checkbox"
          checked={dialog.backupFirst}
          onChange={(event) => setDialog({ ...dialog, backupFirst: event.target.checked })}
        />
        Create a safety backup of the current database first
      </label>
      <label className="mt-dialog-field" style={{ marginTop: 14 }}>
        Type RESTORE to confirm
        <input
          data-initial-focus
          autoComplete="off"
          value={confirm}
          onChange={(event) => setConfirm(event.target.value.toUpperCase())}
        />
      </label>
    </Dialog>
  );
}

const PAGE_SIZE = 8;
function ReportViewer({ report, close, onDelete, onNotice }) {
  const [severity, setSeverity] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const type = typeFor(report.type);
  const filtered = useMemo(
    () => filterFindings(report.findings, { severity, query }),
    [report, severity, query],
  );
  const pagination = paginate(filtered, page, PAGE_SIZE);
  useEffect(() => {
    setPage(1);
  }, [severity, query]);
  return (
    <Dialog
      title={`${type?.title || "Integrity"} report`}
      close={close}
      wide
      actions={
        <>
          <Button
            icon="mdiDownload"
            onClick={() => {
              download(reportFileName(report, "csv"), reportToCsv(report), "text/csv;charset=utf-8");
              onNotice("CSV download started.");
            }}
          >
            Download CSV
          </Button>
          <Button
            icon="mdiFileDocumentOutline"
            onClick={() => {
              download(reportFileName(report, "txt"), reportToText(report), "text/plain;charset=utf-8");
              onNotice("Report file download started.");
            }}
          >
            Download report file
          </Button>
          <Button className="danger" icon="mdiDeleteOutline" onClick={() => setConfirmDelete(true)}>
            Delete report
          </Button>
          <Button primary onClick={close}>
            Close
          </Button>
        </>
      }
    >
      <div className="mt-report-summary">
        <span>{when(report.createdAt)}</span>
        <span>· {report.scanned.toLocaleString("en")} items scanned in {(report.durationMs / 1000).toFixed(1)} s</span>
        <span>· {report.summary.total} {report.summary.total === 1 ? "finding" : "findings"}</span>
      </div>
      <div className="mt-report-toolbar">
        <button type="button" className="mt-sev" aria-pressed={severity === ""} onClick={() => setSeverity("")}>
          All {report.summary.total}
        </button>
        {severities.map((item) => (
          <button
            type="button"
            className={`mt-sev ${item}`}
            key={item}
            aria-pressed={severity === item}
            onClick={() => setSeverity(severity === item ? "" : item)}
          >
            {severityLabels[item]} {report.summary[item]}
          </button>
        ))}
        <input
          type="search"
          aria-label="Filter findings"
          placeholder="Filter by path or message…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      {confirmDelete && (
        <div className="mt-danger-inline" role="alert">
          Delete this report? Its findings cannot be recovered.
          <Button className="danger" onClick={onDelete}>
            Delete
          </Button>
          <Button onClick={() => setConfirmDelete(false)}>Keep</Button>
        </div>
      )}
      <div className="mt-table-wrap">
        <table className="mt-table">
          <thead>
            <tr>
              <th scope="col">Severity</th>
              <th scope="col">Path</th>
              <th scope="col">Finding</th>
            </tr>
          </thead>
          <tbody>
            {pagination.items.map((finding) => (
              <tr key={finding.id}>
                <td>
                  <span className={`mt-sev ${finding.severity}`}>
                    {severityLabels[finding.severity]}
                  </span>
                </td>
                <td>
                  <code>{finding.path}</code>
                </td>
                <td>
                  {finding.message}
                  {finding.detail && <small>{finding.detail}</small>}
                </td>
              </tr>
            ))}
            {!pagination.items.length && (
              <tr>
                <td colSpan={3}>
                  <span className="mt-empty">No findings match this filter.</span>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="mt-pager">
        <span aria-live="polite">{pageSummary(pagination, { noun: "findings", singular: "finding" })}</span>
        <span className="mt-actions">
          <Button disabled={pagination.page <= 1} onClick={() => setPage(pagination.page - 1)}>
            Previous
          </Button>
          <span>
            Page {pagination.page} of {pagination.pageCount}
          </span>
          <Button disabled={!pagination.hasMore} onClick={() => setPage(pagination.page + 1)}>
            Next
          </Button>
        </span>
      </div>
    </Dialog>
  );
}
