import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { Icon } from "./Icon";
import {
  checkPassword,
  expiryLabel,
  isExpired,
  linkAssets,
} from "./shared-links-data.mjs";
import "./sharing.css";

const formatBytes = (bytes) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;
  while (value >= 1000 && index < units.length - 1) {
    value /= 1000;
    index += 1;
  }
  return `${value < 10 && index ? value.toFixed(1) : Math.round(value)} ${units[index]}`;
};
const formatDate = (value) => {
  const at = Date.parse(value || "");
  return Number.isFinite(at)
    ? new Date(at).toLocaleDateString(undefined, {
        year: "numeric",
        month: "long",
        day: "numeric",
      })
    : "";
};
const timecode = (seconds) =>
  `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
const tileShape = (asset) => {
  if (asset.isPanorama) return "pano";
  if (!asset.width || !asset.height) return "";
  const ratio = asset.width / asset.height;
  return ratio >= 1.6 ? "wide" : ratio <= 0.85 ? "tall" : "";
};
const safeName = (value) =>
  String(value || "share")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "share";

function PvButton({ icon, children, primary, className = "", ...props }) {
  return (
    <button
      type="button"
      className={`button ${primary ? "primary" : ""} ${className}`}
      {...props}
    >
      {icon && <Icon name={icon} />}
      {children}
    </button>
  );
}

function OwnerAvatar({ owner }) {
  const name = owner?.name || "Owner";
  return owner?.image ? (
    <img className="pv-avatar" src={owner.image} alt="" width={24} height={24} />
  ) : (
    <span className="pv-avatar pv-avatar-initial" aria-hidden="true">
      {Array.from(name)[0]?.toLocaleUpperCase()}
    </span>
  );
}

function metadataRows(asset) {
  const rows = [];
  const camera = [asset.make, asset.model].filter(Boolean).join(" ");
  if (camera) rows.push(["Camera", camera]);
  if (asset.lensModel) rows.push(["Lens", asset.lensModel]);
  const exposure = [
    asset.fNumber && `ƒ/${asset.fNumber}`,
    asset.exposureTime && `${asset.exposureTime} s`,
    asset.iso && `ISO ${asset.iso}`,
    asset.focalLength && `${asset.focalLength} mm`,
  ].filter(Boolean);
  if (exposure.length) rows.push(["Exposure", exposure.join(" · ")]);
  if (asset.width && asset.height)
    rows.push([
      "Dimensions",
      `${asset.width} × ${asset.height}${asset.frameRate ? ` · ${asset.frameRate} fps` : ""}`,
    ]);
  if (asset.fileSizeInBytes) rows.push(["Size", formatBytes(asset.fileSizeInBytes)]);
  if (asset.takenAt || asset.date) rows.push(["Taken", formatDate(asset.takenAt || asset.date)]);
  const place = [asset.city, asset.state, asset.country].filter(Boolean).join(", ");
  if (place) rows.push(["Location", place]);
  if (Number.isFinite(asset.latitude) && Number.isFinite(asset.longitude))
    rows.push(["Coordinates", `${asset.latitude.toFixed(4)}, ${asset.longitude.toFixed(4)}`]);
  return rows;
}

/**
 * Public share page for `?screen=public&link=…`. Renders its own shell.
 * props: { link|null, assets, owner {name, image}, onUpload(link, files),
 *          onExit(), onView(link), theme }
 */
export function PublicViewer({
  link,
  assets = [],
  owner,
  onUpload,
  onExit,
  onView,
  theme = "dark",
}) {
  const ids = useId();
  const [now, setNow] = useState(() => Date.now());
  const [unlocked, setUnlocked] = useState(false);
  const [entered, setEntered] = useState("");
  const [showEntered, setShowEntered] = useState(false);
  const [passwordError, setPasswordError] = useState("");
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [open, setOpen] = useState(null);
  const [info, setInfo] = useState(false);
  const [job, setJob] = useState(null);
  const [previews, setPreviews] = useState({});
  const [status, setStatus] = useState("");
  const fileInput = useRef(null);
  const lightbox = useRef(null);
  const viewed = useRef(null);
  const previewsRef = useRef(previews);
  previewsRef.current = previews;

  const expired = link ? isExpired(link, now) : false;
  const ready = !!link && !expired && (!link.hasPassword || unlocked);
  const items = useMemo(() => linkAssets(link, assets), [link, assets]);
  const title = link?.description || "Shared with you";
  const ownerName = owner?.name || "the owner";

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if (ready && viewed.current !== link.id) {
      viewed.current = link.id;
      onView?.(link);
    }
  }, [ready, link, onView]);
  useEffect(() => {
    const previous = document.title;
    document.title = `${ready ? title : "Shared link"} · Frameleaf`;
    return () => {
      document.title = previous;
    };
  }, [ready, title]);
  useEffect(
    () => () => {
      Object.values(previewsRef.current).forEach((url) => URL.revokeObjectURL(url));
    },
    [],
  );
  useEffect(() => {
    const dialog = lightbox.current;
    if (!dialog) return;
    if (open !== null && !dialog.open) dialog.showModal();
    if (open === null && dialog.open) dialog.close();
  }, [open]);
  useEffect(() => {
    if (job?.status !== "preparing") return undefined;
    const id = setTimeout(
      () =>
        setJob((current) =>
          !current || current.status !== "preparing"
            ? current
            : current.done + 1 >= current.total
              ? { ...current, done: current.total, status: "ready" }
              : { ...current, done: current.done + 1 },
        ),
      320,
    );
    return () => clearTimeout(id);
  }, [job]);

  const current = open !== null ? items[open] : null;
  const move = (delta) =>
    setOpen((index) =>
      index === null ? null : (index + delta + items.length) % items.length,
    );
  const toggle = (id) =>
    setSelected((set) => {
      const next = new Set(set);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const startDownload = (list) => {
    if (!list.length) return;
    setJob({
      status: "preparing",
      done: 0,
      total: list.length,
      names: list.map((item) => item.name),
      bytes: list.reduce((sum, item) => sum + (item.fileSizeInBytes || 0), 0),
    });
  };
  const saveArchive = () => {
    const manifest = [
      `Frameleaf shared download · ${title}`,
      `${job.names.length} files`,
      "",
      ...job.names,
    ].join("\n");
    const blob = new Blob([manifest], { type: "text/plain" });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = `${safeName(link.slug || link.id)}-download.txt`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
    setJob(null);
    setStatus("Download started.");
  };
  const handleFiles = (event) => {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    if (!files.length) return;
    const next = { ...previews };
    for (const file of files)
      if (file.type?.startsWith("image/"))
        try {
          next[file.name] = URL.createObjectURL(file);
        } catch {
          // preview unavailable; the placeholder tile is shown instead
        }
    setPreviews(next);
    onUpload?.(link, files);
    setStatus(`${files.length} ${files.length === 1 ? "item" : "items"} added to this share.`);
  };
  const unlock = (event) => {
    event.preventDefault();
    if (checkPassword(link, entered)) {
      setUnlocked(true);
      setPasswordError("");
    } else setPasswordError("That password does not match. Check with the person who shared the link.");
  };

  const shell = (children, { hero = false } = {}) => (
    <div className={`frameleaf public-viewer${hero ? " pv-hero" : ""}`} data-theme={theme}>
      <header className="pv-header">
        <div className="pv-brand">
          <img src="/media/brand.png" alt="" width={28} height={28} />
          <strong>Frameleaf</strong>
        </div>
        {ready && (
          <div className="pv-title">
            <h1>{title}</h1>
            <span>
              <OwnerAvatar owner={owner} />
              Shared by {ownerName} · {items.length} {items.length === 1 ? "item" : "items"}
              {link.expiresAt ? ` · ${expiryLabel(link, now).toLowerCase()}` : ""}
            </span>
          </div>
        )}
        {ready && (
          <div className="pv-actions">
            {link.allowUpload && (
              <>
                <input
                  ref={fileInput}
                  id={`${ids}-upload`}
                  className="sr-only"
                  type="file"
                  multiple
                  accept="image/*,video/*"
                  aria-label="Add photos or videos"
                  onChange={handleFiles}
                />
                <PvButton icon="mdiUpload" onClick={() => fileInput.current?.click()}>
                  Add photos
                </PvButton>
              </>
            )}
            <PvButton
              icon={selectMode ? "mdiSelectOff" : "mdiCheckboxMultipleMarkedOutline"}
              aria-pressed={selectMode}
              onClick={() => {
                setSelectMode(!selectMode);
                setSelected(new Set());
              }}
            >
              {selectMode ? "Done" : "Select"}
            </PvButton>
            {link.allowDownload && (
              <PvButton
                primary
                icon="mdiDownloadOutline"
                disabled={selectMode ? !selected.size : !items.length}
                onClick={() =>
                  startDownload(selectMode ? items.filter((item) => selected.has(item.id)) : items)
                }
              >
                {selectMode ? `Download selected (${selected.size})` : "Download all"}
              </PvButton>
            )}
          </div>
        )}
      </header>
      <main className="pv-main">{children}</main>
      <footer className="pv-footer">
        <small>
          Preview · sample data
          {link?.hasPassword && !unlocked && !expired
            ? link.password
              ? ` · use “${link.password}” to open this sample link`
              : " · this link’s password was set in another session; set a new one from Shared links"
            : ""}
          {job ? " · archives are simulated" : ""}
        </small>
        <button type="button" className="pv-exit" onClick={() => onExit?.()}>
          Go to Frameleaf
        </button>
      </footer>
      <p className="sr-only" role="status" aria-live="polite">
        {status}
      </p>
    </div>
  );

  if (!link)
    return shell(
      <div className="pv-state" role="status">
        <Icon name="mdiLinkOff" size={40} />
        <h1>This link is not available</h1>
        <p>It may have been removed, or the address is incomplete.</p>
        <PvButton onClick={() => onExit?.()}>Go to Frameleaf</PvButton>
      </div>,
      { hero: true },
    );
  if (expired)
    return shell(
      <div className="pv-state" role="status">
        <Icon name="mdiClockOutline" size={40} />
        <h1>This link has expired</h1>
        <p>Ask {ownerName} for a new link if you still need these photos.</p>
        <PvButton onClick={() => onExit?.()}>Go to Frameleaf</PvButton>
      </div>,
      { hero: true },
    );
  if (link.hasPassword && !unlocked)
    return shell(
      <form className="pv-state pv-password" onSubmit={unlock}>
        <Icon name="mdiLockOutline" size={40} />
        <h1>This share is protected</h1>
        <p>Enter the password from {ownerName} to continue.</p>
        <div className="slf-password">
          <input
            id={`${ids}-password`}
            type={showEntered ? "text" : "password"}
            autoComplete="off"
            aria-label="Password"
            value={entered}
            placeholder="Password"
            autoFocus
            aria-invalid={!!passwordError}
            aria-describedby={passwordError ? `${ids}-password-error` : undefined}
            onChange={(event) => setEntered(event.target.value)}
          />
          <PvButton
            icon={showEntered ? "mdiEyeOffOutline" : "mdiEyeOutline"}
            aria-label={showEntered ? "Hide password" : "Show password"}
            aria-pressed={showEntered}
            onClick={() => setShowEntered(!showEntered)}
          />
        </div>
        {passwordError && (
          <p id={`${ids}-password-error`} className="slf-error" role="alert">
            <Icon name="mdiAlertCircleOutline" size={16} />
            {passwordError}
          </p>
        )}
        <button type="submit" className="button primary">
          Continue
        </button>
      </form>,
      { hero: true },
    );

  return shell(
    <>
      {selectMode && (
        <div className="pv-selectbar" role="toolbar" aria-label="Selection">
          <span>
            {selected.size} of {items.length} selected
          </span>
          <PvButton onClick={() => setSelected(new Set(items.map((item) => item.id)))}>
            Select all
          </PvButton>
          <PvButton disabled={!selected.size} onClick={() => setSelected(new Set())}>
            Clear
          </PvButton>
        </div>
      )}
      {job && (
        <div className="pv-job" role="status" aria-live="polite">
          <Icon name={job.status === "ready" ? "mdiCheckCircleOutline" : "mdiProgressDownload"} />
          <div className="pv-job-copy">
            <strong>
              {job.status === "ready"
                ? `Archive ready · ${job.total} ${job.total === 1 ? "file" : "files"}${job.bytes ? ` · ${formatBytes(job.bytes)}` : ""}`
                : `Preparing archive · ${job.done} of ${job.total}`}
            </strong>
            <span
              className="pv-progress"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={job.total}
              aria-valuenow={job.done}
            >
              <span style={{ transform: `scaleX(${job.total ? job.done / job.total : 0})` }} />
            </span>
          </div>
          {job.status === "ready" ? (
            <PvButton primary icon="mdiDownloadOutline" onClick={saveArchive}>
              Save archive
            </PvButton>
          ) : (
            <PvButton onClick={() => setJob(null)}>Cancel</PvButton>
          )}
        </div>
      )}
      {items.length ? (
        <ul className={`pv-grid${selectMode ? " selecting" : ""}`} aria-label="Shared items">
          {items.map((item, index) => {
            const src = item.placeholder ? previews[item.name] : item.image;
            const chosen = selected.has(item.id);
            return (
              <li key={item.id} className={tileShape(item)} data-selected={chosen || undefined}>
                <button
                  type="button"
                  className="pv-tile"
                  aria-label={selectMode ? `${chosen ? "Deselect" : "Select"} ${item.name}` : `Open ${item.name}`}
                  aria-pressed={selectMode ? chosen : undefined}
                  onClick={() => (selectMode ? toggle(item.id) : setOpen(index))}
                >
                  {src ? (
                    <img src={src} alt="" loading="lazy" />
                  ) : (
                    <span className="pv-placeholder">
                      <Icon name={item.type === "video" ? "mdiVideoOutline" : "mdiImageOutline"} />
                      <span>{item.name}</span>
                    </span>
                  )}
                  {item.type === "video" && item.duration ? (
                    <span className="pv-duration">
                      <Icon name="mdiPlay" size={12} />
                      {timecode(item.duration)}
                    </span>
                  ) : null}
                  {item.placeholder && <span className="pv-new">New</span>}
                  {selectMode && (
                    <span className="pv-check" aria-hidden="true">
                      <Icon name={chosen ? "mdiCheckCircle" : "mdiCheckboxBlankCircleOutline"} />
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="pv-state" role="status">
          <Icon name="mdiImageMultipleOutline" size={40} />
          <h1>Nothing here yet</h1>
          <p>
            {link.allowUpload
              ? "Be the first to add a photo."
              : "The owner has not added anything to this share yet."}
          </p>
        </div>
      )}
      <dialog
        ref={lightbox}
        className={`pv-lightbox${info && link.showMetadata ? " with-info" : ""}`}
        aria-label={current ? current.name : "Item"}
        onCancel={(event) => {
          event.preventDefault();
          setOpen(null);
        }}
        onClose={() => setOpen(null)}
        onKeyDown={(event) => {
          if (event.target.tagName === "INPUT") return;
          if (event.key === "ArrowRight") move(1);
          else if (event.key === "ArrowLeft") move(-1);
          else if (event.key.toLowerCase() === "i" && link.showMetadata) setInfo(!info);
        }}
      >
        {current && (
          <>
            <header className="pv-lb-header">
              <div className="pv-lb-title">
                <strong>{current.name}</strong>
                <span>
                  {open + 1} of {items.length}
                  {formatDate(current.takenAt || current.date)
                    ? ` · ${formatDate(current.takenAt || current.date)}`
                    : ""}
                </span>
              </div>
              <div className="pv-lb-tools">
                {link.allowDownload && !current.placeholder && (
                  <a
                    className="pv-lb-tool"
                    href={current.type === "video" ? current.mediaSrc || current.image : current.image}
                    download={current.originalFileName || current.name}
                    aria-label={`Download ${current.name}`}
                    title="Download"
                  >
                    <Icon name="mdiDownloadOutline" />
                  </a>
                )}
                {link.showMetadata && (
                  <button
                    type="button"
                    className="pv-lb-tool"
                    aria-label="Toggle details"
                    aria-pressed={info}
                    title="Details (I)"
                    onClick={() => setInfo(!info)}
                  >
                    <Icon name="mdiInformationOutline" />
                  </button>
                )}
                <button
                  type="button"
                  className="pv-lb-tool"
                  aria-label="Close"
                  title="Close (Esc)"
                  onClick={() => setOpen(null)}
                >
                  <Icon name="mdiClose" />
                </button>
              </div>
            </header>
            <div className="pv-lb-stage">
              <button
                type="button"
                className="pv-lb-nav previous"
                aria-label="Previous item"
                disabled={items.length < 2}
                onClick={() => move(-1)}
              >
                <Icon name="mdiChevronLeft" />
              </button>
              <figure className="pv-lb-media">
                {current.type === "video" && current.mediaSrc ? (
                  <video key={current.id} controls playsInline src={current.mediaSrc} poster={current.image} />
                ) : current.placeholder && !previews[current.name] ? (
                  <span className="pv-placeholder large">
                    <Icon name={current.type === "video" ? "mdiVideoOutline" : "mdiImageOutline"} />
                    <span>{current.name}</span>
                    <small>Uploaded to this share</small>
                  </span>
                ) : (
                  <img
                    key={current.id}
                    src={current.placeholder ? previews[current.name] : current.image}
                    alt={current.description || current.name}
                  />
                )}
              </figure>
              <button
                type="button"
                className="pv-lb-nav next"
                aria-label="Next item"
                disabled={items.length < 2}
                onClick={() => move(1)}
              >
                <Icon name="mdiChevronRight" />
              </button>
            </div>
            {link.showMetadata && info && (
              <aside className="pv-info" aria-label="Details">
                <h2>Details</h2>
                {current.description && <p>{current.description}</p>}
                <dl>
                  {metadataRows(current).map(([term, detail]) => (
                    <div key={term}>
                      <dt>{term}</dt>
                      <dd>{detail}</dd>
                    </div>
                  ))}
                </dl>
                {!metadataRows(current).length && (
                  <p className="muted">No capture details for this item.</p>
                )}
              </aside>
            )}
          </>
        )}
      </dialog>
    </>,
  );
}
