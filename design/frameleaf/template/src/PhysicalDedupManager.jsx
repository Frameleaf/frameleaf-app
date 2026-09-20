import React, { useEffect, useRef, useState } from "react";
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
export function PhysicalDedupManager({
  settings = {},
  scope,
  onScopeChange,
  onNavigate,
}) {
  const [state, setState] = useState(readState);
  const [selectedScope, setSelectedScope] = useState(() => dedupScope(scope));
  const [confirmPlan, setConfirmPlan] = useState(null);
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const previousScope = useRef(scope);
  const activeScope =
    scope !== undefined && previousScope.current !== scope
      ? dedupScope(scope)
      : selectedScope;
  const config = dedupSettings(settings);
  const configError = dedupConfigurationError(settings);
  const plan = state.plan?.scope === activeScope ? state.plan : null;
  const planError = physicalDedupPlanError(state, settings, activeScope);
  const visibleHistory =
    activeScope === "all"
      ? state.history
      : state.history.filter((item) => item.scope === activeScope);
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
    commit(
      (current) =>
        preparePhysicalDedupPlan(current, {
          settings,
          scope: activeScope,
          planId: `PD-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
        }),
      "The preview is ready. Review each retained copy before applying this plan.",
    );
  }
  function apply() {
    if (
      commit(
        (current) =>
          applyPhysicalDedupPlan(current, {
            settings,
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
    confirmation === `APPLY ${confirmPlan}`,
  );
  return (
    <section
      className="jobs-manager physical-dedup-manager"
      aria-labelledby="pd-title"
    >
      <header className="jm-header">
        <div>
          <p className="jm-eyebrow">STORAGE · FILE REUSE</p>
          <h2 id="pd-title">Share identical originals</h2>
          <p>
            Keep each person's library intact while exact copies use one
            retained file. Review the file and reference changes before applying
            a plan.
          </p>
        </div>
        <div className="jm-header-actions">
          <Button
            icon="mdiFolderSearchOutline"
            primary
            disabled={Boolean(configError)}
            onClick={scan}
          >
            {plan ? "Prepare new plan" : "Prepare preview plan"}
          </Button>
        </div>
      </header>
      <div className="jm-filterbar">
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
        <div className="pd-retained">
          <span>Retain originals in</span>
          <strong>
            {config.masterOwnerId
              ? dedupOwnerName(config.masterOwnerId)
              : "No account selected"}
          </strong>
          <Button
            onClick={() => onNavigate?.("storage", "advanced-dedup-owner")}
          >
            Change retained account
          </Button>
        </div>
      </div>
      <p className="jm-scope">
        <Icon name="mdiAccountMultipleOutline" />
        {activeScope === "all"
          ? "Review duplicate copies across all accounts."
          : `Review duplicate copies owned by ${dedupOwnerName(activeScope)}, across all of their libraries.`}{" "}
        Retained copies can belong to the configured account. Ownership and
        access stay with each asset.
      </p>
      {configError && (
        <p className="jm-message jm-error" role="status">
          {configError}
          <Button
            onClick={() => onNavigate?.("storage", "advanced-dedup-owner")}
          >
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
        <div className="jm-empty">
          <Icon name="mdiCompare" />
          <h3>
            {state.plan
              ? "Prepare a plan for this account scope"
              : "Start with a preview"}
          </h3>
          <p>
            The preview lists exact copies, the original to retain, reference
            counts, and an estimate of reclaimable space. No files change during
            the scan.
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
                {time(plan.createdAt)} · {dedupOwnerName(plan.scope)} · Retain
                in {dedupOwnerName(plan.masterOwnerId)}
              </p>
            </div>
            <Button icon="mdiDownload" onClick={exportHistory}>
              Export review
            </Button>
          </div>
          <div className="jm-metrics">
            {[
              { label: "Exact copies to share", value: plan.eligibleCount },
              {
                label: "Retained originals",
                value: new Set(
                  plan.rows
                    .filter((row) => row.status === "eligible")
                    .map((row) => row.retainedId),
                ).size,
              },
              { label: "Estimated space", value: bytes(plan.estimatedBytes) },
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
                {plan.rows.map((row) => (
                  <tr key={row.assetId}>
                    <th scope="row">
                      <strong>{row.name}</strong>
                      <small>
                        {dedupOwnerName(row.ownerId)} · {bytes(row.bytes)}
                      </small>
                      <details>
                        <summary>File location</summary>
                        <code>{row.path}</code>
                      </details>
                    </th>
                    <td>
                      {row.retainedId ? (
                        <>
                          <strong>{dedupOwnerName(plan.masterOwnerId)}</strong>
                          <small>
                            {row.retainedExists
                              ? "File available"
                              : "File unavailable"}
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
                      <strong
                        className={
                          row.status === "eligible" ? "pd-eligible" : "jm-muted"
                        }
                      >
                        {row.status === "eligible" ? "Share original" : "Skip"}
                      </strong>
                      <small>
                        {row.reason || `${bytes(row.bytes)} reclaimable`}
                      </small>
                    </td>
                  </tr>
                ))}
                {!plan.rows.length && (
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
                Applying requires this exact completed plan and a second
                confirmation.
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
                          settings,
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
                  disabled={Boolean(planError)}
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
                <dd>{dedupOwnerName(plan?.masterOwnerId)}</dd>
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
            {planError && (
              <p className="jm-message jm-error" role="alert">
                {planError}
              </p>
            )}
          </div>
        </Dialog>
      )}
    </section>
  );
}
