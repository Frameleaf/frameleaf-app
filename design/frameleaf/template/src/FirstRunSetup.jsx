import React, { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { Button } from "./Controls";
import { QrCode } from "./QrCode";
import { media } from "./media";
import { Checklist, ErrorNote, PasswordField, StrengthMeter, SwitchRow, TextField, useTimer } from "./AuthScreens";
import { languages } from "./system-data.mjs";
import { formatUsd, loadCloudState, saveCloudState } from "./frameleaf-cloud-data.mjs";
import { SAMPLE_ACCOUNT, SAMPLE_USER_CODE, linkAccount } from "./cloud-account.mjs";
import {
  CLOUD_BACKUP_PER_TB,
  KEEP_LAYOUT,
  accountToolProgress,
  accountToolSections,
  chapterIndex,
  checkStorage,
  clearSetup,
  cloudBackupMonthly,
  cloudBackupQuote,
  cloudReindexEstimate,
  detectedHardware,
  examplePath,
  existingLibrary,
  flowSteps,
  formatCount,
  formatTb,
  foundBackup,
  goToStep,
  keyModes,
  layoutPresets,
  loadAccountTool,
  loadSetup,
  markSection,
  modelTiers,
  processingOptions,
  queuedJobs,
  reindexHours,
  saveAccountTool,
  saveSetup,
  setupChapters,
  setupSummary,
  themeAfterSetup,
  validateStep,
} from "./first-run-setup.mjs";
import "./first-run-setup.css";

// First-run setup. Two admin flows share one stage: a new server (no users yet)
// and the first Frameleaf launch on an existing library. Other users get the
// personal account tool instead of a wizard. Setup always runs dark.

const EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";
const photos = media.filter((asset) => asset.type === "photo" && asset.image);
const photo = (index) => photos[index % Math.max(1, photos.length)]?.image;
const when = (value) =>
  new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(value));

/** Reduced motion from the system; setup then uses plain fades only. */
export function useReducedMotion() {
  const query = () =>
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const [reduced, setReduced] = useState(query);
  useEffect(() => {
    if (typeof matchMedia !== "function") return undefined;
    const list = matchMedia("(prefers-reduced-motion: reduce)");
    const change = () => setReduced(list.matches);
    list.addEventListener?.("change", change);
    return () => list.removeEventListener?.("change", change);
  }, []);
  return reduced;
}
const animate = (node, frames, options) => node?.animate?.(frames, { fill: "both", easing: EASE, ...options });

// -------------------------------------------------------------- motion parts

function CountUp({ value, format = formatCount, duration = 1400, delay = 0 }) {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState(reduced ? value : 0);
  useEffect(() => {
    if (reduced) return setShown(value);
    let frame;
    let start;
    const tick = (now) => {
      start ??= now + delay;
      const t = Math.min(1, Math.max(0, (now - start) / duration));
      setShown(value * (1 - Math.pow(1 - t, 3)));
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value, reduced, duration, delay]);
  return <span className="frs-count">{format(shown)}</span>;
}

const FRAME = "M 67 2 H 171 C 207 2 236 31 236 67 V 172 C 236 208 207 237 171 237 H 130 C 145 230 158 219 169 205 C 190 202 205 189 205 168 V 71 C 205 50 188 34 167 34 H 72 C 51 34 34 51 34 72 V 166 C 34 182 37 192 47 200 L 48 235 C 21 228 2 203 2 171 V 68 C 2 31 30 2 67 2 Z";
const LEAF = "M 174 102 C 147 102 128 101 112 106 C 89 112 72 124 61 140 C 49 157 45 177 46 200 L 48 235 C 60 201 83 172 119 147 C 94 173 77 202 66 239 C 101 239 128 229 149 208 C 169 188 175 159 174 129 Z";

/** The Frameleaf symbol draws its outline, fills, then the wordmark fades in. */
function LogoIntro({ onSettled, children }) {
  const reduced = useReducedMotion();
  const root = useRef(null);
  useLayoutEffect(() => {
    const node = root.current;
    if (!node) return undefined;
    const strokes = node.querySelectorAll(".frs-logo-stroke");
    const fills = node.querySelectorAll(".frs-logo-fill");
    const after = node.querySelectorAll("[data-intro]");
    const running = [];
    if (reduced || !node.animate) {
      running.push(animate(node.querySelector("svg"), [{ opacity: 0 }, { opacity: 1 }], { duration: 400 }));
      after.forEach((el, index) =>
        running.push(animate(el, [{ opacity: 0 }, { opacity: 1 }], { duration: 400, delay: 300 + index * 150 })),
      );
    } else {
      strokes.forEach((path, index) =>
        running.push(
          animate(path, [{ strokeDashoffset: 1, opacity: 1 }, { strokeDashoffset: 0, opacity: 1 }, { strokeDashoffset: 0, opacity: 0 }], {
            duration: 2000,
            delay: index * 220,
            easing: "cubic-bezier(0.65, 0, 0.35, 1)",
          }),
        ),
      );
      fills.forEach((path, index) =>
        running.push(animate(path, [{ opacity: 0, transform: "scale(0.96)" }, { opacity: 1, transform: "none" }], { duration: 700, delay: 1300 + index * 120 })),
      );
      running.push(animate(node.querySelector(".frs-logo-glow"), [{ opacity: 0 }, { opacity: 1 }], { duration: 1600, delay: 900 }));
      after.forEach((el, index) =>
        running.push(
          animate(el, [{ opacity: 0, transform: "translateY(10px)" }, { opacity: 1, transform: "none" }], { duration: 700, delay: 1900 + index * 380 }),
        ),
      );
    }
    const last = running.filter(Boolean).at(-1);
    if (last) last.onfinish = () => onSettled?.();
    else onSettled?.();
    return () => running.forEach((item) => item?.cancel());
  }, [reduced]);
  return (
    <div className="frs-logo" ref={root}>
      <div className="frs-logo-mark">
        <span className="frs-logo-glow" aria-hidden="true" />
        <svg viewBox="-6 -6 268 268" role="img" aria-label="Frameleaf">
          <defs>
            <linearGradient id="frs-frame" gradientUnits="userSpaceOnUse" x1="15" y1="8" x2="226" y2="237">
              <stop offset="0" stopColor="#86f345" />
              <stop offset="0.25" stopColor="#36ec72" />
              <stop offset="0.57" stopColor="#00c4d6" />
              <stop offset="0.76" stopColor="#00c7b0" />
              <stop offset="1" stopColor="#00d874" />
            </linearGradient>
            <linearGradient id="frs-leaf" gradientUnits="userSpaceOnUse" x1="103" y1="101" x2="136" y2="240">
              <stop offset="0" stopColor="#56f260" />
              <stop offset="0.5" stopColor="#21de73" />
              <stop offset="1" stopColor="#00bc9e" />
            </linearGradient>
          </defs>
          <path className="frs-logo-fill" d={FRAME} fill="url(#frs-frame)" />
          <path className="frs-logo-fill" d={LEAF} fill="url(#frs-leaf)" />
          <circle className="frs-logo-fill" cx="172.5" cy="66.5" r="16.5" fill="url(#frs-frame)" />
          <path className="frs-logo-stroke" d={FRAME} pathLength="1" />
          <path className="frs-logo-stroke" d={LEAF} pathLength="1" />
        </svg>
      </div>
      <img data-intro className="frs-wordmark" src="/brand/frameleaf-logo-dark.svg" alt="" />
      {React.Children.map(children, (child) =>
        child ? React.cloneElement(child, { "data-intro": "" }) : child,
      )}
    </div>
  );
}

/** Slides the step in from the direction of travel; a plain fade when reduced. */
function StepTransition({ stepKey, direction, children }) {
  const reduced = useReducedMotion();
  const ref = useRef(null);
  useLayoutEffect(() => {
    const frames = reduced
      ? [{ opacity: 0 }, { opacity: 1 }]
      : [
          { opacity: 0, transform: `translateX(${direction * 36}px)` },
          { opacity: 1, transform: "none" },
        ];
    const run = animate(ref.current, frames, { duration: reduced ? 200 : 460 });
    return () => run?.cancel();
  }, [stepKey]);
  return (
    <div className="frs-step" ref={ref}>
      {children}
    </div>
  );
}

// ------------------------------------------------------------- shared pieces

function LanguagePicker({ value, onChange }) {
  const id = useId();
  return (
    <label className="frs-language" htmlFor={id}>
      <Icon name="mdiTranslate" size={16} />
      <span className="fl-sr-only">Language</span>
      <select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
        {languages.map((entry) => (
          <option key={entry.code} value={entry.code}>
            {entry.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function Recommended() {
  return (
    <span className="frs-recommended">
      <Icon name="mdiStarFourPoints" size={12} />
      Recommended
    </span>
  );
}

/** A large selectable card for plain two-way or three-way choices. */
function ChoiceCard({ name, value, checked, onChange, icon, title, recommended, children, disabled }) {
  return (
    <label className={`frs-choice ${checked ? "checked" : ""} ${disabled ? "disabled" : ""}`}>
      <input type="radio" name={name} value={value} checked={checked} disabled={disabled} onChange={() => onChange(value)} />
      <span className="frs-choice-head">
        {icon && (
          <span className="frs-choice-icon">
            {icon === "frameleaf" ? <img src="/brand/frameleaf-symbol.svg" alt="" width="22" height="22" /> : <Icon name={icon} size={22} />}
          </span>
        )}
        <strong>{title}</strong>
        {recommended && <Recommended />}
        <span className="frs-choice-mark" aria-hidden="true">
          <Icon name="mdiCheck" size={14} />
        </span>
      </span>
      <span className="frs-choice-body">{children}</span>
    </label>
  );
}

/** The "Change" disclosure every optional step keeps its alternatives in. */
function ChangeDisclosure({ summary, children, defaultOpen = false }) {
  return (
    <details className="frs-change" open={defaultOpen || undefined}>
      <summary>
        <span>{summary}</span>
        <span className="frs-change-link">
          Change
          <Icon name="mdiChevronDown" size={16} />
        </span>
      </summary>
      <div className="frs-change-body">{children}</div>
    </details>
  );
}

function Radio({ name, value, checked, onChange, title, detail, recommended }) {
  return (
    <label className={`frs-radio ${checked ? "checked" : ""}`}>
      <input type="radio" name={name} value={value} checked={checked} onChange={() => onChange(value)} />
      <span className="frs-radio-dot" aria-hidden="true" />
      <span>
        <strong>
          {title} {recommended && <Recommended />}
        </strong>
        {detail && <small>{detail}</small>}
      </span>
    </label>
  );
}

function Stat({ icon, value, label, format, delay }) {
  return (
    <div className="frs-stat">
      <Icon name={icon} size={20} />
      <strong>
        <CountUp value={value} format={format} delay={delay} />
      </strong>
      <span>{label}</span>
    </div>
  );
}

function Facts({ rows }) {
  return (
    <dl className="frs-facts">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function PreviewSwitch({ current, onPreview, onRestart }) {
  const items = [
    ["new", "New server"],
    ["existing", "Existing library"],
    ["account", "Account tool"],
  ];
  return (
    <nav className="frs-preview" aria-label="Preview setup flows">
      <span>Preview:</span>
      {items.map(([id, label]) => (
        <button key={id} type="button" className="auth-link" aria-current={current === id ? "page" : undefined} onClick={() => onPreview?.(id)}>
          {label}
        </button>
      ))}
      {onRestart && (
        <button type="button" className="auth-link" onClick={onRestart}>
          Start over
        </button>
      )}
    </nav>
  );
}

/** Simulated sign-in with Frameleaf: device code, approval, linked. */
function FrameleafLink({ linked, onLinked, compact }) {
  const [phase, setPhase] = useState(linked ? "linked" : "idle");
  const later = useTimer();
  useEffect(() => {
    if (linked) setPhase("linked");
  }, [linked]);
  if (phase === "linked")
    return (
      <div className="frs-linked" role="status">
        <span className="frs-linked-badge">
          <Icon name="mdiCheckDecagram" size={22} />
        </span>
        <div>
          <strong>Signed in as {SAMPLE_ACCOUNT.email}</strong>
          <span>This server is linked to your Frameleaf account.</span>
        </div>
      </div>
    );
  if (phase === "waiting")
    return (
      <div className="frs-device" role="status">
        <span className="frs-device-code" aria-label={`Code ${SAMPLE_USER_CODE}`}>
          {SAMPLE_USER_CODE}
        </span>
        <div>
          <strong>Approve this server on frameleaf.cloud</strong>
          <span>
            A new tab opened. Check the code matches, then approve. <span className="frs-dots" aria-hidden="true" />
          </span>
        </div>
        <button type="button" className="auth-link" onClick={() => setPhase("idle")}>
          Cancel
        </button>
      </div>
    );
  return (
    <Button
      className={`auth-frameleaf frs-frameleaf-button ${compact ? "compact" : ""}`}
      type="button"
      onClick={() => {
        setPhase("waiting");
        later(() => {
          saveCloudState(linkAccount(loadCloudState()));
          setPhase("linked");
          onLinked?.();
        }, 1800);
      }}
    >
      <img src="/brand/frameleaf-symbol.svg" alt="" width="18" height="18" />
      Sign in with Frameleaf
    </Button>
  );
}

// ----------------------------------------------------------- admin setup flow

export function FirstRunSetup({ flow = "new", onDone, onPreview, onOpenSettings, storage }) {
  const ids = useId();
  const [state, setState] = useState(() => loadSetup(flow, storage));
  const [secrets, setSecrets] = useState({ password: "", confirm: "" });
  const [errors, setErrors] = useState({});
  const [direction, setDirection] = useState(1);
  const [introReady, setIntroReady] = useState(false);
  const heading = useRef(null);
  const steps = flowSteps(state.flow);
  const current = steps[state.step];
  const { choices } = state;
  const linked = choices.linked;

  useEffect(() => {
    saveSetup(state, storage);
  }, [state, storage]);
  useEffect(() => {
    setErrors({});
    heading.current?.focus({ preventScroll: true });
  }, [state.step]);

  const choose = (patch) => setState((prev) => ({ ...prev, choices: { ...prev.choices, ...patch } }));
  const go = (target) => {
    const check = validateStep(state, current.id, secrets);
    if (target > state.step && !check.ok) return setErrors(check.errors);
    setDirection(target >= state.step ? 1 : -1);
    setState((prev) => goToStep(prev, target, secrets));
  };
  const next = () => go(state.step + 1);
  const restart = () => {
    clearSetup(storage);
    setSecrets({ password: "", confirm: "" });
    setIntroReady(false);
    setState(loadSetup(flow, storage));
  };
  const finish = () => {
    const done = { ...state, completed: true };
    setState(done);
    saveSetup(done, storage);
    onDone?.({ theme: themeAfterSetup(choices.theme), restore: choices.restore === "restore" && linked });
  };
  const footer = (
    <footer className="frs-foot">
      <span className="auth-note">Preview · sample data · progress is saved as you go</span>
      <PreviewSwitch current={state.flow} onPreview={onPreview} onRestart={restart} />
    </footer>
  );

  // -------------------------------------------------------------- full stages
  if (current.id === "admin-sign-in")
    return (
      <div className="frs frs-stage-screen">
        <div className="frs-stage">
          <div className="frs-gate">
            <img className="frs-gate-logo" src="/brand/frameleaf-logo-dark.svg" alt="Frameleaf" />
            <div className="frs-gate-note">
              <Icon name="mdiDatabaseCheckOutline" size={20} />
              <span>
                Frameleaf found your existing Immich library. Everyone else can keep using it while you finish
                setting up.
              </span>
            </div>
            <form
              className="auth-card frs-gate-card"
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                next();
              }}
            >
              <div className="auth-heading">
                <h1 ref={heading} tabIndex={-1}>
                  {current.title}
                </h1>
                <p>Sign in once with your admin password. There's nothing to register.</p>
              </div>
              {errors.password && <ErrorNote>{errors.password}</ErrorNote>}
              <TextField id={`${ids}-admin-email`} label="Admin email" value={SAMPLE_ACCOUNT.email} readOnly />
              <PasswordField
                id={`${ids}-admin-password`}
                label="Password"
                autoComplete="current-password"
                autoFocus
                value={secrets.password}
                onChange={(password) => setSecrets((prev) => ({ ...prev, password }))}
              />
              <Button primary className="auth-submit" type="submit">
                Sign in and continue
              </Button>
            </form>
          </div>
        </div>
        {footer}
      </div>
    );

  if (current.id === "welcome")
    return (
      <div className="frs frs-stage-screen" data-flow={state.flow}>
        <div className="frs-stage">
          <div className="frs-stage-corner">
            <LanguagePicker value={choices.language} onChange={(language) => choose({ language })} />
          </div>
          {state.flow === "new" ? (
            <LogoIntro key="new" onSettled={() => setIntroReady(true)}>
              <p className="frs-tagline">Your photos, beautifully kept. On your own server.</p>
              <Button primary className="frs-continue" onClick={next} data-ready={introReady || undefined}>
                Continue setup
                <Icon name="mdiArrowRight" size={16} />
              </Button>
            </LogoIntro>
          ) : (
            <LogoIntro key="existing" onSettled={() => setIntroReady(true)}>
              <p className="frs-tagline">Welcome to Frameleaf. Your library is safe.</p>
              <div className="frs-safe">
                <div className="frs-stats" aria-label="Your library">
                  <Stat icon="mdiImageMultipleOutline" value={existingLibrary.items} label="items" delay={2600} />
                  <Stat icon="mdiAccountMultipleOutline" value={existingLibrary.people} label="people" delay={2700} />
                  <Stat icon="mdiImageAlbum" value={existingLibrary.albums} label="albums" delay={2800} />
                  <Stat icon="mdiHarddisk" value={existingLibrary.bytes} label="of originals" format={formatTb} delay={2900} />
                </div>
                <p className="frs-safe-note">
                  <Icon name="mdiShieldCheckOutline" size={16} />
                  Every original, album, face and edit is exactly where it was. Nothing moves unless you say so.
                </p>
              </div>
              <div className="frs-whatsnew">
                {[
                  ["mdiMovieEditOutline", "Studio", "Edit photos and cut videos with the tools right beside your library."],
                  ["mdiShieldCheckOutline", "Library Care", "Find missing and damaged originals before they turn into gaps."],
                  ["mdiCloudOutline", "Frameleaf Cloud", "Optional remote access, backup and faster processing when you want it."],
                ].map(([icon, title, body]) => (
                  <article key={title}>
                    <Icon name={icon} size={22} />
                    <strong>{title}</strong>
                    <span>{body}</span>
                  </article>
                ))}
              </div>
              <Button primary className="frs-continue" onClick={next} data-ready={introReady || undefined}>
                Continue setup
                <Icon name="mdiArrowRight" size={16} />
              </Button>
            </LogoIntro>
          )}
        </div>
        {footer}
      </div>
    );

  // ------------------------------------------------------------- step bodies
  const body = () => {
    switch (current.id) {
      case "sign-in-choice":
        return (
          <>
            <div className="frs-choices two" role="radiogroup" aria-label="How you'll sign in">
              <ChoiceCard
                name={`${ids}-signin`}
                value="frameleaf"
                checked={choices.signIn === "frameleaf"}
                onChange={(signIn) => choose({ signIn })}
                icon="frameleaf"
                title="Frameleaf account"
                recommended
              >
                <ul className="frs-ticks">
                  <li>Reach your library away from home without port-forwarding</li>
                  <li>Sign in anywhere with one account</li>
                  <li>Cloud backup and faster processing when you want them</li>
                  <li>Carries your supporter licence</li>
                </ul>
                <small>Your photos still live on this server.</small>
              </ChoiceCard>
              <ChoiceCard
                name={`${ids}-signin`}
                value="local"
                checked={choices.signIn === "local"}
                onChange={(signIn) => choose({ signIn, linked: false })}
                icon="mdiServerOutline"
                title="Local account only"
              >
                <ul className="frs-ticks">
                  <li>Stored only on this server</li>
                  <li>Nothing leaves your network</li>
                  <li>Link a Frameleaf account later if you change your mind</li>
                </ul>
                <small>You'll create the admin with a name, email and password.</small>
              </ChoiceCard>
            </div>
          </>
        );
      case "account":
        if (state.flow === "existing")
          return (
            <>
              <div className="frs-choices two" role="radiogroup" aria-label="Your account">
                <ChoiceCard
                  name={`${ids}-keep`}
                  value="local"
                  checked={!linked && choices.signIn === "local"}
                  onChange={() => choose({ signIn: "local" })}
                  icon="mdiAccountOutline"
                  title="Keep your local admin"
                  recommended
                >
                  <span>Sign in exactly as you do today. You can link a Frameleaf account later in Settings.</span>
                </ChoiceCard>
                <ChoiceCard
                  name={`${ids}-keep`}
                  value="frameleaf"
                  checked={choices.signIn === "frameleaf" || linked}
                  onChange={() => choose({ signIn: "frameleaf" })}
                  icon="frameleaf"
                  title="Link a Frameleaf account"
                >
                  <span>Adds remote access, Cloud backup and Cloud processing to this server and admin.</span>
                </ChoiceCard>
              </div>
              {(choices.signIn === "frameleaf" || linked) && (
                <FrameleafLink linked={linked} onLinked={() => choose({ linked: true })} />
              )}
            </>
          );
        return choices.signIn === "frameleaf" ? (
          <>
            <p className="frs-lead">
              Sign in with your Frameleaf account and approve this server. You'll use the same account to sign in
              here from now on.
            </p>
            {errors.link && <ErrorNote>{errors.link}</ErrorNote>}
            <FrameleafLink linked={linked} onLinked={() => choose({ linked: true })} />
            {linked && (
              <section className="frs-found" aria-labelledby={`${ids}-found`}>
                <header>
                  <span className="frs-found-icon">
                    <Icon name="mdiCloudCheckOutline" size={26} />
                  </span>
                  <div>
                    <h2 id={`${ids}-found`}>We found a backup</h2>
                    <p>Your account has a Cloud backup from another server.</p>
                  </div>
                </header>
                <div className="frs-found-strip" aria-hidden="true">
                  {[0, 1, 2, 3, 4].map((index) => (
                    <img key={index} src={photo(index + 3)} alt="" />
                  ))}
                </div>
                <Facts
                  rows={[
                    ["Server", foundBackup.server],
                    ["Last backup", when(foundBackup.date)],
                    ["Items", formatCount(foundBackup.items)],
                    ["Size", formatTb(foundBackup.bytes)],
                    ["Database backup", `${when(foundBackup.database.date)} · paired`],
                  ]}
                />
                <div className="frs-choices two" role="radiogroup" aria-label="Backup">
                  <ChoiceCard
                    name={`${ids}-restore`}
                    value="restore"
                    checked={choices.restore === "restore"}
                    onChange={(restore) => choose({ restore })}
                    icon="mdiBackupRestore"
                    title="Restore this backup"
                  >
                    <span>
                      After setup, the whole library comes back from Frameleaf Cloud › Cloud backup › Restore. Every
                      file is checked before it's added.
                    </span>
                  </ChoiceCard>
                  <ChoiceCard
                    name={`${ids}-restore`}
                    value="fresh"
                    checked={choices.restore === "fresh"}
                    onChange={(restore) => choose({ restore })}
                    icon="mdiSprout"
                    title="Start fresh"
                  >
                    <span>Keep the backup untouched in Frameleaf Cloud and start with an empty library.</span>
                  </ChoiceCard>
                </div>
              </section>
            )}
          </>
        ) : (
          <div className="frs-form">
            <TextField
              id={`${ids}-name`}
              label="Name"
              autoComplete="name"
              value={choices.admin.name}
              aria-invalid={errors.name ? true : undefined}
              onChange={(event) => choose({ admin: { ...choices.admin, name: event.target.value } })}
            />
            {errors.name && <ErrorNote>{errors.name}</ErrorNote>}
            <TextField
              id={`${ids}-email`}
              label="Email"
              type="email"
              autoComplete="username"
              value={choices.admin.email}
              aria-invalid={errors.email ? true : undefined}
              onChange={(event) => choose({ admin: { ...choices.admin, email: event.target.value } })}
            />
            {errors.email && <ErrorNote>{errors.email}</ErrorNote>}
            <PasswordField
              id={`${ids}-password`}
              label="Password"
              autoComplete="new-password"
              value={secrets.password}
              onChange={(password) => setSecrets((prev) => ({ ...prev, password }))}
              describedBy={`${ids}-strength`}
            />
            <div id={`${ids}-strength`}>
              <StrengthMeter password={secrets.password} />
            </div>
            <Checklist password={secrets.password} />
            {errors.password && <ErrorNote>{errors.password}</ErrorNote>}
            <PasswordField
              id={`${ids}-confirm`}
              label="Confirm password"
              autoComplete="new-password"
              value={secrets.confirm}
              onChange={(confirm) => setSecrets((prev) => ({ ...prev, confirm }))}
            />
            {errors.confirm && <ErrorNote>{errors.confirm}</ErrorNote>}
            <p className="auth-note">Your password stays on this server and isn't saved with your setup progress.</p>
          </div>
        );
      case "library":
        return <LibraryStep state={state} choose={choose} errors={errors} ids={ids} />;
      case "library-check":
        return (
          <>
            <div className="frs-health">
              <div className="frs-health-ring" aria-hidden="true">
                <Icon name="mdiShieldCheck" size={34} />
              </div>
              <div>
                <strong>
                  <CountUp value={existingLibrary.items - existingLibrary.missing - existingLibrary.damaged} /> of{" "}
                  {formatCount(existingLibrary.items)} items look healthy
                </strong>
                <span>A quick scan of file records. The full check runs in the background after setup.</span>
              </div>
            </div>
            <div className="frs-health-grid">
              <a className="frs-health-card warn" href="/?screen=admin&settings=utilities&section=missing-media">
                <Icon name="mdiFolderSearchOutline" size={20} />
                <strong>
                  <CountUp value={existingLibrary.missing} duration={900} />
                </strong>
                <span>missing originals</span>
                <small>Review in Library Care</small>
              </a>
              <a className="frs-health-card warn" href="/?screen=admin&settings=utilities&section=corrupt-media">
                <Icon name="mdiImageBrokenVariant" size={20} />
                <strong>
                  <CountUp value={existingLibrary.damaged} duration={900} />
                </strong>
                <span>damaged files</span>
                <small>Review in Library Care</small>
              </a>
            </div>
            <ChangeDisclosure
              summary={
                <>
                  <strong>Keep your current folder layout</strong>
                  <code>{examplePath(KEEP_LAYOUT)}</code>
                </>
              }
            >
              <div className="frs-warning">
                <Icon name="mdiAlertOutline" size={18} />
                <span>
                  Changing the layout moves every original into new folders. It runs as a background job and can take
                  hours on a large library.
                </span>
              </div>
              <LayoutChoices state={state} choose={choose} ids={ids} withKeep />
            </ChangeDisclosure>
          </>
        );
      case "processing":
        return <ProcessingStep state={state} choose={choose} ids={ids} />;
      case "protection":
        return <ProtectionStep state={state} choose={choose} ids={ids} onOpenSettings={onOpenSettings} />;
      case "privacy":
        return (
          <>
            <div className="frs-switches">
              <SwitchRow
                label="Check for Frameleaf updates"
                description="Asks GitHub once a day whether a new Frameleaf release is out. Nothing about your library is sent."
                checked={choices.privacy.updates}
                onChange={(updates) => choose({ privacy: { ...choices.privacy, updates } })}
              />
              <SwitchRow
                label="Map tiles"
                description="Loads map images so photos can be shown on the map. The tile server sees which areas you view."
                checked={choices.privacy.map}
                onChange={(map) => choose({ privacy: { ...choices.privacy, map } })}
              />
              {linked && (
                <SwitchRow
                  label="Remote access"
                  description="Lets you reach this server through Frameleaf without opening ports. Traffic is end-to-end encrypted."
                  checked={choices.privacy.remote}
                  onChange={(remote) => choose({ privacy: { ...choices.privacy, remote } })}
                />
              )}
            </div>
            {state.flow === "existing" && (
              <p className="frs-quiet">
                <Icon name="mdiShieldLockOutline" size={16} />
                Immich's own external calls, like its version check, stay off.
              </p>
            )}
          </>
        );
      case "people":
        return <PeoplePreview />;
      case "imports":
        return <ImportShowcase />;
      case "ready":
        return <ReadyStep state={state} choose={choose} ids={ids} onOpenSettings={onOpenSettings} />;
      default:
        return null;
    }
  };

  const chapterAt = chapterIndex(current.chapter);
  const recommendedSteps = ["sign-in-choice", "processing", "protection", "privacy", "library-check"];
  const usesRecommended =
    recommendedSteps.includes(current.id) ||
    (current.id === "account" && state.flow === "existing" && !linked && choices.signIn === "local");
  const isRecommendedChoice =
    (current.id === "sign-in-choice" && choices.signIn === "frameleaf") ||
    (current.id === "library-check" && choices.layout === KEEP_LAYOUT) ||
    (current.id === "account" && state.flow === "existing") ||
    (current.id === "processing" && choices.processing === "local" && choices.model === "balanced") ||
    (current.id === "protection" && choices.nightlyBackup && (!linked || (choices.cloudBackup === "on" && choices.keyMode === "server"))) ||
    current.id === "privacy";
  const last = state.step === steps.length - 1;
  const blocked = !validateStep(state, current.id, secrets).ok;

  return (
    <div className="frs frs-flow" data-flow={state.flow} onKeyDown={(event) => {
      if (event.altKey && event.key === "ArrowLeft") go(state.step - 1);
    }}>
      <aside className="frs-rail">
        <img className="frs-rail-logo" src="/brand/frameleaf-logo-dark.svg" alt="Frameleaf" />
        <nav aria-label="Setup chapters">
          <ol style={{ "--frs-progress": chapterAt / (setupChapters.length - 1) }}>
            {setupChapters.map((chapter, position) => {
              const first = steps.findIndex((entry) => entry.chapter === chapter.id);
              const reachable = first >= 0 && first <= state.reached;
              const status = position < chapterAt ? "done" : position === chapterAt ? "current" : "todo";
              return (
                <li key={chapter.id} data-status={status}>
                  <button
                    type="button"
                    aria-current={status === "current" ? "step" : undefined}
                    disabled={!reachable || status === "current"}
                    onClick={() => go(first)}
                  >
                    <span className="frs-rail-dot" aria-hidden="true">
                      {status === "done" ? <Icon name="mdiCheck" size={13} /> : position + 1}
                    </span>
                    <span>{chapter.label}</span>
                  </button>
                  {status === "current" && (
                    <ul>
                      {steps
                        .filter((entry) => entry.chapter === chapter.id && entry.id !== "welcome" && entry.id !== "admin-sign-in")
                        .map((entry) => (
                          <li key={entry.id} aria-current={entry.id === current.id ? "true" : undefined}>
                            {entry.title}
                          </li>
                        ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ol>
        </nav>
        <LanguagePicker value={choices.language} onChange={(language) => choose({ language })} />
      </aside>
      <main className="frs-main">
        <StepTransition stepKey={current.id} direction={direction}>
          <header className="frs-head">
            <span className="frs-eyebrow">
              {setupChapters[chapterAt].label} · step {state.step + 1} of {steps.length}
            </span>
            <h1 ref={heading} tabIndex={-1}>
              {current.id === "account" && state.flow === "new" && choices.signIn === "local"
                ? "Create the admin account"
                : current.id === "account" && state.flow === "new"
                  ? "Sign in with Frameleaf"
                  : current.title}
            </h1>
            {current.required && <span className="frs-required">Required</span>}
          </header>
          <div className="frs-body">{body()}</div>
        </StepTransition>
        <div className="frs-nav">
          <Button icon="mdiArrowLeft" type="button" onClick={() => go(state.step - 1)} disabled={state.step === 0}>
            Back
          </Button>
          <div>
            {last ? (
              <Button primary type="button" className="frs-open" onClick={finish}>
                Open Frameleaf
                <Icon name="mdiArrowRight" size={16} />
              </Button>
            ) : (
              <Button primary type="button" onClick={next} aria-disabled={blocked || undefined}>
                {usesRecommended && isRecommendedChoice ? "Use recommended" : "Continue"}
                <Icon name="mdiArrowRight" size={16} />
              </Button>
            )}
          </div>
        </div>
        {footer}
      </main>
    </div>
  );
}

// -------------------------------------------------------------- step views

function LayoutChoices({ state, choose, ids, withKeep }) {
  return (
    <div className="frs-radios" role="radiogroup" aria-label="Folder layout">
      {withKeep && (
        <Radio
          name={`${ids}-layout`}
          value={KEEP_LAYOUT}
          checked={state.choices.layout === KEEP_LAYOUT}
          onChange={(layout) => choose({ layout })}
          title="Keep your current folder layout"
          detail={examplePath(KEEP_LAYOUT)}
          recommended
        />
      )}
      {layoutPresets.map((preset) => (
        <Radio
          key={preset.id}
          name={`${ids}-layout`}
          value={preset.id}
          checked={state.choices.layout === preset.id}
          onChange={(layout) => choose({ layout })}
          title={preset.label}
          detail={examplePath(preset.id)}
          recommended={!withKeep && preset.recommended}
        />
      ))}
    </div>
  );
}

function LibraryStep({ state, choose, errors, ids }) {
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState(() => checkStorage(state.choices.storage));
  const later = useTimer();
  useEffect(() => {
    setChecking(true);
    later(() => {
      setResult(checkStorage(state.choices.storage));
      setChecking(false);
    }, 450);
  }, [state.choices.storage]);
  const preset = layoutPresets.find((entry) => entry.id === state.choices.layout) ?? layoutPresets[0];
  const path = examplePath(state.choices.layout);
  const [base, ...rest] = path.split("/");
  return (
    <>
      <section className="frs-panel">
        <div className="auth-field">
          <label htmlFor={`${ids}-storage`}>Storage location</label>
          <div className="frs-storage">
            <Icon name="mdiFolderOutline" size={18} />
            <input
              id={`${ids}-storage`}
              value={state.choices.storage}
              spellCheck={false}
              aria-describedby={`${ids}-storage-check`}
              aria-invalid={result.status === "error" || errors.storage ? true : undefined}
              onChange={(event) => choose({ storage: event.target.value })}
            />
          </div>
        </div>
        <p id={`${ids}-storage-check`} className="frs-check" data-status={checking ? "checking" : result.status} aria-live="polite">
          <Icon
            name={checking ? "mdiLoading" : result.status === "ok" ? "mdiCheckCircle" : "mdiAlertCircleOutline"}
            size={16}
            className={checking ? "frs-spin" : undefined}
          />
          {checking ? "Checking…" : result.message}
        </p>
        {errors.storage && !checking && result.status !== "ok" && <ErrorNote>{errors.storage}</ErrorNote>}
      </section>
      <ChangeDisclosure
        summary={
          <>
            <strong>
              Folder layout: {preset.label} {preset.recommended && <Recommended />}
            </strong>
            <span className="frs-path" aria-label={`Example: ${path}`}>
              <span>{base}/</span>
              {rest.map((part, index) => (
                <span key={`${part}-${index}`} style={{ animationDelay: `${index * 80}ms` }}>
                  {part}
                  {index < rest.length - 1 ? "/" : ""}
                </span>
              ))}
            </span>
          </>
        }
      >
        <LayoutChoices state={state} choose={choose} ids={ids} />
      </ChangeDisclosure>
    </>
  );
}

function ProcessingStep({ state, choose, ids }) {
  const { choices } = state;
  const tier = modelTiers.find((entry) => entry.id === choices.model);
  const options = processingOptions(state);
  const existing = state.flow === "existing";
  const hours = reindexHours(existingLibrary.items, choices.model);
  const cloud = cloudReindexEstimate(existingLibrary.items);
  return (
    <>
      <section className="frs-hardware" aria-label="Detected hardware">
        <header>
          <Icon name="mdiChip" size={20} />
          <strong>Detected on this server</strong>
          <span className="frs-ok">
            <Icon name="mdiCheckCircle" size={14} /> GPU ready
          </span>
        </header>
        <Facts
          rows={[
            ["Processor", detectedHardware.cpu],
            ["Memory", detectedHardware.memory],
            ["GPU", detectedHardware.gpu],
          ]}
        />
      </section>
      <ChangeDisclosure
        summary={
          <>
            <strong>
              {tier.label} models {tier.recommended && <Recommended />}
            </strong>
            <span>{tier.summary}</span>
          </>
        }
      >
        <div className="frs-radios" role="radiogroup" aria-label="Model tier">
          {modelTiers.map((entry) => (
            <Radio
              key={entry.id}
              name={`${ids}-tier`}
              value={entry.id}
              checked={choices.model === entry.id}
              onChange={(model) => choose({ model })}
              title={`${entry.label} models`}
              detail={entry.summary}
              recommended={entry.recommended}
            />
          ))}
        </div>
      </ChangeDisclosure>
      {existing && (
        <p className="frs-estimate">
          <Icon name="mdiTimerSandComplete" size={18} />
          <span>
            Re-indexing {formatCount(existingLibrary.items)} items takes about <strong>{hours} h</strong> on this server.
            Your library stays usable the whole time.
          </span>
        </p>
      )}
      <div className={`frs-choices ${existing ? "three" : "two"}`} role="radiogroup" aria-label="Where processing runs">
        <ChoiceCard
          name={`${ids}-where`}
          value="local"
          checked={choices.processing === "local"}
          onChange={(processing) => choose({ processing })}
          icon="mdiServerOutline"
          title={existing ? "On this server" : "Local only"}
          recommended
        >
          <span>{existing ? `About ${hours} h. Free, and nothing leaves your network.` : "Everything runs here. Nothing leaves your network."}</span>
        </ChoiceCard>
        <ChoiceCard
          name={`${ids}-where`}
          value="cloud"
          checked={choices.processing === "cloud"}
          onChange={(processing) => choose({ processing })}
          icon="mdiCloudOutline"
          title={existing ? "Frameleaf Cloud GPUs" : "Local plus Frameleaf Cloud"}
          disabled={!options.includes("cloud")}
        >
          {options.includes("cloud") ? (
            <span>
              {existing
                ? `About ${cloud.minutes} min for ${formatUsd(cloud.cost)} USD. You confirm the price before it starts.`
                : "Heavy jobs can use Cloud GPUs. You confirm each one and its price first."}
            </span>
          ) : (
            <span>
              {existing ? `About ${cloud.minutes} min for ${formatUsd(cloud.cost)} USD. ` : ""}Link a Frameleaf account to use
              Cloud GPUs.
            </span>
          )}
        </ChoiceCard>
        {existing && (
          <ChoiceCard
            name={`${ids}-where`}
            value="later"
            checked={choices.processing === "later"}
            onChange={(processing) => choose({ processing })}
            icon="mdiClockOutline"
            title="Decide later"
          >
            <span>Keep the current results. Queue the new models from Settings when it suits you.</span>
          </ChoiceCard>
        )}
      </div>
      {existing && <p className="auth-note">Jobs are queued when you finish setup, not before.</p>}
    </>
  );
}

function ProtectionStep({ state, choose, ids }) {
  const { choices } = state;
  const linked = choices.linked;
  const bytes = state.flow === "existing" ? existingLibrary.bytes : 0.2e12;
  const mode = keyModes.find((entry) => entry.id === choices.keyMode);
  return (
    <>
      <div className="frs-switches">
        <SwitchRow
          label="Nightly database backups"
          description={
            state.flow === "existing"
              ? "On. Last backup 2:00 AM today, 14 kept. Albums, people and edits can always be rebuilt."
              : "Every night at 2:00 AM, 14 kept. Protects albums, people and edits."
          }
          checked={choices.nightlyBackup}
          onChange={(nightlyBackup) => choose({ nightlyBackup })}
        />
      </div>
      {linked ? (
        <section className="frs-cloud-backup">
          <header>
            <span className="frs-found-icon">
              <Icon name="mdiCloudLockOutline" size={24} />
            </span>
            <div>
              <h2>Cloud backup</h2>
              <p>An encrypted copy of your originals in a bucket that belongs to this server alone.</p>
            </div>
            <div className="frs-price">
              <strong>{formatUsd(CLOUD_BACKUP_PER_TB)}</strong>
              <span>USD per TB a month</span>
            </div>
          </header>
          <p className="frs-estimate">
            <Icon name="mdiCalculatorVariantOutline" size={18} />
            <span>
              {state.flow === "existing"
                ? `${cloudBackupQuote(bytes)}.`
                : `Billed on what you store, 1 TB minimum: ${formatUsd(cloudBackupMonthly(bytes))} a month to start.`}
            </span>
          </p>
          <div className="frs-choices two" role="radiogroup" aria-label="Cloud backup">
            <ChoiceCard name={`${ids}-cb`} value="on" checked={choices.cloudBackup === "on"} onChange={(cloudBackup) => choose({ cloudBackup })} icon="mdiCloudUploadOutline" title="Turn on cloud backup" recommended>
              <span>First upload starts tonight. Cancel any time.</span>
            </ChoiceCard>
            <ChoiceCard name={`${ids}-cb`} value="later" checked={choices.cloudBackup === "later"} onChange={(cloudBackup) => choose({ cloudBackup })} icon="mdiBellOutline" title="Remind me later">
              <span>We'll remind you in Activity next week.</span>
            </ChoiceCard>
          </div>
          {choices.cloudBackup === "on" && (
            <ChangeDisclosure
              summary={
                <>
                  <strong>
                    Key: {mode.label} {mode.recommended && <Recommended />}
                  </strong>
                  <span>{mode.summary}</span>
                </>
              }
            >
              <div className="frs-radios" role="radiogroup" aria-label="Key mode">
                {keyModes.map((entry) => (
                  <Radio key={entry.id} name={`${ids}-key`} value={entry.id} checked={choices.keyMode === entry.id} onChange={(keyMode) => choose({ keyMode })} title={entry.label} detail={entry.summary} recommended={entry.recommended} />
                ))}
              </div>
            </ChangeDisclosure>
          )}
        </section>
      ) : (
        <p className="frs-quiet">
          <Icon name="mdiInformationOutline" size={16} />
          Cloud backup needs a Frameleaf account. Link one later from Settings › Frameleaf Cloud.
        </p>
      )}
    </>
  );
}

function PeoplePreview() {
  const users = [
    ["Jamie", "/media/avatar-jamie.png"],
    ["Robin", null],
    ["Sam", null],
  ];
  return (
    <>
      <p className="frs-lead">
        The other {existingLibrary.users - 1} people on this server don't see setup. Next time they sign in, they get a
        short “Set up your account” page they can finish in any order, or skip.
      </p>
      <div className="frs-people">
        <ul className="frs-people-list">
          {users.map(([name, image]) => (
            <li key={name}>
              {image ? <img src={image} alt="" /> : <span className="frs-avatar">{name[0]}</span>}
              <div>
                <strong>{name}</strong>
                <span>Keeps using the library as today</span>
              </div>
            </li>
          ))}
        </ul>
        <div className="frs-people-preview" aria-label="What they'll see">
          <span className="frs-eyebrow">What they'll see</span>
          <strong>Set up your account</strong>
          {accountToolSections.map((section) => (
            <span key={section.id}>
              <Icon name={section.icon} size={16} />
              {section.title}
            </span>
          ))}
        </div>
      </div>
    </>
  );
}

function ImportShowcase() {
  const sources = [
    {
      id: "google",
      title: "Google Photos",
      via: "with Google Takeout",
      icon: "mdiGoogle",
      body: "Bring in a Takeout export with albums, dates, places and descriptions intact. Photos you already have join their albums instead of being copied twice.",
      where: "Later, from Settings › Import & protection › Google Photos & server imports",
      href: "/?screen=admin&settings=backup&section=takeout",
    },
    {
      id: "icloud",
      title: "iCloud Photos",
      via: "with a connection you control",
      icon: "mdiApple",
      body: "Connect iCloud Photos, choose the albums, and keep them in sync on a schedule. Live Photos stay paired.",
      where: "Later, from Utilities › iCloud Photos",
      href: "/?screen=admin&settings=utilities&section=icloud",
    },
  ];
  return (
    <>
      <p className="frs-lead">
        Moving over from another service? Frameleaf can bring your whole history across when you're ready. Nothing
        starts during setup.
      </p>
      <div className="frs-imports">
        {sources.map((source, index) => (
          <article key={source.id} className={`frs-import ${source.id}`}>
            <div className="frs-import-art" aria-hidden="true">
              {[0, 1, 2, 3, 4, 5].map((tile) => (
                <img key={tile} src={photo(index * 6 + tile)} alt="" style={{ "--i": tile }} />
              ))}
              <span className="frs-import-badge">
                <Icon name={source.icon} size={26} />
              </span>
              <span className="frs-import-arrow">
                <Icon name="mdiArrowRightThin" size={28} />
              </span>
              <span className="frs-import-target">
                <img src="/brand/frameleaf-symbol.svg" alt="" />
              </span>
            </div>
            <div className="frs-import-copy">
              <h2>
                {source.title} <small>{source.via}</small>
              </h2>
              <p>{source.body}</p>
              <a className="frs-later" href={source.href}>
                <Icon name="mdiClockOutline" size={14} />
                {source.where}
              </a>
            </div>
          </article>
        ))}
      </div>
    </>
  );
}

function ReadyStep({ state, choose, ids, onOpenSettings }) {
  const reduced = useReducedMotion();
  const rows = setupSummary(state);
  const jobs = queuedJobs(state);
  const listRef = useRef(null);
  useLayoutEffect(() => {
    const items = listRef.current?.querySelectorAll("li") ?? [];
    const running = [...items].map((item, index) =>
      animate(item, reduced ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "none" }], {
        duration: reduced ? 200 : 420,
        delay: 120 + index * 170,
      }),
    );
    return () => running.forEach((run) => run?.cancel());
  }, [reduced]);
  const restore = state.choices.restore === "restore" && state.choices.linked;
  return (
    <>
      <ul className="frs-ready" ref={listRef}>
        {rows.map(([label, value]) => (
          <li key={label}>
            <span className="frs-ready-check">
              <Icon name="mdiCheck" size={14} />
            </span>
            <span>{label}</span>
            <strong>{value}</strong>
          </li>
        ))}
      </ul>
      {restore && (
        <div className="frs-handoff">
          <Icon name="mdiBackupRestore" size={20} />
          <span>
            Next: restore {formatCount(foundBackup.items)} items from {foundBackup.server}. Opening Frameleaf takes you
            to Frameleaf Cloud › Cloud backup › Restore.
          </span>
        </div>
      )}
      <section className="frs-jobs" aria-label="Queued jobs">
        {jobs.length ? (
          jobs.map((job) => (
            <div key={job.id}>
              <span className="frs-pulse" aria-hidden="true" />
              <strong>{job.label}</strong>
              <span>{job.detail}</span>
            </div>
          ))
        ) : (
          <div>
            <strong>No jobs queued</strong>
            <span>Queue the new models from Settings when it suits you.</span>
          </div>
        )}
        <button type="button" className="auth-link" onClick={() => onOpenSettings?.("activity")}>
          Follow them in Activity
        </button>
      </section>
      <div className="frs-theme" role="radiogroup" aria-label="Theme after setup">
        <span>Theme after setup</span>
        {[
          ["dark", "Dark", "mdiMoonWaningCrescent"],
          ["light", "Light", "mdiWhiteBalanceSunny"],
        ].map(([value, label, icon]) => (
          <label key={value} className={state.choices.theme === value ? "checked" : ""}>
            <input type="radio" name={`${ids}-theme`} value={value} checked={state.choices.theme === value} onChange={() => choose({ theme: value })} />
            <Icon name={icon} size={16} />
            {label}
          </label>
        ))}
      </div>
    </>
  );
}

// ------------------------------------------------------ personal account tool

export function AccountSetupTool({ user, onDone, onPreview, storage }) {
  const ids = useId();
  const [state, setState] = useState(() => loadAccountTool(storage));
  const [name, setName] = useState(user?.name ?? "Jamie");
  const [avatar, setAvatar] = useState(0);
  useEffect(() => {
    saveAccountTool(state, storage);
  }, [state, storage]);
  const progress = accountToolProgress(state);
  const done = (id) => setState((prev) => markSection(prev, id));
  const isDone = (id) => state.done.includes(id);
  const avatars = ["/media/avatar-jamie.png", photo(2), photo(5), photo(8)];
  const section = (id, children, action = "Save") => {
    const meta = accountToolSections.find((entry) => entry.id === id);
    return (
      <section className={`frs-tool-card ${isDone(id) ? "done" : ""}`} aria-labelledby={`${ids}-${id}`} data-section={id}>
        <header>
          <Icon name={meta.icon} size={20} />
          <h2 id={`${ids}-${id}`}>{meta.title}</h2>
          {isDone(id) && (
            <span className="frs-done-chip">
              <Icon name="mdiCheck" size={12} /> Done
            </span>
          )}
        </header>
        <div className="frs-tool-body">{children}</div>
        {action && (
          <footer>
            <Button type="button" onClick={() => done(id)} disabled={isDone(id)}>
              {isDone(id) ? "Saved" : action}
            </Button>
          </footer>
        )}
      </section>
    );
  };
  return (
    <div className="frs frs-tool-screen">
    <div className="frs-tool">
      <header className="frs-tool-head">
        <img src="/brand/frameleaf-logo-dark.svg" alt="Frameleaf" />
        <div>
          <h1>Set up your account</h1>
          <p>A few things that make Frameleaf yours. Do them in any order, or skip what you don't need.</p>
        </div>
        <div className="frs-tool-progress" aria-label={`${progress.done} of ${progress.total} done`}>
          <svg viewBox="0 0 36 36" aria-hidden="true">
            <circle cx="18" cy="18" r="15.5" />
            <circle cx="18" cy="18" r="15.5" pathLength="1" style={{ strokeDashoffset: 1 - progress.done / progress.total }} />
          </svg>
          <span>
            {progress.done}/{progress.total}
          </span>
        </div>
      </header>

      <section className={`frs-link-card ${state.linked ? "linked" : ""}`} aria-labelledby={`${ids}-frameleaf`}>
        <div className="frs-link-art" aria-hidden="true">
          <img src="/brand/frameleaf-symbol.svg" alt="" />
        </div>
        <div className="frs-link-copy">
          <span className="frs-eyebrow">Recommended</span>
          <h2 id={`${ids}-frameleaf`}>Link your Frameleaf account</h2>
          <ul className="frs-ticks">
            <li>Sign in to this server from anywhere with one account</li>
            <li>Carry your supporter badge across servers</li>
            <li>Use Frameleaf Cloud features your admin turns on</li>
          </ul>
          <small>Your photos stay on this server. You can unlink any time in Account settings.</small>
        </div>
        <div className="frs-link-action">
          <FrameleafLink
            compact
            linked={state.linked}
            onLinked={() => setState((prev) => markSection({ ...prev, linked: true }, "frameleaf"))}
          />
        </div>
      </section>

      <div className="frs-tool-grid">
        {section(
          "profile",
          <>
            <div className="frs-avatars" role="radiogroup" aria-label="Avatar">
              {avatars.map((src, index) => (
                <label key={index} className={avatar === index ? "checked" : ""}>
                  <input type="radio" name={`${ids}-avatar`} checked={avatar === index} onChange={() => setAvatar(index)} />
                  <img src={src} alt={`Avatar ${index + 1}`} />
                </label>
              ))}
            </div>
            <TextField id={`${ids}-profile-name`} label="Display name" value={name} onChange={(event) => setName(event.target.value)} />
          </>,
        )}
        {section(
          "appearance",
          <>
            <div className="frs-theme" role="radiogroup" aria-label="Theme">
              <span>Theme</span>
              {[
                ["dark", "Dark", "mdiMoonWaningCrescent"],
                ["light", "Light", "mdiWhiteBalanceSunny"],
              ].map(([value, label, icon]) => (
                <label key={value} className={state.theme === value ? "checked" : ""}>
                  <input type="radio" name={`${ids}-tool-theme`} checked={state.theme === value} onChange={() => setState((prev) => ({ ...prev, theme: value }))} />
                  <Icon name={icon} size={16} />
                  {label}
                </label>
              ))}
            </div>
            <p className="auth-note">Applies when you close this page.</p>
            <div className="auth-field">
              <label htmlFor={`${ids}-tool-language`}>Language</label>
              <select id={`${ids}-tool-language`} value={state.language} onChange={(event) => setState((prev) => ({ ...prev, language: event.target.value }))}>
                {languages.map((entry) => (
                  <option key={entry.code} value={entry.code}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </div>
          </>,
        )}
        {section(
          "privacy",
          <div className="frs-switches compact">
            <SwitchRow label="Shared album activity" description="When someone adds to an album you're in." checked={state.notifications.albums} onChange={(albums) => setState((prev) => ({ ...prev, notifications: { ...prev.notifications, albums } }))} />
            <SwitchRow label="Memories" description="“On this day” in your library." checked={state.notifications.memories} onChange={(memories) => setState((prev) => ({ ...prev, notifications: { ...prev.notifications, memories } }))} />
            <SwitchRow label="Email notifications" description="A copy of the above by email." checked={state.notifications.email} onChange={(email) => setState((prev) => ({ ...prev, notifications: { ...prev.notifications, email } }))} />
            <SwitchRow label="Show locations to people I share with" description="Turn off to strip places from shared photos." checked={state.sharedLocation} onChange={(sharedLocation) => setState((prev) => ({ ...prev, sharedLocation }))} />
          </div>,
        )}
        {section(
          "mobile",
          <div className="frs-mobile">
            <QrCode value="https://photos.example.test/app?server=taylor-nas" size={132} label="QR code for the mobile app" showActions={false} />
            <div>
              <strong>Back up your phone</strong>
              <span>Scan with your phone's camera to get the app and sign in to this server in one go.</span>
            </div>
          </div>,
          "I've got the app",
        )}
      </div>

      <footer className="frs-tool-foot">
        <span className="auth-note">You can reopen this page from the account menu › Set up your account.</span>
        <PreviewSwitch current="account" onPreview={onPreview} onRestart={() => setState(loadAccountTool({ getItem: () => null }))} />
        <Button
          primary
          type="button"
          onClick={() => {
            const next = { ...state, completed: true };
            saveAccountTool(next, storage);
            onDone?.({ theme: themeAfterSetup(state.theme) });
          }}
        >
          Done
        </Button>
      </footer>
    </div>
    </div>
  );
}
