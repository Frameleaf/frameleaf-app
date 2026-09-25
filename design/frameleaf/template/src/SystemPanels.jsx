import React, { useEffect, useId, useRef, useState } from "react";
import { Icon } from "./Icon";
import { Button, Dialog } from "./App";
import { media } from "./media";
import {
  aboutInfo,
  checkForUpdates,
  dismissNotification,
  markAllRead,
  markRead,
  notificationTypes,
  relativeTime,
  sortNotifications,
  unreadCount,
  versionHistory,
} from "./system-data.mjs";
import { useCloudState } from "./CloudJobDialog";
import { formatUsd, walletAvailable } from "./frameleaf-cloud-data.mjs";
import "./system.css";

const SYMBOL = "/brand/frameleaf-symbol.svg";
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

// --------------------------------------------------------------------- shared

/** Escape, outside pointer, and focus restore for anchored popovers. Pointer
 * events on the currently expanded trigger are ignored so a toggle button can
 * close its own popover without reopening it. */
function usePopover(ref, onClose) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement;
    const onKey = (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close.current?.();
      }
    };
    const onPointer = (event) => {
      if (!ref.current || ref.current.contains(event.target)) return;
      if (event.target.closest?.('[aria-expanded="true"]')) return;
      close.current?.();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
      if (previous?.isConnected) previous.focus();
    };
  }, [ref]);
}
const menuItems = (container) =>
  Array.from(
    container?.querySelectorAll('[role^="menuitem"]:not([aria-disabled="true"])') ??
      [],
  );
function menuKeys(ref, onClose) {
  return (event) => {
    const items = menuItems(ref.current);
    const index = items.indexOf(document.activeElement);
    const focus = (next) => items[(next + items.length) % items.length]?.focus();
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focus(index + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focus(index - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      focus(0);
    } else if (event.key === "End") {
      event.preventDefault();
      focus(items.length - 1);
    } else if (event.key === "Tab") onClose?.();
  };
}

export function Avatar({ user, avatar, size = 29 }) {
  const custom = avatar ?? user?.avatar ?? null;
  const initial = (user?.name ?? "?").trim().charAt(0).toUpperCase();
  const style = { width: size, height: size, fontSize: Math.round(size * 0.42) };
  if (custom?.kind === "color")
    return (
      <span className="fl-avatar" style={{ ...style, background: custom.color }} aria-hidden="true">
        {initial}
      </span>
    );
  const src = custom?.kind === "photo" ? custom.src : user?.image;
  if (!src)
    return (
      <span
        className="fl-avatar"
        style={{ ...style, background: user?.avatarColor || "#3b5563" }}
        aria-hidden="true"
      >
        {initial}
      </span>
    );
  const cropped = custom?.kind === "photo";
  return (
    <span className={`fl-avatar ${cropped ? "cropped" : ""}`} style={style} aria-hidden="true">
      <img
        src={src}
        alt=""
        style={
          cropped
            ? {
                transform: `translate(${custom.x ?? 0}%, ${custom.y ?? 0}%) scale(${custom.zoom ?? 1})`,
              }
            : undefined
        }
      />
    </span>
  );
}

// -------------------------------------------------------------- notifications

export function NotificationsBell({ notifications, onOpen, open = false, className = "" }) {
  const count = unreadCount(notifications);
  return (
    <button
      type="button"
      className={`notif-bell ${className}`}
      aria-label={count ? `Notifications, ${count} unread` : "Notifications"}
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={onOpen}
    >
      <Icon name="mdiBellOutline" size={20} />
      {count > 0 && (
        <span className="notif-count" aria-hidden="true">
          {count > 9 ? "9+" : count}
        </span>
      )}
    </button>
  );
}

export function NotificationsPanel({ notifications, onChange, onClose, onOpenTarget, now }) {
  const ref = useRef(null);
  const titleId = useId();
  usePopover(ref, onClose);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  const list = Array.isArray(notifications) ? notifications : [];
  const sorted = sortNotifications(list);
  const unread = unreadCount(list);
  const open = (item) => {
    onChange?.(markRead(list, item.id));
    onOpenTarget?.(item.target, item);
    onClose?.();
  };
  return (
    <section
      ref={ref}
      className="fl-popover notif-panel"
      role="dialog"
      aria-labelledby={titleId}
      tabIndex={-1}
    >
      <header className="fl-popover-title">
        <h2 id={titleId}>Notifications</h2>
        {unread > 0 && (
          <button
            type="button"
            className="fl-text-button"
            onClick={() => onChange?.(markAllRead(list))}
          >
            Mark all as read
          </button>
        )}
        <button
          type="button"
          className="fl-icon-button"
          aria-label="Close notifications"
          onClick={onClose}
        >
          <Icon name="mdiClose" size={18} />
        </button>
      </header>
      {sorted.length === 0 ? (
        <div className="notif-empty">
          <Icon name="mdiBellOutline" size={28} />
          <p>You're all caught up</p>
          <span>Invitations, finished jobs and updates appear here.</span>
        </div>
      ) : (
        <ul className="notif-list">
          {sorted.map((item) => {
            const type = notificationTypes[item.type] ?? notificationTypes.system;
            return (
              <li key={item.id}>
                <button
                  type="button"
                  className={`notif-item ${item.readAt ? "" : "unread"}`}
                  onClick={() => open(item)}
                >
                  {!item.readAt && <span className="notif-dot" aria-hidden="true" />}
                  <span className={`notif-icon tone-${type.tone}`}>
                    <Icon name={type.icon} size={18} />
                  </span>
                  <span className="notif-text">
                    <strong>
                      {item.title}
                      {!item.readAt && <span className="fl-sr-only">, unread</span>}
                    </strong>
                    {item.body && <span>{item.body}</span>}
                  </span>
                  <time dateTime={item.createdAt}>{relativeTime(item.createdAt, now)}</time>
                </button>
                <button
                  type="button"
                  className="fl-icon-button notif-dismiss"
                  aria-label={`Dismiss ${item.title}`}
                  title="Dismiss"
                  onClick={() => onChange?.(dismissNotification(list, item.id))}
                >
                  <Icon name="mdiClose" size={14} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <footer className="notif-foot">
        {unread ? `${unread} unread` : "Nothing unread"} · Preview · sample data
      </footer>
    </section>
  );
}

// ---------------------------------------------------------------- help/about

const helpRows = (links) => [
  {
    id: "documentation",
    icon: "mdiBookOpenOutline",
    title: "Documentation",
    text: "Guides for setup, backups and the mobile app",
    href: links.documentation,
  },
  {
    id: "community",
    icon: "mdiCommentTextOutline",
    title: "Community chat",
    text: "Ask questions and share what you've built",
    href: links.community,
  },
  {
    id: "problem",
    icon: "mdiBugOutline",
    title: "Report a problem",
    text: "Something isn't working the way you expect",
    href: links.issues,
  },
  {
    id: "feature",
    icon: "mdiLightbulbOnOutline",
    title: "Feature requests",
    text: "Suggest and vote on what comes next",
    href: links.features,
  },
  {
    id: "source",
    icon: "mdiGithub",
    title: "Source code",
    text: `Open source under ${aboutInfo.licence}`,
    href: links.source,
  },
];

export function HelpFeedback({ onClose, links = aboutInfo.links, notices = aboutInfo.thirdParty }) {
  return (
    <Dialog title="Support and feedback" close={onClose}>
      <ul className="help-list">
        {helpRows(links).map((row, index) => (
          <li key={row.id}>
            <a
              className="help-link"
              href={row.href}
              target="_blank"
              rel="noreferrer"
              data-initial-focus={index === 0 ? "" : undefined}
            >
              <Icon name={row.icon} size={20} />
              <div>
                <strong>{row.title}</strong>
                <span>{row.text}</span>
              </div>
              <Icon name="mdiOpenInNew" size={16} />
              <span className="fl-sr-only">, opens in a new tab</span>
            </a>
          </li>
        ))}
        <li>
          <details className="help-notices">
            <summary>
              <span className="help-link">
                <Icon name="mdiCertificateOutline" size={20} />
                <div>
                  <strong>Third-party notices</strong>
                  <span>Licences for the software Frameleaf is built with</span>
                </div>
                <Icon name="mdiChevronDown" size={16} />
              </span>
            </summary>
            <table>
              <tbody>
                {notices.map((entry) => (
                  <tr key={entry.name}>
                    <td>{entry.name}</td>
                    <td>{entry.role}</td>
                    <td>{entry.licence}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </li>
      </ul>
    </Dialog>
  );
}

const longDate = (iso) =>
  new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

export function About({ info = aboutInfo, history = versionHistory, onClose }) {
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState(null);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const check = () => {
    if (checking) return;
    setChecking(true);
    setResult(null);
    timer.current = setTimeout(() => {
      setResult(checkForUpdates(info));
      setChecking(false);
    }, 900);
  };
  const facts = [
    ["Version", info.version + (info.basedOn ? ` · based on ${info.basedOn}` : "")],
    ["Build", <code key="build">{info.build}</code>],
    ["Built", longDate(info.buildDate)],
    ["Server", info.server?.name],
    ["Runtime", [info.server?.runtime, info.server?.platform].filter(Boolean).join(" · ")],
    ["Database", info.server?.database],
    ["Licence", info.licence],
    [
      "Source",
      <a key="source" href={info.links?.source} target="_blank" rel="noreferrer">
        Repository
      </a>,
    ],
  ].filter(([, value]) => value);
  return (
    <Dialog
      title="About Frameleaf"
      close={onClose}
      actions={
        <>
          <Button type="button" icon="mdiUpdate" onClick={check} disabled={checking}>
            {checking ? "Checking…" : "Check for updates"}
          </Button>
          <Button primary type="button" onClick={onClose} data-initial-focus="">
            Done
          </Button>
        </>
      }
    >
      <div className="about-head">
        <img src={SYMBOL} alt="" />
        <div>
          <strong>{info.product}</strong>
          <span>
            {info.channel === "development" ? "Development build" : `Version ${info.version}`}
            {info.build ? ` · ${info.build}` : ""}
          </span>
        </div>
      </div>
      <dl className="about-facts">
        {facts.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <p className="about-attribution">
        <Icon name="mdiInformationOutline" size={16} />
        <span>
          Built on{" "}
          <a href={info.upstream?.url} target="_blank" rel="noreferrer">
            {info.upstream?.name} {info.upstream?.version}
          </a>
          , the open-source photo library ({info.upstream?.licence}). Licences
          and acknowledgements are listed under Support and feedback.
        </span>
      </p>
      <div
        className={`about-check ${result ? (result.status === "current" ? "ok" : "available") : ""}`}
        role="status"
        aria-live="polite"
      >
        {checking && (
          <>
            <Icon name="mdiProgressClock" size={16} />
            Checking the release feed…
          </>
        )}
        {result && (
          <>
            <Icon name={result.status === "current" ? "mdiCheckCircle" : "mdiUpdate"} size={16} />
            {result.message} Checked {relativeTime(result.checkedAt).toLowerCase()}.
          </>
        )}
      </div>
      <section className="about-history" aria-labelledby="about-history-title">
        <h3 id="about-history-title">Version history</h3>
        <ol>
          {history.map((entry) => (
            <li key={entry.version}>
              <div>
                <strong>{entry.version}</strong>
                <time dateTime={entry.date}>{longDate(entry.date)}</time>
              </div>
              <ul>
                {entry.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      </section>
    </Dialog>
  );
}

// --------------------------------------------------------------- account menu

const AVATAR_COLORS = [
  ["#22c55e", "Green"],
  ["#0ea5a0", "Teal"],
  ["#3b82f6", "Blue"],
  ["#8b5cf6", "Violet"],
  ["#ec4899", "Pink"],
  ["#f59e0b", "Amber"],
  ["#ef5350", "Red"],
  ["#64748b", "Slate"],
];

export function AvatarEditor({ user, photos, initial, onSave, onClose }) {
  const options =
    photos ??
    media
      .filter((asset) => asset.type === "photo")
      .slice(0, 8)
      .map((asset) => ({ id: asset.id, src: asset.image, name: asset.name }));
  const start = initial ?? user?.avatar ?? null;
  const [mode, setMode] = useState(start?.kind === "color" ? "color" : "photo");
  const [src, setSrc] = useState(
    start?.kind === "photo" ? start.src : (user?.image ?? options[0]?.src ?? null),
  );
  const [color, setColor] = useState(
    start?.kind === "color" ? start.color : AVATAR_COLORS[0][0],
  );
  const [zoom, setZoom] = useState(start?.kind === "photo" ? (start.zoom ?? 1) : 1);
  const [offset, setOffset] = useState({
    x: start?.kind === "photo" ? (start.x ?? 0) : 0,
    y: start?.kind === "photo" ? (start.y ?? 0) : 0,
  });
  const drag = useRef(null);
  const zoomId = useId();
  const limit = (zoom - 1) * 50;
  const move = (x, y) =>
    setOffset({ x: clamp(x, -limit, limit), y: clamp(y, -limit, limit) });
  const initialLetter = (user?.name ?? "?").trim().charAt(0).toUpperCase();
  const onPointerDown = (event) => {
    if (mode !== "photo") return;
    drag.current = { x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const onPointerMove = (event) => {
    if (!drag.current) return;
    const rect = event.currentTarget.getBoundingClientRect();
    move(
      drag.current.ox + ((event.clientX - drag.current.x) / rect.width) * 100,
      drag.current.oy + ((event.clientY - drag.current.y) / rect.height) * 100,
    );
  };
  const onPointerUp = () => {
    drag.current = null;
  };
  const onKeyDown = (event) => {
    const step = event.shiftKey ? 10 : 2;
    if (event.key === "ArrowLeft") move(offset.x - step, offset.y);
    else if (event.key === "ArrowRight") move(offset.x + step, offset.y);
    else if (event.key === "ArrowUp") move(offset.x, offset.y - step);
    else if (event.key === "ArrowDown") move(offset.x, offset.y + step);
    else return;
    event.preventDefault();
  };
  const save = () =>
    onSave?.(
      mode === "color"
        ? { kind: "color", color }
        : { kind: "photo", src, zoom, x: offset.x, y: offset.y },
    );
  return (
    <Dialog
      title="Edit avatar"
      close={onClose}
      actions={
        <>
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button primary type="button" onClick={save} disabled={mode === "photo" && !src}>
            Save avatar
          </Button>
        </>
      }
    >
      <div className="avatar-editor">
        <div className="avatar-stage">
          <div
            className="avatar-crop"
            role="img"
            aria-label={
              mode === "photo"
                ? "Avatar preview. Drag or use the arrow keys to move the photo."
                : `Avatar preview showing the letter ${initialLetter}`
            }
            tabIndex={0}
            style={mode === "color" ? { background: color } : undefined}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onKeyDown={mode === "photo" ? onKeyDown : undefined}
          >
            {mode === "photo" && src ? (
              <img
                src={src}
                alt=""
                draggable={false}
                style={{ transform: `translate(${offset.x}%, ${offset.y}%) scale(${zoom})` }}
              />
            ) : (
              <span className="avatar-initial">{initialLetter}</span>
            )}
          </div>
          {mode === "photo" && (
            <label className="avatar-zoom" htmlFor={zoomId}>
              Zoom
              <input
                id={zoomId}
                type="range"
                min={1}
                max={3}
                step={0.05}
                value={zoom}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  setZoom(next);
                  const max = (next - 1) * 50;
                  setOffset((prev) => ({
                    x: clamp(prev.x, -max, max),
                    y: clamp(prev.y, -max, max),
                  }));
                }}
              />
            </label>
          )}
        </div>
        <div className="avatar-choices">
          <div>
            <h3>Choose a photo</h3>
            <div className="avatar-grid" role="group" aria-label="Photos">
              {user?.image && (
                <button
                  type="button"
                  aria-label="Current photo"
                  aria-pressed={mode === "photo" && src === user.image}
                  onClick={() => {
                    setMode("photo");
                    setSrc(user.image);
                  }}
                  data-initial-focus=""
                >
                  <img src={user.image} alt="" />
                </button>
              )}
              {options.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  aria-label={option.name}
                  aria-pressed={mode === "photo" && src === option.src}
                  onClick={() => {
                    setMode("photo");
                    setSrc(option.src);
                  }}
                >
                  <img src={option.src} alt="" loading="lazy" />
                </button>
              ))}
            </div>
          </div>
          <div>
            <h3>Or a colour</h3>
            <div className="avatar-colors" role="group" aria-label="Colours">
              {AVATAR_COLORS.map(([value, name]) => (
                <button
                  key={value}
                  type="button"
                  aria-label={name}
                  aria-pressed={mode === "color" && color === value}
                  style={{ background: value }}
                  onClick={() => {
                    setMode("color");
                    setColor(value);
                  }}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

export function AccountMenu({
  user,
  avatar,
  supporter,
  unlocked = false,
  onUnlock,
  onLock,
  onOpenLocked,
  onAccountSettings,
  onAccountSetup,
  onAdministration,
  onEditAvatar,
  onSupport,
  onAbout,
  onSignOut,
  onFrameleafCloud,
  onSupportFrameleaf,
}) {
  const [open, setOpen] = useState(false);
  const cloud = useCloudState();
  const cloudLinked = cloud.link.status === "linked";
  const [editing, setEditing] = useState(false);
  const button = useRef(null);
  const menu = useRef(null);
  const name = user?.name ?? "Account";
  const showSupporter = supporter?.activated && !supporter?.hideBadge;
  const close = () => setOpen(false);
  const run = (callback) => () => {
    close();
    callback?.();
  };
  return (
    <div className="account-menu-wrap">
      <button
        ref={button}
        type="button"
        className="account-button"
        aria-label={`Account menu for ${name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Avatar user={user} avatar={avatar} size={29} />
        <span className="account-name">{name}</span>
        <Icon name="mdiChevronDown" size={16} />
      </button>
      {open && (
        <AccountMenuPopover
          ref={menu}
          onClose={close}
          header={
            <div className="account-identity">
              <Avatar user={user} avatar={avatar} size={44} />
              <div>
                <strong>
                  {name}
                  {user?.isAdmin && <span className="account-tag">Admin</span>}
                  {showSupporter && (
                    <span className="supporter-badge">
                      <Icon name="mdiHandHeartOutline" size={12} />
                      Supporter
                    </span>
                  )}
                </strong>
                {user?.email && <span>{user.email}</span>}
              </div>
            </div>
          }
        >
          <button
            type="button"
            role="menuitemcheckbox"
            className="fl-menu-item"
            aria-checked={unlocked}
            onClick={run(unlocked ? onLock : onUnlock)}
          >
            <Icon name={unlocked ? "mdiLockOpenVariantOutline" : "mdiLockOutline"} size={18} />
            <div>
              Locked content
              <span>{unlocked ? "Revealed for this session" : "Hidden until you unlock"}</span>
            </div>
            <span className="fl-switch" aria-hidden="true" />
          </button>
          <button type="button" role="menuitem" className="fl-menu-item" onClick={run(onOpenLocked)}>
            <Icon name="mdiShieldLockOutline" size={18} />
            <div>
              Open Locked
              {!unlocked && <span>Asks for your PIN first</span>}
            </div>
            <Icon name="mdiChevronRight" size={16} />
          </button>
          <div className="fl-menu-sep" role="separator" />
          {onFrameleafCloud && (
            <button
              type="button"
              role="menuitem"
              className="fl-menu-item account-cloud"
              onClick={run(onFrameleafCloud)}
            >
              <img src="/brand/frameleaf-symbol.svg" alt="" width="18" height="18" />
              <div>
                Frameleaf Cloud
                <span>
                  {cloudLinked
                    ? `Linked · ${cloud.link.account?.email ?? "account"}`
                    : "Not linked · optional"}
                </span>
              </div>
              {cloudLinked && (
                <span className="account-cloud-pill" title="AI credit available">
                  {formatUsd(walletAvailable(cloud.wallet))}
                </span>
              )}
            </button>
          )}
          {onSupportFrameleaf && (
            <button type="button" role="menuitem" className="fl-menu-item" onClick={run(onSupportFrameleaf)}>
              <Icon name="mdiHandHeartOutline" size={18} />
              <div>
                Support Frameleaf
                <span>Plans, AI credit and supporter keys</span>
              </div>
            </button>
          )}
          <div className="fl-menu-sep" role="separator" />
          <button type="button" role="menuitem" className="fl-menu-item" onClick={run(onAccountSettings)}>
            <Icon name="mdiCogOutline" size={18} />
            <div>Account settings</div>
          </button>
          {onAccountSetup && (
            <button type="button" role="menuitem" className="fl-menu-item" onClick={run(onAccountSetup)}>
              <Icon name="mdiAccountCheckOutline" size={18} />
              <div>Set up your account</div>
            </button>
          )}
          {user?.isAdmin && (
            <button type="button" role="menuitem" className="fl-menu-item" onClick={run(onAdministration)}>
              <Icon name="mdiShieldAccountOutline" size={18} />
              <div>Administration</div>
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            className="fl-menu-item"
            onClick={() => {
              close();
              setEditing(true);
            }}
          >
            <Icon name="mdiAccountEditOutline" size={18} />
            <div>Edit avatar</div>
          </button>
          <div className="fl-menu-sep" role="separator" />
          <button type="button" role="menuitem" className="fl-menu-item" onClick={run(onSupport)}>
            <Icon name="mdiLifebuoy" size={18} />
            <div>Support and feedback</div>
          </button>
          {onAbout && (
            <button type="button" role="menuitem" className="fl-menu-item" onClick={run(onAbout)}>
              <Icon name="mdiInformationOutline" size={18} />
              <div>About Frameleaf</div>
            </button>
          )}
          <div className="fl-menu-sep" role="separator" />
          <button type="button" role="menuitem" className="fl-menu-item danger" onClick={run(onSignOut)}>
            <Icon name="mdiLogoutVariant" size={18} />
            <div>Sign out</div>
          </button>
        </AccountMenuPopover>
      )}
      {editing && (
        <AvatarEditor
          user={user}
          initial={avatar}
          onClose={() => setEditing(false)}
          onSave={(value) => {
            setEditing(false);
            onEditAvatar?.(value);
          }}
        />
      )}
    </div>
  );
}

const AccountMenuPopover = React.forwardRef(function AccountMenuPopover(
  { header, children, onClose },
  forwarded,
) {
  const inner = useRef(null);
  const ref = forwarded ?? inner;
  usePopover(ref, onClose);
  useEffect(() => {
    menuItems(ref.current)[0]?.focus();
  }, [ref]);
  return (
    <div
      ref={ref}
      className="fl-popover account-menu"
      role="menu"
      aria-label="Account"
      onKeyDown={menuKeys(ref, onClose)}
    >
      {header}
      <div className="fl-menu-sep" role="separator" />
      {children}
    </div>
  );
});
