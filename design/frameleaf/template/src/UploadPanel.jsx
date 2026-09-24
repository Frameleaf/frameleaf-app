import React, { useEffect, useId, useRef, useState } from "react";
import { Icon } from "./Icon";
import { Button } from "./App";
import {
  advanceDownloads,
  advanceUploads,
  cancelDownload,
  cancelUploads,
  clearFinishedUploads,
  dismissUploadErrors,
  downloadSummary,
  formatBytes,
  retryUploads,
  uploadSummary,
} from "./system-data.mjs";
import "./system.css";
import "./upload.css";

// --------------------------------------------------------------------- files

/** Reads only names, sizes and types from a FileList and creates object URLs
 * for image thumbnails. Nothing is uploaded or read into memory. */
export function readFileList(fileList) {
  const canPreview = typeof URL !== "undefined" && typeof URL.createObjectURL === "function";
  return Array.from(fileList ?? [])
    .filter((file) => file && typeof file.name === "string")
    .map((file) => ({
      name: file.webkitRelativePath || file.name,
      size: file.size,
      type: file.type,
      thumbnailUrl:
        canPreview && typeof file.type === "string" && file.type.startsWith("image/")
          ? URL.createObjectURL(file)
          : null,
    }));
}
export function releaseUploadThumbnails(items) {
  if (typeof URL === "undefined" || typeof URL.revokeObjectURL !== "function") return;
  for (const item of items ?? [])
    if (item?.thumbnailUrl?.startsWith("blob:")) URL.revokeObjectURL(item.thumbnailUrl);
}
const hasFiles = (event) =>
  Array.from(event.dataTransfer?.types ?? []).includes("Files");

/** Tracks whether files are being dragged over the window. */
export function useDragActive() {
  const [active, setActive] = useState(false);
  const depth = useRef(0);
  useEffect(() => {
    const enter = (event) => {
      if (!hasFiles(event)) return;
      depth.current += 1;
      setActive(true);
    };
    const leave = (event) => {
      if (!hasFiles(event)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setActive(false);
    };
    const over = (event) => {
      if (hasFiles(event)) event.preventDefault();
    };
    const drop = () => {
      depth.current = 0;
      setActive(false);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, []);
  return active;
}

// -------------------------------------------------------------- UploadButton

export function UploadButton({ onFiles, targets = [], defaultTarget = "" }) {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState(defaultTarget);
  const wrap = useRef(null);
  const menu = useRef(null);
  const filesInput = useRef(null);
  const folderInput = useRef(null);
  const selectId = useId();
  useEffect(() => {
    folderInput.current?.setAttribute("webkitdirectory", "");
    folderInput.current?.setAttribute("directory", "");
  }, []);
  useEffect(() => {
    if (!open) return undefined;
    const previous = document.activeElement;
    const onKey = (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
      }
    };
    const onPointer = (event) => {
      if (!wrap.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    menu.current?.querySelector('[role="menuitem"]')?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
      if (previous?.isConnected) previous.focus();
    };
  }, [open]);
  const choose = (input) => {
    const files = readFileList(input.files);
    input.value = "";
    setOpen(false);
    if (files.length) onFiles?.(files, { albumId: target || null });
  };
  const onMenuKey = (event) => {
    const items = Array.from(menu.current?.querySelectorAll('[role="menuitem"], select') ?? []);
    const index = items.indexOf(document.activeElement);
    const focus = (next) => items[(next + items.length) % items.length]?.focus();
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focus(index + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focus(index - 1);
    } else if (event.key === "Tab") setOpen(false);
  };
  const targetLabel = targets.find((entry) => entry.id === target)?.name;
  return (
    <div className="upload-menu-wrap" ref={wrap}>
      <Button
        icon="mdiTrayArrowUp"
        aria-label="Upload photos and videos"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="upload-button-label">Upload</span>
      </Button>
      <input
        ref={filesInput}
        className="upload-hidden-input"
        type="file"
        multiple
        accept="image/*,video/*"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => choose(event.target)}
      />
      <input
        ref={folderInput}
        className="upload-hidden-input"
        type="file"
        multiple
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => choose(event.target)}
      />
      {open && (
        <div
          ref={menu}
          className="upload-menu"
          role="menu"
          aria-label="Upload"
          onKeyDown={onMenuKey}
        >
          <button
            type="button"
            role="menuitem"
            className="fl-menu-item"
            onClick={() => filesInput.current?.click()}
          >
            <Icon name="mdiImageMultipleOutline" size={18} />
            <div>
              Upload files
              <span>Photos and videos from this device</span>
            </div>
          </button>
          <button
            type="button"
            role="menuitem"
            className="fl-menu-item"
            onClick={() => folderInput.current?.click()}
          >
            <Icon name="mdiFolderOutline" size={18} />
            <div>
              Upload folder
              <span>Everything inside, including subfolders</span>
            </div>
          </button>
          {targets.length > 0 && (
            <div className="upload-target">
              <label htmlFor={selectId}>Add to</label>
              <select
                id={selectId}
                value={target}
                onChange={(event) => setTarget(event.target.value)}
              >
                <option value="">Library only</option>
                {targets.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
              </select>
              {targetLabel && <span>New uploads also join “{targetLabel}”.</span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ----------------------------------------------------------- DragDropOverlay

export function DragDropOverlay({ active, onDrop }) {
  if (!active) return null;
  return (
    <div
      className="drop-overlay"
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDrop={(event) => {
        event.preventDefault();
        const files = readFileList(event.dataTransfer?.files);
        if (files.length) onDrop?.(files);
      }}
    >
      <div className="drop-frame" aria-hidden="true" />
      <div className="drop-card" role="status" aria-live="polite">
        <Icon name="mdiCloudUploadOutline" size={40} />
        <strong>Drop photos and videos to upload</strong>
        <span>They are added to your library as they arrive</span>
      </div>
    </div>
  );
}

// --------------------------------------------------------------- PanelDock

/** Fixed bottom-right stack for the upload and download panels. */
export function PanelDock({ children }) {
  return <div className="panel-dock">{children}</div>;
}

// ---------------------------------------------------------------- UploadPanel

const STATUS_ICON = {
  done: "mdiCheckCircle",
  duplicate: "mdiContentDuplicate",
  error: "mdiAlertCircleOutline",
};
const STATUS_TEXT = {
  queued: "Waiting",
  uploading: "Uploading",
  done: "Uploaded",
  duplicate: "Already in your library",
  error: "Failed",
};

export function UploadPanel({
  uploads,
  onChange,
  concurrency = 3,
  onConcurrency,
  onDismissErrors,
  onCancel,
  onRetry,
  onClose,
  onMinimize,
  minimized = false,
  tick = 250,
}) {
  const list = Array.isArray(uploads) ? uploads : [];
  const latest = useRef(list);
  latest.current = list;
  const summary = uploadSummary(list);
  const sliderId = useId();
  useEffect(() => {
    if (!summary.active) return undefined;
    const id = setInterval(
      () => onChange?.(advanceUploads(latest.current, concurrency, tick)),
      tick,
    );
    return () => clearInterval(id);
  }, [summary.active, concurrency, tick, onChange]);
  if (!list.length) return null;
  const counts = [
    `${summary.done} uploaded`,
    summary.duplicates ? `${summary.duplicates} duplicate${summary.duplicates === 1 ? "" : "s"}` : null,
    summary.errors ? `${summary.errors} failed` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const retry = () => (onRetry ? onRetry() : onChange?.(retryUploads(list)));
  const dismiss = () =>
    onDismissErrors ? onDismissErrors() : onChange?.(dismissUploadErrors(list));
  const cancel = () => (onCancel ? onCancel() : onChange?.(cancelUploads(list)));
  const finish = () => (onClose ? onClose() : onChange?.([]));
  const clearFinished = () => {
    const kept = clearFinishedUploads(list);
    releaseUploadThumbnails(list.filter((item) => !kept.includes(item)));
    onChange?.(kept);
  };
  if (minimized)
    return (
      <button
        type="button"
        className="upload-pill"
        aria-label={`Show uploads. ${summary.label}. ${counts}`}
        onClick={() => onMinimize?.(false)}
      >
        <span className="upload-ring" style={{ "--pct": summary.percent }} aria-hidden="true" />
        <strong>{summary.label}</strong>
        <span>{summary.percent}%</span>
      </button>
    );
  return (
    <section className="upload-panel" role="region" aria-label="Uploads">
      <header className="panel-head">
        <Icon name={summary.active ? "mdiProgressUpload" : "mdiCloudCheckOutline"} size={20} />
        <div>
          <strong aria-live="polite">{summary.label}</strong>
          <span>
            {counts} · {formatBytes(summary.bytes)}
          </span>
        </div>
        <button
          type="button"
          className="fl-icon-button"
          aria-label="Minimise uploads"
          onClick={() => onMinimize?.(true)}
        >
          <Icon name="mdiChevronDown" size={18} />
        </button>
        {!summary.active && (
          <button
            type="button"
            className="fl-icon-button"
            aria-label="Close uploads"
            onClick={finish}
          >
            <Icon name="mdiClose" size={18} />
          </button>
        )}
      </header>
      <div
        className={`upload-progress ${summary.errors ? "has-errors" : ""}`}
        role="progressbar"
        aria-label="Overall upload progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={summary.percent}
      >
        <span style={{ width: `${summary.percent}%` }} />
      </div>
      <ul className="panel-list">
        {list.map((item) => (
          <li key={item.id} className="upload-row" data-status={item.status}>
            <span className="upload-thumb">
              {item.thumbnailUrl ? (
                <img src={item.thumbnailUrl} alt="" />
              ) : (
                <Icon
                  name={item.type?.startsWith("video/") ? "mdiVideoOutline" : "mdiImageOutline"}
                  size={18}
                />
              )}
            </span>
            <span className="upload-name" title={item.name}>
              {item.name}
            </span>
            <span className="upload-state">
              {item.status === "uploading" || item.status === "queued" ? (
                <span
                  className="upload-ring"
                  style={{ "--pct": item.progress }}
                  role="progressbar"
                  aria-label={`${item.name} progress`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(item.progress)}
                />
              ) : (
                <>
                  <Icon name={STATUS_ICON[item.status]} size={18} />
                  <span className="fl-sr-only">{STATUS_TEXT[item.status]}</span>
                </>
              )}
            </span>
            <span className="upload-meta">
              {item.status === "error"
                ? item.error
                : `${formatBytes(item.size)} · ${STATUS_TEXT[item.status]}${
                    item.status === "uploading" ? ` ${Math.round(item.progress)}%` : ""
                  }`}
            </span>
            {item.status === "uploading" && (
              <span className="upload-mini" aria-hidden="true">
                <span style={{ width: `${item.progress}%` }} />
              </span>
            )}
          </li>
        ))}
      </ul>
      <footer className="panel-foot">
        <label className="upload-concurrency" htmlFor={sliderId}>
          Parallel uploads
          <input
            id={sliderId}
            type="range"
            min={1}
            max={10}
            step={1}
            value={concurrency}
            onChange={(event) => onConcurrency?.(Number(event.target.value))}
          />
          <output htmlFor={sliderId}>{concurrency}</output>
        </label>
        <div className="panel-actions">
          {summary.errors > 0 && (
            <>
              <Button icon="mdiRefresh" type="button" onClick={retry}>
                Retry failed
              </Button>
              <Button type="button" onClick={dismiss}>
                Dismiss errors
              </Button>
            </>
          )}
          {summary.active && summary.done + summary.duplicates > 0 && (
            <Button type="button" onClick={clearFinished}>
              Clear finished
            </Button>
          )}
          {summary.active ? (
            <Button type="button" onClick={cancel}>
              Cancel remaining
            </Button>
          ) : (
            <Button type="button" onClick={finish}>
              Done
            </Button>
          )}
        </div>
      </footer>
    </section>
  );
}

// -------------------------------------------------------------- DownloadPanel

const EMPTY_ZIP = new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)]);

export function DownloadPanel({ downloads, onChange, onSave, tick = 250 }) {
  const list = Array.isArray(downloads) ? downloads : [];
  const latest = useRef(list);
  latest.current = list;
  const summary = downloadSummary(list);
  useEffect(() => {
    if (!summary.active) return undefined;
    const id = setInterval(() => onChange?.(advanceDownloads(latest.current, tick)), tick);
    return () => clearInterval(id);
  }, [summary.active, tick, onChange]);
  if (!list.length) return null;
  const remove = (id) => onChange?.(cancelDownload(list, id));
  const save = (item) => {
    if (onSave) onSave(item);
    else if (typeof document !== "undefined" && typeof URL?.createObjectURL === "function") {
      const url = URL.createObjectURL(new Blob([EMPTY_ZIP], { type: "application/zip" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = item.name;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    remove(item.id);
  };
  const title = summary.preparing
    ? `Preparing ${summary.preparing} download${summary.preparing === 1 ? "" : "s"}`
    : summary.ready
      ? `${summary.ready} download${summary.ready === 1 ? "" : "s"} ready`
      : "Downloads";
  return (
    <section className="download-panel" role="region" aria-label="Downloads">
      <header className="panel-head">
        <Icon name={summary.active ? "mdiProgressDownload" : "mdiDownloadOutline"} size={20} />
        <div>
          <strong aria-live="polite">{title}</strong>
          <span>Archives are built on the server, then saved to this device</span>
        </div>
        {!summary.active && (
          <button
            type="button"
            className="fl-icon-button"
            aria-label="Close downloads"
            onClick={() => onChange?.([])}
          >
            <Icon name="mdiClose" size={18} />
          </button>
        )}
      </header>
      <ul className="panel-list">
        {list.map((item) => (
          <li key={item.id} className="download-row" data-status={item.status}>
            <Icon
              name={
                item.status === "ready"
                  ? "mdiCheckCircle"
                  : item.status === "error"
                    ? "mdiAlertCircleOutline"
                    : "mdiFileDownloadOutline"
              }
              size={20}
            />
            <span className="download-name" title={item.name}>
              {item.name}
            </span>
            <span className="download-actions">
              {item.status === "preparing" && (
                <Button type="button" onClick={() => remove(item.id)}>
                  Cancel
                </Button>
              )}
              {item.status === "ready" && (
                <Button primary type="button" icon="mdiDownload" onClick={() => save(item)}>
                  Save
                </Button>
              )}
              {item.status === "error" && (
                <Button type="button" onClick={() => remove(item.id)}>
                  Dismiss
                </Button>
              )}
            </span>
            <span className="download-meta">
              {item.status === "error"
                ? item.error
                : `${item.count} item${item.count === 1 ? "" : "s"} · ${formatBytes(item.bytes)}${
                    item.status === "preparing" ? ` · ${Math.round(item.progress)}%` : " · Ready"
                  }`}
            </span>
            {item.status === "preparing" && (
              <span
                className="download-progress"
                role="progressbar"
                aria-label={`${item.name} progress`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(item.progress)}
              >
                <span style={{ width: `${item.progress}%` }} />
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
