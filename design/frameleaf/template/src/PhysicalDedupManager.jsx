import React, { useEffect, useMemo, useRef, useState } from "react";
import { Button, Dialog } from "./App";
import { Icon } from "./Icon";
import {
  PHYSICAL_DEDUP_STORAGE_KEY,
  DEDUP_ACCOUNTS,
  dedupOwnerName,
  dedupScope,
  createPhysicalDedupState,
  parsePhysicalDedupState,
  serializePhysicalDedupState,
  dedupSettings,
  dedupConfigurationError,
  physicalDedupPlanError,
  preparePhysicalDedupPlan,
  reviewPhysicalDedupPlan,
  applyPhysicalDedupPlan,
  physicalDedupStorageToken,
} from "./physical-dedup-data.mjs";
import "./jobs-manager.css";
import "./physical-dedup-manager.css";

const bytes = (value) =>
  value >= 1024 ** 3
    ? `${(value / 1024 ** 3).toFixed(2)} GiB`
    : `${(value / 1024 ** 2).toFixed(1)} MiB`;
const readState = () => {
  try {
    return parsePhysicalDedupState(
      localStorage.getItem(PHYSICAL_DEDUP_STORAGE_KEY),
    );
  } catch {
    return createPhysicalDedupState();
  }
};
const time = (value) =>
  new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
const retainedAccounts = DEDUP_ACCOUNTS.filter((owner) => owner.id !== "all");

/**
 * Groups plan rows by the original they would share: one group per retained
 * file, plus one group for copies with no exact match in the retained account.
 */
function groupRows(plan) {
  const groups = new Map();
  for (const row of plan.rows) {
    const key = row.retainedId || `unmatched:${row.checksum}`;
    if (!groups.has(key))
      groups.set(key, {
        key,
        retained: row.retainedId
          ? {
              id: row.retainedId,
              name: row.name,
              bytes: row.bytes,
              preview: row.retainedPreview,
              kind: row.kind,
              detail: row.detail,
              path: row.retainedPath,
              checksum: row.retainedChecksum,
              exists: row.retainedExists,
              ownerId: plan.masterOwnerId,
            }
          : null,
        copies: [],
      });
    groups.get(key).copies.push(row);
  }
  return [...groups.values()].sort((a, b) => {
    const shareA = a.copies.some((row) => row.status === "eligible") ? 0 : 1;
    const shareB = b.copies.some((row) => row.status === "eligible") ? 0 : 1;
    return shareA - shareB || (a.retained ? 0 : 1) - (b.retained ? 0 : 1) ||
      a.copies[0].name.localeCompare(b.copies[0].name);
  });
}

function Thumb({ src, kind, unavailable = false, size = "copy" }) {
  return (
    <span className={`pd-thumb ${size}${unavailable ? " unavailable" : ""}`} aria-hidden="true">
      {src ? <img src={src} alt="" loading="lazy" draggable={false} /> : null}
      {kind === "video" && (
        <span className="pd-thumb-kind">
          <Icon name="mdiPlay" size={14} />
        </span>
      )}
      {unavailable && (
        <span className="pd-thumb-unavailable">
          <Icon name="mdiFileAlertOutline" size={18} />
          Unavailable
        </span>
      )}
    </span>
  );
}

export function PhysicalDedupManager({
  settings = {},
  scope,
  onScopeChange,
  onNavigate,
}) {
  const [state, setState] = useState(readState);
  const [selectedScope, setSelectedScope] = useState(() => dedupScope(scope));
  const [previewOwner, setPreviewOwner] = useState("taylor");
  const [view, setView] = useState("media");
  const [confirmPlan, setConfirmPlan] = useState(null);
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const previousScope = useRef(scope);
  const activeScope =
    scope !== undefined && previousScope.current !== scope
      ? dedupScope(scope)
      : selectedScope;
  // The saved master account wins. Until one is saved, a preview can still be
  // prepared against an account chosen here; applying needs the saved setting.
  const savedMaster = dedupSettings(settings).masterOwnerId;
  const masterSaved = retainedAccounts.some((owner) => owner.id === savedMaster);
  const effectiveSettings = useMemo(
    () =>
      masterSaved
        ? settings
        : { ...settings, advancedDedupMaster: `sample-${previewOwner}` },
    [settings, masterSaved, previewOwner],
  );
  const config = dedupSettings(effectiveSettings);
  const configError = dedupConfigurationError(effectiveSettings);
  const plan = state.plan?.scope === activeScope ? state.plan : null;
  const planError = physicalDedupPlanError(state, effectiveSettings, activeScope);
  const applyBlocked = !masterSaved
    ? "Save the retained account in Storage → Deduplication ownership before applying a plan."
    : "";
  const visibleHistory =
    activeScope === "all"
      ? state.history
      : state.history.filter((item) => item.scope === activeScope);
  const groups = useMemo(() => (plan ? groupRows(plan) : []), [plan]);
  useEffect(() => {
    previousScope.current = scope;
    if (scope !== undefined) setSelectedScope(dedupScope(scope));
  }, [scope]);
  useEffect(() => {
    setConfirmPlan(null);
    setConfirmation("");
    setNotice("");
  }, [activeScope, config.enabled, config.masterOwnerId]);
  useEffect(() => {
    const sync = (event) => {
      if (event.key !== PHYSICAL_DEDUP_STORAGE_KEY && event.key !== null)
        return;
      setState(readState());
      setConfirmPlan(null);
      setConfirmation("");
      setNotice("The plan changed in another tab. Review its current version.");
    };
    addEventListener("storage", sync);
    return () => removeEventListener("storage", sync);
  }, []);
  function commit(action, message) {
    try {
      const latest = parsePhysicalDedupState(
        localStorage.getItem(PHYSICAL_DEDUP_STORAGE_KEY),
      );
      if (
        physicalDedupStorageToken(latest) !== physicalDedupStorageToken(state)
      ) {
        setState(latest);
        setConfirmPlan(null);
        setConfirmation("");
        throw new Error(
          "The plan changed in another tab. Review the latest version before continuing.",
        );
      }
      const next = action(state);
      localStorage.setItem(
        PHYSICAL_DEDUP_STORAGE_KEY,
        serializePhysicalDedupState(next),
      );
      setState(next);
      setError("");
      setNotice(message);
      return true;
    } catch (cause) {
      setError(
        cause.message ||
          "Device storage is unavailable. No changes were saved.",
      );
      return false;
    }
  }
  function scan() {
    if (
      commit(
        (current) =>
          preparePhysicalDedupPlan(current, {
            settings: effectiveSettings,
            scope: activeScope,
            planId: `PD-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
          }),
        "Preview ready. Check each retained original and its copies before applying the plan.",
      )
    )
      setView("media");
  }
  function apply() {
    if (
      commit(
        (current) =>
          applyPhysicalDedupPlan(current, {
            settings: effectiveSettings,
            scope: activeScope,
            planId: confirmPlan,
            confirmation,
          }),
        "Sample plan applied. No server files changed.",
      )
    ) {
      setConfirmPlan(null);
      setConfirmation("");
    }
  }
  function exportHistory() {
    const data = {
      sample: true,
      exportedAt: new Date().toISOString(),
      ...JSON.parse(serializePhysicalDedupState(state)),
      currentPlan: state.plan,
      history: state.history,
    };
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "frameleaf-sample-file-sharing-review.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const canConfirm = Boolean(
    confirmPlan &&
    plan?.id === confirmPlan &&
    plan.status === "reviewed" &&
    !planError &&
    !applyBlocked &&
    confirmation === `APPLY ${confirmPlan}`,
  );
  const retainedName = dedupOwnerName(plan?.masterOwnerId);

  const evidence = (row) => (
    <details className="pd-evidence">
      <summary>Evidence</summary>
      <dl>
        <div>
          <dt>File</dt>
          <dd>
            <code>{row.path}</code>
          </dd>
        </div>
        <div>
          <dt>SHA-1</dt>
          <dd>
            <code>{row.checksum}</code>
          </dd>
        </div>
        {row.retainedChecksum && (
          <div>
            <dt>Retained copy</dt>
            <dd>
              <code>{row.retainedPath}</code>
              <code>{row.retainedChecksum}</code>
            </dd>
          </div>
        )}
        <div>
          <dt>Match</dt>
          <dd>
            {row.retainedChecksum === row.checksum
              ? "Checksum and byte size match"
              : "No exact match"}
          </dd>
        </div>
      </dl>
    </details>
  );

  const mediaView = (
    <div className="pd-groups">
      {groups.map((group) => {
        const sharing = group.copies.filter((row) => row.status === "eligible");
        const first = group.copies[0];
        return (
          <article
            key={group.key}
            className={`pd-group${sharing.length ? "" : " skipped"}`}
            aria-label={group.retained ? `${group.retained.name}, retained original and copies` : `${first.name}, no exact copy`}
          >
            <div className="pd-retained-side">
              {group.retained ? (
                <>
                  <Thumb
                    src={group.retained.preview}
                    kind={group.retained.kind}
                    unavailable={!group.retained.exists}
                    size="retained"
                  />
                  <div className="pd-retained-text">
                    <span className="pd-badge retained">
                      <Icon name="mdiShieldCheckOutline" size={13} />
                      Retained original
                    </span>
                    <strong>{group.retained.name}</strong>
                    <small>
                      {dedupOwnerName(group.retained.ownerId)} · {bytes(group.retained.bytes)}
                      {group.retained.detail ? ` · ${group.retained.detail}` : ""}
                    </small>
                    <small className="pd-references">
                      <Icon name="mdiLinkVariant" size={13} />
                      {first.referencesBefore} {first.referencesBefore === 1 ? "reference" : "references"} now
                      {sharing.length ? ` → ${first.referencesAfter} after this plan` : ""}
                    </small>
                    <details className="pd-evidence">
                      <summary>Location</summary>
                      <code>{group.retained.path}</code>
                    </details>
                  </div>
                </>
              ) : (
                <>
                  <Thumb src={first.preview} kind={first.kind} size="retained" />
                  <div className="pd-retained-text">
                    <span className="pd-badge">
                      <Icon name="mdiHelpCircleOutline" size={13} />
                      No exact copy in {retainedName}
                    </span>
                    <strong>{first.name}</strong>
                    <small>
                      Nothing in {retainedName}'s library has the same bytes, so
                      these copies stay as they are.
                    </small>
                  </div>
                </>
              )}
            </div>
            <div className="pd-link" aria-hidden="true">
              <Icon name={sharing.length ? "mdiLinkVariant" : "mdiLinkVariantOff"} size={18} />
            </div>
            <ul className="pd-copies" aria-label="Duplicate copies">
              {group.copies.map((row) => (
                <li
                  key={row.assetId}
                  className={`pd-copy ${row.status}`}
                >
                  <Thumb src={row.preview} kind={row.kind} />
                  <div className="pd-copy-text">
                    <strong>{dedupOwnerName(row.ownerId)}'s copy</strong>
                    <small>
                      {row.name} · {bytes(row.bytes)}
                      {row.detail ? ` · ${row.detail}` : ""}
                    </small>
                    <span className={`pd-decision ${row.status}`}>
                      <Icon
                        name={row.status === "eligible" ? "mdiCheckCircleOutline" : "mdiMinusCircleOutline"}
                        size={14}
                      />
                      {row.status === "eligible"
                        ? `Share original · ${bytes(row.bytes)} reclaimed`
                        : `Skip · ${row.reason}`}
                    </span>
                    {evidence(row)}
                  </div>
                </li>
              ))}
            </ul>
          </article>
        );
      })}
      {!groups.length && (
        <div className="jm-empty">No duplicate candidates for this account scope.</div>
      )}
    </div>
  );

  const tableView = (
    <div className="jm-table-wrap">
      <table className="pd-table">
        <thead>
          <tr>
            <th scope="col">Duplicate copy</th>
            <th scope="col">Retained original</th>
            <th scope="col">Match evidence</th>
            <th scope="col">References</th>
            <th scope="col">Plan decision</th>
          </tr>
        </thead>
        <tbody>
          {plan?.rows.map((row) => (
            <tr key={row.assetId}>
              <th scope="row">
                <span className="pd-cell-media">
                  <Thumb src={row.preview} kind={row.kind} size="cell" />
                  <span>
                    <strong>{row.name}</strong>
                    <small>
                      {dedupOwnerName(row.ownerId)} · {bytes(row.bytes)}
                    </small>
                  </span>
                </span>
                <details>
                  <summary>File location</summary>
                  <code>{row.path}</code>
                </details>
              </th>
              <td>
                {row.retainedId ? (
                  <>
                    <strong>{retainedName}</strong>
                    <small>
                      {row.retainedExists ? "File available" : "File unavailable"}
                    </small>
                    <details>
                      <summary>Retained location</summary>
                      <code>{row.retainedPath}</code>
                    </details>
                  </>
                ) : (
                  <span className="jm-muted">No exact copy</span>
                )}
              </td>
              <td>
                <span>
                  {row.retainedChecksum === row.checksum
                    ? "Checksum + byte size match"
                    : "No exact match"}
                </span>
                <details>
                  <summary>Checksum evidence</summary>
                  <small>SHA-1 · sample evidence</small>
                  <code>{row.checksum}</code>
                  {row.retainedChecksum && (
                    <>
                      <small>Retained copy</small>
                      <code>{row.retainedChecksum}</code>
                    </>
                  )}
                </details>
              </td>
              <td>
                {row.retainedId ? (
                  <>
                    <strong>
                      {row.referencesBefore} → {row.referencesAfter}
                    </strong>
                    <small>Across this plan</small>
                  </>
                ) : (
                  "—"
                )}
              </td>
              <td>
                <strong className={row.status === "eligible" ? "pd-eligible" : "jm-muted"}>
                  {row.status === "eligible" ? "Share original" : "Skip"}
                </strong>
                <small>{row.reason || `${bytes(row.bytes)} reclaimable`}</small>
              </td>
            </tr>
          ))}
          {!plan?.rows.length && (
            <tr>
              <td colSpan="5">
                <div className="jm-empty">
                  No duplicate candidates for this account scope.
                </div>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );

  return (
    <section className="jobs-manager physical-dedup-manager" aria-label="Physical deduplication">
      <div className="pd-toolbar">
        <label>
          <span>Scan scope</span>
          <select
            value={activeScope}
            onChange={(event) => {
              setSelectedScope(event.target.value);
              setConfirmPlan(null);
              setConfirmation("");
              onScopeChange?.(event.target.value);
            }}
          >
            {DEDUP_ACCOUNTS.map((owner) => (
              <option key={owner.id} value={owner.id}>
                {owner.name}
              </option>
            ))}
            {!DEDUP_ACCOUNTS.some((owner) => owner.id === activeScope) && (
              <option value={activeScope}>Selected account</option>
            )}
          </select>
        </label>
        {masterSaved ? (
          <div className="pd-retained">
            <span>Retain originals in</span>
            <strong>{dedupOwnerName(savedMaster)}</strong>
            <Button onClick={() => onNavigate?.("storage", "advanced-dedup-owner")}>
              Change
            </Button>
          </div>
        ) : (
          <label>
            <span>Retain originals in</span>
            <select
              value={previewOwner}
              onChange={(event) => {
                setPreviewOwner(event.target.value);
                setConfirmPlan(null);
                setConfirmation("");
              }}
            >
              {retainedAccounts.map((owner) => (
                <option key={owner.id} value={owner.id}>
                  {owner.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="pd-toolbar-actions">
          <Button
            icon="mdiFolderSearchOutline"
            primary
            disabled={Boolean(configError)}
            onClick={scan}
          >
            {plan ? "Prepare new plan" : "Prepare preview plan"}
          </Button>
        </div>
      </div>
      <p className="jm-scope">
        <Icon name="mdiAccountMultipleOutline" />
        {activeScope === "all"
          ? "Reviews duplicate copies across all accounts."
          : `Reviews duplicate copies owned by ${dedupOwnerName(activeScope)}, across all of their libraries.`}{" "}
        Ownership and access stay with each asset.
        {!masterSaved && (
          <>
            {" "}
            Previews use the account chosen above;{" "}
            <button
              type="button"
              className="text-button"
              onClick={() => onNavigate?.("storage", "advanced-dedup-owner")}
            >
              save a retained account
            </button>{" "}
            before applying a plan.
          </>
        )}
      </p>
      {configError && (
        <p className="jm-message jm-error" role="status">
          {configError}
          <Button onClick={() => onNavigate?.("storage", "advanced-dedup-owner")}>
            Open settings
          </Button>
        </p>
      )}
      {error && (
        <p className="jm-message jm-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="jm-message" role="status">
          <Icon name="mdiCheckCircleOutline" />
          {notice}
        </p>
      )}
      {!plan ? (
        <div className="jm-empty pd-empty">
          <Icon name="mdiCompare" />
          <h3>
            {state.plan ? "Prepare a plan for this account scope" : "Start with a preview"}
          </h3>
          <p>
            The preview shows every exact copy next to the original that would
            be kept, with reference counts and the space you would get back.
            No files change during the scan.
          </p>
        </div>
      ) : (
        <>
          <div className="pd-plan-heading">
            <div>
              <span
                className={`jm-status jm-status-${plan.status === "applied" ? "completed" : "waiting"}`}
              >
                <i />
                {
                  {
                    completed: "Preview ready",
                    reviewed: "Reviewed",
                    applied: "Applied to sample",
                  }[plan.status]
                }
              </span>
              <h3>{plan.id}</h3>
              <p>
                {time(plan.createdAt)} · {dedupOwnerName(plan.scope)} · Retain in {retainedName}
              </p>
            </div>
            <div className="pd-plan-tools">
              <div className="pd-view" role="group" aria-label="Plan view">
                <button
                  type="button"
                  aria-pressed={view === "media"}
                  onClick={() => setView("media")}
                >
                  <Icon name="mdiImageMultipleOutline" size={16} />
                  Media
                </button>
                <button
                  type="button"
                  aria-pressed={view === "table"}
                  onClick={() => setView("table")}
                >
                  <Icon name="mdiTableLarge" size={16} />
                  Evidence
                </button>
              </div>
              <Button icon="mdiDownload" onClick={exportHistory}>
                Export review
              </Button>
            </div>
          </div>
          <div className="jm-metrics">
            {[
              { label: "Copies to share", value: plan.eligibleCount },
              {
                label: "Retained originals",
                value: new Set(
                  plan.rows
                    .filter((row) => row.status === "eligible")
                    .map((row) => row.retainedId),
                ).size,
              },
              { label: "Space to reclaim", value: bytes(plan.estimatedBytes) },
              { label: "Skipped copies", value: plan.skippedCount },
            ].map((item) => (
              <div className="jm-metric" key={item.label}>
                <div>
                  <span>{item.label}</span>
                  <strong>{item.value}</strong>
                </div>
              </div>
            ))}
          </div>
          {planError && plan.status !== "applied" && (
            <p className="jm-message jm-error" role="status">
              {planError}
            </p>
          )}
          {view === "media" ? mediaView : tableView}
          <p className="jm-muted pd-evidence-note">
            Each asset keeps its owner and library membership. Only exact copies
            are eligible; external-library files and unavailable originals are
            skipped. Estimates cover the listed originals and exclude generated
            previews, filesystem overhead, and delayed file cleanup.
          </p>
          <div className="jm-queue-actions">
            <div>
              <Icon name="mdiShieldCheckOutline" />
              <span>
                {applyBlocked ||
                  "Applying requires this exact completed plan and a second confirmation."}
              </span>
            </div>
            <div>
              {plan.status === "completed" && (
                <Button
                  disabled={Boolean(planError)}
                  onClick={() =>
                    commit(
                      (current) =>
                        reviewPhysicalDedupPlan(current, {
                          settings: effectiveSettings,
                          scope: activeScope,
                          planId: plan.id,
                        }),
                      `${plan.id} is marked reviewed. Apply it only if the retained copies and reference counts are correct.`,
                    )
                  }
                >
                  Mark plan reviewed
                </Button>
              )}
              {plan.status === "reviewed" && (
                <Button
                  primary
                  disabled={Boolean(planError) || Boolean(applyBlocked)}
                  onClick={() => {
                    setConfirmPlan(plan.id);
                    setConfirmation("");
                  }}
                >
                  Apply reviewed plan
                </Button>
              )}
              {plan.status === "applied" && (
                <span className="jm-status jm-status-completed">
                  <i />
                  Plan recorded · asset ownership preserved
                </span>
              )}
            </div>
          </div>
        </>
      )}
      {visibleHistory.length > 0 && (
        <details className="jm-history">
          <summary>
            <Icon name="mdiHistory" />
            Review history <span>{visibleHistory.length}</span>
          </summary>
          <ol>
            {visibleHistory.map((item) => (
              <li key={item.id}>
                <div>
                  <strong>
                    {item.title} · {item.planId}
                  </strong>
                  <span>
                    {dedupOwnerName(item.scope)} · {item.eligibleCount} exact
                    copies · {bytes(item.bytes)}
                  </span>
                </div>
                <time dateTime={item.at}>{time(item.at)}</time>
              </li>
            ))}
          </ol>
        </details>
      )}
      {confirmPlan && (
        <Dialog
          title="Apply this reviewed plan?"
          close={() => setConfirmPlan(null)}
          actions={
            <>
              <Button onClick={() => setConfirmPlan(null)}>Cancel</Button>
              <Button primary disabled={!canConfirm} onClick={apply}>
                Apply this plan
              </Button>
            </>
          }
        >
          <div className="jm-review pd-confirm">
            <p>
              Link the listed asset records to their retained originals, then
              remove only the duplicate physical copies. No asset ownership or
              sharing permissions change.
            </p>
            <dl>
              <div>
                <dt>Reviewed plan</dt>
                <dd>{confirmPlan}</dd>
              </div>
              <div>
                <dt>Account scope</dt>
                <dd>{dedupOwnerName(plan?.scope)}</dd>
              </div>
              <div>
                <dt>Retained account</dt>
                <dd>{retainedName}</dd>
              </div>
              <div>
                <dt>Copies to share</dt>
                <dd>{plan?.eligibleCount ?? 0}</dd>
              </div>
              <div>
                <dt>Estimated space</dt>
                <dd>{bytes(plan?.estimatedBytes ?? 0)}</dd>
              </div>
            </dl>
            <p>
              Keep an independent backup. A shared original still needs
              protection against disk loss.
            </p>
            <label>
              Type <strong>APPLY {confirmPlan}</strong> to confirm
              <input
                data-initial-focus
                autoComplete="off"
                spellCheck="false"
                maxLength={90}
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
              />
            </label>
            {(planError || applyBlocked) && (
              <p className="jm-message jm-error" role="alert">
                {planError || applyBlocked}
              </p>
            )}
          </div>
        </Dialog>
      )}
    </section>
  );
}
