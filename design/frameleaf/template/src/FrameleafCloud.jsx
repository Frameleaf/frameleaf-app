import React, { useEffect, useRef, useState } from "react";
import { Button, Dialog } from "./Controls";
import { Icon } from "./Icon";
import { QrCode, copyText } from "./QrCode";
import { normalizeProductKey, validateProductKey } from "./system-data.mjs";
import {
  CLOUD_STORAGE_KEY,
  BUCKET_MARKER,
  LINK_VERIFICATION_URL,
  acceptCloudConsent,
  activateProductKey,
  activeEntitlements,
  approveDeviceLink,
  backupKeyFile,
  backupKeyModes,
  backupManifests,
  backupPausedReason,
  cancelDeviceLink,
  checkBucketClaim,
  cloudAdmission,
  cloudJobs,
  cloudModels,
  cloudPlans,
  startBackupRun,
  backupRunActive,
  configureBackup,
  consentTerms,
  createBackupKey,
  deviceCodeSecondsLeft,
  entitlementLabels,
  estimateCloudJob,
  formatBytes,
  formatUsd,
  installLicenceFile,
  isLicensed,
  LICENSED_DISCOUNT,
  cloudPrice,
  checkCustomHostname,
  customHostnameRecords,
  removeCustomHostname,
  removePlan,
  removeProductKey,
  validateCustomHostname,
  licenseStatus,
  linkUserAccount,
  loadCloudState,
  modelById,
  recoveryKitText,
  relayRegions,
  remoteAvailability,
  removeLicense,
  sampleLicenceFile,
  saveCloudState,
  serverTelemetry,
  startDeviceLink,
  subscribe,
  testRemoteConnection,
  topUpWallet,
  turnOffBackup,
  unlinkConsequences,
  unlinkServer,
  unlinkUserAccount,
  validateBucketSettings,
  walletAvailable,
  walletPacks,
  DEFAULT_WALLET_PACK,
  WALLET_FEES_NOTE,
  WALLET_MIN_TOP_UP_USD,
  WALLET_MAX_TOP_UP_USD,
} from "./frameleaf-cloud-data.mjs";
import { DefaultModelSlider, WorkloadRoutingTable } from "./WorkloadRouting";
import { billingSentence, perUnitText, renderModels } from "./cloud-jobs.mjs";
import { formatDuration, formatRate, gpuClasses, startFees } from "./gpu-model-catalog.mjs";
import "./frameleaf-cloud.css";

// Frameleaf Cloud settings (Settings → Frameleaf Cloud, plus the sign-in card in
// Access & security). Everything is simulated: no request leaves the browser.

const when = (value, style = "medium") =>
  value
    ? new Intl.DateTimeFormat("en", {
        dateStyle: style,
        ...(style === "medium" && String(value).length > 10
          ? { timeStyle: "short" }
          : {}),
      }).format(new Date(value))
    : "—";
const day = (value) => (value ? when(`${String(value).slice(0, 10)}T12:00:00Z`, "long") : "—");
const plural = (count, noun) =>
  `${count.toLocaleString("en")} ${noun}${count === 1 ? "" : "s"}`;
const planById = (id) => cloudPlans.find((plan) => plan.id === id) ?? null;
const STORE_URL = "https://account.frameleaf.cloud";
const WORKLOADS = [
  ["descriptions", "Descriptions & tags"],
  ["upscale", "Enhance & upscale"],
  ["restoration", "Video restoration"],
  ["studio", "Studio captions"],
  ["interpolation", "Smooth motion"],
  ["render", "Studio export"],
];
const ESTIMATE_MODELS = [...cloudModels, ...renderModels];
const startFeeRange = () => {
  const fees = Object.values(startFees).map((fee) => fee.customerUsd);
  return `$${Math.min(...fees).toFixed(2)}–$${Math.max(...fees).toFixed(2)}`;
};

function download(name, text, type = "application/json") {
  try {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  } catch {
    return false;
  }
}

function printText(title, text) {
  try {
    const frame = document.createElement("iframe");
    frame.style.position = "fixed";
    frame.style.width = "0";
    frame.style.height = "0";
    frame.style.border = "0";
    document.body.append(frame);
    const doc = frame.contentDocument;
    doc.open();
    doc.write(
      `<title>${title}</title><pre style="font:13px/1.6 ui-monospace,monospace;white-space:pre-wrap"></pre>`,
    );
    doc.close();
    doc.querySelector("pre").textContent = text;
    frame.contentWindow.print();
    setTimeout(() => frame.remove(), 1000);
    return true;
  } catch {
    return false;
  }
}

/** Shared cloud state for every Frameleaf Cloud surface in this tab and others. */
export function useCloudState() {
  const [state, setState] = useState(() => loadCloudState());
  const ref = useRef(state);
  ref.current = state;
  useEffect(() => {
    const sync = () => setState(loadCloudState());
    const storage = (event) => {
      if (event.key === CLOUD_STORAGE_KEY || event.key === null) sync();
    };
    addEventListener("frameleaf-cloud-change", sync);
    addEventListener("storage", storage);
    return () => {
      removeEventListener("frameleaf-cloud-change", sync);
      removeEventListener("storage", storage);
    };
  }, []);
  function commit(update) {
    const next = update(ref.current);
    ref.current = next;
    setState(next);
    return saveCloudState(next);
  }
  return [state, commit];
}

function useActions(commit) {
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  function run(update, message) {
    try {
      const saved = commit(update);
      setError(
        saved
          ? ""
          : "Device storage is unavailable. This change lasts until you reload the page.",
      );
      if (message) setNotice(message);
      return true;
    } catch (failure) {
      setError(failure.message || "That did not work. Try again.");
      return false;
    }
  }
  const messages = (
    <>
      {error && (
        <p className="cc-notice error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <div className="cc-notice" role="status">
          <span>{notice}</span>
          <button aria-label="Dismiss notice" onClick={() => setNotice("")}>
            <Icon name="mdiClose" />
          </button>
        </div>
      )}
    </>
  );
  return { run, setNotice, setError, messages };
}

/**
 * section: cloud-account | cloud-plan | cloud-license | cloud-remote | cloud-processing |
 * cloud-backup | frameleaf-signin. onNavigate(area, section) opens another page;
 * onBuy() opens the Support Frameleaf screen when the host provides it.
 */
export function FrameleafCloud({
  section = "cloud-account",
  onNavigate,
  onBuy,
  draft = {},
  onSettingChange,
  fields = [],
  errors = [],
}) {
  const [state, commit] = useCloudState();
  const actions = useActions(commit);
  const context = { state, onNavigate, onBuy, draft, onSettingChange, fields, errors, ...actions };
  return (
    <div className="frameleaf-cloud" data-section={section}>
      {actions.messages}
      {section === "cloud-account" && <AccountLink {...context} />}
      {section === "cloud-plan" && <Plan {...context} />}
      {section === "cloud-license" && <License {...context} />}
      {section === "cloud-remote" && <RemoteAccess {...context} />}
      {section === "cloud-processing" && <Processing {...context} />}
      {section === "cloud-backup" && <Backup {...context} />}
      {section === "frameleaf-signin" && <FrameleafSignIn {...context} />}
      {section === "workload-routing" && <WorkloadRoutingTable {...context} />}
    </div>
  );
}

// ------------------------------------------------------------------ building blocks

function Card({ title, description, status, tone = "muted", icon, children, id }) {
  return (
    <section className="fc-card" aria-labelledby={id}>
      <div className="fc-card-title">
        {icon && (
          <span className="fc-card-icon">
            <Icon name={icon} />
          </span>
        )}
        <div>
          <h2 id={id}>{title}</h2>
          {description && <p>{description}</p>}
        </div>
        {status && <span className={`fc-status is-${tone}`}>{status}</span>}
      </div>
      {children}
    </section>
  );
}

function Facts({ rows }) {
  return (
    <dl className="fc-facts">
      {rows
        .filter(Boolean)
        .map(([label, value]) => (
          <React.Fragment key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </React.Fragment>
        ))}
    </dl>
  );
}

function Toggle({ id, label, help, value, onChange, disabled, reason, policy }) {
  const control = `fc-toggle-${id}`;
  return (
    <div className="cc-field fc-field">
      <div>
        <label htmlFor={control}>{label}</label>
        <p id={`${control}-help`}>
          {help}
          {disabled && reason && <span className="cc-dependency">{reason}</span>}
        </p>
        {policy && <small className="cc-locked">{policy}</small>}
      </div>
      <div className="cc-field-control">
        <button
          id={control}
          type="button"
          role="switch"
          aria-checked={value}
          aria-describedby={`${control}-help`}
          disabled={disabled || !!policy}
          className={`cc-switch ${value ? "on" : ""}`}
          onClick={() => onChange(!value)}
        >
          <span />
          {value ? "On" : "Off"}
        </button>
      </div>
    </div>
  );
}

function Field({ id, label, help, children }) {
  return (
    <div className="cc-field fc-field">
      <div>
        <label htmlFor={id}>{label}</label>
        {help && <p>{help}</p>}
      </div>
      <div className="cc-field-control">{children}</div>
    </div>
  );
}

function Meter({ value, max, label, detail, warn = 0.8 }) {
  const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  return (
    <div className="fc-meter">
      <div className="fc-meter-label">
        <span>{label}</span>
        <strong>{detail}</strong>
      </div>
      <div
        className={`fc-meter-track ${ratio >= warn ? "is-high" : ""}`}
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={detail}
      >
        <span style={{ width: `${(ratio * 100).toFixed(1)}%` }} />
      </div>
    </div>
  );
}

function Banner({ tone = "info", icon, title, children, action }) {
  return (
    <div className={`fc-banner is-${tone}`} role={tone === "danger" ? "alert" : "status"}>
      <Icon name={icon || (tone === "info" ? "mdiInformationOutline" : "mdiAlertOutline")} />
      <div>
        {title && <strong>{title}</strong>}
        <p>{children}</p>
      </div>
      {action}
    </div>
  );
}

/** Explains why a cloud feature is unavailable and offers the next step. */
function Gate({ state, onNavigate, onBuy, feature }) {
  if (state.link.status !== "linked")
    return (
      <Banner
        icon="mdiLinkVariant"
        title="Link this server first"
        action={
          <Button onClick={() => onNavigate?.("cloud", "cloud-account")}>
            Link to Frameleaf
          </Button>
        }
      >
        {feature} uses a Frameleaf account. Everything else on this server
        works without one.
      </Banner>
    );
  return (
    <Banner
      icon="mdiCertificateOutline"
      title={`${feature} is part of a Frameleaf Cloud plan`}
      action={
        onNavigate ? (
          <Button onClick={() => onNavigate("cloud", "cloud-plan")}>See plans</Button>
        ) : (
          <PlansLink onBuy={onBuy} />
        )
      }
    >
      Your photos and every local feature keep working without a plan.
    </Banner>
  );
}

function PlansLink({ onBuy, primary }) {
  // The Support Frameleaf screen is the app's `?screen=buy` route.
  return onBuy ? (
    <Button primary={primary} onClick={onBuy}>
      See plans
    </Button>
  ) : (
    <a className={`button ${primary ? "primary" : ""}`} href="?screen=buy">
      See plans
    </a>
  );
}

function CopyValue({ value, label }) {
  const [copied, setCopied] = useState("");
  return (
    <span className="fc-copy">
      <code>{value}</code>
      <Button
        icon="mdiContentCopy"
        aria-label={`Copy ${label}`}
        onClick={async () => {
          const ok = await copyText(value);
          setCopied(ok ? "Copied" : "Select to copy");
          setTimeout(() => setCopied(""), 2000);
        }}
      />
      <span role="status" className="fc-copy-status">
        {copied}
      </span>
    </span>
  );
}

function useNow(active, interval = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(timer);
  }, [active, interval]);
  return now;
}

// ------------------------------------------------------------------ account & link

function AccountLink({ state, run, onNavigate }) {
  const { link } = state;
  const [unlinking, setUnlinking] = useState(false);
  const [understood, setUnderstood] = useState(false);
  const now = useNow(link.status === "pending");
  const left = deviceCodeSecondsLeft(link.deviceCode, now);
  const clock = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
  const permission = (key, value) =>
    run((current) => ({
      ...current,
      link: {
        ...current.link,
        permissions: { ...current.link.permissions, [key]: value },
      },
    }));

  if (link.status === "unlinked")
    return (
      <>
        <Card
          id="fc-link-title"
          icon="mdiCloudOutline"
          title="This server is not linked"
          description="Frameleaf works fully without an account. Linking is optional and only adds cloud features."
          status="Not linked"
        >
          <ul className="fc-benefits">
            <li>
              <Icon name="mdiCellphone" />
              <span>
                <strong>Access your library from the Frameleaf mobile apps</strong>{" "}
                from anywhere. Sign in with your Frameleaf account and this
                server appears on your phone automatically.
              </span>
            </li>
            <li>
              <Icon name="mdiEarth" />
              <span>
                <strong>Remote access</strong> away from home, without opening
                ports or managing certificates.
              </span>
            </li>
            <li>
              <Icon name="mdiCloudSyncOutline" />
              <span>
                <strong>Cloud processing</strong> for richer descriptions,
                enhancement and restoration, paid per job.
              </span>
            </li>
            <li>
              <Icon name="mdiCloudUploadOutline" />
              <span>
                <strong>Cloud backup</strong> to an encrypted bucket that only
                this server uses.
              </span>
            </li>
          </ul>
          <p className="fc-muted">
            You approve the link on frameleaf.cloud with a short code. Nothing
            from your library is uploaded by linking.
          </p>
          <div className="fc-actions">
            <Button
              primary
              icon="mdiLinkVariant"
              onClick={() =>
                run((current) => startDeviceLink(current), "Link started. Enter the code on frameleaf.cloud.")
              }
            >
              Link to Frameleaf
            </Button>
          </div>
        </Card>
        <HeadlessNote />
      </>
    );

  if (link.status === "pending") {
    const code = link.deviceCode;
    const expired = left === 0;
    return (
      <Card
        id="fc-code-title"
        icon="mdiQrcode"
        title="Approve this server on frameleaf.cloud"
        description="Open the address on your phone or computer, sign in, and check that the code matches."
        status={expired ? "Code expired" : "Waiting for approval…"}
        tone={expired ? "danger" : "running"}
      >
        <div className="fc-device-code">
          <div>
            <p className="fc-overline">Your code</p>
            <p className={`fc-code ${expired ? "is-expired" : ""}`} aria-live="polite">
              {code?.userCode || link.userCode}
            </p>
            <p>
              Go to{" "}
              <a href={code?.verificationUriComplete} target="_blank" rel="noopener noreferrer">
                {LINK_VERIFICATION_URL.replace("https://", "")}
              </a>{" "}
              and enter the code, or scan the QR code.
            </p>
            <Facts
              rows={[
                ["Expires in", expired ? "Expired" : clock],
                ["Server key", <code key="fp">{link.fingerprint}</code>],
              ]}
            />
            <p className="fc-muted">
              The approval page shows this server’s name, version and key
              fingerprint. Only approve if they match.
            </p>
            {!expired && (
              <p className="fc-waiting">
                <Icon name="mdiProgressClock" /> Waiting for approval…
              </p>
            )}
          </div>
          <QrCode
            value={code?.verificationUriComplete || LINK_VERIFICATION_URL}
            size={168}
            label="Link this server"
            showActions={false}
          />
        </div>
        <div className="fc-actions">
          {expired ? (
            <Button primary icon="mdiRefresh" onClick={() => run((current) => startDeviceLink(current), "New code ready.")}>
              Get a new code
            </Button>
          ) : (
            <Button
              primary
              icon="mdiCheck"
              onClick={() =>
                run(
                  (current) =>
                    approveDeviceLink(current, { email: "taylor@example.invalid", name: "Taylor" }),
                  "Linked. Cloud features are now available to set up.",
                )
              }
            >
              Simulate approval
            </Button>
          )}
          {!expired && (
            <Button icon="mdiRefresh" onClick={() => run((current) => startDeviceLink(current))}>
              Get a new code
            </Button>
          )}
          <Button onClick={() => run((current) => cancelDeviceLink(current), "Linking cancelled.")}>
            Cancel
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <>
      <Card
        id="fc-linked-title"
        icon="mdiCloudCheckOutline"
        title="Linked to Frameleaf"
        description="Cloud features you turn on use this link. Local sign-in and your library never depend on it."
        status="Linked"
        tone="ok"
      >
        <Facts
          rows={[
            ["Account", link.account?.email || "—"],
            ["Linked", when(link.linkedAt)],
            ["Last contact", when(link.lastContactAt)],
            ["Instance ID", <code key="id">{link.instanceId}</code>],
            ["Key fingerprint", <code key="fp">{link.fingerprint}</code>],
          ]}
        />
        <div className="fc-actions">
          <Button
            icon="mdiRefresh"
            onClick={() =>
              run(
                (current) => ({
                  ...current,
                  link: { ...current.link, lastContactAt: new Date().toISOString() },
                }),
                "Checked in with Frameleaf Cloud.",
              )
            }
          >
            Check in now
          </Button>
          <a className="button" href={`${STORE_URL}/servers`} target="_blank" rel="noopener noreferrer">
            <Icon name="mdiOpenInNew" /> Manage on frameleaf.cloud
          </a>
        </div>
      </Card>
      <Card
        id="fc-mobile-title"
        icon="mdiCellphone"
        title="Access your library from the Frameleaf mobile apps"
        description="Sign in to the Frameleaf app on iPhone, iPad or Android with your Frameleaf account. This server appears automatically, at home or anywhere else."
        status={state.remote.enabled ? "Available anywhere" : "At home only"}
        tone={state.remote.enabled ? "ok" : "muted"}
      >
        <p className="fc-muted">
          {state.remote.enabled
            ? "Away from home the app connects directly when it can and through the Frameleaf relay otherwise."
            : "The apps reach this server on your home network. Turn on remote access to use them from anywhere."}
        </p>
        {!state.remote.enabled && onNavigate && (
          <div className="fc-actions">
            <Button icon="mdiEarth" onClick={() => onNavigate("cloud", "cloud-remote")}>
              Set up remote access
            </Button>
          </div>
        )}
      </Card>
      <Card
        id="fc-permissions-title"
        title="Allow Frameleaf Cloud to…"
        description="Choose what your Frameleaf account can ask this server to do. The server always decides and records each request."
      >
        <Toggle
          id="allowRemoteEnable"
          label="Turn remote access on or off"
          help="Lets you enable remote access from account.frameleaf.cloud when you are away."
          value={link.permissions.allowRemoteEnable}
          onChange={(value) => permission("allowRemoteEnable", value)}
        />
        <Toggle
          id="allowBackupTrigger"
          label="Start a cloud backup"
          help="Lets the account site start a backup run. It can never read, change or delete backups."
          value={link.permissions.allowBackupTrigger}
          onChange={(value) => permission("allowBackupTrigger", value)}
        />
        <Toggle
          id="allowEntitlementRefresh"
          label="Refresh your plan automatically"
          help="Picks up renewals and plan changes without a manual refresh."
          value={link.permissions.allowEntitlementRefresh}
          onChange={(value) => permission("allowEntitlementRefresh", value)}
        />
      </Card>
      <details className="fc-disclosure">
        <summary>
          <Icon name="mdiInformationOutline" /> What this server sends
        </summary>
        <Facts rows={serverTelemetry} />
        <p className="fc-muted">
          Check-ins happen every few minutes. They never include media, faces,
          albums or anything about the people who use this server.
        </p>
      </details>
      <HeadlessNote />
      <Card
        id="fc-unlink-title"
        title="Unlink this server"
        description="Stops every cloud feature on this server. You can link again at any time."
      >
        <div className="fc-actions">
          <Button
            icon="mdiLinkOff"
            onClick={() => {
              setUnderstood(false);
              setUnlinking(true);
            }}
          >
            Unlink…
          </Button>
        </div>
      </Card>
      {unlinking && (
        <Dialog
          title="Unlink this server from Frameleaf?"
          close={() => setUnlinking(false)}
          actions={
            <>
              <Button onClick={() => setUnlinking(false)}>Keep linked</Button>
              <Button
                primary
                disabled={!understood}
                onClick={() => {
                  if (run((current) => unlinkServer(current), "Server unlinked. Local features are unchanged."))
                    setUnlinking(false);
                }}
              >
                Unlink server
              </Button>
            </>
          }
        >
          <ul className="fc-consequences">
            {unlinkConsequences.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <label className="fc-confirm">
            <input
              type="checkbox"
              checked={understood}
              onChange={(event) => setUnderstood(event.target.checked)}
            />
            I understand that remote visitors, cloud jobs and scheduled cloud
            backups stop now.
          </label>
        </Dialog>
      )}
      {onNavigate && (
        <p className="fc-muted">
          Next:{" "}
          <button className="fc-link" onClick={() => onNavigate("cloud", "cloud-plan")}>
            choose a plan
          </button>
          ,{" "}
          <button className="fc-link" onClick={() => onNavigate("cloud", "cloud-license")}>
            activate a licence
          </button>{" "}
          or{" "}
          <button className="fc-link" onClick={() => onNavigate("cloud", "cloud-remote")}>
            set up remote access
          </button>
          .
        </p>
      )}
    </>
  );
}

function HeadlessNote() {
  return (
    <details className="fc-disclosure">
      <summary>
        <Icon name="mdiServerOutline" /> Linking a server without a browser
      </summary>
      <p>
        Create a link token at account.frameleaf.cloud → Servers → Add server,
        then start the server with <code>FRAMELEAF_LINK_TOKEN=fll_…</code>. The
        token works once and expires within an hour. Remove it after the
        server shows as linked.
      </p>
    </details>
  );
}

// ------------------------------------------------------------------ plan and licence

function Discount({ license, onNavigate }) {
  const pct = `${Math.round(LICENSED_DISCOUNT * 100)}%`;
  return isLicensed(license) ? (
    <p className="fc-note">
      <Icon name="mdiTagOutline" /> This server is licensed: Frameleaf Cloud
      plans and AI credit cost {pct} less.
    </p>
  ) : (
    <p className="fc-note">
      <Icon name="mdiTagOutline" /> Licensed servers get {pct} off Frameleaf
      Cloud plans and AI credit.{" "}
      {onNavigate && (
        <button className="fc-link" onClick={() => onNavigate("cloud", "cloud-license")}>
          Activate a licence
        </button>
      )}
    </p>
  );
}

function Price({ price, license, period }) {
  const paid = cloudPrice(price, license);
  return (
    <p className="fc-price">
      {paid !== price && <s className="fc-muted">{formatUsd(price)}</s>} {formatUsd(paid)}{" "}
      {period && <small>/ {period}</small>}
    </p>
  );
}

function Plan({ state, run, onBuy, onNavigate, setError }) {
  const status = licenseStatus(state.license);
  const linked = state.link.status === "linked";
  const included = activeEntitlements(state.license);
  const entitlements = { ...included, cloudProcessing: linked || included.cloudProcessing };
  const plan = planById(state.license.plan);
  const [checkout, setCheckout] = useState(null);
  const [removing, setRemoving] = useState(false);
  const setPreview = (license) =>
    run((current) => ({ ...current, license: { ...current.license, ...license } }));
  const planState = plan ? status : { label: "No plan", tone: "muted", state: "none" };

  return (
    <>
      <Card
        id="fc-plan-title"
        icon="mdiCreditCardOutline"
        title={plan ? plan.title : "No plan on this server"}
        description={
          plan
            ? `${formatUsd(cloudPrice(plan.price, state.license))} per ${plan.period}. ${plan.description}`
            : "Self-hosting needs no plan. A Frameleaf Cloud plan adds remote access and cloud backup."
        }
        status={planState.label}
        tone={planState.tone}
      >
        {status.state === "grace" && (
          <Banner tone="warning" title="Your renewal did not go through">
            Remote access and cloud backup keep working until{" "}
            {day(state.license.graceUntil)}. Update your payment method on
            frameleaf.cloud to avoid a pause.
          </Banner>
        )}
        {status.state === "expired" && (
          <Banner tone="danger" title="Your plan has ended">
            Remote access and cloud backup are paused. Everything else on this
            server, including every photo, keeps working.
          </Banner>
        )}
        <ul className="fc-chips" aria-label="Included features">
          {["remoteAccess", "cloudBackup", "cloudProcessing"].map((id) => (
            <li key={id} className={entitlements[id] ? "is-on" : ""}>
              <Icon name={entitlements[id] ? "mdiCheckCircleOutline" : "mdiMinus"} />
              {entitlementLabels[id]}
              <span className="fc-visually-hidden">{entitlements[id] ? " included" : " not included"}</span>
            </li>
          ))}
        </ul>
        {plan && (
          <Facts
            rows={[
              [status.state === "expired" ? "Ended" : "Renews", day(state.license.renewsOn)],
              ["Source", state.license.source === "file" ? "Licence file (offline)" : "Frameleaf account"],
              ["Last checked", when(state.license.checkedAt)],
            ]}
          />
        )}
        <p className="fc-note">
          <Icon name="mdiShieldCheckOutline" /> Local photos are never locked. If
          a plan ends, only cloud-connected features pause.
        </p>
        <Discount license={state.license} onNavigate={onNavigate} />
        <div className="fc-actions">
          {plan && state.license.source !== "file" && (
            <a className="button" href={`${STORE_URL}/billing`} target="_blank" rel="noopener noreferrer">
              <Icon name="mdiOpenInNew" /> Manage subscription on frameleaf.cloud
            </a>
          )}
          {plan && (
            <Button
              icon="mdiRefresh"
              onClick={() => {
                if (!linked && state.license.source !== "file") {
                  setError("Link this server to refresh the plan.");
                  return;
                }
                run(
                  (current) => ({
                    ...current,
                    license: { ...current.license, checkedAt: new Date().toISOString() },
                  }),
                  "Plan refreshed.",
                );
              }}
            >
              Refresh
            </Button>
          )}
          {plan && (
            <Button icon="mdiDeleteOutline" onClick={() => setRemoving(true)}>
              Remove from this server…
            </Button>
          )}
        </div>
      </Card>

      {!plan && (
        <Card
          id="fc-plans-title"
          title="Add Frameleaf Cloud to this server"
          description={
            linked
              ? "Checkout happens on frameleaf.cloud. This server picks up the plan automatically."
              : "Link this server to a Frameleaf account first; the plan follows the account."
          }
        >
          <div className="fc-plan-grid">
            {cloudPlans.map((item) => (
              <article key={item.id} className={item.recommended ? "is-recommended" : ""}>
                <h3>{item.title}</h3>
                <Price price={item.price} license={state.license} period={item.period} />
                <ul>
                  {item.features.map((feature) => (
                    <li key={feature}>{feature}</li>
                  ))}
                </ul>
                <Button primary={item.recommended} disabled={!linked} onClick={() => setCheckout(item)}>
                  Continue on frameleaf.cloud
                </Button>
              </article>
            ))}
          </div>
          {!linked && onNavigate && (
            <div className="fc-actions">
              <Button icon="mdiLinkVariant" onClick={() => onNavigate("cloud", "cloud-account")}>
                Link this server
              </Button>
            </div>
          )}
          {onBuy && (
            <p className="fc-muted">
              <button className="fc-link" onClick={onBuy}>
                Compare plans and supporter licences
              </button>
            </p>
          )}
        </Card>
      )}

      <details className="fc-disclosure fc-preview">
        <summary>
          <Icon name="mdiEyeOutline" /> Preview other plan states
        </summary>
        <div className="fc-actions">
          <Button
            disabled={!plan}
            onClick={() =>
              setPreview({
                state: "grace",
                graceUntil: new Date(Date.now() + 14 * 86400000).toISOString(),
              })
            }
          >
            Missed renewal
          </Button>
          <Button disabled={!plan} onClick={() => setPreview({ state: "expired", graceUntil: null })}>
            Grace period ended
          </Button>
          <Button disabled={!plan} onClick={() => setPreview({ state: "active", graceUntil: null })}>
            Back to active
          </Button>
        </div>
      </details>

      {checkout && (
        <Dialog
          title="Checkout on frameleaf.cloud"
          close={() => setCheckout(null)}
          actions={
            <>
              <Button onClick={() => setCheckout(null)}>Cancel</Button>
              <Button
                primary
                onClick={() => {
                  if (run((current) => subscribe(current, checkout.id), `${checkout.title} is active on this server.`))
                    setCheckout(null);
                }}
              >
                Simulate successful checkout
              </Button>
            </>
          }
        >
          <p>
            A new tab opens on frameleaf.cloud for {checkout.title} (
            {formatUsd(cloudPrice(checkout.price, state.license))} per {checkout.period}
            {isLicensed(state.license) ? ", licensed-server price" : ""}). Payment
            details are entered there, never on this server.
          </p>
          <p className="fc-muted">
            When checkout finishes, this server receives a signed plan
            certificate on its next check-in.
          </p>
        </Dialog>
      )}
      {removing && (
        <Dialog
          title="Remove the plan from this server?"
          close={() => setRemoving(false)}
          actions={
            <>
              <Button onClick={() => setRemoving(false)}>Cancel</Button>
              <Button
                primary
                onClick={() => {
                  if (run((current) => removePlan(current), "Plan removed from this server."))
                    setRemoving(false);
                }}
              >
                Remove plan
              </Button>
            </>
          }
        >
          <p>
            Remote access turns off and cloud backups pause on this server. Your
            subscription itself is managed on frameleaf.cloud and is not
            cancelled. Your licence, local photos and settings are unchanged.
          </p>
        </Dialog>
      )}
    </>
  );
}

function License({ state, run, onNavigate, setError }) {
  const licensed = isLicensed(state.license);
  const [key, setKey] = useState("");
  const [removing, setRemoving] = useState(false);
  const fileInput = useRef(null);
  const keyCheck = key ? validateProductKey(key) : null;
  const kind = state.license.supporterKind === "individual" ? "Individual licence" : "Server licence";

  async function installFile(file) {
    if (!file) return;
    try {
      const text = await file.text();
      run((current) => installLicenceFile(current, text), "Licence file installed. Cloud features follow its dates.");
    } catch {
      setError("The file could not be read.");
    }
  }

  return (
    <>
      <Card
        id="fc-licence-title"
        icon="mdiCertificateOutline"
        title={licensed ? kind : "This server is not licensed"}
        description={
          licensed
            ? "Thank you for supporting Frameleaf. The licence is yours for life, with no renewals."
            : "Frameleaf is free to self-host. A one-time licence supports development, adds a supporter badge and lowers the price of cloud services."
        }
        status={licensed ? "Licensed" : "Not licensed"}
        tone={licensed ? "ok" : "muted"}
      >
        <ul className="fc-benefits">
          <li>
            <Icon name="mdiTagOutline" />
            <span>
              <strong>{Math.round(LICENSED_DISCOUNT * 100)}% off Frameleaf Cloud</strong>{" "}
              plans and AI credit for as long as the server stays licensed.
            </span>
          </li>
          <li>
            <Icon name="mdiHeartOutline" />
            <span>
              <strong>Supporter badge</strong> for everyone on this server
              (server licence) or for you (individual licence).
            </span>
          </li>
          <li>
            <Icon name="mdiInfinity" />
            <span>
              <strong>One-time purchase.</strong> A licence never expires and
              never locks anything on this server.
            </span>
          </li>
        </ul>
        {licensed && (
          <Facts
            rows={[
              ["Licence key", `•••• ${state.license.keyHint || "—"}`],
              ["Type", kind],
              ["Last checked", when(state.license.checkedAt)],
            ]}
          />
        )}
        <div className="fc-actions">
          {!licensed && (
            <a className="button primary" href="?screen=buy">
              <Icon name="mdiCartOutline" /> Buy a licence
            </a>
          )}
          {licensed && (
            <Button icon="mdiDeleteOutline" onClick={() => setRemoving(true)}>
              Remove licence key…
            </Button>
          )}
          {onNavigate && (
            <Button icon="mdiCreditCardOutline" onClick={() => onNavigate("cloud", "cloud-plan")}>
              See Frameleaf Cloud plans
            </Button>
          )}
        </div>
      </Card>

      {!licensed && (
        <Card
          id="fc-key-title"
          icon="mdiKeyOutline"
          title="Enter a licence key"
          description="The key arrives by email after purchase and is shown once on frameleaf.cloud."
        >
          <Field id="fc-product-key" label="Licence key" help="Keys look like FL-SXXX-XXXX-XXXX (server) or FL-IXXX-XXXX-XXXX (one person).">
            <input
              id="fc-product-key"
              value={key}
              autoComplete="off"
              spellCheck={false}
              placeholder="FL-XXXX-XXXX-XXXX"
              aria-invalid={keyCheck ? !keyCheck.valid : undefined}
              onChange={(event) => setKey(normalizeProductKey(event.target.value))}
            />
            {keyCheck && !keyCheck.valid && key.length >= 17 && (
              <small className="cc-error">{keyCheck.message}</small>
            )}
          </Field>
          <div className="fc-actions">
            <Button
              primary
              disabled={!keyCheck?.valid}
              onClick={() => {
                if (run((current) => activateProductKey(current, key), "Thank you! This server is now licensed."))
                  setKey("");
              }}
            >
              Activate licence
            </Button>
          </div>
        </Card>
      )}

      <Card
        id="fc-file-title"
        icon="mdiFileDocumentOutline"
        title="Install a licence file"
        description="For servers without internet access. Download the file for this server on another device from frameleaf.cloud, then install it here. It can carry a licence and a Frameleaf Cloud plan."
      >
        <Facts rows={[["This server’s instance ID", <CopyValue key="id" value={state.link.instanceId} label="instance ID" />]]} />
        <input
          ref={fileInput}
          type="file"
          accept=".json,.lic,application/json"
          hidden
          onChange={(event) => {
            installFile(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
        <div className="fc-actions">
          <Button icon="mdiUpload" onClick={() => fileInput.current?.click()}>
            Choose licence file…
          </Button>
          <Button
            onClick={() =>
              run(
                (current) => installLicenceFile(current, sampleLicenceFile(current.link.instanceId)),
                "Sample licence file installed.",
              )
            }
          >
            Use a sample file
          </Button>
        </div>
      </Card>

      {removing && (
        <Dialog
          title="Remove the licence key from this server?"
          close={() => setRemoving(false)}
          actions={
            <>
              <Button onClick={() => setRemoving(false)}>Cancel</Button>
              <Button
                primary
                onClick={() => {
                  if (run((current) => removeProductKey(current), "Licence key removed from this server."))
                    setRemoving(false);
                }}
              >
                Remove key
              </Button>
            </>
          }
        >
          <p>
            The supporter badge and the licensed-server discount stop on this
            server. The licence stays yours: activate it again here or on
            another server. A Frameleaf Cloud plan is not affected.
          </p>
        </Dialog>
      )}
    </>
  );
}

// ------------------------------------------------------------------ remote access

const hostnameNotice = (remote, host) =>
  remote.customHostname === host && remote.customHostnameStatus === "pending"
    ? `${host} is verified.`
    : "Checking DNS. Add the records, then check again.";

function RemoteAccess({ state, run, onNavigate, onBuy, draft, onSettingChange, errors }) {
  const { remote } = state;
  const [hostInput, setHostInput] = useState(remote.customHostname || "");
  const hostCheck = hostInput ? validateCustomHostname(hostInput) : null;
  const customUrl = remote.customHostname ? `https://${remote.customHostname}` : "";
  const serverUrl = draft?.externalUrl ?? "";
  const serverUrlError = errors?.find?.((item) => item.id === "externalUrl")?.error;
  const blocked = remoteAvailability(state);
  const [testing, setTesting] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const set = (patch, message) =>
    run((current) => ({ ...current, remote: { ...current.remote, ...patch } }), message);
  const direct = remote.mode === "relay-and-direct";
  const host = remote.publicUrl.replace("https://", "");
  const label = host.split(".")[1];

  return (
    <>
      {blocked && <Gate state={state} onNavigate={onNavigate} onBuy={onBuy} feature="Remote access" />}
      <Card
        id="fc-remote-title"
        icon="mdiEarth"
        title="Remote access"
        description="Reach this server from anywhere through the Frameleaf relay, or directly when your router allows it. The relay never sees inside your connection."
        status={remote.enabled ? (remote.relayConnected ? "On · connected" : "On") : "Off"}
        tone={remote.enabled ? "ok" : "muted"}
      >
        <Toggle
          id="remoteEnabled"
          label="Allow remote access"
          help="People away from home sign in with their Frameleaf account. Turning this off disconnects them immediately."
          value={remote.enabled && !blocked}
          disabled={!!blocked}
          reason={blocked}
          onChange={(value) =>
            set(
              { enabled: value, relayConnected: value },
              value ? "Remote access is on." : "Remote access is off.",
            )
          }
        />
        <Field id="fc-remote-mode" label="Connection" help="Direct connections are faster and do not count toward your relay allowance.">
          <select
            id="fc-remote-mode"
            value={remote.mode}
            disabled={!!blocked}
            onChange={(event) => set({ mode: event.target.value, portMappingResult: null })}
          >
            <option value="relay">Relay only</option>
            <option value="relay-and-direct">Relay and direct</option>
          </select>
        </Field>
      </Card>

      <div className="fc-grid">
        <Card
          id="fc-relay-title"
          title="Relay"
          status={remote.enabled && remote.relayConnected ? "Connected" : "Not connected"}
          tone={remote.enabled && remote.relayConnected ? "ok" : "muted"}
        >
          <Facts
            rows={[
              ["Region", relayRegions[remote.relay] || remote.relay],
              ["Latency", remote.enabled && remote.relayConnected ? `${remote.relayLatencyMs} ms` : "—"],
              ["Speed", "Up to 8 Mbit/s through the relay"],
            ]}
          />
          <Meter
            label="Relay use this month"
            value={remote.usageGb}
            max={remote.allowanceGb}
            detail={`${remote.usageGb.toFixed(1)} of ${remote.allowanceGb} GB`}
          />
        </Card>
        <Card
          id="fc-direct-title"
          title="Direct connection"
          status={!direct ? "Off" : remote.cgnatSuspected && !remote.manualPort ? "Unavailable" : remote.portMappingResult ? "Ready" : "Not tested"}
          tone={!direct ? "muted" : remote.cgnatSuspected && !remote.manualPort ? "warning" : remote.portMappingResult ? "ok" : "muted"}
        >
          {direct ? (
            <>
              <Facts
                rows={[
                  ["Port", remote.directPort],
                  ["Router mapping", remote.manualPort ? "Forwarded manually" : "UPnP / NAT-PMP"],
                  ["Last result", remote.portMappingResult || "Run a connection test"],
                ]}
              />
              {remote.cgnatSuspected && (
                <Banner tone="warning" title="Your internet provider shares one public address">
                  Direct connections cannot reach this server (CGNAT). Remote
                  access keeps working through the relay.
                </Banner>
              )}
            </>
          ) : (
            <p className="fc-muted">
              Everything goes through the relay. Choose “Relay and direct” to
              let nearby devices connect straight to your router.
            </p>
          )}
        </Card>
      </div>

      {direct && (
        <Card id="fc-port-title" title="Port forwarding" description="Frameleaf asks your router to open the port automatically. Turn this on if your router does not support that.">
          <Toggle
            id="manualPort"
            label="I forward the port myself"
            help="Stops automatic router mapping. Forward the port below to this server’s local address."
            value={remote.manualPort}
            disabled={!!blocked}
            onChange={(value) => set({ manualPort: value, portMappingResult: null })}
          />
          <Field id="fc-direct-port" label="External port" help="Use a port between 1024 and 65535.">
            <div className="cc-input-unit">
              <input
                id="fc-direct-port"
                type="number"
                min={1024}
                max={65535}
                step={1}
                value={remote.directPort}
                disabled={!!blocked}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  if (Number.isInteger(value) && value >= 1024 && value <= 65535)
                    set({ directPort: value, portMappingResult: null });
                }}
              />
            </div>
          </Field>
        </Card>
      )}

      <Card
        id="fc-address-title"
        title="Your public address"
        description="Share this address or scan it on a phone. It works on the relay and on direct connections."
      >
        <div className="fc-address">
          <div>
            <CopyValue value={remote.publicUrl} label="public address" />
            <Facts
              rows={[
                ["Certificate", `*.${label}.frameleaf-direct.net`],
                ["Renews", `Automatically · current one expires ${day(remote.certificateExpires)}`],
                ["Issued to", "This server only; the private key never leaves it"],
              ]}
            />
          </div>
          <QrCode value={remote.publicUrl} size={148} label="Public address" fileName="frameleaf-remote-address" />
        </div>
      </Card>

      <Card
        id="fc-custom-domain-title"
        icon="mdiWeb"
        title="Use your own domain"
        description="Reach this server at an address on a domain you own, such as photos.example.com. Frameleaf still carries the traffic and this server still holds the certificate."
        status={
          remote.customHostnameStatus === "verified"
            ? "Verified"
            : remote.customHostnameStatus === "pending"
              ? "Waiting for DNS"
              : "Not set"
        }
        tone={remote.customHostnameStatus === "verified" ? "ok" : remote.customHostnameStatus === "pending" ? "running" : "muted"}
      >
        <Field
          id="fc-custom-hostname"
          label="Custom hostname"
          help="A subdomain you control. Add the two DNS records below at your domain provider."
        >
          <input
            id="fc-custom-hostname"
            value={hostInput}
            placeholder="photos.example.com"
            autoComplete="off"
            spellCheck={false}
            disabled={!!blocked}
            aria-invalid={hostCheck ? !hostCheck.valid : undefined}
            onChange={(event) => setHostInput(event.target.value)}
          />
          {hostCheck && !hostCheck.valid && hostInput.length > 3 && (
            <small className="cc-error">{hostCheck.message}</small>
          )}
        </Field>
        {hostCheck?.valid && (
          <div className="fc-table-wrap">
            <table className="fc-table">
              <thead>
                <tr>
                  <th scope="col">Type</th>
                  <th scope="col">Name</th>
                  <th scope="col">Points to</th>
                </tr>
              </thead>
              <tbody>
                {customHostnameRecords(hostCheck.host, remote.publicUrl).map((record) => (
                  <tr key={record.name}>
                    <td>{record.type}</td>
                    <td>
                      <CopyValue value={record.name} label={`${record.type} name`} />
                      <small className="fc-muted">{record.purpose}</small>
                    </td>
                    <td>
                      <CopyValue value={record.value} label={`${record.type} target`} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {remote.customHostnameStatus === "pending" && (
          <p className="fc-muted" role="status">
            <Icon name="mdiProgressClock" /> The records are not visible yet.
            DNS changes can take up to an hour; check again after adding them.
          </p>
        )}
        {remote.customHostnameStatus === "verified" && (
          <p className="fc-ok" role="status">
            <Icon name="mdiCheckCircleOutline" /> {remote.customHostname} points
            to this server. Its certificate is issued and renewed here.
          </p>
        )}
        <div className="fc-actions">
          <Button
            primary={!remote.customHostname}
            icon="mdiDnsOutline"
            disabled={!!blocked || !hostCheck?.valid}
            onClick={() =>
              run(
                (current) => checkCustomHostname(current, hostInput),
                hostnameNotice(remote, hostCheck?.host),
              )
            }
          >
            Check DNS
          </Button>
          {remote.customHostname && (
            <Button
              icon="mdiDeleteOutline"
              onClick={() => {
                setHostInput("");
                run((current) => removeCustomHostname(current), "Custom domain removed.");
              }}
            >
              Remove domain
            </Button>
          )}
        </div>
      </Card>

      <Card
        id="fc-server-url-title"
        icon="mdiLinkVariant"
        title="Public server URL"
        description="The address this server puts in shared links, emails and sign-in callbacks. Pick one people can open from anywhere."
      >
        <Field id="fc-server-url" label="Public server URL" help="Saved with your other settings changes.">
          <input
            id="fc-server-url"
            type="url"
            value={serverUrl}
            placeholder="https://photos.example.com"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={serverUrlError ? true : undefined}
            onChange={(event) => onSettingChange?.("externalUrl", event.target.value)}
          />
          {serverUrlError && <small className="cc-error">{serverUrlError}</small>}
        </Field>
        <div className="fc-actions">
          <Button
            icon="mdiCloudOutline"
            disabled={serverUrl === remote.publicUrl}
            onClick={() => onSettingChange?.("externalUrl", remote.publicUrl)}
          >
            Use the Frameleaf address
          </Button>
          <Button
            icon="mdiWeb"
            disabled={remote.customHostnameStatus !== "verified" || serverUrl === customUrl}
            onClick={() => onSettingChange?.("externalUrl", customUrl)}
          >
            Use my domain
          </Button>
        </div>
      </Card>

      <Card id="fc-remote-security-title" title="Who can connect" description="Remote visitors always prove who they are with a Frameleaf account.">
        <Toggle
          id="requireFrameleafSignIn"
          label="Require Frameleaf sign-in for remote visitors"
          help="Everyone connecting from outside your home signs in with a Frameleaf account linked to their account here. Public shared links still open without signing in; API keys work only for people who linked an account."
          value
          policy="Always on"
          onChange={() => {}}
        />
        <Toggle
          id="allowOriginals"
          label="Allow original downloads over the relay"
          help="Originals can be very large and count toward the relay allowance. Previews and streaming always work."
          value={remote.allowOriginals}
          disabled={!!blocked}
          onChange={(value) =>
            value ? setConfirm("allowOriginals") : set({ allowOriginals: false }, "Original downloads over the relay are off.")
          }
        />
        <Toggle
          id="allowPasswordSignIn"
          label="Allow password sign-in over the relay"
          help="Passwords typed away from home are easier to phish or guess. Keep this off unless someone cannot use a Frameleaf account."
          value={remote.allowPasswordSignIn}
          disabled={!!blocked}
          onChange={(value) =>
            value ? setConfirm("allowPasswordSignIn") : set({ allowPasswordSignIn: false }, "Password sign-in over the relay is off.")
          }
        />
      </Card>

      <div className="fc-actions">
        <Button
          primary
          icon="mdiCheckCircleOutline"
          disabled={!!blocked || !remote.enabled || testing}
          onClick={() => {
            setTesting(true);
            timer.current = setTimeout(() => {
              setTesting(false);
              run((current) => testRemoteConnection(current), "Connection test finished.");
            }, 1200);
          }}
        >
          {testing ? "Testing…" : "Test connection"}
        </Button>
        {remote.lastTestAt && <span className="fc-muted">Last tested {when(remote.lastTestAt)}</span>}
      </div>

      <details className="fc-disclosure fc-preview">
        <summary>
          <Icon name="mdiEyeOutline" /> Preview other network conditions
        </summary>
        <Toggle
          id="cgnatSuspected"
          label="Shared public address (CGNAT)"
          help="Shows how the page explains a provider that blocks direct connections."
          value={remote.cgnatSuspected}
          onChange={(value) => set({ cgnatSuspected: value, portMappingResult: null })}
        />
      </details>

      {confirm && (
        <Dialog
          title={confirm === "allowOriginals" ? "Allow original downloads over the relay?" : "Allow password sign-in over the relay?"}
          close={() => setConfirm(null)}
          actions={
            <>
              <Button onClick={() => setConfirm(null)}>Keep off</Button>
              <Button
                primary
                onClick={() => {
                  set({ [confirm]: true }, confirm === "allowOriginals" ? "Original downloads over the relay are on." : "Password sign-in over the relay is on.");
                  setConfirm(null);
                }}
              >
                Turn on
              </Button>
            </>
          }
        >
          <p>
            {confirm === "allowOriginals"
              ? "Anyone signed in remotely can download full-resolution originals, including embedded location data. Large downloads can use up this month’s relay allowance quickly."
              : "Remote visitors could sign in with only a password, without Frameleaf account protection such as passkeys and new-device checks. Leaked or reused passwords become a direct way in."}
          </p>
        </Dialog>
      )}
    </>
  );
}

// ------------------------------------------------------------------ cloud processing

function Processing({ state, run, onNavigate, onBuy }) {
  const { processing, wallet } = state;
  const linked = state.link.status === "linked";
  const consentCurrent = processing.consentVersion === processing.requiredConsentVersion;
  const [consent, setConsent] = useState(null);
  const [topUp, setTopUp] = useState(null);
  const [trial, setTrial] = useState({
    model: modelById(processing.defaultModels?.descriptions)?.gpuClass
      ? processing.defaultModels.descriptions
      : "qwen3.5-9b@1",
    quantity: 500,
  });
  const refusal = cloudAdmission(state, null);
  const estimate = estimateCloudJob(trial.model, trial.quantity);
  const trialRefusal = cloudAdmission(state, estimate);
  const set = (patch, message) =>
    run((current) => ({ ...current, processing: { ...current.processing, ...patch } }), message);
  const setWallet = (patch, message) =>
    run((current) => ({ ...current, wallet: { ...current.wallet, ...patch } }), message);
  const status = !linked
    ? ["Not linked", "muted"]
    : !processing.enabled
      ? ["Off", "muted"]
      : !consentCurrent
        ? ["Review terms", "warning"]
        : ["On", "ok"];

  return (
    <>
      {!linked && <Gate state={state} onNavigate={onNavigate} onBuy={onBuy} feature="Cloud processing" />}
      <Card
        id="fc-destination-title"
        icon="mdiCloudSyncOutline"
        title="Frameleaf Cloud"
        description="Your own computers stay the default, and nothing goes to the cloud without asking."
        status={status[0]}
        tone={status[1]}
      >
        {linked && processing.enabled && !consentCurrent && (
          <Banner
            tone="warning"
            title="The processing terms have changed"
            action={<Button onClick={() => setConsent({ identityNames: processing.identityNames, medicalSignals: processing.medicalSignals })}>Review terms</Button>}
          >
            Review version {processing.requiredConsentVersion} to keep sending
            jobs to Frameleaf Cloud.
          </Banner>
        )}
        <Toggle
          id="cloudProcessing"
          label="Use Frameleaf Cloud for chosen jobs"
          help="Each job still shows its model and cost before it starts. Turning this off cancels waiting cloud jobs and returns their held credit."
          value={processing.enabled}
          disabled={!linked}
          reason="Link this server first."
          onChange={(value) =>
            value && !consentCurrent
              ? setConsent({ identityNames: false, medicalSignals: false })
              : set({ enabled: value, autoDescribe: value && processing.autoDescribe }, value ? "Cloud processing is on." : "Cloud processing is off.")
          }
        />
        <Facts
          rows={[
            ["Terms", processing.consentVersion ? `Version ${processing.consentVersion} accepted` : "Not accepted"],
            ["Recognised names", processing.identityNames ? "Sent with previews" : "Never sent"],
            ["Medical signals", processing.medicalSignals ? "Allowed in descriptions" : "Never described"],
            ["Faces", "Always recognised on this server"],
          ]}
        />
        {refusal && linked && (
          <p className="fc-refusal" role="status">
            <Icon name="mdiAlertCircleOutline" /> Cloud jobs cannot start: {refusal}
          </p>
        )}
        {linked && consentCurrent && (
          <div className="fc-actions">
            <Button onClick={() => setConsent({ identityNames: processing.identityNames, medicalSignals: processing.medicalSignals })}>
              Review terms and features
            </Button>
          </div>
        )}
      </Card>

      <WorkloadRoutingTable state={state} run={run} onNavigate={onNavigate} showModels={false} />

      <Card
        id="fc-wallet-title"
        icon="mdiCreditCardOutline"
        title="AI Wallet"
        description="Prepaid credit for cloud jobs. Each job holds its estimate, then settles at the actual cost."
        status={`${formatUsd(walletAvailable(wallet))} available`}
        tone={walletAvailable(wallet) < 5 ? "warning" : "ok"}
      >
        <div className="fc-wallet">
          <div>
            <span>Balance</span>
            <strong>{formatUsd(wallet.balanceUsd)}</strong>
          </div>
          <div>
            <span>Held for running jobs</span>
            <strong>{formatUsd(wallet.heldUsd)}</strong>
          </div>
          <div>
            <span>Available</span>
            <strong>{formatUsd(walletAvailable(wallet))}</strong>
          </div>
        </div>
        <Meter
          label="Spent today"
          value={wallet.spentTodayUsd}
          max={wallet.dailyCapUsd}
          detail={`${formatUsd(wallet.spentTodayUsd)} of ${formatUsd(wallet.dailyCapUsd)} daily cap`}
        />
        <Field id="fc-daily-cap" label="Daily spending cap" help="Jobs that would pass the cap wait until tomorrow instead of starting.">
          <div className="cc-input-unit">
            <input
              id="fc-daily-cap"
              type="number"
              min={1}
              max={1000}
              step={1}
              value={wallet.dailyCapUsd}
              disabled={!linked}
              onChange={(event) => {
                const value = Number(event.target.value);
                if (Number.isFinite(value) && value >= 1 && value <= 1000) setWallet({ dailyCapUsd: value });
              }}
            />
            <span>USD</span>
          </div>
        </Field>
        <Toggle
          id="autoTopUp"
          label="Top up automatically"
          help="When available credit drops below $5, add $25 with the payment method saved on frameleaf.cloud."
          value={wallet.autoTopUp}
          disabled={!linked}
          reason="Link this server first."
          onChange={(value) => setWallet({ autoTopUp: value }, value ? "Automatic top-up is on." : "Automatic top-up is off.")}
        />
        <div className="fc-actions">
          <Button primary icon="mdiPlus" disabled={!linked} onClick={() => setTopUp({ pack: DEFAULT_WALLET_PACK, stage: "choose" })}>
            Add credit
          </Button>
        </div>
        <p className="fc-muted">
          Top-ups from {formatUsd(WALLET_MIN_TOP_UP_USD, 0)} to {formatUsd(WALLET_MAX_TOP_UP_USD, 0)}; no bonus credit. {WALLET_FEES_NOTE}
        </p>
      </Card>

      <Card
        id="fc-models-title"
        icon="mdiTuneVariant"
        title="Models"
        description="Slide from lighter to heavier models for each kind of work. White runs on the processor, green on your GPU, and blue only on Frameleaf Cloud. Any single job can use a different model."
      >
        <div className="fc-billing">
          <p>
            <strong>How cloud jobs are billed.</strong> You pay for the GPU time a job uses, per second,
            at twice what that GPU costs us, plus a start fee ({startFeeRange()}) for each worker that
            loads the model. Per-photo and per-minute prices are estimates from measured speed; long
            videos run in 30-second chunks on up to five workers.
          </p>
          <details className="fc-disclosure fc-rates">
            <summary>
              <Icon name="mdiExpansionCard" size={16} /> GPU rates
            </summary>
            <dl className="fc-facts">
              {gpuClasses.map((gpu) => (
                <React.Fragment key={gpu.id}>
                  <dt>{gpu.label}</dt>
                  <dd>{formatRate(gpu.customerUsdPerSec)}</dd>
                </React.Fragment>
              ))}
            </dl>
          </details>
        </div>
        {WORKLOADS.map(([workload, label]) => (
          <div key={workload} className="fc-model-row">
            <DefaultModelSlider state={state} run={run} workload={workload} label={label} />
          </div>
        ))}
        <div className="fc-estimate">
          <h3>Estimate a job</h3>
          <div className="fc-estimate-row">
            <label>
              Model
              <select value={trial.model} onChange={(event) => setTrial({ ...trial, model: event.target.value })}>
                {ESTIMATE_MODELS.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name}
                    {model.params ? ` · ${model.params}` : ""}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Quantity
              <input
                type="number"
                min={1}
                max={100000}
                value={trial.quantity}
                onChange={(event) => setTrial({ ...trial, quantity: event.target.value })}
              />
              <small>{modelById(trial.model)?.unit}s</small>
            </label>
          </div>
          {estimate ? (
            <>
              <p>
                Likely {formatUsd(estimate.p50)}, at most about {formatUsd(estimate.p90)}.{" "}
                {formatUsd(estimate.hold)} is held until the job settles.
              </p>
              <p className="fc-muted">
                {billingSentence(estimate)} {perUnitText(estimate).replace(/^about/, "About")}.
              </p>
            </>
          ) : (
            <p className="fc-muted">Enter a quantity to see an estimate.</p>
          )}
          {estimate && (
            <p className={trialRefusal ? "fc-refusal" : "fc-ok"} role="status">
              <Icon name={trialRefusal ? "mdiAlertCircleOutline" : "mdiCheckCircleOutline"} />
              {trialRefusal ? `Would be refused: ${trialRefusal}` : "This job could start now."}
            </p>
          )}
        </div>
      </Card>

      <Card id="fc-auto-title" title="New photos" description="Optional background work for new uploads only.">
        <Toggle
          id="autoDescribe"
          label="Describe new photos automatically"
          help="Sends previews of new uploads to your default description model. Stops for the day when the budget is reached."
          value={processing.autoDescribe}
          disabled={!processing.enabled || !consentCurrent}
          reason="Turn on cloud processing and accept the current terms first."
          onChange={(value) => set({ autoDescribe: value }, value ? "New photos will be described automatically." : "Automatic descriptions are off.")}
        />
        <Field id="fc-auto-budget" label="Daily budget" help="Counts toward the wallet’s daily cap.">
          <div className="cc-input-unit">
            <input
              id="fc-auto-budget"
              type="number"
              min={0.5}
              max={100}
              step={0.5}
              value={processing.dailyBudgetUsd}
              disabled={!processing.autoDescribe}
              onChange={(event) => {
                const value = Number(event.target.value);
                if (Number.isFinite(value) && value >= 0.5 && value <= 100) set({ dailyBudgetUsd: value });
              }}
            />
            <span>USD</span>
          </div>
        </Field>
      </Card>

      <Card id="fc-jobs-title" title="Recent cloud jobs" description="Estimates next to what each job cost: GPU time at the job's rate plus its start fees.">
        <div className="fc-table-wrap">
          <table className="fc-table">
            <thead>
              <tr>
                <th scope="col">Job</th>
                <th scope="col">Model</th>
                <th scope="col">Status</th>
                <th scope="col">Estimate</th>
                <th scope="col">Cost</th>
              </tr>
            </thead>
            <tbody>
              {cloudJobs.map((job) => (
                <tr key={job.id}>
                  <th scope="row">
                    {job.title}
                    <small>{job.finishedAt ? when(job.finishedAt) : "Started today"}</small>
                  </th>
                  <td>{modelById(job.model)?.name || job.model}</td>
                  <td>
                    <span className={`fc-status is-${job.status === "running" ? "running" : "ok"}`}>
                      {job.status === "running" ? "Running" : "Completed"}
                    </span>
                  </td>
                  <td>{formatUsd(job.estimateUsd)}</td>
                  <td>
                    {job.settledUsd === null ? `${formatUsd(job.heldUsd)} held` : formatUsd(job.settledUsd)}
                    {job.gpuSeconds ? (
                      <small className="fc-muted">
                        {formatDuration(job.gpuSeconds)} GPU time
                        {job.workers > 1 ? ` · ${job.workers} workers` : ""}
                      </small>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {onNavigate && (
          <div className="fc-actions">
            <Button onClick={() => onNavigate("processing", "queues")}>Open job manager</Button>
            <Button onClick={() => onNavigate("processing", "workers")}>Home computers</Button>
          </div>
        )}
      </Card>

      {consent && (
        <ConsentDialog
          version={processing.requiredConsentVersion}
          initial={consent}
          close={() => setConsent(null)}
          accept={(features) => {
            if (run((current) => acceptCloudConsent(current, features), `Terms ${processing.requiredConsentVersion} accepted. Cloud processing is on.`))
              setConsent(null);
          }}
        />
      )}
      {topUp && (
        <Dialog
          title={topUp.stage === "choose" ? "Add AI credit" : "Checkout on frameleaf.cloud"}
          close={() => setTopUp(null)}
          actions={
            topUp.stage === "choose" ? (
              <>
                <Button onClick={() => setTopUp(null)}>Cancel</Button>
                <Button primary onClick={() => setTopUp({ ...topUp, stage: "checkout" })}>
                  Continue on frameleaf.cloud
                </Button>
              </>
            ) : (
              <>
                <Button onClick={() => setTopUp({ ...topUp, stage: "choose" })}>Back</Button>
                <Button
                  primary
                  onClick={() => {
                    const pack = walletPacks.find((item) => item.id === topUp.pack);
                    if (run((current) => topUpWallet(current, topUp.pack), `${formatUsd(pack.amount)} added to your AI Wallet.`))
                      setTopUp(null);
                  }}
                >
                  Simulate successful payment
                </Button>
              </>
            )
          }
        >
          {topUp.stage === "choose" ? (
            <fieldset className="fc-choices">
              <legend>Amount</legend>
              {walletPacks.map((pack) => (
                <label key={pack.id} className={topUp.pack === pack.id ? "is-selected" : ""}>
                  <input
                    type="radio"
                    name="fc-pack"
                    checked={topUp.pack === pack.id}
                    onChange={() => setTopUp({ ...topUp, pack: pack.id })}
                  />
                  <strong>{formatUsd(pack.amount)}</strong>
                  <span>{pack.id === DEFAULT_WALLET_PACK ? "Suggested" : "AI credit"}</span>
                </label>
              ))}
            </fieldset>
          ) : (
            <p>
              Payment happens on frameleaf.cloud in a new tab. Credit appears
              here as soon as it clears. Unused credit can be refunded on
              request.
            </p>
          )}
        </Dialog>
      )}
    </>
  );
}

function ConsentDialog({ version, initial, close, accept }) {
  const [features, setFeatures] = useState(initial);
  const [read, setRead] = useState(false);
  return (
    <Dialog
      title={`Cloud processing terms · version ${version}`}
      close={close}
      wide
      actions={
        <>
          <Button onClick={close}>Not now</Button>
          <Button primary disabled={!read} onClick={() => accept(features)}>
            Accept and turn on
          </Button>
        </>
      }
    >
      <ul className="fc-terms">
        {consentTerms.map((term) => (
          <li key={term}>
            <Icon name="mdiShieldCheckOutline" />
            {term}
          </li>
        ))}
      </ul>
      <Facts rows={[["Region", "Europe · your account’s region"], ["Faces", "Never sent; recognition stays on this server"]]} />
      <h3 className="fc-subhead">Optional features</h3>
      <Toggle
        id="identityNames"
        label="Use recognised names in descriptions"
        help="Sends the names of people you have named along with the preview, so descriptions can say who is in a photo."
        value={features.identityNames}
        onChange={(value) => setFeatures({ ...features, identityNames: value })}
      />
      <Toggle
        id="medicalSignals"
        label="Describe health and medical details"
        help="Lets descriptions mention visible medical devices, injuries or conditions."
        value={features.medicalSignals}
        onChange={(value) => setFeatures({ ...features, medicalSignals: value })}
      />
      <label className="fc-confirm">
        <input type="checkbox" checked={read} onChange={(event) => setRead(event.target.checked)} />
        I have read these terms. I can turn cloud processing off at any time.
      </label>
    </Dialog>
  );
}

// ------------------------------------------------------------------ cloud backup

const SCHEDULES = [
  ["0 3 * * *", "Every night at 03:00"],
  ["0 */6 * * *", "Every 6 hours"],
  ["0 3 * * 0", "Sundays at 03:00"],
];

const BACKUP_WORDS = { queued: "Queued", starting: "Starting", running: "Backing up" };

function Backup({ state, run, onNavigate, onBuy, setNotice }) {
  const { backup } = state;
  const entitled = state.link.status === "linked" && activeEntitlements(state.license).cloudBackup;
  const [wizard, setWizard] = useState(false);
  const [restore, setRestore] = useState(false);
  const [unlock, setUnlock] = useState(false);
  const [turningOff, setTurningOff] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const paused = backupPausedReason(state);
  const mode = backupKeyModes.find((item) => item.id === backup.keyMode);
  // "Back up now" is saved as backup.run and moved by the app's shared tick,
  // so it also shows in Activity and survives leaving this page.
  const active = backupRunActive(state);
  const runStatus = backup.run?.status;
  const progress = active ? Math.round(backup.run.progress || 0) : null;
  const previousRun = useRef(runStatus);
  useEffect(() => {
    if (previousRun.current && BACKUP_WORDS[previousRun.current] && runStatus === "completed")
      setNotice("Backup finished. Only new or changed files were uploaded.");
    if (previousRun.current && BACKUP_WORDS[previousRun.current] && runStatus === "failed")
      setNotice(`Backup stopped. ${backup.run?.error || ""}`.trim());
    previousRun.current = runStatus;
  }, [runStatus]);
  useEffect(() => {
    if (!verifying) return undefined;
    const timer = setTimeout(() => {
      setVerifying(false);
      run(
        (current) => ({ ...current, backup: { ...current.backup, lastVerifyAt: new Date().toISOString() } }),
        "Verified 312 sampled files against the latest manifest. Everything matched.",
      );
    }, 1400);
    return () => clearTimeout(timer);
  }, [verifying]);
  const set = (patch, message) =>
    run((current) => ({ ...current, backup: { ...current.backup, ...patch } }), message);

  if (!backup.configured)
    return (
      <>
        {!entitled && <Gate state={state} onNavigate={onNavigate} onBuy={onBuy} feature="Cloud backup" />}
        <Card
          id="fc-backup-title"
          icon="mdiCloudUploadOutline"
          title="Cloud backup is not set up"
          description="Back up originals and the database to an encrypted bucket that only this server uses."
          status="Off"
        >
          <ul className="fc-benefits">
            <li>
              <Icon name="mdiContentDuplicate" />
              <span>
                <strong>Only new or changed files upload.</strong> A photo you
                have twice is stored once.
              </span>
            </li>
            <li>
              <Icon name="mdiLockOutline" />
              <span>
                <strong>Encrypted with a key for this bucket.</strong> You
                choose at setup who keeps it.
              </span>
            </li>
            <li>
              <Icon name="mdiServerOutline" />
              <span>
                <strong>One bucket per server.</strong> Backups from different
                servers never mix.
              </span>
            </li>
          </ul>
          <div className="fc-actions">
            <Button primary icon="mdiCloudUploadOutline" disabled={!entitled} onClick={() => setWizard(true)}>
              Set up cloud backup
            </Button>
          </div>
        </Card>
        {wizard && (
          <BackupSetup
            state={state}
            close={() => setWizard(false)}
            finish={(config) => {
              if (run((current) => configureBackup(current, config), "Cloud backup is set up. The first run starts tonight."))
                setWizard(false);
            }}
          />
        )}
      </>
    );

  const quota = backup.quotaBytes;
  return (
    <>
      {backup.keyMode === "own-memory" && !backup.keyLoaded && (
        <Banner
          tone="danger"
          icon="mdiLockOutline"
          title="Key not loaded — backups paused"
          action={
            <Button primary icon="mdiKeyOutline" onClick={() => setUnlock(true)}>
              Unlock
            </Button>
          }
        >
          This server restarted and does not keep your key. Load the key file
          to resume backups.
        </Banner>
      )}
      {!entitled && <Gate state={state} onNavigate={onNavigate} onBuy={onBuy} feature="Cloud backup" />}
      <Card
        id="fc-backup-title"
        icon="mdiCloudUploadOutline"
        title={backup.target === "byo" ? "Your own bucket" : "Frameleaf-managed storage"}
        description={
          backup.target === "byo"
            ? `On ${backup.endpoint?.replace("https://", "")}. Frameleaf never holds its credentials or key.`
            : "Included with your plan. Frameleaf can see file names and sizes, never contents."
        }
        status={paused ? "Paused" : active ? BACKUP_WORDS[runStatus] : "On"}
        tone={paused ? "warning" : active ? "running" : "ok"}
      >
        <Facts
          rows={[
            ["Bucket", <code key="b">{backup.bucket}</code>],
            ["Region", backup.region],
            ["Key", mode?.title || "—"],
            ["Key fingerprint", <code key="f">{backup.keyFingerprint || "—"}</code>],
            backup.keyMode === "server" && ["Escrow", backup.escrow ? "Encrypted copy with Frameleaf (your passphrase)" : "Off"],
            ["Last verified", when(backup.lastVerifyAt)],
          ]}
        />
        {quota ? (
          <Meter label="Storage used" value={backup.usedBytes || 609e9} max={quota} detail={`${formatBytes(backup.usedBytes || 609e9)} of ${formatBytes(quota)}`} />
        ) : (
          <p className="fc-muted">Storage used: {formatBytes(backup.usedBytes || 609e9)} · billed by your provider</p>
        )}
        <div className="fc-last-run">
          <h3>Last run</h3>
          {backup.lastRunAt ? (
            <p>
              {when(backup.lastRunAt)} ·{" "}
              <strong>{plural(backup.lastRunUploaded, "new or changed file")}</strong> uploaded ·{" "}
              {plural(backup.lastRunSkipped, "file")} already backed up
            </p>
          ) : (
            <p className="fc-muted">No backup has run yet.</p>
          )}
          {active && (
            <>
              <p className="fc-muted" role="status">
                {runStatus === "queued"
                  ? "Queued · waiting for its turn"
                  : runStatus === "starting"
                    ? "Starting · checking the bucket and key"
                    : `Running · ${progress}% · ${plural(backup.run.uploaded || 0, "new or changed file")} uploaded so far`}
              </p>
              {runStatus === "running" && (
                <progress max={100} value={progress} aria-label="Backup progress">
                  {progress}%
                </progress>
              )}
            </>
          )}
        </div>
        <div className="fc-actions">
          <Button primary icon="mdiCloudUploadOutline" disabled={!!paused || active || !entitled}
            onClick={() => run((current) => startBackupRun(current), "Backup queued. Follow it here or in Activity.")}
          >
            {active ? (runStatus === "running" ? `Backing up… ${progress}%` : `${BACKUP_WORDS[runStatus]}…`) : "Back up now"}
          </Button>
          <Button icon="mdiCheckCircleOutline" disabled={verifying || !!paused} onClick={() => setVerifying(true)}>
            {verifying ? "Verifying…" : "Verify"}
          </Button>
          <Button icon="mdiRestore" onClick={() => setRestore(true)}>
            Restore…
          </Button>
        </div>
      </Card>

      <Card id="fc-schedule-title" title="Schedule & retention" description="Older runs are thinned out; files still in a kept run are never removed.">
        <Field id="fc-backup-schedule" label="Run" help="Times use the server’s time zone.">
          <select
            id="fc-backup-schedule"
            value={backup.schedule}
            onChange={(event) => set({ schedule: event.target.value })}
          >
            {SCHEDULES.map(([cron, label]) => (
              <option key={cron} value={cron}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        {[
          ["keepDaily", "Keep daily runs", 1, 90, "days"],
          ["keepWeekly", "Keep weekly runs", 0, 52, "weeks"],
          ["keepMonthly", "Keep monthly runs", 0, 120, "months"],
        ].map(([key, label, min, max, unit]) => (
          <Field key={key} id={`fc-${key}`} label={label}>
            <div className="cc-input-unit">
              <input
                id={`fc-${key}`}
                type="number"
                min={min}
                max={max}
                step={1}
                value={backup[key]}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  if (Number.isInteger(value) && value >= min && value <= max) set({ [key]: value });
                }}
              />
              <span>{unit}</span>
            </div>
          </Field>
        ))}
      </Card>

      <Card id="fc-backup-off-title" title="Turn off cloud backup" description="Stops scheduled runs. Existing backups stay in the bucket until you delete them on frameleaf.cloud.">
        <div className="fc-actions">
          <Button onClick={() => setTurningOff(true)}>Turn off backup…</Button>
        </div>
      </Card>

      {backup.keyMode === "own-memory" && backup.keyLoaded && (
        <details className="fc-disclosure fc-preview">
          <summary>
            <Icon name="mdiEyeOutline" /> Preview a server restart
          </summary>
          <p className="fc-muted">Shows what happens when this server starts without the key.</p>
          <Button onClick={() => set({ keyLoaded: false })}>Simulate restart</Button>
        </details>
      )}

      {unlock && (
        <KeyPrompt
          title="Unlock cloud backups"
          fingerprint={backup.keyFingerprint}
          confirmLabel="Unlock"
          close={() => setUnlock(false)}
          done={() => {
            set({ keyLoaded: true }, "Key loaded for this session. Backups resume on schedule.");
            setUnlock(false);
          }}
        >
          The key stays in memory until the server restarts. It is never saved
          or sent to Frameleaf.
        </KeyPrompt>
      )}
      {restore && (
        <RestoreDialog
          state={state}
          close={() => setRestore(false)}
          start={(summary) => {
            setRestore(false);
            setNotice(`Restore started: ${summary}. Files appear in Library care for review.`);
          }}
          onNavigate={onNavigate}
        />
      )}
      {turningOff && (
        <Dialog
          title="Turn off cloud backup?"
          close={() => setTurningOff(false)}
          actions={
            <>
              <Button onClick={() => setTurningOff(false)}>Keep backing up</Button>
              <Button
                primary
                onClick={() => {
                  if (run((current) => turnOffBackup(current), "Cloud backup is off. Existing backups were kept."))
                    setTurningOff(false);
                }}
              >
                Turn off
              </Button>
            </>
          }
        >
          <p>
            Scheduled runs stop now. The bucket and its backups are kept, and
            you still need this key to read them
            {backup.keyMode === "server" ? " (keep your recovery kit)" : " (keep your key file)"}.
            Delete the bucket on frameleaf.cloud when you no longer need it.
          </p>
        </Dialog>
      )}
    </>
  );
}

function KeyPrompt({ title, fingerprint, close, done, confirmLabel, children }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const input = useRef(null);
  async function readFile(file) {
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (data.format !== "frameleaf-backup-key") throw new Error();
      if (fingerprint && data.fingerprint !== fingerprint)
        throw new Error("This key file is for a different bucket.");
      setValue(data.key);
      setError("");
    } catch (failure) {
      setError(failure.message || "This is not a Frameleaf backup key file.");
    }
  }
  return (
    <Dialog
      title={title}
      close={close}
      actions={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button primary disabled={!value.trim()} onClick={done}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p>{children}</p>
      <input
        ref={input}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={(event) => {
          readFile(event.target.files?.[0]);
          event.target.value = "";
        }}
      />
      <div className="fc-actions">
        <Button icon="mdiUpload" onClick={() => input.current?.click()}>
          Choose key file…
        </Button>
      </div>
      <label className="fc-stack">
        Or paste the key
        <input
          type="password"
          autoComplete="off"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      </label>
      {fingerprint && <p className="fc-muted">Expected fingerprint: <code>{fingerprint}</code></p>}
      {error && <p className="cc-error" role="alert">{error}</p>}
    </Dialog>
  );
}

function RestoreDialog({ state, close, start }) {
  const { backup } = state;
  const [manifest, setManifest] = useState(backupManifests[0].id);
  const [scope, setScope] = useState("library");
  const [asset, setAsset] = useState("");
  const [key, setKey] = useState(false);
  const [useStored, setUseStored] = useState(backup.keyMode === "own-stored");
  const needsKey = backup.keyMode === "own-memory" || (backup.keyMode === "own-stored" && !useStored);
  const chosen = backupManifests.find((item) => item.id === manifest);
  const ready = (!needsKey || key) && (scope !== "asset" || asset.trim());
  const summary = {
    library: `whole library from ${when(chosen.createdAt)}`,
    database: `database only from ${when(chosen.createdAt)}`,
    asset: `“${asset.trim()}” from ${when(chosen.createdAt)}`,
  }[scope];
  if (key === "prompt")
    return (
      <KeyPrompt
        title="Load the backup key"
        fingerprint={backup.keyFingerprint}
        confirmLabel="Use this key"
        close={() => setKey(false)}
        done={() => setKey(true)}
      >
        Restoring needs the key for this bucket.
      </KeyPrompt>
    );
  return (
    <Dialog
      title="Restore from cloud backup"
      close={close}
      wide
      actions={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button primary disabled={!ready} onClick={() => start(summary)}>
            Start restore
          </Button>
        </>
      }
    >
      <label className="fc-stack">
        Backup
        <select value={manifest} onChange={(event) => setManifest(event.target.value)}>
          {backupManifests.map((item) => (
            <option key={item.id} value={item.id}>
              {when(item.createdAt)} · {plural(item.assets, "file")} · {formatBytes(item.bytes)}
            </option>
          ))}
        </select>
      </label>
      <fieldset className="fc-choices">
        <legend>What to restore</legend>
        {[
          ["library", "Whole library", "Originals, edits and the database."],
          ["database", "Database only", "Albums, people, tags and settings. Files are not touched."],
          ["asset", "One photo or video", "Find it by file name or ID."],
        ].map(([id, label, detail]) => (
          <label key={id} className={scope === id ? "is-selected" : ""}>
            <input type="radio" name="fc-restore-scope" checked={scope === id} onChange={() => setScope(id)} />
            <strong>{label}</strong>
            <span>{detail}</span>
          </label>
        ))}
      </fieldset>
      {scope === "asset" && (
        <label className="fc-stack">
          File name or ID
          <input value={asset} placeholder="IMG_2041.HEIC" onChange={(event) => setAsset(event.target.value)} />
        </label>
      )}
      <Facts rows={[["Restores to", "Library care → Restores, for review. Nothing in your library is overwritten."]]} />
      {backup.keyMode === "own-stored" && (
        <label className="fc-confirm">
          <input type="checkbox" checked={useStored} onChange={(event) => setUseStored(event.target.checked)} />
          Use the key stored on this server
        </label>
      )}
      {needsKey && (
        <div className="fc-key-needed">
          <p>
            <Icon name="mdiKeyOutline" /> {key === true ? "Key loaded for this restore." : "This restore needs your key file."}
          </p>
          {key !== true && <Button onClick={() => setKey("prompt")}>Load key file…</Button>}
        </div>
      )}
    </Dialog>
  );
}

function BackupSetup({ state, close, finish }) {
  const [step, setStep] = useState(0);
  const [target, setTarget] = useState("managed");
  const [bucket, setBucket] = useState({ endpoint: "https://s3.eu-central-2.wasabisys.com", bucket: "", accessKey: "", secret: "" });
  const [probe, setProbe] = useState(null);
  const [keyChoice, setKeyChoice] = useState("generated");
  const [storeOwnKey, setStoreOwnKey] = useState(true);
  const keyMode = keyChoice === "generated" ? "server" : storeOwnKey ? "own-stored" : "own-memory";
  const [key, setKey] = useState(null);
  const [downloaded, setDownloaded] = useState(false);
  const [savedKey, setSavedKey] = useState(false);
  const [typed, setTyped] = useState("");
  const [kitSaved, setKitSaved] = useState(false);
  const [escrow, setEscrow] = useState(false);
  const [passphrase, setPassphrase] = useState({ first: "", second: "" });
  const [claim, setClaim] = useState(null);
  const errors = target === "byo" ? validateBucketSettings(bucket) : {};
  const bucketName = target === "byo" ? bucket.bucket : `fl-eu-${state.link.instanceId}`;
  const serverKey = keyMode === "server";
  const steps = ["Destination", "Encryption key", ...(serverKey ? ["Recovery kit"] : []), "Claim bucket"];
  const current = steps[step];
  const fingerprint = key?.fingerprint;
  const ensureKey = () => {
    if (!key) setKey(createBackupKey());
  };
  const escrowValid = !escrow || (passphrase.first.length >= 12 && passphrase.first === passphrase.second);
  const canNext =
    current === "Destination"
      ? target === "managed" || (!Object.keys(errors).length && probe?.ok)
      : current === "Encryption key"
        ? serverKey ||
          (downloaded && savedKey && (keyMode !== "own-memory" || typed.trim().toLowerCase() === "i understand"))
        : current === "Recovery kit"
          ? kitSaved && escrowValid
          : claim?.ok;
  const kit = recoveryKitText({
    instanceId: state.link.instanceId,
    bucket: bucketName,
    fingerprint: fingerprint || "—",
    region: state.backup.region,
    escrow,
  });
  const field = (name, label, type = "text", help) => (
    <label className="fc-stack">
      {label}
      <input
        type={type}
        value={bucket[name]}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={bucket[name] !== "" && !!errors[name]}
        onChange={(event) => {
          setBucket({ ...bucket, [name]: event.target.value });
          setProbe(null);
        }}
      />
      {help && <small className="fc-muted">{help}</small>}
      {bucket[name] !== "" && errors[name] && <small className="cc-error">{errors[name]}</small>}
    </label>
  );
  return (
    <Dialog
      title="Set up cloud backup"
      close={close}
      wide
      actions={
        <>
          <Button onClick={step ? () => setStep(step - 1) : close}>{step ? "Back" : "Cancel"}</Button>
          {current === "Claim bucket" && claim?.ok ? (
            <Button
              primary
              onClick={() =>
                finish({
                  target,
                  endpoint: bucket.endpoint,
                  bucket: bucketName,
                  keyMode,
                  fingerprint,
                  escrow,
                })
              }
            >
              Finish setup
            </Button>
          ) : (
            <Button
              primary
              disabled={!canNext}
              onClick={() => {
                if (current === "Destination") ensureKey();
                setStep(step + 1);
              }}
            >
              Continue
            </Button>
          )}
        </>
      }
    >
      <ol className="fc-steps" aria-label="Setup steps">
        {steps.map((name, index) => (
          <li key={name} aria-current={index === step ? "step" : undefined} className={index < step ? "is-done" : ""}>
            <span>{index < step ? <Icon name="mdiCheck" size={14} /> : index + 1}</span>
            {name}
          </li>
        ))}
      </ol>

      {current === "Destination" && (
        <>
          <fieldset className="fc-choices">
            <legend>Where backups are stored</legend>
            <label className={target === "managed" ? "is-selected" : ""}>
              <input type="radio" name="fc-target" checked={target === "managed"} onChange={() => setTarget("managed")} />
              <strong>Frameleaf-managed storage</strong>
              <span>Included with your plan · 1 TB · Europe. Frameleaf creates a bucket just for this server.</span>
            </label>
            <label className={target === "byo" ? "is-selected" : ""}>
              <input type="radio" name="fc-target" checked={target === "byo"} onChange={() => setTarget("byo")} />
              <strong>Your own S3-compatible bucket</strong>
              <span>An empty bucket on a provider that supports customer-provided encryption keys (SSE-C).</span>
            </label>
          </fieldset>
          {target === "byo" && (
            <div className="fc-form">
              {field("endpoint", "Storage address", "url")}
              {field("bucket", "Bucket name")}
              {field("accessKey", "Access key ID")}
              {field("secret", "Secret access key", "password", "Stored encrypted on this server and never shown again.")}
              <div className="fc-actions">
                <Button
                  disabled={Object.keys(errors).length > 0}
                  onClick={() =>
                    setProbe({
                      ok: true,
                      message: "Connected. The provider accepted and returned a test file encrypted with a customer key (SSE-C).",
                    })
                  }
                >
                  Check bucket
                </Button>
              </div>
              {probe && (
                <p className={probe.ok ? "fc-ok" : "fc-refusal"} role="status">
                  <Icon name={probe.ok ? "mdiCheckCircleOutline" : "mdiAlertCircleOutline"} /> {probe.message}
                </p>
              )}
            </div>
          )}
        </>
      )}

      {current === "Encryption key" && (
        <>
          <p className="fc-muted">
            Every file is encrypted by the storage provider with a key for this
            bucket. The provider never keeps the key. This choice cannot be
            changed later without starting a new backup.
          </p>
          <fieldset className="fc-choices">
            <legend>Encryption key</legend>
            <label className={keyChoice === "generated" ? "is-selected" : ""}>
              <input
                type="radio"
                name="fc-key-choice"
                checked={keyChoice === "generated"}
                onChange={() => {
                  setKeyChoice("generated");
                  setDownloaded(false);
                  setSavedKey(false);
                  setTyped("");
                }}
              />
              <strong>Generate a key for me</strong>
              <span>
                This server creates the key and keeps it next to its identity.
                You save a recovery kit in the next step.
              </span>
              <em>
                <Icon name="mdiAlertOutline" size={14} /> If you lose this server
                and the recovery kit, the backup cannot be read.
              </em>
            </label>
            <label className={keyChoice === "own" ? "is-selected" : ""}>
              <input
                type="radio"
                name="fc-key-choice"
                checked={keyChoice === "own"}
                onChange={() => {
                  setKeyChoice("own");
                  setDownloaded(false);
                  setSavedKey(false);
                }}
              />
              <strong>I’ll maintain my own key</strong>
              <span>
                A key is created in this browser and you download it. It is
                never sent to Frameleaf Cloud, and nobody can recover it for you.
              </span>
              <em>
                <Icon name="mdiAlertOutline" size={14} /> You must download the
                key before you can continue.
              </em>
            </label>
          </fieldset>
          {!serverKey && key && (
            <div className="fc-key-card">
              <Facts rows={[["Key fingerprint", <code key="f">{key.fingerprint}</code>], ["Created", "In this browser, just now"]]} />
              <div className="fc-actions">
                <Button
                  primary={!downloaded}
                  icon={downloaded ? "mdiCheck" : "mdiDownloadOutline"}
                  onClick={() => {
                    if (
                      download(
                        `frameleaf-backup-key-${key.fingerprint}.json`,
                        backupKeyFile({ ...key, instanceId: state.link.instanceId, bucket: bucketName, mode: keyMode }),
                      )
                    )
                      setDownloaded(true);
                  }}
                >
                  {downloaded ? "Downloaded · download again" : "Download key file"}
                </Button>
              </div>
              {!downloaded && (
                <p className="fc-muted" role="status">
                  <Icon name="mdiLockOutline" size={14} /> Download the key file to continue.
                </p>
              )}
              <label className="fc-confirm">
                <input
                  type="checkbox"
                  checked={savedKey}
                  disabled={!downloaded}
                  onChange={(event) => setSavedKey(event.target.checked)}
                />
                I saved the key file somewhere other than this server.
              </label>
              <Toggle
                id="storeOwnKey"
                label="Keep a copy on this server"
                help={
                  storeOwnKey
                    ? "Scheduled backups run unattended. The copy stays on this server and is never sent to Frameleaf Cloud."
                    : "The key is never saved. After every restart backups pause until someone enters it, and restores always need the key file."
                }
                value={storeOwnKey}
                onChange={(value) => {
                  setStoreOwnKey(value);
                  setTyped("");
                }}
              />
              {keyMode === "own-memory" && (
                <label className="fc-stack">
                  Type “I understand” to confirm that a lost key means every backup in this bucket is permanently unreadable.
                  <input value={typed} autoComplete="off" onChange={(event) => setTyped(event.target.value)} />
                </label>
              )}
            </div>
          )}
        </>
      )}

      {current === "Recovery kit" && (
        <>
          <Banner tone="warning" title="This kit is shown once">
            Without this server and this kit, the backup cannot be read.
            Frameleaf cannot recover it for you.
          </Banner>
          <pre className="fc-kit">{kit}</pre>
          <div className="fc-actions">
            <Button icon="mdiDownloadOutline" onClick={() => download("frameleaf-recovery-kit.txt", kit, "text/plain")}>
              Download
            </Button>
            <Button icon="mdiFileDocumentOutline" onClick={() => printText("Frameleaf recovery kit", kit)}>
              Print
            </Button>
          </div>
          <Toggle
            id="escrow"
            label="Also keep an encrypted copy with Frameleaf"
            help="Protected by a passphrase only you know. Frameleaf cannot read it; it helps if you lose this server but still remember the passphrase."
            value={escrow}
            onChange={setEscrow}
          />
          {escrow && (
            <div className="fc-form">
              <label className="fc-stack">
                Passphrase (12 characters or more)
                <input type="password" autoComplete="new-password" value={passphrase.first} onChange={(event) => setPassphrase({ ...passphrase, first: event.target.value })} />
              </label>
              <label className="fc-stack">
                Repeat passphrase
                <input type="password" autoComplete="new-password" value={passphrase.second} onChange={(event) => setPassphrase({ ...passphrase, second: event.target.value })} />
              </label>
              {!escrowValid && passphrase.second && <small className="cc-error">Passphrases must match and be at least 12 characters.</small>}
            </div>
          )}
          <label className="fc-confirm">
            <input type="checkbox" checked={kitSaved} onChange={(event) => setKitSaved(event.target.checked)} />
            I saved or printed the recovery kit.
          </label>
        </>
      )}

      {current === "Claim bucket" && (
        <>
          <p>
            Each server uses its own bucket, and a bucket belongs to exactly one
            server. Frameleaf writes <code>{BUCKET_MARKER}</code> with this
            server’s instance ID so no other server can use it.
          </p>
          <Facts rows={[["Bucket", <code key="b">{bucketName}</code>], ["Instance ID", <code key="i">{state.link.instanceId}</code>]]} />
          <div className="fc-actions">
            <Button primary={!claim} icon="mdiServerOutline" onClick={() => setClaim(checkBucketClaim(bucketName, state.link.instanceId))}>
              Claim bucket
            </Button>
          </div>
          {claim && (
            <p className={claim.ok ? "fc-ok" : "fc-refusal"} role="status">
              <Icon name={claim.ok ? "mdiCheckCircleOutline" : "mdiAlertCircleOutline"} />{" "}
              {claim.ok ? "Bucket claimed for this server." : claim.reason}
            </p>
          )}
          {target === "byo" && (
            <p className="fc-muted">Sample names “family-photos-backup” and “shared-archive” show the refusals.</p>
          )}
        </>
      )}
    </Dialog>
  );
}

// ------------------------------------------------------------------ sign in with Frameleaf

function FrameleafSignIn({ state, run, onNavigate }) {
  const linked = state.link.status === "linked";
  const count = Object.keys(state.userLinks || {}).length;
  return (
    <Card
      id="fc-signin-title"
      icon="mdiShieldAccountOutline"
      title="Sign in with Frameleaf"
      description="Once this server is linked, people can sign in with their Frameleaf account. It works alongside passwords and your own OpenID provider."
      status={linked ? "Available" : "Not linked"}
      tone={linked ? "ok" : "muted"}
    >
      <Facts
        rows={[
          ["Provider", "Frameleaf · id.frameleaf.cloud"],
          ["This server’s client ID", <code key="c">{state.link.instanceId}</code>],
          ["Linked accounts", linked ? plural(count, "person") : "—"],
        ]}
      />
      <Toggle
        id="requireFrameleafRemote"
        label="Require Frameleaf sign-in for remote access"
        help="Anyone connecting from outside your home signs in with a Frameleaf account linked to their account here. At home, people keep signing in however they do now."
        value
        policy="Always on"
        onChange={() => {}}
      />
      <Toggle
        id="showOnLocalLogin"
        label="Show “Sign in with Frameleaf” at home"
        help="Adds the button to the local sign-in page too. Passwords and your own provider stay available."
        value={linked && state.signIn?.showOnLocalLogin !== false}
        disabled={!linked}
        reason="Link this server first."
        onChange={(value) =>
          run((current) => ({ ...current, signIn: { ...current.signIn, showOnLocalLogin: value } }))
        }
      />
      <div className="fc-actions">
        {!linked && (
          <Button primary onClick={() => onNavigate?.("cloud", "cloud-account")}>
            Link to Frameleaf
          </Button>
        )}
        <Button onClick={() => onNavigate?.("security", "signin")}>Your own OpenID provider</Button>
        <Button onClick={() => onNavigate?.("preferences", "frameleaf-account")}>Link your own account</Button>
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------ personal account link

/** Your preferences → Frameleaf account. userId is the signed-in local account. */
export function FrameleafAccountLink({ userId, email = "" }) {
  const [state, commit] = useCloudState();
  const { run, messages } = useActions(commit);
  const [dialog, setDialog] = useState(null);
  const [address, setAddress] = useState(email);
  const mine = state.userLinks?.[userId];
  const serverLinked = state.link.status === "linked";
  return (
    <>
      {messages}
      <header>
        <div>
          <h2>Frameleaf account</h2>
          <p>
            {mine
              ? `Linked to ${mine.email} since ${when(mine.linkedAt)}. Use it to sign in when you are away from home.`
              : serverLinked
                ? "Link your Frameleaf account to sign in to this server when you are away from home."
                : "Your administrator has not linked this server to Frameleaf yet. You can keep signing in at home as usual."}
          </p>
        </div>
        <Button
          disabled={!serverLinked && !mine}
          onClick={() => {
            setAddress(email);
            setDialog(mine ? "unlink" : "link");
          }}
        >
          {mine ? "Unlink" : "Link Frameleaf account"}
        </Button>
      </header>
      {dialog === "link" && (
        <Dialog
          title="Link your Frameleaf account"
          close={() => setDialog(null)}
          actions={
            <>
              <Button onClick={() => setDialog(null)}>Cancel</Button>
              <Button
                primary
                onClick={() => {
                  if (run((current) => linkUserAccount(current, userId, address), "Frameleaf account linked."))
                    setDialog(null);
                }}
              >
                Simulate sign-in on frameleaf.cloud
              </Button>
            </>
          }
        >
          <p>
            You sign in on frameleaf.cloud in a new tab and come back here. Your
            local password, albums and photos stay as they are.
          </p>
          <label className="fc-stack">
            Frameleaf account email
            <input type="email" value={address} autoComplete="email" onChange={(event) => setAddress(event.target.value)} />
          </label>
        </Dialog>
      )}
      {dialog === "unlink" && (
        <Dialog
          title="Unlink your Frameleaf account?"
          close={() => setDialog(null)}
          actions={
            <>
              <Button onClick={() => setDialog(null)}>Keep linked</Button>
              <Button
                primary
                onClick={() => {
                  if (run((current) => unlinkUserAccount(current, userId), "Frameleaf account unlinked."))
                    setDialog(null);
                }}
              >
                Unlink
              </Button>
            </>
          }
        >
          <p>
            You will not be able to reach this server from outside your home
            until you link again. Signing in at home is unchanged.
          </p>
        </Dialog>
      )}
    </>
  );
}
