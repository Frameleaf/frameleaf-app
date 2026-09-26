import React, { useEffect, useId, useRef, useState } from "react";
import { mdiBackspaceOutline } from "@mdi/js";
import { Icon, IconPath } from "./Icon";
import { Button, Dialog } from "./App";
import { media } from "./media";
import {
  aboutInfo,
  activateSupporter,
  advanceMaintenance,
  createMaintenance,
  formatPrice,
  loadSupporter,
  maintenanceSummary,
  passwordRequirements,
  passwordStrength,
  removeSupporter,
  saveSupporter,
  setSupporterBadgeHidden,
  supporterProducts,
  validPin,
  validateEmail,
  validateProductKey,
} from "./system-data.mjs";
import { useCloudState } from "./CloudJobDialog";
import {
  cloudPlans,
  formatUsd,
  loadCloudState,
  saveCloudState,
  walletAvailable,
  walletPacks,
  WALLET_FEES_NOTE,
} from "./frameleaf-cloud-data.mjs";
import {
  activatePlan,
  linkAccount,
  planById,
} from "./cloud-account.mjs";
import { addCredit } from "./cloud-jobs.mjs";
import "./system.css";
import "./auth.css";

const LOGO = "/brand/frameleaf-logo-dark.svg";
const photoNamed = (pattern) =>
  media.find((asset) => asset.type === "photo" && pattern.test(asset.image));
const heroAsset = photoNamed(/summit/i) ?? media.find((a) => a.type === "photo");
const HERO = {
  src: heroAsset?.image ?? "/media/summit.png",
  title: heroAsset?.name?.replace(/\.[a-z0-9]+$/i, "") ?? "Summit",
  subtitle: [heroAsset?.city, heroAsset?.date?.slice(0, 4)].filter(Boolean).join(" · "),
};

// ------------------------------------------------------------------ shared UI

export function BrandPlate({ compact }) {
  return (
    <div className={`auth-brand-plate ${compact ? "compact" : ""}`}>
      <img src={LOGO} alt="Frameleaf" />
    </div>
  );
}
function ThemeToggle({ theme, setTheme }) {
  if (!setTheme) return null;
  const dark = theme !== "light";
  return (
    <Button
      className="auth-theme-toggle"
      icon={dark ? "mdiWhiteBalanceSunny" : "mdiMoonWaningCrescent"}
      aria-label={dark ? "Switch to light theme" : "Switch to dark theme"}
      onClick={() => setTheme(dark ? "light" : "dark")}
    />
  );
}
function BuiltOn() {
  return (
    <span>
      Built on{" "}
      <a href={aboutInfo.upstream.url} target="_blank" rel="noreferrer">
        Immich
      </a>
    </span>
  );
}
function AuthShell({
  hero,
  wide,
  keypad,
  children,
  theme,
  setTheme,
  footer,
  note = "Preview · sample data",
  onKeyDown,
}) {
  return (
    <div
      className={`auth-screen ${hero ? "split" : "single"} ${wide ? "wide" : ""}`}
      data-keypad={keypad}
      onKeyDown={onKeyDown}
    >
      <div className="auth-pane">
        <div className="auth-pane-top">
          <BrandPlate />
          <ThemeToggle theme={theme} setTheme={setTheme} />
        </div>
        <div className="auth-pane-body">{children}</div>
        <footer className="auth-foot">
          {footer}
          {note && <span className="auth-note">{note}</span>}
        </footer>
      </div>
      {hero && (
        <figure className="auth-hero" aria-hidden="true">
          <img src={hero.src} alt="" />
          <figcaption>
            <strong>{hero.title}</strong>
            <span>{hero.subtitle}</span>
          </figcaption>
        </figure>
      )}
    </div>
  );
}
export function ErrorNote({ id, children }) {
  return (
    <p className="auth-error" role="alert" id={id}>
      <Icon name="mdiAlertCircleOutline" size={16} />
      <span>{children}</span>
    </p>
  );
}
export function InfoNote({ children }) {
  return (
    <p className="auth-info">
      <Icon name="mdiInformationOutline" size={16} />
      <span>{children}</span>
    </p>
  );
}
export function TextField({ id, label, hint, hintId, ...props }) {
  return (
    <div className="auth-field">
      <label htmlFor={id}>{label}</label>
      <input id={id} aria-describedby={hint ? hintId : undefined} {...props} />
      {hint && (
        <span className="auth-field-hint" id={hintId}>
          {hint}
        </span>
      )}
    </div>
  );
}
export function PasswordField({ id, label, value, onChange, describedBy, ...props }) {
  const [show, setShow] = useState(false);
  return (
    <div className="auth-field">
      <label htmlFor={id}>{label}</label>
      <span className="auth-password">
        <input
          id={id}
          type={show ? "text" : "password"}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-describedby={describedBy}
          {...props}
        />
        <button
          type="button"
          aria-label={show ? "Hide password" : "Show password"}
          aria-pressed={show}
          onClick={() => setShow(!show)}
        >
          <Icon name={show ? "mdiEyeOffOutline" : "mdiEyeOutline"} size={18} />
        </button>
      </span>
    </div>
  );
}
export function StrengthMeter({ password }) {
  const strength = passwordStrength(password);
  return (
    <div className="auth-strength" data-score={strength.score}>
      <div className="auth-strength-bars" aria-hidden="true">
        <span />
        <span />
        <span />
        <span />
      </div>
      <div className="auth-strength-label">
        <span>Password strength</span>
        <span aria-live="polite">{strength.label}</span>
      </div>
    </div>
  );
}
export function Checklist({ password }) {
  const strength = passwordStrength(password);
  return (
    <ul className="auth-checks" aria-label="Password requirements">
      {passwordRequirements.map((rule) => {
        const met = strength.checks[rule.id];
        return (
          <li key={rule.id} className={met ? "met" : ""}>
            <Icon name={met ? "mdiCheckCircle" : "mdiCircleOutline"} size={16} />
            <span>{rule.label}</span>
            <span className="fl-sr-only">{met ? ", met" : ", not met"}</span>
          </li>
        );
      })}
    </ul>
  );
}
export function SwitchRow({ label, description, checked, onChange }) {
  const labelId = useId();
  const descId = useId();
  return (
    <div className="fl-switch-row">
      <div>
        <strong id={labelId}>{label}</strong>
        {description && <span id={descId}>{description}</span>}
      </div>
      <button
        type="button"
        role="switch"
        className="fl-switch"
        aria-checked={checked}
        aria-labelledby={labelId}
        aria-describedby={description ? descId : undefined}
        onClick={() => onChange(!checked)}
      />
    </div>
  );
}
export function useTimer() {
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const cancel = () => {
    clearTimeout(timer.current);
    timer.current = null;
  };
  /** Schedules one callback (replacing any pending one) and returns its cancel. */
  const schedule = (callback, delay) => {
    cancel();
    timer.current = setTimeout(callback, delay);
    return cancel;
  };
  schedule.cancel = cancel;
  return schedule;
}

// ---------------------------------------------------------------------- Login

export function Login({
  onDone,
  onRegister,
  theme,
  setTheme,
  serverUrl = aboutInfo.server.url,
  users,
  oauthProvider = "Authentik",
  error: externalError = "",
  via: initialVia = "lan",
  relayUrl = "https://r.k3v9q2m7x4a8d1fh.frameleaf-direct.net",
}) {
  const ids = useId();
  const later = useTimer();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [forgot, setForgot] = useState(false);
  const [server, setServer] = useState(serverUrl);
  const [editServer, setEditServer] = useState(false);
  // Simulated arrival: "relay" is a visitor coming through Frameleaf remote access.
  const [via, setVia] = useState(initialVia === "relay" ? "relay" : "lan");
  const [sameNetwork, setSameNetwork] = useState(true);
  const relay = via === "relay";
  const cloud = useCloudState();
  const showFrameleafLocally = cloud.signIn?.showOnLocalLogin !== false;

  const submit = (event) => {
    event.preventDefault();
    if (busy) return;
    const address = email.trim().toLowerCase();
    if (!validateEmail(address)) return setError("Enter a valid email address.");
    if (!password) return setError("Enter your password.");
    setError("");
    setBusy(true);
    later(() => {
      setBusy(false);
      const known =
        !Array.isArray(users) ||
        users.some((user) => user.email?.toLowerCase() === address);
      if (!known) {
        setError("Incorrect email or password.");
        setPassword("");
        return;
      }
      onDone?.({ method: "password", email: address, remember, server });
    }, 600);
  };
  const oauth = () => {
    if (busy) return;
    setBusy(true);
    later(() => {
      setBusy(false);
      onDone?.({
        method: "oauth",
        provider: oauthProvider.toLowerCase(),
        remember,
        server,
      });
    }, 800);
  };
  const frameleaf = () => {
    if (busy) return;
    setBusy("frameleaf");
    later(() => {
      setBusy(false);
      onDone?.({ method: "frameleaf", via, remember, server: relay ? relayUrl : server });
    }, 900);
  };
  const frameleafButton = (
    <Button
      className="auth-oauth auth-frameleaf"
      type="button"
      onClick={frameleaf}
      disabled={Boolean(busy)}
      autoFocus={relay}
    >
      <img src="/brand/frameleaf-symbol.svg" alt="" width="18" height="18" />
      {busy === "frameleaf" ? "Opening frameleaf.cloud…" : "Sign in with Frameleaf"}
    </Button>
  );
  const demoSwitch = (
    <button
      type="button"
      className="auth-link auth-demo-switch"
      onClick={() => {
        setVia(relay ? "lan" : "relay");
        setSameNetwork(true);
        setError("");
      }}
    >
      {relay ? "Preview: sign-in on the local network" : "Preview: arriving through remote access"}
    </button>
  );
  const shown = error || externalError;
  if (relay)
    return (
      <AuthShell
        hero={HERO}
        theme={theme}
        setTheme={setTheme}
        footer={
          <>
            <BuiltOn />
            {demoSwitch}
          </>
        }
      >
        <div className="auth-heading">
          <h1>Welcome back</h1>
          <p>Sign in to your photo library.</p>
        </div>
        {sameNetwork && (
          <div className="auth-lan" role="status">
            <Icon name="mdiLanConnect" size={18} />
            <div>
              <strong>You're on the same network as this server</strong>
              <span>
                The local address is faster and keeps your photos off the internet.
              </span>
            </div>
            <div className="auth-lan-actions">
              <Button
                type="button"
                primary
                onClick={() => {
                  setServer(serverUrl);
                  setVia("lan");
                }}
              >
                Continue on {new URL(serverUrl).host}
              </Button>
              <button type="button" className="auth-link" onClick={() => setSameNetwork(false)}>
                Stay on remote access
              </button>
            </div>
          </div>
        )}
        <div className="auth-card auth-form">
          <InfoNote>
            You're reaching this server through Frameleaf remote access. Sign in
            with the Frameleaf account your administrator linked to your
            member profile. Passwords stay on the local network.
          </InfoNote>
          {shown && <ErrorNote id={`${ids}-error`}>{shown}</ErrorNote>}
          {frameleafButton}
          <label className="auth-check">
            <input
              type="checkbox"
              checked={remember}
              onChange={(event) => setRemember(event.target.checked)}
            />
            Keep me signed in
          </label>
        </div>
        <div className="auth-server">
          <Icon name="mdiEarth" size={16} />
          <span>Remote access</span>
          <code>{new URL(relayUrl).host}</code>
        </div>
      </AuthShell>
    );
  return (
    <AuthShell
      hero={HERO}
      theme={theme}
      setTheme={setTheme}
      footer={
        <>
          <BuiltOn />
          {demoSwitch}
        </>
      }
    >
      <div className="auth-heading">
        <h1>Welcome back</h1>
        <p>Sign in to your photo library.</p>
      </div>
      <form className="auth-card auth-form" onSubmit={submit} noValidate>
        {shown && <ErrorNote id={`${ids}-error`}>{shown}</ErrorNote>}
        <TextField
          id={`${ids}-email`}
          label="Email"
          type="email"
          inputMode="email"
          autoComplete="username"
          autoFocus
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
            setError("");
          }}
          aria-invalid={shown ? true : undefined}
          placeholder="you@example.test"
        />
        <PasswordField
          id={`${ids}-password`}
          label="Password"
          autoComplete="current-password"
          value={password}
          onChange={(value) => {
            setPassword(value);
            setError("");
          }}
          aria-invalid={shown ? true : undefined}
        />
        <div className="auth-row">
          <label className="auth-check">
            <input
              type="checkbox"
              checked={remember}
              onChange={(event) => setRemember(event.target.checked)}
            />
            Keep me signed in
          </label>
          <button
            type="button"
            className="auth-link"
            aria-expanded={forgot}
            onClick={() => setForgot(!forgot)}
          >
            Forgot your password?
          </button>
        </div>
        {forgot && (
          <InfoNote>
            Passwords are reset by your server administrator. Ask them for a
            temporary password from Users, then sign in and choose your own.
          </InfoNote>
        )}
        <Button primary className="auth-submit" type="submit" disabled={Boolean(busy)}>
          {busy === true ? "Signing in…" : "Sign in"}
        </Button>
        <div className="auth-divider" aria-hidden="true">
          or
        </div>
        {showFrameleafLocally && frameleafButton}
        <Button
          className="auth-oauth"
          type="button"
          icon="mdiShieldAccountOutline"
          onClick={oauth}
          disabled={Boolean(busy)}
        >
          Continue with {oauthProvider}
        </Button>
        {showFrameleafLocally && (
          <p className="auth-note auth-frameleaf-note">
            A Frameleaf account is optional here. It's needed only for remote
            access and Frameleaf Cloud features.
          </p>
        )}
      </form>
      <div className="auth-server">
        <Icon name="mdiServerOutline" size={16} />
        {editServer ? (
          <>
            <label className="fl-sr-only" htmlFor={`${ids}-server`}>
              Server address
            </label>
            <input
              id={`${ids}-server`}
              type="url"
              autoFocus
              value={server}
              onChange={(event) => setServer(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  setEditServer(false);
                }
              }}
            />
            <Button type="button" onClick={() => setEditServer(false)}>
              Done
            </Button>
          </>
        ) : (
          <>
            <span>Server</span>
            <code>{server}</code>
            <button
              type="button"
              className="auth-link"
              onClick={() => setEditServer(true)}
            >
              Change
            </button>
          </>
        )}
      </div>
      {onRegister && (
        <p className="auth-row">
          <span className="auth-note">First time on this server?</span>
          <button type="button" className="auth-link" onClick={onRegister}>
            Create the admin account
          </button>
        </p>
      )}
    </AuthShell>
  );
}

// ------------------------------------------------------------- ChangePassword

export function ChangePassword({ user, onDone, onCancel, theme, setTheme, reason }) {
  const ids = useId();
  const later = useTimer();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const strength = passwordStrength(password);
  const ready = strength.acceptable && confirm === password;
  const submit = (event) => {
    event.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    later(() => {
      setBusy(false);
      onDone?.({ changed: true });
    }, 700);
  };
  return (
    <AuthShell theme={theme} setTheme={setTheme} footer={<BuiltOn />}>
      <div className="auth-heading">
        <h1>Choose a new password</h1>
        <p>
          {reason ??
            "Your administrator asked you to set a new password before you continue."}
        </p>
      </div>
      <form className="auth-card auth-form" onSubmit={submit} noValidate>
        {user?.email && (
          <TextField
            id={`${ids}-email`}
            label="Account"
            value={user.email}
            readOnly
            autoComplete="username"
          />
        )}
        <PasswordField
          id={`${ids}-password`}
          label="New password"
          autoComplete="new-password"
          autoFocus
          value={password}
          onChange={setPassword}
          describedBy={`${ids}-checks`}
        />
        <StrengthMeter password={password} />
        <div id={`${ids}-checks`}>
          <Checklist password={password} />
        </div>
        <PasswordField
          id={`${ids}-confirm`}
          label="Confirm new password"
          autoComplete="new-password"
          value={confirm}
          onChange={setConfirm}
          aria-invalid={confirm && confirm !== password ? true : undefined}
          describedBy={confirm && confirm !== password ? `${ids}-match` : undefined}
        />
        {confirm && confirm !== password && (
          <span className="auth-field-hint" id={`${ids}-match`}>
            The passwords don't match yet.
          </span>
        )}
        <Button primary className="auth-submit" type="submit" disabled={!ready || busy}>
          {busy ? "Saving…" : "Save and continue"}
        </Button>
        {onCancel && (
          <button type="button" className="auth-link" onClick={onCancel}>
            Sign out instead
          </button>
        )}
      </form>
    </AuthShell>
  );
}

// ------------------------------------------------------------------ PinPrompt

export function PinPrompt({
  mode = "unlock",
  onDone,
  onCancel,
  onReset,
  verify,
  keypad = "auto",
  theme,
  setTheme,
  title,
  description,
}) {
  const ids = useId();
  const later = useTimer();
  const input = useRef(null);
  const [digits, setDigits] = useState("");
  const [stage, setStage] = useState("enter");
  const [first, setFirst] = useState("");
  const [error, setError] = useState("");
  const [shake, setShake] = useState(false);
  const [focused, setFocused] = useState(false);
  const create = mode === "create";
  const heading =
    title ??
    (create
      ? stage === "confirm"
        ? "Confirm your PIN"
        : "Create a PIN"
      : "Enter your PIN");
  const copy =
    description ??
    (create
      ? "Six digits protect your Locked content on this device."
      : "Unlock Locked content for this session.");
  useEffect(() => {
    input.current?.focus();
  }, [stage]);
  const fail = (message) => {
    setError(message);
    setShake(true);
    setDigits("");
  };
  const complete = (value) => {
    if (create) {
      if (stage === "enter") {
        setFirst(value);
        setDigits("");
        setError("");
        setStage("confirm");
        return;
      }
      if (value !== first) {
        setStage("enter");
        setFirst("");
        fail("The PINs don't match. Start again.");
        return;
      }
      onDone?.(value);
      return;
    }
    const result = verify ? verify(value) : validPin(value);
    if (result === true || result === undefined) {
      onDone?.(value);
      return;
    }
    fail(typeof result === "string" ? result : "That PIN isn't right. Try again.");
  };
  const update = (value) => {
    const next = value.replace(/\D/g, "").slice(0, 6);
    setDigits(next);
    setError("");
    if (next.length === 6) later(() => complete(next), 140);
  };
  const press = (key) => {
    update(key === "back" ? digits.slice(0, -1) : digits + key);
    input.current?.focus();
  };
  const restart = () => {
    setStage("enter");
    setFirst("");
    setDigits("");
    setError("");
  };
  return (
    <AuthShell keypad={keypad} theme={theme} setTheme={setTheme}>
      <div className="auth-card pin-card">
        <span className="pin-mark">
          <Icon name="mdiShieldLockOutline" size={26} />
        </span>
        <div className="auth-heading">
          <h1>{heading}</h1>
          <p>{copy}</p>
        </div>
        <div
          className={`pin-cells ${shake ? "pin-shake" : ""} ${error ? "error" : ""} ${focused ? "focused" : ""}`}
          onAnimationEnd={() => setShake(false)}
        >
          {Array.from({ length: 6 }, (_, index) => (
            <span
              key={index}
              aria-hidden="true"
              className={`pin-cell ${index < digits.length ? "filled" : ""} ${
                index === Math.min(digits.length, 5) ? "active" : ""
              }`}
            />
          ))}
          <input
            ref={input}
            className="pin-input"
            type="password"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            maxLength={6}
            value={digits}
            aria-label={heading}
            aria-describedby={error ? `${ids}-error` : `${ids}-hint`}
            aria-invalid={error ? true : undefined}
            onChange={(event) => update(event.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
          />
        </div>
        <p id={`${ids}-hint`} className="fl-sr-only">
          Six digits. The PIN is checked as soon as all six are entered.
        </p>
        {error ? (
          <ErrorNote id={`${ids}-error`}>{error}</ErrorNote>
        ) : (
          <p className="auth-field-hint">
            {create && stage === "confirm"
              ? "Enter the same six digits again."
              : "Digits are checked automatically."}
          </p>
        )}
        <div className="pin-keypad">
          {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((digit) => (
            <button
              key={digit}
              type="button"
              aria-label={`Digit ${digit}`}
              onClick={() => press(String(digit))}
            >
              {digit}
            </button>
          ))}
          {onCancel ? (
            <button type="button" className="pin-key-soft" onClick={onCancel}>
              Cancel
            </button>
          ) : (
            <span aria-hidden="true" />
          )}
          <button type="button" aria-label="Digit 0" onClick={() => press("0")}>
            0
          </button>
          <button
            type="button"
            className="pin-key-soft"
            aria-label="Delete last digit"
            onClick={() => press("back")}
          >
            <IconPath path={mdiBackspaceOutline} size={20} />
          </button>
        </div>
        <div className="pin-actions">
          {onCancel && (
            <Button type="button" onClick={onCancel}>
              Cancel
            </Button>
          )}
          {!create && onReset && (
            <button type="button" className="auth-link" onClick={onReset}>
              Reset PIN
            </button>
          )}
          {create && stage === "confirm" && (
            <button type="button" className="auth-link" onClick={restart}>
              Start over
            </button>
          )}
        </div>
      </div>
    </AuthShell>
  );
}

// ---------------------------------------------------------- MaintenanceSplash

const MAINTENANCE_ICONS = {
  done: "mdiCheckCircle",
  running: "mdiProgressClock",
  queued: "mdiClockOutline",
  standby: "mdiBackupRestore",
  skipped: "mdiMinus",
};
const MAINTENANCE_LABELS = {
  done: "Done",
  running: "Running",
  queued: "Waiting",
  standby: "On standby",
  skipped: "Not needed",
};
export function MaintenanceSplash({
  isAdmin = false,
  onDone,
  onEnd,
  refreshSeconds = 30,
  theme,
  setTheme,
  tick = 500,
}) {
  const [tasks, setTasks] = useState(createMaintenance);
  const [countdown, setCountdown] = useState(refreshSeconds);
  const summary = maintenanceSummary(tasks);
  useEffect(() => {
    if (summary.complete) return undefined;
    const id = setInterval(
      () => setTasks((prev) => advanceMaintenance(prev, tick)),
      tick,
    );
    return () => clearInterval(id);
  }, [summary.complete, tick]);
  useEffect(() => {
    if (summary.complete) return undefined;
    const id = setInterval(
      () => setCountdown((value) => (value <= 1 ? refreshSeconds : value - 1)),
      1000,
    );
    return () => clearInterval(id);
  }, [summary.complete, refreshSeconds]);
  const end = (forced) => (onEnd ?? onDone)?.({ ended: true, forced });
  return (
    <AuthShell theme={theme} setTheme={setTheme} footer={<BuiltOn />}>
      <div className="auth-card">
        <span className="pin-mark">
          <Icon name={summary.complete ? "mdiCheckCircle" : "mdiWrenchOutline"} size={26} />
        </span>
        <div className="auth-heading">
          <h1>{summary.complete ? "Maintenance is finished" : "Frameleaf is being updated"}</h1>
          <p>
            {summary.complete
              ? "Everything completed without a rollback. Your library is ready."
              : "Your photos are safe. The server finishes a few tasks and comes back on its own."}
          </p>
        </div>
        <div className="fl-bar" role="progressbar" aria-label="Maintenance progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={summary.percent}>
          <span style={{ width: `${summary.percent}%` }} />
        </div>
        <ul className="maint-tasks">
          {tasks.map((task) => (
            <li key={task.id} data-status={task.status}>
              <span className="maint-icon">
                <Icon name={MAINTENANCE_ICONS[task.status]} size={20} />
              </span>
              <div>
                <strong>{task.title}</strong>
                <span>{task.detail}</span>
              </div>
              <span className="maint-pct">
                {task.status === "running" ? `${Math.round(task.progress)}%` : MAINTENANCE_LABELS[task.status]}
                <span className="fl-sr-only">
                  {task.status === "running" ? " complete" : ""}
                </span>
              </span>
              {task.status === "running" && (
                <div className="fl-bar" aria-hidden="true">
                  <span style={{ width: `${task.progress}%` }} />
                </div>
              )}
            </li>
          ))}
        </ul>
        <div className="maint-status">
          <span role="status" aria-live="polite">
            {summary.complete ? "All tasks finished" : summary.currentTitle ? `${summary.currentTitle} in progress` : "Starting"}
          </span>
          {!summary.complete && (
            <span>
              Checking again in {countdown} s ·{" "}
              <button type="button" className="auth-link" onClick={() => setCountdown(refreshSeconds)}>
                Check now
              </button>
            </span>
          )}
        </div>
        <div className="maint-actions">
          {summary.complete ? (
            <Button primary type="button" onClick={() => end(false)}>
              Open Frameleaf
            </Button>
          ) : (
            isAdmin && (
              <Button type="button" icon="mdiLockOpenVariantOutline" onClick={() => end(true)}>
                End maintenance
              </Button>
            )
          )}
        </div>
        {isAdmin && !summary.complete && (
          <InfoNote>
            Ending maintenance early keeps the rollback point but lets members in
            before the remaining steps finish.
          </InfoNote>
        )}
      </div>
    </AuthShell>
  );
}

// ------------------------------------------------------------------------ Buy

export function Buy({
  user,
  onDone,
  onCancel,
  onChange,
  theme,
  setTheme,
  storage,
  section = null,
  onOpenCloudSettings,
}) {
  const ids = useId();
  const later = useTimer();
  const cloud = useCloudState();
  const creditRef = useRef(null);
  const [checkout, setCheckout] = useState(null);
  const [cloudBusy, setCloudBusy] = useState(false);
  const [cloudNote, setCloudNote] = useState("");
  useEffect(() => {
    if (section === "credit") creditRef.current?.scrollIntoView({ block: "start" });
  }, [section]);
  const activePlan = cloud.license.state === "active" ? planById(cloud.license.plan) : null;
  const confirmCheckout = () => {
    if (!checkout || cloudBusy) return;
    setCloudBusy(true);
    later(() => {
      const current = loadCloudState();
      if (checkout.kind === "plan") {
        saveCloudState(activatePlan(current, checkout.plan.id));
        setCloudNote(`${checkout.plan.title} is active. Remote access and cloud backup are ready to set up.`);
      } else {
        const linked = current.link.status === "linked" ? current : linkAccount(current);
        saveCloudState(addCredit(linked, checkout.pack.amount));
        setCloudNote(
          `${formatUsd(checkout.pack.amount, 0)} of AI credit added.`,
        );
      }
      setCloudBusy(false);
      setCheckout(null);
    }, 900);
  };
  const [state, setState] = useState(() => loadSupporter(storage));
  const [modal, setModal] = useState(null);
  const [key, setKey] = useState("");
  const [keyError, setKeyError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const commit = (next) => {
    setState(next);
    saveSupporter(next, storage);
    onChange?.(next);
  };
  const validation = validateProductKey(key);
  const activate = (event) => {
    event?.preventDefault();
    if (busy) return;
    if (!validation.valid) {
      setKeyError(validation.message);
      return;
    }
    setBusy(true);
    later(() => {
      commit(activateSupporter(state, key));
      setBusy(false);
      setModal(null);
      setKey("");
      setKeyError("");
      onDone?.({ activated: true, kind: validation.kind });
    }, 700);
  };
  const product = supporterProducts.find((entry) => entry.id === modal);
  const activeProduct = supporterProducts.find((entry) => entry.id === state.kind);
  const keyField = (autoFocus) => (
    <div className="auth-field">
      <label htmlFor={`${ids}-key`}>Product key</label>
      <input
        id={`${ids}-key`}
        value={key}
        autoFocus={autoFocus}
        autoComplete="off"
        spellCheck={false}
        placeholder="FL-XXXX-XXXX-XXXX"
        aria-invalid={keyError ? true : undefined}
        aria-describedby={`${ids}-key-hint`}
        onChange={(event) => {
          setKey(event.target.value.toUpperCase());
          setKeyError("");
        }}
      />
      <span className="auth-field-hint" id={`${ids}-key-hint`} aria-live="polite">
        {validation.valid
          ? `${validation.kind === "server" ? "Server" : "Individual"} key recognised`
          : "Keys look like FL-XXXX-XXXX-XXXX."}
      </span>
    </div>
  );
  return (
    <AuthShell wide theme={theme} setTheme={setTheme} footer={<BuiltOn />}>
      <div className="buy-head">
        <div className="auth-heading">
          <h1>Support Frameleaf</h1>
          <p>
            Frameleaf is free to self-host and made by a small team funded by
            the people who use it. Frameleaf Cloud adds optional online
            services; a supporter key adds a badge that says thanks. Nothing
            on your server is ever locked.
          </p>
        </div>
        {onCancel && (
          <Button icon="mdiArrowLeft" type="button" onClick={onCancel}>
            Back
          </Button>
        )}
      </div>
      {cloudNote && (
        <p className="auth-success" role="status">
          <Icon name="mdiCheckCircleOutline" size={16} />
          <span>{cloudNote}</span>
        </p>
      )}
      <section className="buy-section" aria-labelledby={`${ids}-cloud`}>
        <div className="buy-section-head">
          <h2 id={`${ids}-cloud`}>Frameleaf Cloud</h2>
          <p>Remote access and encrypted cloud backup for this server.</p>
        </div>
        <div className="buy-cards">
          {cloudPlans.map((plan) => {
            const current = activePlan?.id === plan.id;
            return (
              <section
                key={plan.id}
                className={`buy-card ${plan.recommended ? "recommended" : ""} ${current ? "current" : ""}`}
                aria-labelledby={`${ids}-${plan.id}`}
              >
                <h2 id={`${ids}-${plan.id}`}>
                  {plan.title}
                  {current ? (
                    <span className="buy-tag">Current plan</span>
                  ) : (
                    plan.recommended && <span className="buy-tag">Recommended</span>
                  )}
                </h2>
                <div className="buy-price">
                  <strong>{formatUsd(plan.price, 0)}</strong>
                  <span>per {plan.period}</span>
                </div>
                <p>{plan.description}</p>
                <ul>
                  {plan.features.map((feature) => (
                    <li key={feature}>
                      <Icon name="mdiCheck" size={16} />
                      {feature}
                    </li>
                  ))}
                </ul>
                {current ? (
                  <>
                    <span className="auth-note">Renews {cloud.license.renewsOn}</span>
                    {onOpenCloudSettings && (
                      <Button type="button" icon="mdiCloudLockOutline" onClick={() => onOpenCloudSettings("cloud-backup")}>
                        Set up cloud backup
                      </Button>
                    )}
                  </>
                ) : (
                  <Button
                    primary={plan.recommended && !activePlan}
                    type="button"
                    icon="mdiOpenInNew"
                    onClick={() => setCheckout({ kind: "plan", plan })}
                  >
                    {activePlan ? "Switch on frameleaf.cloud" : "Subscribe on frameleaf.cloud"}
                  </Button>
                )}
              </section>
            );
          })}
        </div>
      </section>
      <section className="auth-card buy-credit" ref={creditRef} aria-labelledby={`${ids}-credit`}>
        <div className="buy-credit-head">
          <div>
            <h2 id={`${ids}-credit`}>AI credit</h2>
            <p>
              Pay as you go for Frameleaf Cloud processing: restorations,
              upscales, descriptions and Studio renders. Every job shows its
              cost before it runs. No subscription needed.
            </p>
          </div>
          <div className="buy-balance">
            <span>Available</span>
            <strong>{formatUsd(walletAvailable(cloud.wallet))}</strong>
            {cloud.wallet.heldUsd > 0 && <small>{formatUsd(cloud.wallet.heldUsd)} held for running jobs</small>}
          </div>
        </div>
        <div className="buy-packs" role="group" aria-label="Add AI credit">
          {walletPacks.map((pack) => (
            <button key={pack.id} type="button" onClick={() => setCheckout({ kind: "credit", pack })}>
              <strong>{formatUsd(pack.amount, 0)}</strong>
              <small>AI credit</small>
            </button>
          ))}
        </div>
        <p className="buy-note">{WALLET_FEES_NOTE}</p>
        {onOpenCloudSettings && (
          <button type="button" className="auth-link" onClick={() => onOpenCloudSettings("cloud-processing")}>
            Spending cap, auto top-up and models
          </button>
        )}
      </section>
      <div className="buy-section-head">
        <h2>Supporter key</h2>
        <p>A one-time thank you. It adds a badge and unlocks nothing.</p>
      </div>
      {state.activated ? (
        <section className="auth-card" aria-labelledby={`${ids}-active`}>
          <div className="buy-active">
            <span className="buy-badge">
              <Icon name="mdiHandHeartOutline" size={28} />
            </span>
            <div>
              <h2 id={`${ids}-active`}>
                Thank you{user?.name ? `, ${user.name}` : ""}
              </h2>
              <dl>
                <dt>Key</dt>
                <dd>
                  {activeProduct?.title ?? "Supporter"} · ends in {state.keyHint}
                </dd>
                <dt>Activated</dt>
                <dd>
                  {new Date(state.activatedAt).toLocaleDateString(undefined, {
                    day: "numeric",
                    month: "short",
                    year: "numeric",
                  })}
                </dd>
                <dt>Badge</dt>
                <dd>
                  <span className="supporter-badge">
                    <Icon name="mdiHandHeartOutline" size={12} />
                    Supporter
                  </span>
                </dd>
              </dl>
            </div>
          </div>
          <SwitchRow
            label="Hide the supporter badge"
            description="Keep supporting without showing the badge next to your name."
            checked={state.hideBadge}
            onChange={(value) => commit(setSupporterBadgeHidden(state, value))}
          />
          <div className="auth-row">
            {confirmRemove ? (
              <>
                <span>Remove this key from {activeProduct?.id === "server" ? "this server" : "your account"}?</span>
                <span style={{ display: "flex", gap: 8 }}>
                  <Button type="button" onClick={() => setConfirmRemove(false)}>
                    Keep
                  </Button>
                  <Button
                    type="button"
                    onClick={() => {
                      commit(removeSupporter(state));
                      setConfirmRemove(false);
                    }}
                  >
                    Remove key
                  </Button>
                </span>
              </>
            ) : (
              <button type="button" className="auth-link" onClick={() => setConfirmRemove(true)}>
                Remove key
              </button>
            )}
          </div>
        </section>
      ) : (
        <div className="buy-cards">
          {supporterProducts.map((entry) => (
            <section
              key={entry.id}
              className={`buy-card ${entry.recommended ? "recommended" : ""}`}
              aria-labelledby={`${ids}-${entry.id}`}
            >
              <h2 id={`${ids}-${entry.id}`}>
                {entry.title}
                {entry.recommended && <span className="buy-tag">Recommended</span>}
              </h2>
              <div className="buy-price">
                <strong>{formatPrice(entry)}</strong>
                <span>{entry.period}</span>
              </div>
              <p>{entry.description}</p>
              <ul>
                {entry.features.map((feature) => (
                  <li key={feature}>
                    <Icon name="mdiCheck" size={16} />
                    {feature}
                  </li>
                ))}
              </ul>
              <Button
                primary={entry.recommended}
                type="button"
                onClick={() => {
                  setKeyError("");
                  setModal(entry.id);
                }}
              >
                Purchase
              </Button>
            </section>
          ))}
        </div>
      )}
      {!state.activated && (
        <section className="auth-card buy-key" aria-labelledby={`${ids}-have`}>
          <h2 id={`${ids}-have`}>Already have a key?</h2>
          <form className="buy-key-row" onSubmit={activate} noValidate>
            {keyField(false)}
            <Button primary type="submit" disabled={busy}>
              {busy ? "Activating…" : "Activate"}
            </Button>
          </form>
          {keyError && !modal && <ErrorNote>{keyError}</ErrorNote>}
        </section>
      )}
      {checkout && (
        <Dialog
          title="Continue to frameleaf.cloud?"
          close={() => setCheckout(null)}
          actions={
            <>
              <Button type="button" onClick={() => setCheckout(null)}>
                Cancel
              </Button>
              <Button primary type="button" icon="mdiOpenInNew" onClick={confirmCheckout} disabled={cloudBusy}>
                {cloudBusy ? "Waiting for frameleaf.cloud…" : "Continue"}
              </Button>
            </>
          }
        >
          <div className="auth-form">
            <p>
              {checkout.kind === "plan"
                ? `${checkout.plan.title} costs ${formatUsd(checkout.plan.price, 0)} per ${checkout.plan.period}. `
                : `Add ${formatUsd(checkout.pack.amount, 0)} of AI credit. `}
              Checkout opens on frameleaf.cloud in a new tab. You sign in with
              your Frameleaf account there, and payment details are entered
              only on that site.
            </p>
            {cloud.link.status !== "linked" && (
              <InfoNote>This server will be linked to the Frameleaf account you use at checkout.</InfoNote>
            )}
            <InfoNote>The store isn't connected in this preview. Continue to see the finished state.</InfoNote>
          </div>
        </Dialog>
      )}
      {product && (
        <Dialog
          title={`Purchase a ${product.title} key`}
          close={() => setModal(null)}
          actions={
            <>
              <Button type="button" onClick={() => setModal(null)}>
                Cancel
              </Button>
              <Button primary type="button" onClick={activate} disabled={busy || !validation.valid}>
                {busy ? "Activating…" : "Activate key"}
              </Button>
            </>
          }
        >
          <div className="auth-form">
            <p>
              Purchases open the Frameleaf store in a new tab, where you pay{" "}
              {formatPrice(product)} once and receive a product key by email.
            </p>
            <InfoNote>
              The store isn't connected in this preview. Enter a key here to see
              the activated state.
            </InfoNote>
            {keyField(true)}
            {keyError && <ErrorNote>{keyError}</ErrorNote>}
          </div>
        </Dialog>
      )}
    </AuthShell>
  );
}
