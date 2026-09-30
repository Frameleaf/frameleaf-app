import React, { useEffect, useState } from "react";
import { Button, Dialog } from "./Controls";
import { Icon } from "./Icon";
import {
  sampleRawFiles,
  rawStatus,
  repairableRawIds,
  advanceRawRepair,
  repairRawFiles,
} from "./raw-library.mjs";
import "./raw-library.css";

const storageKey = "frameleaf:raw-care:prototype:v1";
const readRepair = () => {
  try {
    const job = JSON.parse(localStorage.getItem(storageKey) || "null");
    return job &&
      Array.isArray(job.ids) &&
      job.ids.every((id) => sampleRawFiles.some((file) => file.id === id)) &&
      job.total === job.ids.length &&
      Number.isInteger(job.completed) &&
      job.completed >= 0 &&
      job.completed <= job.total &&
      ["running", "paused", "complete", "cancelled"].includes(job.status)
      ? {
          ...job,
          repairedIds: [
            ...new Set([
              ...(Array.isArray(job.repairedIds) ? job.repairedIds : []),
              ...job.ids.slice(0, job.completed),
            ]),
          ].filter((id) => sampleRawFiles.some((file) => file.id === id)),
        }
      : null;
  } catch {
    return null;
  }
};

/** Sample health states; no decoder, file access, or real media jobs run here. */
export function RawLibraryCare({ onBack, onPhotography, notify }) {
  const [job, setJob] = useState(readRepair);
  const [files, setFiles] = useState(() =>
    repairRawFiles(sampleRawFiles, job?.repairedIds || []),
  );
  const [selectedId, setSelectedId] = useState(sampleRawFiles[0].id);
  const [tab, setTab] = useState("health");
  const [source, setSource] = useState("sensor");
  const [dialog, setDialog] = useState(null);
  const [concurrency, setConcurrency] = useState("2");
  const [storageFailed, setStorageFailed] = useState(false);
  const selected = files.find((file) => file.id === selectedId) || files[0];
  const status = rawStatus[selected.status];
  const repairIds = repairableRawIds(files);
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(job));
      setStorageFailed(false);
    } catch {
      setStorageFailed(true);
    }
    if (job?.repairedIds?.length)
      setFiles((current) => repairRawFiles(current, job.repairedIds));
    if (job?.status !== "running") return;
    const timer = setTimeout(() => setJob(advanceRawRepair), 2800);
    return () => clearTimeout(timer);
  }, [job]);
  const startRepair = (ids) => {
    if (["running", "paused"].includes(job?.status) || !ids.length) return;
    setJob({
      ids,
      repairedIds: job?.repairedIds || [],
      total: ids.length,
      completed: 0,
      status: "running",
      concurrency: Number(concurrency),
    });
    setDialog(null);
  };
  return (
    <main className="raw-care">
      <header className="raw-care-header">
        <div>
          <p className="eyebrow">LIBRARY CARE</p>
          <h1>RAW support</h1>
          <p className="muted">
            Camera originals, clear status, and reliable previews.
          </p>
        </div>
        <span className="grow" />
        <span className="raw-core-badge">
          <Icon name="mdiCheckCircleOutline" size={16} />
          Included in Frameleaf
        </span>
        <Button icon="mdiArrowLeft" onClick={onBack}>
          Library
        </Button>
      </header>
      <div className="raw-core-note">
        <Icon name="mdiCameraOutline" />
        <div>
          <strong>Your RAW files belong in your library.</strong>
          <p>
            Importing, viewing, full-resolution zoom, and preview repair work
            without Photography, a subscription, or a Cloud connection.
          </p>
        </div>
        <span className="grow" />
        <span>Local instance</span>
      </div>
      <nav className="raw-tabs" aria-label="RAW support">
        <button
          aria-current={tab === "health" ? "page" : undefined}
          onClick={() => setTab("health")}
        >
          RAW health <span>{files.length}</span>
        </button>
        <button
          aria-current={tab === "formats" ? "page" : undefined}
          onClick={() => setTab("formats")}
        >
          Cameras & formats
        </button>
        <span className="grow" />
        <Button
          icon="mdiRefresh"
          disabled={
            !repairIds.length || ["running", "paused"].includes(job?.status)
          }
          onClick={() => setDialog("repair")}
        >
          Reprocess RAW previews
        </Button>
      </nav>
      {storageFailed && (
        <p className="raw-storage-alert" role="alert">
          This device couldn’t save the sample repair queue. Keep this tab open
          to retain progress.
        </p>
      )}
      {job && !job.hidden && (
        <section className="raw-job" aria-label="RAW repair progress">
          <Icon
            name={
              job.status === "complete"
                ? "mdiCheckCircleOutline"
                : "mdiProgressClock"
            }
          />
          <div>
            <strong>
              {job.status === "complete"
                ? "RAW previews repaired"
                : job.status === "paused"
                  ? "RAW repair paused"
                  : job.status === "cancelled"
                    ? "RAW repair cancelled"
                    : "Reprocessing RAW previews"}
            </strong>
            <p>
              {job.completed} of {job.total} sample files · Originals and asset
              IDs preserved
            </p>
            <progress max={job.total || 1} value={job.completed} />
          </div>
          <span className="grow" />
          {job.status === "running" && (
            <Button onClick={() => setJob({ ...job, status: "paused" })}>
              Pause
            </Button>
          )}
          {job.status === "paused" && (
            <Button
              primary
              onClick={() => setJob({ ...job, status: "running" })}
            >
              Resume
            </Button>
          )}
          {["running", "paused"].includes(job.status) && (
            <Button onClick={() => setJob({ ...job, status: "cancelled" })}>
              Cancel
            </Button>
          )}
          {["complete", "cancelled"].includes(job.status) && (
            <Button
              aria-label="Dismiss RAW repair"
              icon="mdiClose"
              onClick={() => setJob({ ...job, hidden: true })}
            />
          )}
        </section>
      )}
      {tab === "formats" ? (
        <section className="raw-formats">
          <h2>Support follows the camera and compression mode.</h2>
          <p className="muted">
            Design example of the compatibility matrix. Camera samples and
            processing results must be qualified before release.
          </p>
          <div className="raw-table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Format</th>
                  <th>Viewing</th>
                  <th>Development</th>
                  <th>Qualification</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ["CR2 / CR3", "Canon"],
                  ["NEF", "Nikon"],
                  ["ARW", "Sony"],
                  ["RAF", "Fujifilm"],
                  ["DNG / ProRAW", "Adobe / Apple"],
                  ["ORF", "OM System"],
                  ["RW2", "Panasonic"],
                ].map(([format, camera]) => (
                  <tr key={format}>
                    <td>
                      <strong>{format}</strong>
                      <small>{camera}</small>
                    </td>
                    <td>Local decoder</td>
                    <td>Separate engine capability</td>
                    <td>
                      <span className="raw-status">
                        Sample coverage required
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="raw-matrix-note">
            <Icon name="mdiInformationOutline" />
            An extension identifies the container. Camera, compression, and
            decoder build determine what can be rendered.
          </p>
        </section>
      ) : (
        <div className="raw-health-body">
          <section className="raw-list" aria-label="RAW files">
            {files.map((file) => (
              <button
                key={file.id}
                className={file.id === selected.id ? "selected" : ""}
                aria-pressed={file.id === selected.id}
                onClick={() => {
                  setSelectedId(file.id);
                  setSource(file.status === "ready" ? "sensor" : "embedded");
                }}
              >
                <img src={file.image} alt="" />
                <div>
                  <strong>{file.name}</strong>
                  <small>{file.camera}</small>
                  <span className={`raw-status raw-status-${file.status}`}>
                    {rawStatus[file.status].label}
                  </span>
                </div>
                <Icon name="mdiChevronRight" size={17} />
              </button>
            ))}
          </section>
          <section className="raw-detail" aria-label="RAW file details">
            <div className="raw-preview">
              <img
                src={selected.image}
                alt={`Sample preview for ${selected.name}`}
              />
              <span>
                {source === "sensor" && selected.status === "ready"
                  ? "Sensor render"
                  : selected.source === "Preview unavailable"
                    ? "Sample reference · Preview unavailable"
                    : "Embedded camera preview"}
              </span>
              <Button
                icon="mdiMagnifyPlusOutline"
                onClick={() => setDialog("zoom")}
              >
                Full-resolution view
              </Button>
            </div>
            <div className="raw-provenance">
              <div>
                <h2>{selected.name}</h2>
                <p>
                  {selected.camera} · {selected.dimensions}
                </p>
              </div>
              <span className={`raw-status raw-status-${selected.status}`}>
                {status.label}
              </span>
            </div>
            <p>{status.detail}</p>
            <div className="raw-source-switch">
              <Button
                active={source === "embedded"}
                onClick={() => setSource("embedded")}
              >
                Camera preview
              </Button>
              <Button
                active={source === "sensor"}
                disabled={selected.status !== "ready"}
                onClick={() => setSource("sensor")}
              >
                Sensor render
              </Button>
            </div>
            <dl>
              <div>
                <dt>Source</dt>
                <dd>{selected.format}</dd>
              </div>
              <div>
                <dt>Display profile</dt>
                <dd>
                  {selected.status === "ready"
                    ? "sRGB · From 16-bit decode"
                    : "Camera JPEG · Not a sensor render"}
                </dd>
              </div>
              <div>
                <dt>Original</dt>
                <dd>
                  <Icon name="mdiShieldCheckOutline" size={15} />
                  Preserved · Never overwritten
                </dd>
              </div>
              {selected.pair && (
                <div>
                  <dt>RAW / JPEG stack</dt>
                  <dd>{selected.pair}</dd>
                </div>
              )}
            </dl>
            <div className="raw-detail-actions">
              {status.action && (
                <Button
                  primary
                  disabled={
                    ["preview", "timeout"].includes(selected.status) &&
                    ["running", "paused"].includes(job?.status)
                  }
                  onClick={() =>
                    ["preview", "timeout"].includes(selected.status)
                      ? startRepair([selected.id])
                      : setDialog("details")
                  }
                >
                  {status.action}
                </Button>
              )}
              <Button icon="mdiCameraIris" onClick={onPhotography}>
                Open Photography
              </Button>
            </div>
          </section>
        </div>
      )}
      <footer className="raw-care-footer">
        <Icon name="mdiFlaskOutline" size={16} />
        Prototype · Camera status and repair progress use fictional local data.
      </footer>
      {dialog === "repair" && (
        <Dialog title="Reprocess RAW previews" close={() => setDialog(null)}>
          <p>
            Generate missing full-resolution renders and retry failed previews
            for {repairIds.length} sample files.
          </p>
          <p>
            Existing assets keep their IDs and original files. Unsupported and
            damaged files remain in the attention queue.
          </p>
          <label className="raw-field">
            Concurrent renders
            <select
              value={concurrency}
              onChange={(event) => setConcurrency(event.target.value)}
            >
              <option value="1">1 · Low memory</option>
              <option value="2">2 · Balanced</option>
              <option value="4">4 · Faster server</option>
            </select>
          </label>
          <div className="raw-repair-note">
            <Icon name="mdiHarddisk" />
            Temporary storage is bounded. Repair can be paused and resumed.
          </div>
          <div className="raw-dialog-actions">
            <Button onClick={() => setDialog(null)}>Cancel</Button>
            <Button
              primary
              icon="mdiRefresh"
              onClick={() => startRepair(repairIds)}
            >
              Start sample repair
            </Button>
          </div>
        </Dialog>
      )}
      {dialog === "zoom" && (
        <Dialog wide title={selected.name} close={() => setDialog(null)}>
          <img
            className="raw-zoom"
            src={selected.image}
            alt={`Sample zoom of ${selected.name}`}
          />
          <p className="muted">
            Design preview of full-resolution viewing. This sample image is not
            a decoded RAW file.
          </p>
        </Dialog>
      )}
      {dialog === "details" && (
        <Dialog title={status.label} close={() => setDialog(null)}>
          <p>{status.detail}</p>
          <p>
            {selected.camera} · {selected.format}
          </p>
          <p className="muted">
            The production status will include decoder version, supported
            compression modes, and retry guidance.
          </p>
          <div className="raw-dialog-actions">
            <Button
              onClick={() => {
                setTab("formats");
                setDialog(null);
              }}
            >
              Cameras & formats
            </Button>
            <Button
              primary
              onClick={() => {
                setDialog(null);
                notify?.(
                  "Sample decoder details reviewed. Originals remain preserved.",
                );
              }}
            >
              Done
            </Button>
          </div>
        </Dialog>
      )}
    </main>
  );
}
