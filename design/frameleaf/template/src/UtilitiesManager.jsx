import React, { useEffect, useRef, useState } from "react";
import { Button, Dialog } from "./App";
import { Icon } from "./Icon";
import { DuplicateReview } from "./DuplicateReview";
import { UtilityRecovery } from "./UtilityRecovery";
import { UtilityMapPicker } from "./UtilityMapPicker";
import { WorkflowDesigner } from "./WorkflowDesigner";
import { ItemRestoreDialog, RestoreKeyPrompt, restoreNeedsKey, useCloudState } from "./FrameleafCloud";
import { backupManifests, restoreRunActive, startRestoreRun } from "./frameleaf-cloud-data.mjs";
import {
  workflowExecutionErrors,
  workflowPersistenceError,
  exportWorkflowDefinition,
  workflowTriggers,
} from "./workflow-schema.mjs";
import {
  utilityTools,
  utilityStorageKey,
  initialUtilities,
  parseUtilities,
  applyUtilityAction,
  ownerName,
  formatBytes,
  parseWorkflowImport,
  RESTORE_REFUSED,
} from "./utilities-data.mjs";
import "./utilities-manager.css";
const read = () => {
  try {
    return parseUtilities(localStorage.getItem(utilityStorageKey));
  } catch {
    return initialUtilities();
  }
};
const download = (name, value) => {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
export function UtilitiesManager({
  tool = "duplicates",
  actorId = "taylor",
  scope = "all",
  onNavigate = () => {},
}) {
  const [state, setState] = useState(read),
    [undo, setUndo] = useState(null),
    [query, setQuery] = useState(""),
    [owner, setOwner] = useState(
      ["taylor", "jamie", "emma"].includes(scope) ? scope : "all",
    ),
    [status, setStatus] = useState("open"),
    [selected, setSelected] = useState([]),
    [inspect, setInspect] = useState(null),
    [review, setReview] = useState(null),
    [notice, setNotice] = useState(""),
    [error, setError] = useState(""),
    [lat, setLat] = useState("51.3217"),
    [lng, setLng] = useState("-116.1860"),
    [workflow, setWorkflow] = useState(null),
    [confirmation, setConfirmation] = useState(""),
    [recovery, setRecovery] = useState(null),
    [restores, setRestores] = useState({}),
    [backupChecked, setBackupChecked] = useState(false),
    [restoreDialog, setRestoreDialog] = useState(null);
  const [cloud, commitCloud] = useCloudState();
  const stateRef = useRef(null);
  const backupOn =
    cloud.backup.configured && ["missing-media", "corrupt-media"].includes(tool);
  useEffect(() => {
    // "Checking…" rows resolve once the kept manifests have been searched.
    setBackupChecked(false);
    const timer = setTimeout(() => setBackupChecked(true), 1600);
    return () => clearTimeout(timer);
  }, [tool]);
  useEffect(() => {
    setOwner(["taylor", "jamie", "emma"].includes(scope) ? scope : "all");
    setSelected([]);
  }, [scope]);
  useEffect(() => {
    setSelected([]);
    setStatus("open");
    setQuery("");
    setInspect(null);
    setReview(null);
  }, [tool]);
  const running =
    state.runs.find((run) => run.tool === tool)?.status === "Queued";
  const definition = utilityTools.find((x) => x.id === tool);
  stateRef.current = state;
  function commit(next, message) {
    try {
      localStorage.setItem(utilityStorageKey, JSON.stringify(next));
      setUndo(state);
      setState(next);
      setNotice(message);
      setError("");
      return true;
    } catch {
      setError(
        "Changes could not be saved on this device. Keep this page open and try again.",
      );
      return false;
    }
  }
  const rows = state.rows.filter(
    (row) =>
      row.status !== "Deleted" &&
      row.tool === tool &&
      (owner === "all" || row.ownerId === owner) &&
      (status === "all" ||
        ![
          "Linked",
          "Relinked",
          "Dismissed",
          "Trashed",
          "Restored",
          "Deleted",
          "Kept",
          "Stacked",
          "Resolved",
        ].includes(row.status)) &&
      `${row.name} ${row.status} ${ownerName(row.ownerId)}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const chosen = rows.filter((r) => selected.includes(r.id));
  const coverage = (row) =>
    row.backup?.status === "checking" && backupChecked ? "in-backup" : row.backup?.status;
  const restorable = (row) =>
    backupOn &&
    coverage(row) === "in-backup" &&
    restores[row.id] !== "verifying" &&
    !["Restored", "Relinked", "Dismissed", "Trashed"].includes(row.status);
  const backupDay = (id) => {
    const manifest = backupManifests.find((item) => item.id === id);
    return manifest
      ? new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(new Date(manifest.createdAt))
      : "—";
  };
  function restoreRows(targets) {
    if (!targets.length) return;
    setRestores((current) => ({
      ...current,
      ...Object.fromEntries(targets.map((row) => [row.id, "verifying"])),
    }));
    setNotice(
      targets.length === 1
        ? `Restoring ${targets[0].name}. It is checked against its fingerprint first.`
        : `Restoring ${targets.length} items. Follow the progress in Activity.`,
    );
    if (!restoreRunActive(cloud))
      commitCloud((current) =>
        startRestoreRun(current, {
          title: targets.length === 1 ? `Restore ${targets[0].name}` : `Restore ${targets.length} items from backup`,
          files: targets.length,
        }),
      );
    setTimeout(() => {
      const verified = targets.filter((row) => !row.backup.fingerprintMismatch);
      const refused = targets.filter((row) => row.backup.fingerprintMismatch);
      setRestores((current) => ({
        ...current,
        ...Object.fromEntries(targets.map((row) => [row.id, refused.includes(row) ? "refused" : undefined])),
      }));
      if (verified.length)
        commit(
          applyUtilityAction(stateRef.current, {
            action: "restore",
            ids: verified.map((row) => row.id),
            actorId: "taylor",
            admin: true,
          }),
          refused.length
            ? `Restored ${verified.length} of ${targets.length}. ${refused.length} refused because the fingerprint didn’t match.`
            : `Restored ${verified.length === 1 ? verified[0].name : `${verified.length} items`}. The fingerprint matched.`,
        );
      else setError(RESTORE_REFUSED);
    }, 1400);
  }
  const restoreSelected = () => {
    const targets = chosen.filter(restorable);
    if (restoreNeedsKey(cloud.backup)) setRestoreDialog({ kind: "key", rows: targets });
    else restoreRows(targets);
  };
  const canEdit = (row) =>
    row.status !== "Deleted" && (row.ownerId === "taylor" || definition?.admin);
  const ask = (action, targets = chosen, extra = {}) => {
    if (!targets.length) return;
    setConfirmation("");
    setReview({
      action,
      ids: targets.map((x) => x.id),
      rows: targets.map((x) => ({ ...x })),
      latitude: Number(lat),
      longitude: Number(lng),
      ...extra,
    });
  };
  function apply() {
    try {
      const next = applyUtilityAction(state, {
        ...review,
        actorId: "taylor",
        admin: true,
      });
      if (
        commit(
          next,
          `${review.rows.length} item${review.rows.length === 1 ? "" : "s"} updated.`,
        )
      ) {
        setSelected([]);
        setReview(null);
      }
    } catch (e) {
      setError(e.message);
      setReview(null);
    }
  }
  const toggle = (id) =>
    setSelected((old) =>
      old.includes(id) ? old.filter((x) => x !== id) : [...old, id],
    );
  const remaining = rows.filter(canEdit);
  const scopeControls = (
    <div className="um-toolbar">
      {tool !== "duplicates" && (
        <label>
          Account
          <select
            value={owner}
            onChange={(e) => {
              setOwner(e.target.value);
              setSelected([]);
            }}
          >
            <option value="all">All accounts</option>
            {["taylor", "jamie", "emma"].map((id) => (
              <option key={id} value={id}>
                {ownerName(id)}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        Find items
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={
            tool === "duplicates"
              ? "Filename or status"
              : "Filename, owner or status"
          }
        />
      </label>
      <label>
        Show
        <select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setSelected([]);
          }}
        >
          <option value="open">Needs attention</option>
          <option value="all">All results</option>
        </select>
      </label>
    </div>
  );
  function scan() {
    commit(
      {
        ...state,
        runs: [
          { tool, status: "Queued", at: new Date().toISOString() },
          ...state.runs,
        ].slice(0, 20),
      },
      "Scan started. Earlier findings stay available.",
    );
  }
  function rowTable(items = rows) {
    return (
      <div className="um-table-scroll">
        <table>
          <thead>
            <tr>
              <th>
                <input
                  type="checkbox"
                  aria-label="Select all editable results"
                  checked={
                    remaining.length > 0 &&
                    remaining.every((r) => selected.includes(r.id))
                  }
                  onChange={() =>
                    setSelected(
                      remaining.every((r) => selected.includes(r.id))
                        ? []
                        : remaining.map((r) => r.id),
                    )
                  }
                />
              </th>
              <th>Original</th>
              <th>Account</th>
              <th>{tool === "large-files" ? "Size" : "Finding"}</th>
              {backupOn && <th>Backup</th>}
              <th>Review</th>
            </tr>
          </thead>
          <tbody>
            {items.map((row) => (
              <tr key={row.id}>
                <td>
                  <input
                    type="checkbox"
                    aria-label={`Select ${row.name}`}
                    disabled={!canEdit(row)}
                    checked={selected.includes(row.id)}
                    onChange={() => toggle(row.id)}
                  />
                </td>
                <td>
                  <div className="um-file">
                    <img src={`/media/${row.image}.png`} alt="" />
                    <span>
                      <strong>{row.name}</strong>
                      <small>
                        {row.format || row.path || formatBytes(row.bytes)}
                      </small>
                    </span>
                  </div>
                </td>
                <td>
                  {ownerName(row.ownerId)}
                  {!canEdit(row) && <small>Owner access required</small>}
                </td>
                <td>
                  {tool === "large-files" ? formatBytes(row.bytes) : row.status}
                  {restores[row.id] === "refused" && (
                    <small role="alert" style={{ color: "var(--fl-warning)", maxWidth: 280 }}>
                      {RESTORE_REFUSED}
                    </small>
                  )}
                </td>
                {backupOn && (
                  <td>
                    {!row.backup
                      ? "—"
                      : coverage(row) === "checking"
                        ? "Checking…"
                        : coverage(row) === "none"
                          ? "Not in any backup"
                          : `In backup · ${backupDay(row.backup.newest)}`}
                  </td>
                )}
                <td>
                  <span style={{ display: "flex", gap: 8, alignItems: "center", whiteSpace: "nowrap" }}>
                    <Button onClick={() => setInspect(row)}>Inspect</Button>
                    {backupOn &&
                      row.backup &&
                      (restores[row.id] === "verifying" ? (
                        <span role="status">Verifying…</span>
                      ) : row.status === "Restored" ? (
                        <span>Restored</span>
                      ) : (
                        <Button
                          icon="mdiBackupRestore"
                          disabled={!restorable(row) || !canEdit(row)}
                          onClick={() => setRestoreDialog({ kind: "item", row })}
                        >
                          Restore from backup
                        </Button>
                      ))}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!items.length && (
          <div className="um-empty">
            <Icon name="mdiCheckCircleOutline" size={28} />
            <h3>No matching items</h3>
            <p>Change the account or filters to see more results.</p>
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="utilities-manager">
      {error && (
        <p role="alert" className="um-message error">
          {error}
        </p>
      )}
      {notice && tool !== "duplicates" && (
        <div role="status" className="um-message">
          <span>{notice}</span>
          {undo && (
            <Button
              onClick={() => {
                const previous = undo;
                if (commit(previous, "Last change undone.")) setUndo(null);
              }}
              icon="mdiUndo"
            >
              Undo
            </Button>
          )}
          <Button
            aria-label="Dismiss utility message"
            onClick={() => setNotice("")}
            icon="mdiClose"
          />
        </div>
      )}
      {[
        "duplicates",
        "large-files",
        "live-photos",
        "geolocation",
        "missing-media",
        "corrupt-media",
      ].includes(tool) && scopeControls}
      {tool === "duplicates" && (
        <DuplicateReview
          key={actorId}
          state={state}
          actorId={actorId}
          owner={actorId}
          query={query}
          status={status}
          onCommit={commit}
          readLatest={read}
          onOpenTrash={() => onNavigate("trash", "contents")}
        />
      )}
      {tool === "large-files" && (
        <>
          <div className="um-stats">
            <span>
              <strong>
                {formatBytes(rows.reduce((sum, r) => sum + r.bytes, 0))}
              </strong>{" "}
              in this view
            </span>
            <span>Largest originals first · logical file sizes</span>
          </div>
          <div className="um-toolbar">
            <Button disabled={!chosen.length} onClick={() => ask("trash")}>
              Move selected to trash
            </Button>
            <Button
              disabled={!rows.length}
              icon="mdiDownload"
              onClick={() =>
                download("frameleaf-large-file-review.json", {
                  sample: true,
                  scope: owner,
                  items: rows.map(({ id, name, ownerId, bytes }) => ({
                    id,
                    name,
                    ownerId,
                    bytes,
                  })),
                })
              }
            >
              Export file list
            </Button>
          </div>
          {rowTable([...rows].sort((a, b) => b.bytes - a.bytes))}
        </>
      )}
      {tool === "live-photos" && (
        <>
          <div className="um-toolbar">
            <span>{rows.length} candidate pairs</span>
            <Button
              primary
              disabled={
                !rows.some((r) => r.confidence === "High" && canEdit(r))
              }
              onClick={() =>
                ask(
                  "link",
                  rows.filter((r) => r.confidence === "High" && canEdit(r)),
                )
              }
            >
              Link high-confidence pairs
            </Button>
          </div>
          <div className="um-pairs">
            {rows.map((row) => (
              <article key={row.id}>
                <div className="um-pair-images">
                  <img src={`/media/${row.image}.png`} alt={row.name} />
                  <span>
                    <img src={`/media/${row.image}.png`} alt={row.pair} />
                    <Icon name="mdiPlay" />
                  </span>
                </div>
                <div>
                  <strong>{row.name}</strong>
                  <small>
                    {row.pair} · {ownerName(row.ownerId)}
                  </small>
                  <p>{row.evidence}</p>
                  <span
                    className={`um-badge ${row.confidence === "Low" ? "warning" : ""}`}
                  >
                    {row.confidence} confidence
                  </span>
                </div>
                <Button
                  disabled={!canEdit(row)}
                  onClick={() => ask("link", [row])}
                >
                  Review pair
                </Button>
              </article>
            ))}
          </div>
          {!rows.length && (
            <p className="um-empty">No candidate pairs need review.</p>
          )}
        </>
      )}
      {tool === "geolocation" && (
        <>
          <div className="um-location">
            <UtilityMapPicker
              latitude={lat}
              longitude={lng}
              photos={rows}
              onChange={(latitude, longitude) => {
                setLat(String(latitude));
                setLng(String(longitude));
              }}
            />
            <div>
              <label>
                Latitude
                <input
                  type="number"
                  min="-90"
                  max="90"
                  step="any"
                  value={lat}
                  onChange={(e) => setLat(e.target.value)}
                />
              </label>
              <label>
                Longitude
                <input
                  type="number"
                  min="-180"
                  max="180"
                  step="any"
                  value={lng}
                  onChange={(e) => setLng(e.target.value)}
                />
              </label>
              <Button
                primary
                disabled={
                  !chosen.length ||
                  lat.trim() === "" ||
                  lng.trim() === "" ||
                  !Number.isFinite(Number(lat)) ||
                  !Number.isFinite(Number(lng)) ||
                  Math.abs(Number(lat)) > 90 ||
                  Math.abs(Number(lng)) > 180
                }
                onClick={() => ask("location")}
              >
                Apply to {chosen.length} selected
              </Button>
            </div>
          </div>
          <div className="um-photo-grid">
            {rows.map((row) => (
              <article key={row.id}>
                <img src={`/media/${row.image}.png`} alt={row.name} />
                <label>
                  <input
                    type="checkbox"
                    disabled={!canEdit(row)}
                    checked={selected.includes(row.id)}
                    onChange={() => toggle(row.id)}
                  />
                  {row.name}
                </label>
                <small>
                  {ownerName(row.ownerId)} ·{" "}
                  {row.latitude === null
                    ? "No location"
                    : `${row.latitude.toFixed(4)}, ${row.longitude.toFixed(4)}`}
                </small>
                <Button
                  disabled={row.latitude === null}
                  onClick={() => {
                    setLat(String(row.latitude));
                    setLng(String(row.longitude));
                  }}
                >
                  Use this location
                </Button>
              </article>
            ))}
          </div>
        </>
      )}
      {["missing-media", "corrupt-media"].includes(tool) && (
        <>
          <div className="um-scan">
            <span>
              <strong>{rows.length} findings</strong>
              <small>
                {running
                  ? "Waiting to start"
                  : "Last scan · 19 Sep 2026, 11:40 UTC"}
              </small>
            </span>
            <Button disabled={running} onClick={scan}>
              Scan again
            </Button>
            {running && (
              <Button
                onClick={() => {
                  commit(
                    {
                      ...state,
                      runs: state.runs.map((run, index) =>
                        index === state.runs.findIndex((x) => x.tool === tool)
                          ? { ...run, status: "Cancelled" }
                          : run,
                      ),
                    },
                    "Scan cancelled. Previous findings were retained.",
                  );
                }}
              >
                Cancel scan
              </Button>
            )}
            <Button onClick={() => onNavigate("processing", "queues")}>
              View jobs
            </Button>
          </div>
          <div className="um-toolbar">
            {tool === "missing-media" ? (
              <>
                <Button
                  disabled={!chosen.length}
                  onClick={() =>
                    setRecovery({
                      mode: "locate",
                      rows: chosen.map((row) => ({ ...row })),
                    })
                  }
                >
                  Locate originals
                </Button>
                <Button
                  primary
                  disabled={
                    !chosen.length ||
                    chosen.some(
                      (r) =>
                        r.checksum !== "Match" || r.candidateStatus !== "Found",
                    )
                  }
                  onClick={() => ask("relink")}
                >
                  Relink verified matches
                </Button>
              </>
            ) : (
              <Button
                disabled={!chosen.some((r) => r.status === "Confirmed damaged")}
                onClick={() =>
                  ask(
                    "trash-corrupt",
                    chosen.filter((r) => r.status === "Confirmed damaged"),
                  )
                }
              >
                Trash confirmed damage
              </Button>
            )}
            {backupOn && (
              <Button
                icon="mdiBackupRestore"
                disabled={!chosen.some(restorable)}
                onClick={restoreSelected}
              >
                Restore all from backup
              </Button>
            )}
            <Button disabled={!chosen.length} onClick={() => ask("dismiss")}>
              Dismiss findings
            </Button>
          </div>
          {tool === "corrupt-media" && (
            <Button
              disabled={
                !chosen.length ||
                chosen.some((row) => row.status !== "Confirmed damaged")
              }
              onClick={() =>
                setRecovery({
                  mode: "replace",
                  rows: chosen.map((row) => ({ ...row })),
                })
              }
            >
              Recover from a verified copy
            </Button>
          )}
          {tool === "corrupt-media" && (
            <p className="um-policy">
              Unsupported RAW and suspected damage are kept until validation
              confirms a problem.
            </p>
          )}
          {rowTable()}
        </>
      )}
      {tool === "icloud" && (
        <ICloudPanel state={state} commit={commit} onNavigate={onNavigate} />
      )}
      {tool === "workflows" && (
        <>
          <div className="um-toolbar">
            <label>
              Account
              <select value={owner} onChange={(e) => setOwner(e.target.value)}>
                <option value="all">All accounts</option>
                {["taylor", "jamie", "emma"].map((id) => (
                  <option key={id} value={id}>
                    {ownerName(id)}
                  </option>
                ))}
              </select>
            </label>
            <Button
              primary
              icon="mdiPlus"
              onClick={() =>
                setWorkflow({
                  id: crypto.randomUUID(),
                  name: "",
                  ownerId: "taylor",
                  enabled: false,
                  logging: true,
                  trigger: "AssetCreate",
                  steps: [],
                })
              }
            >
              Create workflow
            </Button>
            <label className="button um-file-import">
              <Icon name="mdiFileImportOutline" size={16} />
              Import workflow
              <input
                className="fl-sr-only"
                type="file"
                accept="application/json,.json"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  try {
                    if (file.size > 100000)
                      throw Error(
                        "Choose a workflow file smaller than 100 KB.",
                      );
                    const value = JSON.parse(await file.text());
                    const parsed = parseWorkflowImport(value);
                    setWorkflow({
                      ...parsed,
                      enabled: false,
                      id: crypto.randomUUID(),
                      ownerId: "taylor",
                    });
                  } catch (error) {
                    setError(error.message);
                  }
                  e.target.value = "";
                }}
              />
            </label>
          </div>
          <div className="um-workflow-list">
            {state.workflows
              .filter((w) => owner === "all" || w.ownerId === owner)
              .map((w) => (
                <article key={w.id}>
                  <Icon name="mdiTuneVariant" size={25} />
                  <div>
                    <strong>{w.name}</strong>
                    <p>
                      {ownerName(w.ownerId)} ·{" "}
                      {workflowTriggers.find(
                        (trigger) => trigger.value === w.trigger,
                      )?.label ?? w.trigger}{" "}
                      · {w.steps.length} steps
                    </p>
                    <small>
                      {w.enabled
                        ? workflowExecutionErrors(w).length
                          ? "Blocked"
                          : "Enabled"
                        : "Paused"}{" "}
                      · {w.logging ? "Run history enabled" : "Run history off"}
                    </small>
                  </div>
                  <Button onClick={() => setWorkflow(structuredClone(w))}>
                    Open workflow
                  </Button>
                  <Button
                    disabled={
                      w.ownerId !== "taylor" ||
                      (!w.enabled && workflowExecutionErrors(w).length > 0)
                    }
                    onClick={() =>
                      commit(
                        {
                          ...state,
                          workflows: state.workflows.map((x) =>
                            x.id === w.id ? { ...x, enabled: !x.enabled } : x,
                          ),
                        },
                        `Workflow ${w.enabled ? "paused" : "enabled"}.`,
                      )
                    }
                  >
                    {w.enabled ? "Pause" : "Enable"}
                  </Button>
                  <Button
                    icon="mdiDownload"
                    aria-label={`Export ${w.name}`}
                    onClick={() =>
                      download(
                        `${w.name || "workflow"}.json`,
                        exportWorkflowDefinition(w),
                      )
                    }
                  />
                </article>
              ))}
          </div>
        </>
      )}
      {["downloads", "obtainium"].includes(tool) && (
        <ApplicationSetup tool={tool} onNavigate={onNavigate} />
      )}
      {restoreDialog?.kind === "item" && (
        <ItemRestoreDialog
          item={{
            name: restoreDialog.row.name,
            path: restoreDialog.row.path,
            newest: restoreDialog.row.backup.newest,
          }}
          close={() => setRestoreDialog(null)}
          onRestore={() => {
            setRestoreDialog(null);
            restoreRows([restoreDialog.row]);
          }}
        />
      )}
      {restoreDialog?.kind === "key" && (
        <RestoreKeyPrompt
          close={() => setRestoreDialog(null)}
          done={() => {
            setRestoreDialog(null);
            restoreRows(restoreDialog.rows);
          }}
        />
      )}
      {recovery && (
        <UtilityRecovery
          state={state}
          rows={recovery.rows}
          mode={recovery.mode}
          close={() => setRecovery(null)}
          onCommit={(next) => {
            if (
              commit(
                next,
                recovery.mode === "replace"
                  ? "Verified recovery recorded. Previous source evidence was retained."
                  : "Candidate search choices saved. Review exact matches before relinking.",
              )
            ) {
              setRecovery(null);
              setSelected([]);
              return true;
            }
            return false;
          }}
        />
      )}
      {inspect && (
        <Dialog
          title={inspect.name}
          close={() => setInspect(null)}
          wide
          actions={<Button onClick={() => setInspect(null)}>Done</Button>}
        >
          <div className="um-evidence">
            <img src={`/media/${inspect.image}.png`} alt={inspect.name} />
            <dl>
              <dt>Account</dt>
              <dd>{ownerName(inspect.ownerId)}</dd>
              <dt>Original size</dt>
              <dd>{formatBytes(inspect.bytes)}</dd>
              <dt>Status</dt>
              <dd>{inspect.status}</dd>
              {inspect.path && (
                <>
                  <dt>Original path</dt>
                  <dd>{inspect.path}</dd>
                </>
              )}
              {inspect.evidence && (
                <>
                  <dt>Evidence</dt>
                  <dd>{inspect.evidence}</dd>
                </>
              )}
              {inspect.candidate && (
                <>
                  <dt>Candidate</dt>
                  <dd>{inspect.candidate}</dd>
                  <dt>Checksum</dt>
                  <dd>
                    {inspect.checksum} · {inspect.candidateStatus}
                  </dd>
                </>
              )}
            </dl>
          </div>
        </Dialog>
      )}
      {review && (
        <Dialog
          title={
            {
              "resolve-duplicates": "Keep the original you chose",
              trash: "Move to trash",
              "trash-corrupt": "Move confirmed damage to trash",
              link: "Review Live Photo pairs",
              relink: "Relink originals",
              location: "Update locations",
              keep: "Keep every copy",
              stack: "Stack related photos",
              dismiss: "Dismiss findings",
              locate: "Locate originals",
            }[review.action]
          }
          close={() => setReview(null)}
          wide
          actions={
            <>
              <Button onClick={() => setReview(null)}>Cancel</Button>
              <Button
                primary
                disabled={
                  review.action === "trash-corrupt" &&
                  confirmation !== "MOVE CORRUPT MEDIA TO TRASH"
                }
                onClick={apply}
              >
                Confirm {review.rows.length}{" "}
                {review.rows.length === 1 ? "item" : "items"}
              </Button>
            </>
          }
        >
          <p>
            The selected items below are fixed for this operation. Changing a
            filter later will not add more items.
          </p>
          <div className="um-review-rows">
            {review.rows.map((row) => (
              <div key={row.id}>
                <strong>{row.name}</strong>
                <span>
                  {ownerName(row.ownerId)} ·{" "}
                  {review.action === "location"
                    ? `${row.latitude ?? "No location"} → ${review.latitude}, ${review.longitude}`
                    : review.action === "resolve-duplicates"
                      ? row.id === review.keeperId
                        ? "Keep original"
                        : "Move to trash"
                      : row.status}
                </span>
                {row.confidence === "Low" && (
                  <p className="um-policy">
                    This pairing is uncertain. Check the filename and capture
                    time before linking.
                  </p>
                )}
              </div>
            ))}
          </div>
          {review.action === "trash-corrupt" && (
            <label>
              Type MOVE CORRUPT MEDIA TO TRASH
              <input
                autoComplete="off"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
              />
              <small>
                Additional identity verification is required when your
                private-media policy is enabled.
              </small>
            </label>
          )}
          <p>
            {["trash", "trash-corrupt", "resolve-duplicates"].includes(
              review.action,
            )
              ? "Copies you are discarding move to trash. Originals still owned or referenced by other accounts are retained."
              : "Original files and ownership are retained."}
          </p>
        </Dialog>
      )}
      {workflow && (
        <WorkflowDesigner
          value={workflow}
          close={() => setWorkflow(null)}
          onSave={(value) => {
            const issue = workflowPersistenceError(value);
            if (issue || value.ownerId !== "taylor") {
              setError(issue || "Only the owner can change this workflow.");
              return false;
            }
            if (
              commit(
                {
                  ...state,
                  workflows: [
                    ...state.workflows.filter((x) => x.id !== value.id),
                    value,
                  ],
                },
                "Workflow saved.",
              )
            ) {
              setWorkflow(null);
              return true;
            }
            return false;
          }}
          onRemove={(id) => {
            if (
              commit(
                {
                  ...state,
                  workflows: state.workflows.filter((x) => x.id !== id),
                },
                "Workflow deleted.",
              )
            )
              setWorkflow(null);
          }}
        />
      )}
      {tool !== "duplicates" && state.history.length > 0 && (
        <details className="um-history">
          <summary>Recent utility activity</summary>
          {state.history.slice(0, 8).map((item, index) => (
            <p key={index}>
              <span>{item.title}</span>
              <time>{new Date(item.at).toLocaleString()}</time>
            </p>
          ))}
        </details>
      )}
    </div>
  );
}
function ICloudPanel({ state, commit, onNavigate }) {
  const [connectionId, setConnectionId] = useState(state.connections[0]?.id);
  const connection =
    state.connections.find((item) => item.id === connectionId) ||
    state.connections[0];
  const [draft, setDraft] = useState(connection),
    [code, setCode] = useState(""),
    [auth, setAuth] = useState(false),
    [albumSearch, setAlbumSearch] = useState(""),
    [consent, setConsent] = useState(false);
  useEffect(() => setDraft(connection), [connection]);
  const change = (patch) =>
    commit(
      {
        ...state,
        connections: state.connections.map((item) =>
          item.id === connection.id ? { ...item, ...patch } : item,
        ),
      },
      "Connection updated.",
    );
  const connected = [
    "Connected",
    "Queued",
    "Paused",
    "Cancelled",
    "Completed",
  ].includes(connection?.status);
  function addConnection() {
    const next = {
      ...initialUtilities().connections[0],
      id: crypto.randomUUID(),
      name: `iCloud connection ${state.connections.length + 1}`,
    };
    if (
      commit(
        { ...state, connections: [...state.connections, next] },
        "Connection added.",
      )
    )
      setConnectionId(next.id);
  }
  if (!connection)
    return (
      <div className="um-empty">
        <h3>Connect an iCloud library</h3>
        <p>Import originals into your own Frameleaf account.</p>
        <Button primary onClick={addConnection}>
          Add connection
        </Button>
      </div>
    );
  return (
    <>
      <div className="um-toolbar">
        <label>
          Connection
          <select
            value={connection.id}
            onChange={(event) => {
              setConnectionId(event.target.value);
              setAuth(false);
              setCode("");
            }}
          >
            {state.connections.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <Button
          disabled={state.connections.length >= 20}
          onClick={addConnection}
        >
          Add connection
        </Button>
      </div>
      <div className="um-connection">
        <Icon name="mdiCloudOutline" size={32} />
        <div>
          <h2>{connection.name}</h2>
          <p>Taylor · personal photo library</p>
          <span className="um-badge">{connection.status}</span>
        </div>
        <Button onClick={() => setAuth(true)}>
          {connected ? "Review connection" : "Connect account"}
        </Button>
      </div>
      <div className="um-work-grid">
        <section>
          <h3>Photo libraries</h3>
          {[
            ["personal", "Personal library"],
            ["shared-family", "Family shared library"],
          ].map(([id, label]) => (
            <label className="um-check" key={id}>
              <input
                type="checkbox"
                checked={draft.libraries.includes(id)}
                onChange={() =>
                  setDraft({
                    ...draft,
                    libraries: draft.libraries.includes(id)
                      ? draft.libraries.filter((x) => x !== id)
                      : [...draft.libraries, id],
                  })
                }
              />
              {label}
            </label>
          ))}
          <h3>Source albums</h3>
          <p>
            Leave albums unselected to import all albums in the selected
            libraries.
          </p>
          <label>
            Find albums
            <input
              type="search"
              value={albumSearch}
              onChange={(e) => setAlbumSearch(e.target.value)}
            />
          </label>
          {["Recents", "Summer trip", "Family"]
            .filter((a) => a.toLowerCase().includes(albumSearch.toLowerCase()))
            .map((a) => (
              <label className="um-check" key={a}>
                <input
                  type="checkbox"
                  checked={draft.albums.includes(a)}
                  onChange={() =>
                    setDraft({
                      ...draft,
                      albums: draft.albums.includes(a)
                        ? draft.albums.filter((x) => x !== a)
                        : [...draft.albums, a],
                    })
                  }
                />
                {a}
              </label>
            ))}
          <h3>Include</h3>
          {[
            ["edits", "Edited versions"],
            ["includeHidden", "Hidden photos"],
            [
              "recoverExternalAsManaged",
              "Recover external files into managed storage",
            ],
          ].map(([id, label]) => (
            <label className="um-check" key={id}>
              <input
                type="checkbox"
                checked={draft[id]}
                onChange={(e) => setDraft({ ...draft, [id]: e.target.checked })}
              />
              {label}
            </label>
          ))}
        </section>
        <section>
          <h3>Sync limits</h3>
          <label>
            Connection name
            <input
              value={draft.name}
              maxLength={100}
              onChange={(event) =>
                setDraft({ ...draft, name: event.target.value })
              }
            />
          </label>
          <label>
            Check every (hours)
            <input
              type="number"
              min="1"
              max="8760"
              value={draft.intervalHours}
              onChange={(e) =>
                setDraft({ ...draft, intervalHours: e.target.value })
              }
            />
          </label>
          <label>
            Concurrent downloads
            <input
              type="number"
              min="1"
              max="4"
              value={draft.concurrency}
              onChange={(e) =>
                setDraft({ ...draft, concurrency: e.target.value })
              }
            />
          </label>
          <label>
            Staging budget (GiB)
            <input
              type="number"
              min={1 / 1024}
              max={Number.MAX_SAFE_INTEGER / 1024 ** 3}
              step="any"
              value={draft.stagingGiB}
              onChange={(e) =>
                setDraft({ ...draft, stagingGiB: e.target.value })
              }
            />
          </label>
          <p>
            Downloads wait when the staging budget is full. Originals are
            matched before importing.
          </p>
        </section>
      </div>
      <div className="um-toolbar">
        <Button
          primary
          disabled={
            !draft.name.trim() ||
            !draft.libraries.length ||
            !Number.isInteger(Number(draft.intervalHours)) ||
            Number(draft.intervalHours) < 1 ||
            Number(draft.intervalHours) > 8760 ||
            !Number.isInteger(Number(draft.concurrency)) ||
            Number(draft.concurrency) < 1 ||
            Number(draft.concurrency) > 4 ||
            !Number.isFinite(Number(draft.stagingGiB)) ||
            Number(draft.stagingGiB) < 1 / 1024 ||
            Number(draft.stagingGiB) > Number.MAX_SAFE_INTEGER / 1024 ** 3
          }
          onClick={() => {
            if (
              (draft.includeHidden && !connection.includeHidden) ||
              (draft.recoverExternalAsManaged &&
                !connection.recoverExternalAsManaged)
            ) {
              setConsent(true);
              return;
            }
            change({
              ...draft,
              intervalHours: Number(draft.intervalHours),
              concurrency: Number(draft.concurrency),
              stagingGiB: Number(draft.stagingGiB),
            });
          }}
        >
          Save sync preferences
        </Button>
        <Button
          disabled={!connected}
          onClick={() => change({ status: "Queued" })}
        >
          Sync now
        </Button>
        <Button
          disabled={!["Queued", "Paused"].includes(connection.status)}
          onClick={() =>
            change({
              status: connection.status === "Paused" ? "Queued" : "Paused",
            })
          }
        >
          {connection.status === "Paused" ? "Resume" : "Pause"}
        </Button>
        <Button
          disabled={!["Queued", "Paused"].includes(connection.status)}
          onClick={() => change({ status: "Cancelled" })}
        >
          Cancel
        </Button>
        <Button
          disabled={connection.status !== "Cancelled"}
          onClick={() => change({ status: "Queued" })}
        >
          Retry
        </Button>
        <Button
          disabled={!connected}
          onClick={() => change({ status: "Queued" })}
        >
          Rescan source
        </Button>
      </div>
      <section className="um-result-panel">
        <h3>Reconciliation</h3>
        <p>Imported 128 · matched 42 · review 3 · skipped 0</p>
        <div className="um-result-row">
          <span>IMG_1104.MOV</span>
          <span>Ambiguous Live Photo pair</span>
          <Button onClick={() => onNavigate("utilities", "live-photos")}>
            Review
          </Button>
        </div>
        <div className="um-result-row">
          <span>IMG_2302.JPG</span>
          <span>Existing original · album membership restored</span>
        </div>
      </section>
      {consent && (
        <Dialog
          title="Review import access"
          close={() => setConsent(false)}
          actions={
            <>
              <Button onClick={() => setConsent(false)}>Cancel</Button>
              <Button
                primary
                onClick={() => {
                  change({
                    ...draft,
                    intervalHours: Number(draft.intervalHours),
                    concurrency: Number(draft.concurrency),
                    stagingGiB: Number(draft.stagingGiB),
                  });
                  setConsent(false);
                }}
              >
                Allow and save
              </Button>
            </>
          }
        >
          <p>
            {draft.includeHidden
              ? "Hidden photos will be included. Your private-media policy still applies and may require identity verification."
              : ""}
          </p>
          <p>
            {draft.recoverExternalAsManaged
              ? "External files may be copied into Frameleaf-managed storage. Existing originals are retained; this can require additional disk space."
              : ""}
          </p>
        </Dialog>
      )}
      {auth && (
        <Dialog
          title="iCloud connection"
          close={() => {
            setAuth(false);
            setCode("");
          }}
          actions={
            <>
              <Button
                onClick={() => {
                  setAuth(false);
                  setCode("");
                }}
              >
                Cancel
              </Button>
              {!connected && (
                <Button
                  primary
                  disabled={
                    connection.status === "Awaiting verification" &&
                    !/^\d{6}$/.test(code)
                  }
                  onClick={() => {
                    if (connection.status === "Awaiting verification") {
                      change({ status: "Connected" });
                      setAuth(false);
                      setCode("");
                    } else change({ status: "Awaiting verification" });
                  }}
                >
                  {connection.status === "Awaiting verification"
                    ? "Verify connection"
                    : "Continue with sample account"}
                </Button>
              )}
              {connected && (
                <Button
                  onClick={() => {
                    change({ status: "Disconnected" });
                    setAuth(false);
                  }}
                >
                  Disconnect
                </Button>
              )}
              {connection.status === "Disconnected" && (
                <Button
                  onClick={() => {
                    commit(
                      {
                        ...state,
                        connections: state.connections.filter(
                          (item) => item.id !== connection.id,
                        ),
                      },
                      "Connection removed. Imported originals were retained.",
                    );
                    setAuth(false);
                  }}
                >
                  Remove connection
                </Button>
              )}
            </>
          }
        >
          <p>Taylor’s iCloud connection · authentication preview</p>
          {connection.status === "Awaiting verification" ? (
            <label>
              Six-digit verification code
              <input
                autoComplete="off"
                inputMode="numeric"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
              <small>Use any six digits to explore this preview.</small>
            </label>
          ) : (
            <p>
              {connected
                ? "Disconnecting stops new imports. Photos already in Frameleaf are retained."
                : "Connect an Apple account to select albums and review import limits. No password is collected in this preview."}
            </p>
          )}
        </Dialog>
      )}
    </>
  );
}
function ApplicationSetup({ tool, onNavigate }) {
  const [platform, setPlatform] = useState("Android"),
    [architecture, setArchitecture] = useState("Automatic"),
    [step, setStep] = useState(0);
  return (
    <>
      <div className="um-work-grid">
        <section>
          <Icon name="mdiDevices" size={35} />
          <h2>
            {tool === "obtainium"
              ? "Direct Android updates"
              : "Frameleaf on your devices"}
          </h2>
          <p>
            Browse your library, back up new photos, and keep your account
            connected.
          </p>
          <label>
            Platform
            <select
              value={platform}
              onChange={(e) => setPlatform(e.target.value)}
            >
              {(tool === "obtainium" ? ["Android"] : ["Android", "iOS"]).map(
                (x) => (
                  <option key={x}>{x}</option>
                ),
              )}
            </select>
          </label>
          {platform === "Android" && (
            <label>
              Architecture
              <select
                value={architecture}
                onChange={(e) => setArchitecture(e.target.value)}
              >
                {[
                  "Automatic",
                  "arm64-v8a",
                  "armeabi-v7a",
                  "x86_64",
                  "Universal",
                ].map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </select>
            </label>
          )}
          <div className="um-policy">
            No signed release is available for this installation yet.
          </div>
          <Button disabled>
            {tool === "obtainium"
              ? "Open in Obtainium"
              : platform === "iOS"
                ? "Open App Store"
                : "Download Android app"}
          </Button>
        </section>
        <section>
          <h3>{tool === "obtainium" ? "Update access" : "Setup checklist"}</h3>
          <ol className="um-setup-list">
            {(tool === "obtainium"
              ? [
                  "Use this server’s Frameleaf release service",
                  "Create access limited to application downloads",
                  "Choose the device architecture",
                  "Import the configuration directly into Obtainium",
                ]
              : [
                  "Sign in to your Frameleaf account",
                  "Grant access to the photos you want to back up",
                  "Choose Wi-Fi and background upload preferences",
                  "Disable the previous automatic uploader",
                ]
            ).map((x, i) => (
              <li key={x}>
                <input
                  type="checkbox"
                  aria-label={x}
                  checked={step > i}
                  onChange={() => setStep(step > i ? i : i + 1)}
                />
                {x}
              </li>
            ))}
          </ol>
          <Button onClick={() => onNavigate("security", "credentials")}>
            Manage device access
          </Button>
          <Button onClick={() => onNavigate("server", "updates")}>
            Release information
          </Button>
        </section>
      </div>
      <p className="um-policy">
        Each person signs in to their own account. Installing another client
        does not move or merge their library.
      </p>
    </>
  );
}
