import React, { useEffect, useId, useState } from "react";
import { Button, Dialog } from "./Controls";
import { Icon } from "./Icon";
import { FrameleafCloud, useCloudState } from "./FrameleafCloud";
import {
  BUDDY_STORAGE_KEY,
  BUDDY_SCENARIOS,
  SAMPLE_RECOVERY_KIT,
  OWN_BACKUP_ITEMS,
  loadBuddyState,
  buddyStatus,
  previewBuddyScenario,
  validateBuddyAgreement,
  validateBuddyControls,
} from "./buddy-backup.mjs";
import "./backup-center.css";

const gb = (value) =>
  `${Number(value).toLocaleString("en-CA", { maximumFractionDigits: 1 })} GB`;
const VIEWS = {
  status: "Status",
  cloud: "Cloud Backup",
  controls: "Buddy controls",
  restore: "Recover",
  compare: "How it works",
};

function useBuddyState() {
  const [state, setState] = useState(() => loadBuddyState(localStorage));
  const [error, setError] = useState("");
  useEffect(() => {
    const sync = () => setState(loadBuddyState(localStorage));
    addEventListener("frameleaf-buddy-design", sync);
    addEventListener("storage", sync);
    return () => {
      removeEventListener("frameleaf-buddy-design", sync);
      removeEventListener("storage", sync);
    };
  }, []);
  function save(next) {
    try {
      localStorage.setItem(BUDDY_STORAGE_KEY, JSON.stringify(next));
      setState(next);
      setError("");
      dispatchEvent(new Event("frameleaf-buddy-design"));
      return true;
    } catch {
      setError(
        "This browser could not save the sample state. Free local storage and try again.",
      );
      return false;
    }
  }
  return [state, save, error];
}

function Facts({ rows }) {
  return (
    <dl className="bk-facts">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Capacity({ label, value, max, detail }) {
  return (
    <div className="bk-capacity">
      <div>
        <span>{label}</span>
        <strong>
          {gb(value)} <small>/ {gb(max)}</small>
        </strong>
      </div>
      <meter aria-label={label} min={0} max={max} value={value} />
      <small>
        {detail ||
          `${gb(Math.max(0, max - value))} remaining in this agreement`}
      </small>
    </div>
  );
}

function Card({ title, icon, status, children, className = "" }) {
  const id = useId();
  return (
    <section className={`bk-card ${className}`} aria-labelledby={id}>
      <div className="bk-card-heading">
        <span className="bk-icon">
          <Icon name={icon} size={22} />
        </span>
        <h2 id={id}>{title}</h2>
        {status && <span className="bk-badge">{status}</span>}
      </div>
      {children}
    </section>
  );
}

export function BackupSummary({ onNavigate, analytics = false }) {
  const [state] = useBuddyState();
  const status = buddyStatus(state);
  const [cloud] = useCloudState();
  function openBackup(view = "status") {
    const url = new URL(location.href);
    url.searchParams.set("backupView", view);
    history.replaceState({}, "", url);
    onNavigate?.("backups");
  }
  return (
    <section
      className={`bk-summary ${analytics ? "bk-summary-analytics" : ""}`}
      aria-label="Backup and hosting status"
    >
      <div className="bk-summary-heading">
        <div>
          <h2>Backup & hosting</h2>
          <p>
            {analytics
              ? "Server-wide operational snapshot · 2 Oct 2026. Independent of the library filters above."
              : "Your off-site copies and the encrypted space you share."}
          </p>
        </div>
        <Button onClick={() => openBackup()} icon="mdiBackupRestore">
          Open Backup
        </Button>
      </div>
      <div className="bk-summary-grid">
        <button className="bk-summary-item" onClick={() => openBackup("cloud")}>
          <Icon name="mdiCloudUploadOutline" />
          <span>
            <strong>Cloud Backup</strong>
            <small>
              {cloud.backup.configured
                ? "Managed destination configured"
                : "Not set up"}
            </small>
            <b>
              {cloud.backup.configured
                ? gb((cloud.backup.usedBytes || 609e9) / 1e9)
                : "Add a managed copy"}
            </b>
          </span>
          <Icon name="mdiChevronRight" />
        </button>
        <button className="bk-summary-item" onClick={() => openBackup()}>
          <Icon name="mdiArrowTopRight" />
          <span>
            <strong>My backup · outgoing</strong>
            <small>{status.label}</small>
            <b>
              {state.paired
                ? `${gb(status.storedGB)} / ${gb(state.outgoingQuotaGB)}`
                : "Choose a buddy"}
            </b>
          </span>
          <Icon name="mdiChevronRight" />
        </button>
        <button
          className="bk-summary-item"
          onClick={() => openBackup("controls")}
        >
          <Icon name="mdiArrowBottomLeft" />
          <span>
            <strong>Hosting for my buddy · incoming</strong>
            <small>{status.receiving}</small>
            <b>
              {state.paired
                ? `${gb(state.incomingGB)} encrypted / ${gb(state.incomingQuotaGB)}`
                : "No space reserved"}
            </b>
          </span>
          <Icon name="mdiChevronRight" />
        </button>
      </div>
      {analytics && (
        <div className="bk-analytics-extra">
          <div>
            <h3>Transfer activity</h3>
            <p>Last 7 days · sample encrypted traffic</p>
            <div className="bk-transfer-bars">
              <span>Sent to buddy</span>
              <meter
                aria-label="Sent to buddy, 18.4 GB this week"
                max={24}
                value={18.4}
              />
              <strong>18.4 GB</strong>
              <span>Received here</span>
              <meter
                aria-label="Received here, 12.6 GB this week"
                max={24}
                value={12.6}
              />
              <strong>12.6 GB</strong>
            </div>
          </div>
          <Facts
            rows={[
              [
                "Last recovery point",
                state.hasRecoveryPoint ? status.recoveryPoint : "None yet",
              ],
              ["Last restore verification", status.verification],
              [
                "Hosting reservation",
                state.paired ? gb(state.incomingQuotaGB) : "None",
              ],
              [
                "Connection",
                state.connection === "direct"
                  ? "Direct · no relay bytes"
                  : "Relay · plan allowance applies",
              ],
            ]}
          />
        </div>
      )}
      {status.alert && (
        <p className="bk-summary-alert">
          <Icon name="mdiAlertCircleOutline" size={16} />
          {status.alert[0]}
        </p>
      )}
    </section>
  );
}

function BackupDiagram() {
  return (
    <div
      className="bk-map"
      role="img"
      aria-label="Your library sends a backup to managed Cloud storage and an encrypted backup to your buddy. Your buddy sends encrypted backup data to a separate vault on your server. Neither buddy can browse the other library."
    >
      <div className="bk-map-source">
        <div className="bk-server-art">
          <Icon name="mdiServerOutline" size={40} />
          <span />
          <span />
        </div>
        <strong>Your Frameleaf server</strong>
        <small>Your library. Your recovery key.</small>
      </div>
      <div className="bk-map-lanes">
        <div className="bk-map-lane">
          <span className="bk-line">
            <Icon name="mdiArrowRight" size={18} />
          </span>
          <span className="bk-map-destination">
            <Icon name="mdiCloudOutline" size={30} />
            <span>
              <strong>Cloud Backup</strong>
              <small>Managed storage</small>
            </span>
          </span>
        </div>
        <div className="bk-map-lane">
          <span className="bk-line">
            <Icon name="mdiLockOutline" size={16} />
            <Icon name="mdiArrowRight" size={18} />
          </span>
          <span className="bk-map-destination">
            <Icon name="mdiServerSecurity" size={30} />
            <span>
              <strong>Buddy Backup</strong>
              <small>Your encrypted copy, off-site</small>
            </span>
          </span>
        </div>
        <div className="bk-map-lane bk-map-incoming">
          <span className="bk-line">
            <Icon name="mdiArrowLeft" size={18} />
            <Icon name="mdiLockOutline" size={16} />
          </span>
          <span className="bk-map-destination">
            <Icon name="mdiPackageVariantClosed" size={28} />
            <span>
              <strong>You host for your buddy</strong>
              <small>Encrypted data only</small>
            </span>
          </span>
        </div>
      </div>
    </div>
  );
}

export function BackupCenter({ onNavigate }) {
  const [state, save, saveError] = useBuddyState();
  const [cloud] = useCloudState();
  const initialView = new URL(location.href).searchParams.get("backupView");
  const [view, setView] = useState(
    Object.hasOwn(VIEWS, initialView) ? initialView : "status",
  );
  const [dialog, setDialog] = useState(null);
  const [notice, setNotice] = useState("");
  const status = buddyStatus(state);
  useEffect(() => {
    const url = new URL(location.href);
    url.searchParams.set("backupView", view);
    history.replaceState({}, "", url);
  }, [view]);
  function update(patch, message) {
    if (save({ ...state, ...patch }) && message) setNotice(message);
  }
  function runBackup() {
    update(
      {
        scenario: state.hasRecoveryPoint ? "incremental" : "initial",
        sendingPaused: false,
      },
      "Sample transfer started. Only new or changed encrypted blocks are sent after the first backup.",
    );
  }
  function openAlert() {
    if (state.scenario === "key") setDialog("unlock");
    else if (state.scenario === "auth") setDialog("connection");
    else if (state.scenario === "offline")
      setNotice(
        "Sample connection check: Jamie’s server is still offline. Your existing recovery point is kept.",
      );
    else if (state.scenario === "stale") runBackup();
    else if (state.scenario === "ending" || state.scenario === "integrity")
      setView("restore");
    else if (state.scenario === "blocked") setDialog("end");
    else setView("controls");
  }
  return (
    <div className="backup-center">
      <nav className="bk-tabs" aria-label="Backup sections">
        {Object.entries(VIEWS).map(([id, label]) => (
          <button
            key={id}
            aria-current={view === id ? "page" : undefined}
            onClick={() => setView(id)}
          >
            {label}
          </button>
        ))}
      </nav>
      {notice && (
        <div className="bk-notice" role="status">
          <Icon name="mdiInformationOutline" />
          <span>{notice}</span>
          <Button
            aria-label="Dismiss backup message"
            icon="mdiClose"
            onClick={() => setNotice("")}
          />
        </div>
      )}
      {saveError && (
        <p className="bk-alert" role="alert">
          {saveError}
        </p>
      )}
      {view === "status" && (
        <>
          <div className="bk-intro">
            <div>
              <h2>A safe copy, away from home.</h2>
              <p>
                Use managed Cloud storage, a trusted buddy, or both. Each
                destination keeps its own backup and recovery history.
              </p>
              <Button
                icon="mdiInformationOutline"
                onClick={() => setView("compare")}
              >
                Compare destinations
              </Button>
            </div>
            <BackupDiagram />
          </div>
          {status.alert && (
            <div className="bk-alert" role="status">
              <Icon name="mdiAlertCircleOutline" />
              <div>
                <strong>{status.alert[0]}</strong>
                <p>{status.alert[1]}</p>
              </div>
              <Button onClick={openAlert}>{status.alert[2]}</Button>
            </div>
          )}
          <div className="bk-destinations">
            <Card
              title="My backup"
              icon="mdiArrowTopRight"
              status={status.label}
              className="bk-outgoing"
            >
              <p className="bk-card-description">
                {state.paired ? (
                  <>
                    Your library → <strong>{state.buddy}</strong>
                  </>
                ) : (
                  "Keep an encrypted copy on a trusted person’s Frameleaf server."
                )}
              </p>
              {state.paired ? (
                <>
                  <Capacity
                    label="Stored at my buddy"
                    value={status.storedGB}
                    max={state.outgoingQuotaGB}
                  />
                  {["initial", "incremental"].includes(state.scenario) && (
                    <div className="bk-progress">
                      <div>
                        <strong>
                          {state.scenario === "initial"
                            ? "First full backup"
                            : "New and changed data"}
                        </strong>
                        <span>{status.progress}%</span>
                      </div>
                      <progress
                        aria-label="Outgoing backup progress"
                        max={100}
                        value={status.progress}
                      />
                      <small>
                        {state.sendingPaused
                          ? "Paused. Completed blocks are kept."
                          : state.scenario === "initial"
                            ? `260 GB of 684.2 GB · around ${Math.round(((state.outgoingGB - status.storedGB) * 8000) / (Number(state.controls.sendMbps) * 3600))} transfer hours at the current cap, within your daily window`
                            : "141 MB of 214 MB · around a minute remaining"}
                      </small>
                      <Button
                        onClick={() =>
                          update(
                            { scenario: "current", hasRecoveryPoint: true },
                            "Sample backup completed. The new recovery point is available.",
                          )
                        }
                      >
                        Complete sample transfer
                      </Button>
                    </div>
                  )}
                  <Facts
                    rows={[
                      [
                        "Latest recovery point",
                        state.hasRecoveryPoint
                          ? status.recoveryPoint
                          : "First backup not complete",
                      ],
                      ["Last restore verification", status.verification],
                      [
                        "Connection",
                        state.scenario === "offline"
                          ? "Offline · last seen 1 Oct, 23:48"
                          : `${state.connection === "direct" ? "Direct" : "Relay"} · encrypted in transit`,
                      ],
                      [
                        "Next backup window",
                        `${state.controls.start}–${state.controls.end} · America/Edmonton`,
                      ],
                    ]}
                  />
                  <div className="bk-actions">
                    <Button
                      primary
                      icon="mdiPlayOutline"
                      disabled={
                        !status.canSend ||
                        ["initial", "incremental"].includes(state.scenario)
                      }
                      onClick={runBackup}
                    >
                      Back up now
                    </Button>
                    <Button
                      icon={state.sendingPaused ? "mdiPlayOutline" : "mdiPause"}
                      disabled={["ending", "blocked"].includes(state.scenario)}
                      onClick={() =>
                        update(
                          { sendingPaused: !state.sendingPaused },
                          state.sendingPaused
                            ? "Sending resumed."
                            : "Sending paused. Hosting for your buddy is unchanged.",
                        )
                      }
                    >
                      {state.sendingPaused ? "Resume sending" : "Pause sending"}
                    </Button>
                    <Button
                      icon="mdiBackupRestore"
                      onClick={() => setView("restore")}
                    >
                      Restore my backup
                    </Button>
                  </div>
                </>
              ) : (
                <div className="bk-empty">
                  <Icon name="mdiServerSecurity" size={44} />
                  <h3>Give your memories another home.</h3>
                  <p>
                    Pair compatible Cloud-linked servers, agree on space, save
                    your recovery kit, then test the encrypted connection.
                  </p>
                  <Button primary onClick={() => setDialog("pair")}>
                    Set up Buddy Backup
                  </Button>
                </div>
              )}
            </Card>
            <Card
              title="Hosting for my buddy"
              icon="mdiArrowBottomLeft"
              status={status.receiving}
              className="bk-incoming"
            >
              <p className="bk-card-description">
                {state.paired ? (
                  <>
                    <strong>{state.buddy}</strong> → encrypted storage here
                  </>
                ) : (
                  "A separate encrypted vault on your server."
                )}
              </p>
              {state.paired ? (
                <>
                  <Capacity
                    label="Encrypted data hosted here"
                    value={state.incomingGB}
                    max={state.incomingQuotaGB}
                  />
                  {state.receivingActive && (
                    <div className="bk-progress">
                      <div>
                        <strong>Incoming encrypted transfer</strong>
                        <span>62%</span>
                      </div>
                      <progress
                        aria-label="Incoming encrypted transfer progress"
                        value={62}
                        max={100}
                      />
                      <small>
                        {state.receivingPaused
                          ? "Receiving paused. Verified encrypted blocks are kept."
                          : "53 MB of 86 MB · no media details are shared"}
                      </small>
                      <Button
                        disabled={state.receivingPaused}
                        onClick={() =>
                          update(
                            { receivingActive: false },
                            "Sample incoming transfer completed and verified as stored.",
                          )
                        }
                      >
                        Complete incoming sample
                      </Button>
                    </div>
                  )}
                  <Facts
                    rows={[
                      ["Reserved for my buddy", gb(state.incomingQuotaGB)],
                      [
                        "Usable free space",
                        state.scenario === "capacity"
                          ? "58 GB · below safety reserve"
                          : "950 GB after safety reserve",
                      ],
                      ["Last received", "2 Oct, 02:26 · 86 MB"],
                      [
                        "Receive limit",
                        `${state.controls.receiveMbps} Mbit/s · ${state.controls.concurrent} transfers max`,
                      ],
                    ]}
                  />
                  <div className="bk-privacy">
                    <Icon name="mdiLockOutline" />
                    <p>
                      Only your buddy has the recovery key. Their photos,
                      albums, people and search results never appear in your
                      library.
                    </p>
                  </div>
                  <div className="bk-actions">
                    <Button
                      icon={
                        state.receivingPaused ? "mdiPlayOutline" : "mdiPause"
                      }
                      disabled={["ending", "blocked"].includes(state.scenario)}
                      onClick={() =>
                        update(
                          { receivingPaused: !state.receivingPaused },
                          state.receivingPaused
                            ? "Receiving resumed."
                            : "Receiving paused. Your outgoing backup is unchanged.",
                        )
                      }
                    >
                      {state.receivingPaused
                        ? "Resume receiving"
                        : "Pause receiving"}
                    </Button>
                    <Button onClick={() => setView("controls")}>
                      Manage hosting
                    </Button>
                    <Button
                      disabled={
                        ["ending", "blocked", "capacity"].includes(
                          state.scenario,
                        ) ||
                        state.receivingActive ||
                        state.receivingPaused
                      }
                      onClick={() =>
                        update(
                          { receivingActive: true },
                          "Sample incoming transfer started. Only encrypted data is visible here.",
                        )
                      }
                    >
                      Preview incoming transfer
                    </Button>
                  </div>
                </>
              ) : (
                <div className="bk-empty">
                  <Icon name="mdiPackageVariantClosed" size={44} />
                  <h3>Share space, keep privacy.</h3>
                  <p>
                    You choose how much disk to reserve and when to receive. The
                    two storage quotas can be different.
                  </p>
                  <Button onClick={() => setDialog("pair")}>
                    Accept a buddy invitation
                  </Button>
                </div>
              )}
            </Card>
          </div>
          <Card
            title="Cloud Backup"
            icon="mdiCloudUploadOutline"
            status={cloud.backup.configured ? "Configured" : "Not set up"}
            className="bk-cloud-strip"
          >
            <div>
              <p>
                A managed destination, without another server to maintain. Cloud
                and Buddy work independently.
              </p>
              <small>
                Storage billed through your Cloud plan · provider-side SSE-C
                encryption
              </small>
            </div>
            <Button icon="mdiChevronRight" onClick={() => setView("cloud")}>
              {cloud.backup.configured
                ? "Manage Cloud Backup"
                : "Set up Cloud Backup"}
            </Button>
          </Card>
          <div className="bk-review-state">
            <label>
              Preview Buddy state
              <select
                value={state.scenario}
                onChange={(event) => {
                  save(previewBuddyScenario(state, event.target.value));
                  setNotice("");
                }}
              >
                {Object.entries(BUDDY_SCENARIOS).map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <p>
              Local design simulation. No accounts, media or servers are
              connected.
            </p>
            <Button onClick={() => setDialog("pair")}>
              Review pairing flow
            </Button>
          </div>
        </>
      )}
      {view === "cloud" && (
        <>
          <p className="bk-local-note">
            Cloud Backup is an independent destination. These existing setup and
            restore controls use sample data.
          </p>
          <FrameleafCloud section="cloud-backup" onNavigate={onNavigate} />
        </>
      )}
      {view === "controls" && (
        <BuddyControls state={state} update={update} setDialog={setDialog} />
      )}
      {view === "restore" && (
        <BuddyRecovery state={state} update={update} setDialog={setDialog} />
      )}
      {view === "compare" && (
        <BackupComparison
          onCloud={() => setView("cloud")}
          onBuddy={() => setDialog("pair")}
        />
      )}
      {dialog === "pair" && (
        <PairBuddy
          close={() => setDialog(null)}
          state={state}
          complete={(patch) => {
            update(
              patch,
              "Sample pairing complete. The initial encrypted backup is ready to review.",
            );
            setView("status");
            setDialog(null);
          }}
        />
      )}
      {dialog === "end" && (
        <EndPartnership
          state={state}
          close={() => setDialog(null)}
          complete={(scenario) => {
            update(
              { scenario },
              scenario === "ending"
                ? "Sample partnership ended. Restore access remains until 1 Nov 2026."
                : "Sample security block applied. Read and write access stopped immediately.",
            );
            setDialog(null);
            setView("status");
          }}
        />
      )}
      {dialog === "unlock" && (
        <UnlockBackup
          escrow={state.escrow}
          close={() => setDialog(null)}
          complete={() => {
            update(
              { scenario: "current" },
              "Sample recovery key verified on this server. No real key was loaded.",
            );
            setDialog(null);
          }}
        />
      )}
      {dialog === "connection" && (
        <Dialog
          title="Check the buddy connection"
          close={() => setDialog(null)}
          actions={
            <Button
              primary
              onClick={() => {
                update(
                  { scenario: "current" },
                  "Sample server links and subscriptions renewed.",
                );
                setDialog(null);
              }}
            >
              Simulate reconnect
            </Button>
          }
        >
          <div className="bk-dialog-body">
            <p>
              Both servers must stay linked to Frameleaf Cloud with active
              subscriptions and compatible Buddy Backup versions.
            </p>
            <Facts
              rows={[
                ["Your server", "Cloud link needs renewal"],
                ["Buddy’s server", "Subscription needs renewal"],
                [
                  "Existing backups",
                  "Retained while the connection is repaired",
                ],
              ]}
            />
            <p className="bk-local-note">
              This button repairs the sample state only.
            </p>
          </div>
        </Dialog>
      )}
    </div>
  );
}

function BuddyControls({ state, update, setDialog }) {
  const [controls, setControls] = useState(state.controls);
  const [agreement, setAgreement] = useState({
    outgoingQuotaGB: state.outgoingQuotaGB,
    incomingQuotaGB: state.incomingQuotaGB,
  });
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState("");
  const change = (id, value) => setControls({ ...controls, [id]: value });
  function apply() {
    const problem = validateBuddyControls(controls);
    setError(problem);
    if (!problem)
      update(
        { controls },
        "Buddy limits, schedule and retention saved for this design preview.",
      );
  }
  function applyAgreement() {
    const problem =
      validateBuddyAgreement(agreement) ||
      (!agreed ? "Confirm both sides accepted the sample agreement." : "");
    setError(problem);
    if (!problem)
      update(
        {
          outgoingQuotaGB: Number(agreement.outgoingQuotaGB),
          incomingQuotaGB: Number(agreement.incomingQuotaGB),
          scenario: state.scenario === "quota" ? "current" : state.scenario,
        },
        "Sample agreement accepted. Each direction keeps its own quota.",
      );
  }
  return (
    <div className="bk-control-layout">
      {error && (
        <p role="alert" className="bk-alert">
          {error}
        </p>
      )}
      <Card title="Transfer limits & schedule" icon="mdiTuneVariant">
        <p className="bk-card-description">
          Make room for everyday use. Sending and receiving have separate caps.
        </p>
        <div className="bk-form-grid">
          <label>
            Send limit <span>Mbit/s</span>
            <input
              type="number"
              min={1}
              max={1000}
              value={controls.sendMbps}
              onChange={(e) => change("sendMbps", e.target.value)}
            />
          </label>
          <label>
            Receive limit <span>Mbit/s</span>
            <input
              type="number"
              min={1}
              max={1000}
              value={controls.receiveMbps}
              onChange={(e) => change("receiveMbps", e.target.value)}
            />
          </label>
          <label>
            Concurrent transfers
            <select
              value={controls.concurrent}
              onChange={(e) => change("concurrent", Number(e.target.value))}
            >
              <option value={1}>1 transfer</option>
              <option value={2}>2 transfers</option>
            </select>
          </label>
          <label>
            Connection
            <select
              value={state.connection}
              onChange={(e) =>
                update(
                  { connection: e.target.value },
                  "Sample connection route changed.",
                )
              }
            >
              <option value="direct">Direct, with relay fallback</option>
              <option value="relay">Relay preview</option>
            </select>
          </label>
          <label>
            Window begins
            <input
              type="time"
              value={controls.start}
              onChange={(e) => change("start", e.target.value)}
            />
          </label>
          <label>
            Window ends
            <input
              type="time"
              value={controls.end}
              onChange={(e) => change("end", e.target.value)}
            />
          </label>
        </div>
        <p className="bk-local-note">
          Daily, in America/Edmonton. Incomplete transfers resume in the next
          window. Relay traffic uses the allowance in each server’s
          subscription; direct traffic does not use relay allowance.
        </p>
        <div className="bk-divider" />
        <h3>Recovery point retention</h3>
        <div className="bk-form-grid">
          <label>
            Daily recovery points
            <input
              type="number"
              min={1}
              max={365}
              value={controls.daily}
              onChange={(e) => change("daily", e.target.value)}
            />
          </label>
          <label>
            Monthly recovery points
            <input
              type="number"
              min={1}
              max={365}
              value={controls.monthly}
              onChange={(e) => change("monthly", e.target.value)}
            />
          </label>
        </div>
        <p className="bk-local-note">
          Default: 30 daily and 12 monthly points. Expired data is reclaimed
          after a successful backup; the latest known-good point stays
          protected.
        </p>
        <div className="bk-actions">
          <Button primary onClick={apply}>
            Save Buddy controls
          </Button>
          <Button
            disabled={
              !["current", "initial", "incremental", "stale"].includes(
                state.scenario,
              )
            }
            onClick={() =>
              update(
                { scenario: "incremental", sendingPaused: false },
                "Incomplete sample transfer restarted from its last verified block.",
              )
            }
          >
            Restart incomplete transfer
          </Button>
        </div>
      </Card>
      <Card title="Our storage agreement" icon="mdiHandshakeOutline">
        <p className="bk-card-description">
          Agree independently on space in each direction. Disk space is supplied
          by each server owner.
        </p>
        <div className="bk-form-grid">
          <label>
            Space for my backup <span>GB at my buddy</span>
            <input
              type="number"
              min={684.2}
              max={1500}
              value={agreement.outgoingQuotaGB}
              onChange={(e) => {
                setAgreement({ ...agreement, outgoingQuotaGB: e.target.value });
                setAgreed(false);
              }}
            />
          </label>
          <label>
            Space I host for my buddy <span>GB here</span>
            <input
              type="number"
              min={412.8}
              max={950}
              value={agreement.incomingQuotaGB}
              onChange={(e) => {
                setAgreement({ ...agreement, incomingQuotaGB: e.target.value });
                setAgreed(false);
              }}
            />
          </label>
        </div>
        <Facts
          rows={[
            ["My library to protect", "684.2 GB"],
            ["Buddy’s available offer", "Up to 1,500 GB"],
            ["My disk free", "1,200 GB"],
            ["My safety reserve", "250 GB"],
            ["Maximum I can offer", "950 GB"],
          ]}
        />
        <label className="bk-check">
          <input
            type="checkbox"
            checked={agreed}
            onChange={(e) => setAgreed(e.target.checked)}
          />
          Both sides accepted these sample quotas
        </label>
        <Button primary onClick={applyAgreement}>
          Apply sample agreement
        </Button>
      </Card>
      <Card title="Keys & partnership" icon="mdiKeyOutline">
        <Facts
          rows={[
            [
              "My recovery kit",
              state.paired
                ? "Saved and verified in this sample"
                : "Not created yet",
            ],
            [
              "Optional key escrow",
              state.escrow
                ? "Passphrase-wrapped copy enabled"
                : "Off · keep your kit offline",
            ],
            ["Buddy access to my media", "None · encrypted backup only"],
          ]}
        />
        <div className="bk-actions">
          <Button onClick={() => setDialog("unlock")}>
            Recovery kit & escrow
          </Button>
          <Button onClick={() => setDialog("pair")}>Review pairing</Button>
          <Button onClick={() => setDialog("end")}>End partnership…</Button>
        </div>
      </Card>
    </div>
  );
}

function PairBuddy({ close, complete, state }) {
  const [step, setStep] = useState(0);
  const [method, setMethod] = useState("invite");
  const [linked, setLinked] = useState(true);
  const [subscribed, setSubscribed] = useState(true);
  const [compatible, setCompatible] = useState(true);
  const [code, setCode] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [agreement, setAgreement] = useState({
    outgoingQuotaGB: 1000,
    incomingQuotaGB: 750,
  });
  const [agreed, setAgreed] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const [verification, setVerification] = useState("");
  const [verified, setVerified] = useState(false);
  const [escrow, setEscrow] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [confirmPassphrase, setConfirmPassphrase] = useState("");
  const [tested, setTested] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState("");
  const steps = ["Connect", "Agree on space", "Recovery kit", "Test & start"];
  useEffect(() => {
    if (!testing) return;
    const timer = setTimeout(() => {
      setTesting(false);
      setTested(true);
    }, 800);
    return () => clearTimeout(timer);
  }, [testing]);
  function download() {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(SAMPLE_RECOVERY_KIT, null, 2)], {
        type: "application/json",
      }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "frameleaf-buddy-SAMPLE-recovery-kit.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setDownloaded(true);
  }
  function next() {
    let problem = "";
    if (step === 0)
      problem =
        !linked || !subscribed || !compatible
          ? "Both servers need a Cloud link, active subscriptions and compatible versions."
          : !accepted
            ? "Accept the sample invitation before continuing."
            : "";
    if (step === 1)
      problem =
        validateBuddyAgreement(agreement) ||
        (!agreed ? "Both people must accept the independent quotas." : "");
    if (step === 2)
      problem = !verified
        ? "Download and verify your recovery kit first."
        : escrow && (passphrase.length < 12 || passphrase !== confirmPassphrase)
          ? "Use a passphrase of at least 12 characters and enter it again exactly."
          : "";
    if (step === 3)
      problem = !tested ? "Run the encrypted round-trip simulation first." : "";
    setError(problem);
    if (problem) return;
    if (step < 3) setStep(step + 1);
    else
      complete({
        paired: true,
        scenario: "initial",
        hasRecoveryPoint: false,
        lastVerified: null,
        sendingPaused: false,
        receivingPaused: false,
        escrow,
        outgoingQuotaGB: Number(agreement.outgoingQuotaGB),
        incomingQuotaGB: Number(agreement.incomingQuotaGB),
      });
  }
  return (
    <Dialog
      title="Set up Buddy Backup"
      close={close}
      wide
      actions={
        <>
          <Button
            onClick={
              step
                ? () => {
                    setStep(step - 1);
                    setError("");
                  }
                : close
            }
          >
            {step ? "Back" : "Cancel"}
          </Button>
          <Button primary onClick={next}>
            {step === 3 ? "Start initial backup" : "Continue"}
          </Button>
        </>
      }
    >
      <div className="bk-dialog-body">
        <ol className="bk-steps" aria-label="Buddy setup steps">
          {steps.map((label, index) => (
            <li key={label} aria-current={step === index ? "step" : undefined}>
              <span>
                {index < step ? <Icon name="mdiCheck" size={14} /> : index + 1}
              </span>
              {label}
            </li>
          ))}
        </ol>
        <p className="bk-local-note">
          Local sample flow. No invitation is sent and no real account is
          linked.
        </p>
        {error && (
          <p className="bk-alert" role="alert">
            {error}
          </p>
        )}
        {step === 0 && (
          <>
            <h3>Two servers. One agreement.</h3>
            <p>
              Invite someone you trust, or accept their invitation. Both of you
              keep your own keys.
            </p>
            <div className="bk-choice-row">
              <button
                aria-pressed={method === "invite"}
                onClick={() => {
                  setMethod("invite");
                  setAccepted(false);
                }}
              >
                Invite a buddy
              </button>
              <button
                aria-pressed={method === "accept"}
                onClick={() => {
                  setMethod("accept");
                  setAccepted(false);
                }}
              >
                Accept invitation
              </button>
            </div>
            <div className="bk-preflight">
              <label className="bk-check">
                <input
                  type="checkbox"
                  checked={linked}
                  onChange={(e) => setLinked(e.target.checked)}
                />
                Both servers linked to Frameleaf Cloud
              </label>
              <label className="bk-check">
                <input
                  type="checkbox"
                  checked={subscribed}
                  onChange={(e) => setSubscribed(e.target.checked)}
                />
                Both Cloud subscriptions active
              </label>
              <label className="bk-check">
                <input
                  type="checkbox"
                  checked={compatible}
                  onChange={(e) => setCompatible(e.target.checked)}
                />
                Compatible Buddy Backup versions
              </label>
            </div>
            {method === "invite" ? (
              <div className="bk-invite">
                <small>Sample invitation code · expires in 24 hours</small>
                <strong>FRAMELEAF-DEMO-4826</strong>
                <p>
                  Share through a channel you trust. Your buddy reviews the
                  request before either server reserves space.
                </p>
                <Button
                  disabled={!linked || !subscribed || !compatible}
                  onClick={() => setAccepted(true)}
                >
                  {accepted
                    ? "Jamie accepted the sample invitation"
                    : "Simulate buddy accepting"}
                </Button>
              </div>
            ) : (
              <>
                <label className="bk-field">
                  Invitation code
                  <input
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    placeholder="FRAMELEAF-DEMO-4826"
                  />
                </label>
                <Button
                  disabled={!linked || !subscribed || !compatible}
                  onClick={() => {
                    if (code.trim() === "FRAMELEAF-DEMO-4826") {
                      setAccepted(true);
                      setError("");
                    } else setError("Use the sample code FRAMELEAF-DEMO-4826.");
                  }}
                >
                  Accept sample invitation
                </Button>
                {accepted && (
                  <p className="bk-success">
                    Invitation accepted from Jamie’s home server.
                  </p>
                )}
              </>
            )}
          </>
        )}
        {step === 1 && (
          <>
            <h3>Choose how much space to share.</h3>
            <p>
              The quotas do not need to match. Each offer must cover its backup
              and fit the host’s available disk.
            </p>
            <div className="bk-form-grid">
              <label>
                My quota at Jamie’s server <span>GB</span>
                <input
                  type="number"
                  value={agreement.outgoingQuotaGB}
                  onChange={(e) => {
                    setAgreement({
                      ...agreement,
                      outgoingQuotaGB: e.target.value,
                    });
                    setAgreed(false);
                  }}
                />
                <small>684.2 GB library · 1,500 GB available there</small>
              </label>
              <label>
                Jamie’s quota on my server <span>GB</span>
                <input
                  type="number"
                  value={agreement.incomingQuotaGB}
                  onChange={(e) => {
                    setAgreement({
                      ...agreement,
                      incomingQuotaGB: e.target.value,
                    });
                    setAgreed(false);
                  }}
                />
                <small>412.8 GB encrypted · up to 950 GB available here</small>
              </label>
            </div>
            <Facts
              rows={[
                ["Your free disk", "1,200 GB"],
                ["Kept free for your library", "250 GB"],
                [
                  "Frameleaf Buddy storage charge",
                  "None · you both supply the disks",
                ],
              ]}
            />
            <label className="bk-check">
              <input
                type="checkbox"
                checked={agreed}
                onChange={(e) => setAgreed(e.target.checked)}
              />
              Both sides accept these sample quotas
            </label>
          </>
        )}
        {step === 2 && (
          <>
            <h3>Your key. Your way back.</h3>
            <p>
              Your server encrypts Buddy data with AES-256-GCM before sending
              it. Your buddy cannot recover it for you.
            </p>
            <div className="bk-recovery-kit">
              <Icon name="mdiFileKeyOutline" size={36} />
              <div>
                <strong>Save your recovery kit somewhere safe.</strong>
                <p>
                  Keep it outside this server. Losing every copy of the key
                  makes your Buddy backup unrecoverable.
                </p>
              </div>
              <Button icon="mdiDownload" onClick={download}>
                Download sample kit
              </Button>
            </div>
            <label className="bk-field">
              Verification code from the downloaded kit
              <input
                value={verification}
                onChange={(e) => {
                  setVerification(e.target.value);
                  setVerified(false);
                }}
                placeholder="Open the sample kit to find the code"
              />
            </label>
            <Button
              disabled={!downloaded}
              onClick={() => {
                const ok =
                  verification.trim() === SAMPLE_RECOVERY_KIT.verificationCode;
                setVerified(ok);
                setError(
                  ok
                    ? ""
                    : "That code does not match the downloaded sample kit.",
                );
              }}
            >
              {verified ? "Recovery kit verified" : "Verify saved kit"}
            </Button>
            <div className="bk-divider" />
            <label className="bk-check">
              <input
                type="checkbox"
                checked={escrow}
                onChange={(e) => setEscrow(e.target.checked)}
              />
              Keep an optional passphrase-wrapped key copy with Frameleaf Cloud
            </label>
            <p className="bk-local-note">
              Cloud holds the wrapped copy; your passphrase unlocks it. It is
              not a replacement for your offline recovery kit. The prototype
              does not store a passphrase.
            </p>
            {escrow && (
              <div className="bk-form-grid">
                <label>
                  Sample passphrase
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={passphrase}
                    onChange={(e) => setPassphrase(e.target.value)}
                  />
                </label>
                <label>
                  Repeat passphrase
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={confirmPassphrase}
                    onChange={(e) => setConfirmPassphrase(e.target.value)}
                  />
                </label>
              </div>
            )}
          </>
        )}
        {step === 3 && (
          <>
            <h3>Test the way there. And back.</h3>
            <p>
              Before the first backup, send an encrypted test block, fetch it
              back, decrypt it on your server and compare its fingerprint.
            </p>
            <ol className="bk-roundtrip">
              <li>
                <Icon name="mdiLockOutline" />
                Encrypt on your server
              </li>
              <li>
                <Icon name="mdiArrowLeftRight" />
                Store and retrieve from Jamie’s server
              </li>
              <li>
                <Icon name="mdiShieldCheckOutline" />
                Decrypt here and verify
              </li>
            </ol>
            <Button
              primary
              disabled={testing || tested}
              onClick={() => setTesting(true)}
            >
              {testing
                ? "Running sample round trip…"
                : tested
                  ? "Sample round trip passed"
                  : "Run encrypted test"}
            </Button>
            <p role="status" className="bk-success">
              {tested
                ? "Simulation passed · direct connection · matching fingerprint. No real encryption or transfer was performed."
                : ""}
            </p>
            <Facts
              rows={[
                [
                  "Initial backup",
                  "684.2 GB · originals, edits and library data",
                ],
                ["Send / receive caps", "20 / 20 Mbit/s"],
                ["Concurrency", "2 transfers"],
                ["Daily window", "02:00–06:00 · America/Edmonton"],
                ["Retention", "30 daily + 12 monthly recovery points"],
              ]}
            />
          </>
        )}
      </div>
    </Dialog>
  );
}

function BuddyRecovery({ state, update, setDialog }) {
  const [scope, setScope] = useState("Items");
  const [point, setPoint] = useState(() => buddyStatus(state).recoveryPoint);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("All items");
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState("");
  const [replacement, setReplacement] = useState(false);
  const [replacementLinked, setReplacementLinked] = useState(false);
  const [replacementKey, setReplacementKey] = useState("");
  const [attached, setAttached] = useState(false);
  const status = buddyStatus(state);
  const items = OWN_BACKUP_ITEMS.filter(
    (item) =>
      item.name.toLowerCase().includes(query.toLowerCase()) &&
      (filter === "All items" || item.state === filter),
  );
  return (
    <div className="bk-recovery">
      <Card
        title="Recover my backup"
        icon="mdiBackupRestore"
        status="Your library only"
      >
        <p className="bk-card-description">
          Browse recovery points from your library on {state.buddy}. Hosting
          someone else’s encrypted data never gives you access to their library.
        </p>
        {!status.canRestore && (
          <div className="bk-alert">
            <Icon name="mdiAlertCircleOutline" />
            <p>
              {!state.hasRecoveryPoint
                ? "Complete the first backup before restoring."
                : state.scenario === "key"
                  ? "Unlock your recovery key to open your backup."
                  : "Your backup is currently unavailable. Resolve the connection or access alert before restoring."}
            </p>
            {state.scenario === "key" && (
              <Button onClick={() => setDialog("unlock")}>Unlock key</Button>
            )}
          </div>
        )}
        <div hidden={!status.canRestore}>
          <div className="bk-recovery-toolbar">
            <label>
              My recovery point
              <select value={point} onChange={(e) => setPoint(e.target.value)}>
                <option>{status.recoveryPoint}</option>
                <option>
                  {state.scenario === "stale"
                    ? "28 Sep 2026, 02:09"
                    : "1 Oct 2026, 02:09"}
                </option>
                <option>1 Sep 2026, 02:18 · monthly</option>
              </select>
            </label>
            <span>
              <Icon name="mdiLockOutline" size={16} />
              Decrypted only on your server
            </span>
          </div>
          <div className="bk-choice-row" aria-label="Restore scope">
            {["Items", "Albums", "Library", "Settings", "Server"].map(
              (name) => (
                <button
                  key={name}
                  aria-pressed={scope === name}
                  onClick={() => setScope(name)}
                >
                  {name}
                </button>
              ),
            )}
          </div>
          {scope === "Items" && (
            <>
              <div className="bk-recovery-toolbar">
                <label>
                  Search my backup
                  <input
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Filename"
                  />
                </label>
                <label>
                  Show
                  <select
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                  >
                    {["All items", "Deleted", "Damaged", "In library"].map(
                      (value) => (
                        <option key={value}>{value}</option>
                      ),
                    )}
                  </select>
                </label>
              </div>
              <div className="bk-restore-list">
                {items.length ? (
                  items.map((item) => (
                    <div key={item.id}>
                      <Icon name="mdiFileImageOutline" />
                      <span>
                        <strong>{item.name}</strong>
                        <small>
                          {item.detail} · {item.album}
                        </small>
                      </span>
                      <em>{item.state}</em>
                      <Button
                        disabled={!status.canRestore}
                        onClick={() =>
                          setPreview({ scope: "Item", name: item.name })
                        }
                      >
                        Preview restore
                      </Button>
                    </div>
                  ))
                ) : (
                  <div className="bk-empty">
                    <p>No items match this search in your sample backup.</p>
                    <Button
                      onClick={() => {
                        setQuery("");
                        setFilter("All items");
                      }}
                    >
                      Clear filters
                    </Button>
                  </div>
                )}
              </div>
            </>
          )}
          {scope === "Albums" && (
            <div className="bk-restore-list">
              {[
                ["Lake house weekend", "84 items · deleted album"],
                ["Mountain mornings", "212 items · 3 missing originals"],
              ].map(([name, detail]) => (
                <div key={name}>
                  <Icon name="mdiImageAlbum" />
                  <span>
                    <strong>{name}</strong>
                    <small>{detail}</small>
                  </span>
                  <Button
                    disabled={!status.canRestore}
                    onClick={() => setPreview({ scope: "Album", name })}
                  >
                    Preview restore
                  </Button>
                </div>
              ))}
            </div>
          )}
          {["Library", "Settings", "Server"].includes(scope) && (
            <div className="bk-restore-wide">
              <Icon
                name={
                  scope === "Server"
                    ? "mdiServerOutline"
                    : scope === "Settings"
                      ? "mdiTuneVariant"
                      : "mdiImageMultipleOutline"
                }
                size={38}
              />
              <div>
                <h3>
                  {scope === "Library"
                    ? "Recover my whole library"
                    : scope === "Settings"
                      ? "Recover settings"
                      : "Recover a replacement server"}
                </h3>
                <p>
                  {scope === "Library"
                    ? "Restore original files, saved edits, album membership and library metadata from the same recovery point. Rebuild previews after verification."
                    : scope === "Settings"
                      ? "Review the saved server configuration before applying it. Recovery credentials must be supplied again on this server."
                      : "Link your replacement server, unlock your recovery kit, then reconnect the existing backup before previewing the full restore."}
                </p>
              </div>
              {scope === "Server" ? (
                <Button onClick={() => setReplacement(true)}>
                  Begin replacement recovery
                </Button>
              ) : (
                <Button
                  disabled={!status.canRestore}
                  onClick={() =>
                    setPreview({
                      scope,
                      name:
                        scope === "Library"
                          ? "My whole library"
                          : "Server settings",
                    })
                  }
                >
                  Preview restore
                </Button>
              )}
            </div>
          )}
        </div>
      </Card>
      <Card title="Check that recovery works" icon="mdiShieldCheckOutline">
        <p>
          Latest backup and last restore verification are different checks.
          Verify a sample restore before relying on a new destination.
        </p>
        <Facts
          rows={[
            [
              "Latest recovery point",
              state.hasRecoveryPoint ? point : "None yet",
            ],
            ["Last restore verification", status.verification],
            [
              "Verification includes",
              "Fetch, decrypt, fingerprint and metadata checks",
            ],
          ]}
        />
        <Button
          disabled={!status.canRestore}
          onClick={() => {
            update(
              { lastVerified: "2 Oct, 13:42", scenario: "current" },
              "Sample restore verification passed. This is a local design simulation.",
            );
            setResult(
              "Sample restore verification passed at 13:42. No real media was processed.",
            );
          }}
        >
          Verify sample restore
        </Button>
      </Card>
      {result && (
        <p className="bk-notice" role="status">
          {result}
        </p>
      )}
      {preview && (
        <RestorePreview
          preview={preview}
          point={point}
          close={() => setPreview(null)}
          complete={(policy) => {
            setResult(
              `${preview.scope} restore simulation complete. Conflict policy: ${policy === "keep" ? "keep current" : "replace with backup"}. No real files were changed.`,
            );
            setPreview(null);
          }}
        />
      )}
      {replacement && (
        <Dialog
          title="Recover a replacement server"
          close={() => setReplacement(false)}
          wide
          actions={
            <>
              <Button onClick={() => setReplacement(false)}>Cancel</Button>
              <Button
                primary
                disabled={!attached || !status.canRestore}
                onClick={() => {
                  setReplacement(false);
                  setPreview({
                    scope: "Server",
                    name: "My replacement server",
                  });
                }}
              >
                Preview server restore
              </Button>
            </>
          }
        >
          <div className="bk-dialog-body">
            <p>
              Your backup belongs to you. Your buddy supplies the encrypted
              data; the replacement server does the recovery.
            </p>
            <label className="bk-check">
              <input
                type="checkbox"
                checked={replacementLinked}
                onChange={(e) => {
                  setReplacementLinked(e.target.checked);
                  setAttached(false);
                }}
              />
              Replacement server linked to my Cloud account with an active
              subscription
            </label>
            <label className="bk-field">
              Verification code from my sample recovery kit
              <input
                value={replacementKey}
                onChange={(e) => {
                  setReplacementKey(e.target.value);
                  setAttached(false);
                }}
                placeholder="LEAF-4826"
              />
            </label>
            <Button
              disabled={
                !replacementLinked ||
                replacementKey.trim() !==
                  SAMPLE_RECOVERY_KIT.verificationCode ||
                !status.canRestore
              }
              onClick={() => setAttached(true)}
            >
              Attach my existing sample backup
            </Button>
            {attached && (
              <p role="status" className="bk-success">
                Attached your backup at Jamie’s home server. 684.2 GB is
                available for recovery.
              </p>
            )}
            <ol className="bk-roundtrip">
              <li>Review the recovery point and destination paths</li>
              <li>Restore configuration, library database and originals</li>
              <li>Verify restored data, then rebuild previews</li>
            </ol>
            <p className="bk-local-note">
              This flow does not create a second backup or expose any hosted
              buddy library.
            </p>
          </div>
        </Dialog>
      )}
    </div>
  );
}

function RestorePreview({ preview, point, close, complete }) {
  const [policy, setPolicy] = useState("keep");
  const [reviewed, setReviewed] = useState(false);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!running) return;
    const timer = setTimeout(() => {
      setRunning(false);
      setDone(true);
    }, 1000);
    return () => clearTimeout(timer);
  }, [running]);
  return (
    <Dialog
      title={`Preview ${preview.scope.toLowerCase()} restore`}
      close={close}
      wide
      actions={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button
            primary
            disabled={!reviewed || running}
            onClick={() => (done ? complete(policy) : setRunning(true))}
          >
            {done ? "Done" : running ? "Restoring sample…" : "Simulate restore"}
          </Button>
        </>
      }
    >
      <div className="bk-dialog-body">
        <Facts
          rows={[
            ["Restore", preview.name],
            ["Source", "My backup at Jamie’s home server"],
            ["Recovery point", point],
            [
              "Destination",
              preview.scope === "Server"
                ? "My replacement server"
                : "My Frameleaf server",
            ],
            [
              "Includes",
              preview.scope === "Settings"
                ? "Server configuration"
                : preview.scope === "Server"
                  ? "Configuration, library database, originals and saved edits"
                  : "Originals, albums, metadata and saved edits",
            ],
            [
              "Preflight",
              "Enough free space · key verified · recovery point readable",
            ],
          ]}
        />
        <h3>When the current version differs</h3>
        <label className="bk-radio">
          <input
            type="radio"
            name="restore-policy"
            checked={policy === "keep"}
            disabled={running || done}
            onChange={() => {
              setPolicy("keep");
              setReviewed(false);
            }}
          />
          <span>
            <strong>Keep current</strong>
            <small>
              Restore missing data. Keep existing files, edits and metadata.
            </small>
          </span>
        </label>
        <label className="bk-radio">
          <input
            type="radio"
            name="restore-policy"
            checked={policy === "replace"}
            disabled={running || done}
            onChange={() => {
              setPolicy("replace");
              setReviewed(false);
            }}
          />
          <span>
            <strong>Replace with backup</strong>
            <small>
              Use this recovery point. Keep displaced current files in the
              recovery holding area for review.
            </small>
          </span>
        </label>
        <label className="bk-check">
          <input
            type="checkbox"
            disabled={running || done}
            checked={reviewed}
            onChange={(e) => setReviewed(e.target.checked)}
          />
          I reviewed the scope, destination and conflict policy
        </label>
        {(running || done) && (
          <div className="bk-progress" role="status">
            <progress
              aria-label="Sample restore progress"
              value={done ? 100 : 55}
              max={100}
            />
            <p>
              {done
                ? "Sample restore verified. No real files were changed."
                : "Fetching encrypted blocks → decrypting here → verifying…"}
            </p>
          </div>
        )}
        <p className="bk-local-note">
          Recovery preview is local sample data. This does not run a real
          restore.
        </p>
      </div>
    </Dialog>
  );
}

function UnlockBackup({ close, complete, escrow }) {
  const [value, setValue] = useState("");
  const [method, setMethod] = useState("kit");
  const [error, setError] = useState("");
  return (
    <Dialog
      title="Unlock my recovery key"
      close={close}
      actions={
        <Button
          primary
          onClick={() => {
            if (
              method === "kit"
                ? value.trim() === SAMPLE_RECOVERY_KIT.verificationCode
                : value.length >= 12
            )
              complete();
            else
              setError(
                method === "kit"
                  ? "Enter the sample kit code LEAF-4826."
                  : "Use a sample passphrase with at least 12 characters.",
              );
          }}
        >
          Unlock sample backup
        </Button>
      }
    >
      <div className="bk-dialog-body">
        <p>The key is used on your server. Your buddy never receives it.</p>
        <div className="bk-choice-row">
          <button
            aria-pressed={method === "kit"}
            onClick={() => {
              setMethod("kit");
              setValue("");
            }}
          >
            Recovery kit
          </button>
          <button
            disabled={!escrow}
            aria-pressed={method === "escrow"}
            onClick={() => {
              setMethod("escrow");
              setValue("");
            }}
          >
            Wrapped Cloud copy
          </button>
        </div>
        {!escrow && (
          <p className="bk-local-note">
            Cloud key escrow is off for this sample partnership. Enable it when
            saving your recovery kit in the pairing flow.
          </p>
        )}
        <label className="bk-field">
          {method === "kit"
            ? "Sample kit verification code"
            : "Your wrapping passphrase"}
          <input
            type={method === "kit" ? "text" : "password"}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={
              method === "kit" ? "LEAF-4826" : "Sample passphrase only"
            }
          />
        </label>
        {error && (
          <p className="bk-alert" role="alert">
            {error}
          </p>
        )}
        <p className="bk-local-note">
          This only exercises the design. No real key or passphrase is accepted
          or stored.
        </p>
      </div>
    </Dialog>
  );
}

function EndPartnership({ close, complete, state }) {
  const [mode, setMode] = useState("ending");
  const [acknowledged, setAcknowledged] = useState(false);
  return (
    <Dialog
      title="End this buddy partnership"
      close={close}
      actions={
        <>
          <Button onClick={close}>Keep partnership</Button>
          <Button disabled={!acknowledged} onClick={() => complete(mode)}>
            {mode === "blocked"
              ? "Block sample partnership"
              : "End sample partnership"}
          </Button>
        </>
      }
    >
      <div className="bk-dialog-body">
        <p>
          {state.buddy} supplies your off-site storage. Set up another
          destination before ending your agreement.
        </p>
        <label className="bk-radio">
          <input
            name="end-mode"
            type="radio"
            checked={mode === "ending"}
            onChange={() => {
              setMode("ending");
              setAcknowledged(false);
            }}
          />
          <span>
            <strong>End with a 30-day recovery window</strong>
            <small>
              Stop new transfers. Existing backups stay readable until 1 Nov
              2026 so both people can recover or move them.
            </small>
          </span>
        </label>
        <label className="bk-radio">
          <input
            name="end-mode"
            type="radio"
            checked={mode === "blocked"}
            onChange={() => {
              setMode("blocked");
              setAcknowledged(false);
            }}
          />
          <span>
            <strong>Block immediately for security</strong>
            <small>
              Stop reads and writes in both directions now. The normal recovery
              window is unavailable while blocked.
            </small>
          </span>
        </label>
        <label className="bk-check">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
          />
          I understand how this affects both backups
        </label>
        <p className="bk-local-note">
          This changes the local sample only and does not delete data.
        </p>
      </div>
    </Dialog>
  );
}

function BackupComparison({ onCloud, onBuddy }) {
  return (
    <div className="bk-comparison">
      <div className="bk-comparison-intro">
        <h2>Two ways to keep a copy away from home.</h2>
        <p>
          Choose who supplies the storage. Keep Cloud and Buddy together when
          you want independent destinations.
        </p>
      </div>
      <BackupDiagram />
      <div className="bk-destinations">
        <Card title="Cloud Backup" icon="mdiCloudOutline">
          <h3>Let Frameleaf manage the destination.</h3>
          <p>
            For a separate copy without arranging another server. You choose a
            storage plan; Frameleaf manages the destination.
          </p>
          <ul>
            <li>Managed destination with billed storage</li>
            <li>No buddy server or reciprocal disk required</li>
            <li>Cloud subscription and storage plan apply</li>
            <li>Provider-side SSE-C encryption with your backup key</li>
          </ul>
          <Button primary onClick={onCloud}>
            Explore Cloud Backup
          </Button>
        </Card>
        <Card title="Buddy Backup" icon="mdiServerSecurity">
          <h3>Give each other a place to recover.</h3>
          <p>
            Pair your self-hosted servers and agree on disk space. Each library
            is encrypted before it leaves its owner’s server.
          </p>
          <ul>
            <li>Reciprocal, independently agreed storage quotas</li>
            <li>No Frameleaf storage charge for your buddy’s disk</li>
            <li>Both servers need active Cloud subscriptions</li>
            <li>AES-256-GCM encryption before transmission</li>
          </ul>
          <Button primary onClick={onBuddy}>
            Set up Buddy Backup
          </Button>
        </Card>
      </div>
      <div className="bk-comparison-notes">
        <div>
          <Icon name="mdiKeyOutline" />
          <h3>Keep your recovery kit.</h3>
          <p>
            Buddy keys stay with the source owner. Optional Cloud escrow holds a
            passphrase-wrapped copy. Losing the key and passphrase can make a
            backup unrecoverable.
          </p>
        </div>
        <div>
          <Icon name="mdiSwapHorizontal" />
          <h3>Direct when possible.</h3>
          <p>
            Buddy transfers prefer a direct encrypted connection. Relay fallback
            is subject to subscription allowances. Disk, internet and
            electricity are supplied by each buddy.
          </p>
        </div>
        <div>
          <Icon name="mdiShieldCheckOutline" />
          <h3>A backup you have tested.</h3>
          <p>
            Recovery points and restore verification have separate timestamps.
            Check both, whether you choose Cloud, Buddy, or two independent
            destinations.
          </p>
        </div>
      </div>
      <p className="bk-local-note">
        The encryption models differ: Buddy encrypts on your server before
        transfer; Cloud’s existing SSE-C model encrypts at the storage provider.
        They are not the same end-to-end encryption model.
      </p>
    </div>
  );
}
