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
  languages,
  loadOnboarding,
  loadSupporter,
  maintenanceSummary,
  onboardingSteps,
  passwordRequirements,
  passwordStrength,
  removeSupporter,
  renderStorageTemplate,
  saveOnboarding,
  saveSupporter,
  setSupporterBadgeHidden,
  storageTemplatePresets,
  storageTemplateVariables,
  supporterProducts,
  validPin,
  validateEmail,
  validateProductKey,
} from "./system-data.mjs";
import "./system.css";
import "./auth.css";

const LOGO = "/brand/frameleaf-logo-dark.svg";
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const photoNamed = (pattern) =>
  media.find((asset) => asset.type === "photo" && pattern.test(asset.image));
const heroAsset = photoNamed(/summit/i) ?? media.find((a) => a.type === "photo");
const HERO = {
  src: heroAsset?.image ?? "/media/summit.png",
  title: heroAsset?.name?.replace(/\.[a-z0-9]+$/i, "") ?? "Summit",
  subtitle: [heroAsset?.city, heroAsset?.date?.slice(0, 4)].filter(Boolean).join(" · "),
};
const HELLO_IMAGE = photoNamed(/hiking|lake/i)?.image ?? "/media/lake.png";

// ------------------------------------------------------------------ shared UI

function BrandPlate({ compact }) {
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
function ErrorNote({ id, children }) {
  return (
    <p className="auth-error" role="alert" id={id}>
      <Icon name="mdiAlertCircleOutline" size={16} />
      <span>{children}</span>
    </p>
  );
}
function InfoNote({ children }) {
  return (
    <p className="auth-info">
      <Icon name="mdiInformationOutline" size={16} />
      <span>{children}</span>
    </p>
  );
}
function TextField({ id, label, hint, hintId, ...props }) {
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
function PasswordField({ id, label, value, onChange, describedBy, ...props }) {
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
function StrengthMeter({ password }) {
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
function Checklist({ password }) {
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
function useTimer() {
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (callback, delay) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(callback, delay);
  };
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
  const shown = error || externalError;
  return (
    <AuthShell hero={HERO} theme={theme} setTheme={setTheme} footer={<BuiltOn />}>
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
        <Button primary className="auth-submit" type="submit" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </Button>
        <div className="auth-divider" aria-hidden="true">
          or
        </div>
        <Button
          className="auth-oauth"
          type="button"
          icon="mdiShieldAccountOutline"
          onClick={oauth}
          disabled={busy}
        >
          Continue with {oauthProvider}
        </Button>
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

// ------------------------------------------------------------------- Register

export function Register({ onDone, onCancel, theme, setTheme }) {
  const ids = useId();
  const later = useTimer();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const strength = passwordStrength(password);
  const submit = (event) => {
    event.preventDefault();
    if (busy) return;
    if (!name.trim()) return setError("Enter your name.");
    if (!validateEmail(email)) return setError("Enter a valid email address.");
    if (!strength.acceptable)
      return setError("Choose a stronger password that meets the requirements.");
    if (confirm !== password) return setError("The passwords don't match.");
    setError("");
    setBusy(true);
    later(() => {
      setBusy(false);
      onDone?.({ name: name.trim(), email: email.trim().toLowerCase() });
    }, 700);
  };
  return (
    <AuthShell
      hero={{ ...HERO, src: photoNamed(/cabin|creek/i)?.image ?? HERO.src }}
      theme={theme}
      setTheme={setTheme}
      footer={
        <>
          <BuiltOn />
          <span>
            Frameleaf builds on Immich's open-source photo library. Licences and
            acknowledgements are listed in About.
          </span>
        </>
      }
    >
      <div className="auth-heading">
        <h1>Create the admin account</h1>
        <p>This account manages the server, its members and libraries.</p>
      </div>
      <form className="auth-card auth-form" onSubmit={submit} noValidate>
        {error && <ErrorNote>{error}</ErrorNote>}
        <TextField
          id={`${ids}-name`}
          label="Name"
          autoComplete="name"
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <TextField
          id={`${ids}-email`}
          label="Email"
          type="email"
          inputMode="email"
          autoComplete="username"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <PasswordField
          id={`${ids}-password`}
          label="Password"
          autoComplete="new-password"
          value={password}
          onChange={setPassword}
          describedBy={`${ids}-strength`}
        />
        <div id={`${ids}-strength`}>
          <StrengthMeter password={password} />
        </div>
        <Checklist password={password} />
        <PasswordField
          id={`${ids}-confirm`}
          label="Confirm password"
          autoComplete="new-password"
          value={confirm}
          onChange={setConfirm}
          aria-invalid={confirm && confirm !== password ? true : undefined}
        />
        <Button primary className="auth-submit" type="submit" disabled={busy}>
          {busy ? "Creating account…" : "Create account"}
        </Button>
        {onCancel && (
          <button type="button" className="auth-link" onClick={onCancel}>
            Back to sign in
          </button>
        )}
      </form>
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

// ----------------------------------------------------------------- Onboarding

function ThemePreview({ mode }) {
  return (
    <div className={`theme-preview ${mode}`} aria-hidden="true">
      <div className="tp-bar">
        <i />
        <i />
        <i />
      </div>
      <div className="tp-side" />
      <div className="tp-grid">
        {Array.from({ length: 8 }, (_, index) => (
          <i key={index} />
        ))}
      </div>
    </div>
  );
}
function OptionRadio({ name, value, checked, onChange, children }) {
  return (
    <label className="ob-option">
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={() => onChange(value)}
      />
      <span className="ob-radio" aria-hidden="true" />
      <span>{children}</span>
    </label>
  );
}

export function Onboarding({ onDone, onCancel, theme, setTheme, user, storage }) {
  const ids = useId();
  const heading = useRef(null);
  const patternInput = useRef(null);
  const [state, setState] = useState(() => loadOnboarding(storage));
  const [reached, setReached] = useState(state.step);
  const last = onboardingSteps.length - 1;
  const index = clamp(state.step, 0, last);
  const step = onboardingSteps[index];
  const { choices } = state;
  useEffect(() => {
    saveOnboarding(state, storage);
  }, [state, storage]);
  useEffect(() => {
    heading.current?.focus();
  }, [index]);
  const choose = (key, value) =>
    setState((prev) => ({ ...prev, choices: { ...prev.choices, [key]: value } }));
  const chooseIn = (group, key, value) =>
    choose(group, { ...choices[group], [key]: value });
  const go = (next) => {
    const target = clamp(next, 0, last);
    setState((prev) => ({ ...prev, step: target }));
    setReached((prev) => Math.max(prev, target));
  };
  const finish = () => {
    const done = { ...state, completed: true };
    setState(done);
    saveOnboarding(done, storage);
    onDone?.(done.choices);
  };
  const applyTheme = (value) => {
    choose("theme", value);
    if (!setTheme) return;
    if (value === "system") {
      const light =
        typeof window !== "undefined" &&
        window.matchMedia?.("(prefers-color-scheme: light)").matches;
      setTheme(light ? "light" : "dark");
    } else setTheme(value);
  };
  const insertToken = (token) => {
    const field = patternInput.current;
    const pattern = choices.storageTemplate.pattern;
    const start = field?.selectionStart ?? pattern.length;
    const end = field?.selectionEnd ?? pattern.length;
    const next = pattern.slice(0, start) + token + pattern.slice(end);
    chooseIn("storageTemplate", "pattern", next);
    requestAnimationFrame(() => {
      field?.focus();
      field?.setSelectionRange(start + token.length, start + token.length);
    });
  };
  const onKeyDown = (event) => {
    if (event.altKey && event.key === "ArrowRight") {
      event.preventDefault();
      index === last ? finish() : go(index + 1);
    } else if (event.altKey && event.key === "ArrowLeft") {
      event.preventDefault();
      go(index - 1);
    } else if (
      event.key === "Enter" &&
      event.target.tagName === "INPUT" &&
      !["radio", "checkbox"].includes(event.target.type)
    ) {
      event.preventDefault();
      index === last ? finish() : go(index + 1);
    }
  };
  const preview = renderStorageTemplate(choices.storageTemplate.pattern);
  const languageLabel =
    languages.find((entry) => entry.code === choices.language)?.label ?? "English";
  const themeLabel = { light: "Light", dark: "Dark", system: "Match system" }[
    choices.theme
  ];

  const body = () => {
    if (step.id === "hello")
      return (
        <div className="ob-hello">
          <div className="ob-hero">
            <img src={HELLO_IMAGE} alt="" />
          </div>
          <p>
            Hi {user?.name ?? "there"}, welcome to Frameleaf. A few quick
            choices set up your server. Everything here can be changed later in
            Settings.
          </p>
          <ul className="ob-list">
            <li>
              <strong>Two minutes</strong> — language, theme, privacy and storage
              layout.
            </li>
            <li>
              <strong>Nothing leaves your server</strong> — choices are stored
              locally and apply to this server only.
            </li>
          </ul>
        </div>
      );
    if (step.id === "language")
      return (
        <div className="ob-options" role="radiogroup" aria-label="Language">
          {languages.map((entry) => (
            <OptionRadio
              key={entry.code}
              name={`${ids}-language`}
              value={entry.code}
              checked={choices.language === entry.code}
              onChange={(value) => choose("language", value)}
            >
              {entry.label}
            </OptionRadio>
          ))}
        </div>
      );
    if (step.id === "theme")
      return (
        <div className="ob-theme-cards" role="radiogroup" aria-label="Theme">
          {[
            ["dark", "Dark", "Photography first, easy on the eyes"],
            ["light", "Light", "Bright rooms and printed work"],
            ["system", "Match system", "Follows your device setting"],
          ].map(([value, label, hint]) => (
            <label key={value} className="ob-theme-card">
              <input
                type="radio"
                name={`${ids}-theme`}
                value={value}
                checked={choices.theme === value}
                onChange={() => applyTheme(value)}
              />
              <ThemePreview mode={value} />
              <span>
                {label}
                <small>{hint}</small>
              </span>
            </label>
          ))}
        </div>
      );
    if (step.id === "server-privacy")
      return (
        <div className="ob-switches">
          <SwitchRow
            label="Check for new versions"
            description="Frameleaf checks its own release feed once a day. No library data is sent."
            checked={choices.server.versionCheck}
            onChange={(value) => chooseIn("server", "versionCheck", value)}
          />
          <SwitchRow
            label="Show the map"
            description="Map tiles load from the tile server configured for this server."
            checked={choices.server.map}
            onChange={(value) => chooseIn("server", "map", value)}
          />
          <SwitchRow
            label="Allow casting"
            description="Members can send photos and videos to TVs on the local network."
            checked={choices.server.cast}
            onChange={(value) => chooseIn("server", "cast", value)}
          />
        </div>
      );
    if (step.id === "user-privacy")
      return (
        <div className="ob-switches">
          <SwitchRow
            label="Show my photos on the map"
            description="Place your photos by their location data. Other members never see your map."
            checked={choices.user.mapLocations}
            onChange={(value) => chooseIn("user", "mapLocations", value)}
          />
          <SwitchRow
            label="Suggest memories"
            description="Resurface photos from past years on the same date."
            checked={choices.user.memories}
            onChange={(value) => chooseIn("user", "memories", value)}
          />
          <SwitchRow
            label="Include shared albums in my timeline"
            description="Photos others share with you appear alongside your own."
            checked={choices.user.sharedInTimeline}
            onChange={(value) => chooseIn("user", "sharedInTimeline", value)}
          />
        </div>
      );
    if (step.id === "storage-template")
      return (
        <div className="ob-template">
          <SwitchRow
            label="Organise originals into folders"
            description="Files are renamed and filed on disk using the pattern below. Off keeps uploads as they arrive."
            checked={choices.storageTemplate.enabled}
            onChange={(value) => chooseIn("storageTemplate", "enabled", value)}
          />
          {choices.storageTemplate.enabled && (
            <>
              <div className="ob-chips" role="group" aria-label="Presets">
                {storageTemplatePresets.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    aria-pressed={choices.storageTemplate.pattern === preset.pattern}
                    onClick={() =>
                      chooseIn("storageTemplate", "pattern", preset.pattern)
                    }
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
              <TextField
                id={`${ids}-pattern`}
                label="Pattern"
                ref={patternInput}
                value={choices.storageTemplate.pattern}
                onChange={(event) =>
                  chooseIn("storageTemplate", "pattern", event.target.value)
                }
                spellCheck={false}
                autoComplete="off"
                hint="Insert a variable at the cursor, or type your own."
                hintId={`${ids}-pattern-hint`}
              />
              <div className="ob-chips" role="group" aria-label="Variables">
                {storageTemplateVariables.map((variable) => (
                  <button
                    key={variable.token}
                    type="button"
                    onClick={() => insertToken(variable.token)}
                    aria-label={`Insert ${variable.label}`}
                  >
                    {variable.label}
                    <code aria-hidden="true">{variable.token}</code>
                  </button>
                ))}
              </div>
              <div
                className={`ob-template-preview ${preview.valid ? "" : "invalid"}`}
                aria-live="polite"
              >
                <span>Example</span>
                <code>{preview.path}</code>
                {preview.unknown.length > 0 && (
                  <span>
                    Unknown variable{preview.unknown.length > 1 ? "s" : ""}:{" "}
                    {preview.unknown.join(", ")}
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      );
    if (step.id === "backup")
      return (
        <>
          <div className="ob-illustration">
            <div className="ob-device">
              <Icon name="mdiCellphone" size={40} />
              Your phone
            </div>
            <div className="ob-flow" aria-hidden="true">
              <i />
              <i />
              <i />
            </div>
            <div className="ob-device">
              <Icon name="mdiServerOutline" size={40} />
              {aboutInfo.server.name}
            </div>
          </div>
          <p>
            The mobile app backs up new photos and videos to this server in the
            background, so your library grows without any copying by hand.
          </p>
          <ul className="ob-list">
            <li>
              <strong>Choose what to include</strong> — pick albums on your phone
              to back up, and skip the rest.
            </li>
            <li>
              <strong>Wi-Fi by default</strong> — mobile data is only used when
              you allow it.
            </li>
            <li>
              <strong>Originals stay put</strong> — nothing is removed from your
              phone unless you ask.
            </li>
          </ul>
        </>
      );
    if (step.id === "mobile")
      return (
        <>
          <p>
            Install the app, then enter{" "}
            <code className="auth-server">{aboutInfo.server.url}</code> to
            connect it to this server.
          </p>
          <div className="ob-stores">
            {[
              ["mdiApple", "App Store", "iPhone and iPad", aboutInfo.links.appStore],
              ["mdiAndroid", "Google Play", "Android", aboutInfo.links.googlePlay],
              [
                "mdiPackageVariant",
                "Obtainium",
                "Android, direct releases",
                aboutInfo.links.obtainium,
              ],
            ].map(([icon, label, hint, href]) => (
              <a
                key={label}
                className="ob-store"
                href={href}
                target="_blank"
                rel="noreferrer"
              >
                <Icon name={icon} size={26} />
                <span>
                  <strong>{label}</strong>
                  <small>{hint}</small>
                </span>
                <Icon name="mdiOpenInNew" size={16} />
              </a>
            ))}
          </div>
        </>
      );
    return (
      <>
        <p>Your server is ready. Here is what you chose.</p>
        <div className="ob-summary">
          {[
            ["Language", languageLabel],
            ["Theme", themeLabel],
            [
              "Server privacy",
              [
                choices.server.versionCheck && "version checks",
                choices.server.map && "map",
                choices.server.cast && "casting",
              ]
                .filter(Boolean)
                .join(", ") || "all off",
            ],
            [
              "Your privacy",
              [
                choices.user.mapLocations && "map",
                choices.user.memories && "memories",
                choices.user.sharedInTimeline && "shared albums",
              ]
                .filter(Boolean)
                .join(", ") || "all off",
            ],
            [
              "Storage",
              choices.storageTemplate.enabled
                ? choices.storageTemplate.pattern
                : "Keep files as uploaded",
            ],
          ].map(([label, value]) => (
            <div key={label}>
              <span>{label}</span>
              <strong>{value}</strong>
            </div>
          ))}
        </div>
      </>
    );
  };

  return (
    <AuthShell
      wide
      theme={theme}
      setTheme={setTheme}
      footer={<BuiltOn />}
      onKeyDown={onKeyDown}
    >
      <div className="onboarding">
        <nav aria-label="Setup steps">
          <ol className="ob-rail">
            {onboardingSteps.map((entry, position) => (
              <li key={entry.id} className={position < index ? "done" : ""}>
                <button
                  type="button"
                  aria-current={position === index ? "step" : undefined}
                  disabled={position > reached}
                  onClick={() => go(position)}
                >
                  <span className="ob-step-mark" aria-hidden="true">
                    {position < index ? <Icon name="mdiCheck" size={14} /> : position + 1}
                  </span>
                  {entry.short}
                </button>
              </li>
            ))}
          </ol>
          <div className="ob-progress" aria-hidden="true">
            <span>
              Step {index + 1} of {onboardingSteps.length}
            </span>
            <div className="ob-progress-bar">
              <span style={{ width: `${((index + 1) / onboardingSteps.length) * 100}%` }} />
            </div>
          </div>
        </nav>
        <div className="ob-panel">
          <div className="auth-heading">
            <h1 ref={heading} tabIndex={-1}>
              {step.title}
            </h1>
            <p className="fl-sr-only">
              Step {index + 1} of {onboardingSteps.length}
            </p>
          </div>
          <div className="ob-body" key={step.id}>
            {body()}
          </div>
          <div className="ob-nav">
            <div>
              {index > 0 && (
                <Button icon="mdiArrowLeft" type="button" onClick={() => go(index - 1)}>
                  Back
                </Button>
              )}
              {onCancel && index < last && (
                <button type="button" className="auth-link" onClick={onCancel}>
                  Finish later
                </button>
              )}
            </div>
            <div>
              <span className="auth-note">
                Alt + arrow keys move between steps
              </span>
              {index < last ? (
                <Button primary type="button" onClick={() => go(index + 1)}>
                  Next
                  <Icon name="mdiArrowRight" size={16} />
                </Button>
              ) : (
                <Button primary type="button" onClick={finish}>
                  Open Frameleaf
                </Button>
              )}
            </div>
          </div>
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

export function Buy({ user, onDone, onCancel, onChange, theme, setTheme, storage }) {
  const ids = useId();
  const later = useTimer();
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
            Frameleaf is made by a small team and funded by the people who use
            it. A supporter key removes nothing and adds a badge that says
            thanks.
          </p>
        </div>
        {onCancel && (
          <Button icon="mdiArrowLeft" type="button" onClick={onCancel}>
            Back
          </Button>
        )}
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
