import React, { useEffect, useState } from "react";
import { Button, Dialog } from "./App";
import { Icon } from "./Icon";
import { media, timecode } from "./media";
import { durationFor } from "./state.mjs";

export function Editor(props) {
  const {
    quick,
    selected,
    edit,
    changeEdit,
    initialEdit,
    session,
    dispatch,
    undo,
    redo,
    undoEdit,
    redoEdit,
    destination,
    setDestination,
    saveVersion,
    enqueue,
    close,
    openStudio,
    back,
    openAsset,
    notify,
  } = props;
  const duration = durationFor(selected);
  const [tab, setTab] = useState("Trim");
  const [workspace, setWorkspace] = useState("Edit");
  const [playing, setPlaying] = useState(false);
  const [modal, setModal] = useState(null);
  const { restorationMode: mode, comment, title } = edit;
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(
      () =>
        dispatch({
          type: "playback",
          time:
            session.playbackPosition >= duration
              ? 0
              : Math.min(duration, session.playbackPosition + 0.2),
        }),
      200,
    );
    return () => clearInterval(timer);
  }, [playing, session.playbackPosition, duration]);
  const visualStyle = {
    transform: `rotate(${edit.rotation}deg) scale(${edit.rotation % 180 ? 0.5625 : 1})`,
    filter: `brightness(${2 ** edit.exposure}) saturate(${edit.saturation / 100})`,
  };
  const preview = (
    <div className="monitor">
      <img src={selected.image} alt={selected.name} style={visualStyle} />
      {edit.crop !== "Original" && (
        <div
          className="crop-overlay"
          style={{ aspectRatio: edit.crop.replace(":", "/") }}
        />
      )}
      {workspace === "Motion" && <span className="preview-title">{title}</span>}
    </div>
  );
  const controlTab = workspace === "Edit" ? tab : workspace;
  const controls = (
    <div className="edit-controls">
      {controlTab === "Trim" && (
        <>
          <label>
            Trim mode
            <select
              value={edit.trim}
              onChange={(e) => changeEdit({ trim: e.target.value })}
            >
              <option value="precise">Precise</option>
              <option value="fast">Fast · keyframe aligned</option>
            </select>
          </label>
          <div className="field-pair">
            <label>
              In (seconds)
              <input
                aria-label="Trim start"
                type="number"
                min="0"
                max={edit.end - 0.1}
                step="0.1"
                value={edit.start}
                onChange={(e) =>
                  changeEdit({
                    start: Math.min(
                      edit.end - 0.1,
                      Math.max(0, Number(e.target.value)),
                    ),
                  })
                }
              />
            </label>
            <label>
              Out (seconds)
              <input
                aria-label="Trim end"
                type="number"
                min={edit.start + 0.1}
                max={duration}
                step="0.1"
                value={edit.end}
                onChange={(e) =>
                  changeEdit({
                    end: Math.max(
                      edit.start + 0.1,
                      Math.min(duration, Number(e.target.value)),
                    ),
                  })
                }
              />
            </label>
          </div>
          <p className="muted">
            {edit.trim === "fast"
              ? `Sample boundaries: ${Math.floor(edit.start / 2) * 2}s – ${Math.min(duration, Math.ceil(edit.end / 2) * 2)}s. The source end is included for this demonstration; actual keyframes and stream-copy safety require source analysis.`
              : "Frame-accurate boundaries. Render from the original."}
          </p>
        </>
      )}
      {controlTab === "Rotate" && (
        <>
          <div className="field-pair">
            <Button
              icon="mdiRotateLeft"
              onClick={() =>
                changeEdit({ rotation: (edit.rotation + 270) % 360 })
              }
            >
              Left 90°
            </Button>
            <Button
              icon="mdiRotateRight"
              onClick={() =>
                changeEdit({ rotation: (edit.rotation + 90) % 360 })
              }
            >
              Right 90°
            </Button>
          </div>
          <p>
            {edit.rotation}° ·{" "}
            {edit.rotation % 180 ? "2160 × 3840" : "3840 × 2160"} edited master
          </p>
          <p className="muted">
            Source resolution is retained. Playback quality is a separate
            setting.
          </p>
        </>
      )}
      {controlTab === "Crop" && (
        <>
          <label>
            Aspect ratio
            <select
              value={edit.crop}
              onChange={(e) => changeEdit({ crop: e.target.value })}
            >
              {["Original", "16:9", "9:16", "1:1", "4:3"].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <p className="muted">The overlay shows the output frame.</p>
        </>
      )}
      {["Adjust", "Color"].includes(controlTab) && (
        <>
          <label>
            Exposure <output>{edit.exposure.toFixed(1)} EV</output>
            <input
              aria-label="Exposure"
              type="range"
              min="-2"
              max="2"
              step="0.1"
              value={edit.exposure}
              onChange={(e) => changeEdit({ exposure: Number(e.target.value) })}
            />
          </label>
          <label>
            Saturation <output>{edit.saturation}%</output>
            <input
              aria-label="Saturation"
              type="range"
              min="0"
              max="150"
              value={edit.saturation}
              onChange={(e) =>
                changeEdit({ saturation: Number(e.target.value) })
              }
            />
          </label>
          <p className="muted">
            Display approximation. HDR rendering is qualified separately.
          </p>
        </>
      )}
      {controlTab === "Audio" && (
        <>
          <label>
            Clip gain <output>{edit.volume}%</output>
            <input
              aria-label="Clip gain"
              type="range"
              min="0"
              max="150"
              value={edit.volume}
              onChange={(e) => changeEdit({ volume: Number(e.target.value) })}
            />
          </label>
          <Button
            active={edit.volume === 0}
            icon="mdiVolumeOff"
            onClick={() => changeEdit({ volume: edit.volume ? 0 : 100 })}
          >
            Mute clip
          </Button>
          <p className="muted">
            Original channels preserved. This still-image prototype plays no
            audio.
          </p>
        </>
      )}
      {controlTab === "Motion" && (
        <>
          <label>
            Title
            <input
              value={title}
              onChange={(e) => changeEdit({ title: e.target.value })}
            />
          </label>
          <label>
            Animation
            <select
              value={edit.animation}
              onChange={(e) => changeEdit({ animation: e.target.value })}
            >
              <option>Fade in</option>
              <option>Rise</option>
              <option>Typewriter</option>
            </select>
          </label>
          <p className="muted">
            Title placement preview. Full animation controls are tracked in the
            feature manifest.
          </p>
        </>
      )}
      {controlTab === "Captions" && (
        <>
          <label>
            Language
            <select
              value={edit.captionLanguage}
              onChange={(e) => changeEdit({ captionLanguage: e.target.value })}
            >
              <option>Auto detect</option>
              <option>English</option>
              <option>French</option>
            </select>
          </label>
          <Button
            onClick={() =>
              notify(
                "A qualified worker is required. No transcript was generated.",
              )
            }
          >
            Transcribe
          </Button>
          <label>
            Caption text
            <textarea
              placeholder="Enter a sample caption…"
              value={edit.caption}
              onChange={(e) => changeEdit({ caption: e.target.value })}
            />
          </label>
        </>
      )}
      {controlTab === "Restore" && (
        <>
          <label>
            Restoration mode
            <select
              value={mode}
              onChange={(e) => changeEdit({ restorationMode: e.target.value })}
            >
              <option>Faithful</option>
              <option>Creative</option>
            </select>
          </label>
          <p>2× upscale · 4K cap · Original timing</p>
          <label>
            Destination
            <select
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
            >
              <option value="local">Home workstation · Local GPU</option>
              <option value="runpod">RunPod · Cloud GPU</option>
            </select>
          </label>
          <p className="muted">
            {destination === "local"
              ? "Media stays on your network."
              : "Cloud media transfer requires your explicit destination choice."}
          </p>
          <Button primary onClick={() => setModal("restore")}>
            Preview 5 seconds
          </Button>
          <p className="muted">
            Model estimates and quality comparisons require a qualified worker.
            This prototype simulates the flow.
          </p>
        </>
      )}
    </div>
  );
  const timeline = (
    <div className="timeline">
      <div className="transport">
        <Button
          aria-label={playing ? "Pause preview cursor" : "Play preview cursor"}
          icon={playing ? "mdiPause" : "mdiPlay"}
          onClick={() => setPlaying(!playing)}
        />
        <span className="timecode">
          {timecode(session.playbackPosition)} / {timecode(duration)}
        </span>
        <span className="muted">Preview still</span>
        <span className="grow" />
        <Button
          aria-label="Undo edit"
          icon="mdiUndo"
          disabled={!undo.length}
          onClick={undoEdit}
        />
        <Button
          aria-label="Redo edit"
          icon="mdiRedo"
          disabled={!redo.length}
          onClick={redoEdit}
        />
      </div>
      <input
        aria-label="Playhead"
        type="range"
        min="0"
        max={duration}
        step="0.1"
        value={session.playbackPosition}
        onChange={(e) =>
          dispatch({ type: "playback", time: Number(e.target.value) })
        }
      />
      <div className="trim-strip">
        <div className="filmstrip">
          {Array.from({ length: 10 }, (_, i) => (
            <img src={selected.image} alt="" key={i} />
          ))}
        </div>
        <div
          className="trim-region"
          style={{
            left: `${(edit.start / duration) * 100}%`,
            width: `${((edit.end - edit.start) / duration) * 100}%`,
          }}
        />
      </div>
      <div className="trim-handles">
        <label>
          In
          <input
            aria-label="Trim in handle"
            type="range"
            min="0"
            max={duration - 0.1}
            step="0.1"
            value={edit.start}
            onChange={(e) =>
              changeEdit({
                start: Math.min(edit.end - 0.1, Number(e.target.value)),
              })
            }
          />
        </label>
        <label>
          Out
          <input
            aria-label="Trim out handle"
            type="range"
            min="0.1"
            max={duration}
            step="0.1"
            value={edit.end}
            onChange={(e) =>
              changeEdit({
                end: Math.max(edit.start + 0.1, Number(e.target.value)),
              })
            }
          />
        </label>
      </div>
      <div className="ruler">
        {Array.from({ length: 7 }, (_, i) => (duration * i) / 6).map(
          (value) => (
            <span key={value}>{timecode(value)}</span>
          ),
        )}
      </div>
    </div>
  );
  if (quick)
    return (
      <Dialog
        title={`Quick edit · ${selected.name}`}
        close={close}
        wide
        actions={
          <>
            <Button
              onClick={() => changeEdit({ ...initialEdit, end: duration })}
            >
              Revert to original
            </Button>
            <Button onClick={openStudio}>Open full editor</Button>
            <Button primary onClick={saveVersion}>
              Save version
            </Button>
          </>
        }
      >
        <div className="quick-workspace">
          <div>
            {preview}
            {timeline}
          </div>
          <aside>
            <div className="quick-tabs">
              {["Trim", "Rotate", "Crop", "Adjust", "Audio"].map((value) => (
                <Button
                  key={value}
                  active={tab === value}
                  onClick={() => setTab(value)}
                >
                  {value}
                </Button>
              ))}
            </div>
            {controls}
            <p className="muted">Prototype draft · no media is rendered.</p>
          </aside>
        </div>
      </Dialog>
    );
  return (
    <main className="studio">
      <div className="studio-header">
        <Button icon="mdiArrowLeft" onClick={back}>
          Library
        </Button>
        <h1>
          Summer in the Rockies<small>Project draft</small>
        </h1>
        <span className="grow" />
        <span className="muted">Editing as Taylor</span>
        <Button onClick={() => setModal("review")}>Review</Button>
        <Button
          primary
          icon="mdiExportVariant"
          onClick={() => setModal("export")}
        >
          Export
        </Button>
      </div>
      <div className="studio-tabs">
        {["Edit", "Color", "Audio", "Motion", "Captions", "Restore"].map(
          (value) => (
            <button
              key={value}
              className={workspace === value ? "current" : ""}
              onClick={() => setWorkspace(value)}
            >
              {value}
            </button>
          ),
        )}
        <span className="grow" />
        <span className="prototype-label">
          Interaction prototype · rendering unavailable
        </span>
      </div>
      <div className="studio-body">
        <aside className="media-bin">
          <h3>Project media</h3>
          <div className="bin-grid">
            {media.slice(0, 8).map((asset) => (
              <button
                key={asset.id}
                onClick={() => openAsset(asset)}
                className={selected.id === asset.id ? "active" : ""}
              >
                <img src={asset.image} alt="" />
                <span>{asset.name}</span>
              </button>
            ))}
          </div>
          <h3>Sequences</h3>
          <Button
            active
            icon="mdiMovieOpenOutline"
            onClick={() => setWorkspace("Edit")}
          >
            Summer in the Rockies
          </Button>
        </aside>
        <section className="program">
          {preview}
          <div className="monitor-label">
            <span>{selected.name}</span>
            <span>3840 × 2160 · 29.97 fps</span>
          </div>
          {timeline}
        </section>
        <aside className="studio-inspector">
          <h3>{workspace === "Edit" ? "Clip inspector" : workspace}</h3>
          {workspace === "Edit" && (
            <div className="quick-tabs">
              {["Trim", "Rotate", "Crop"].map((value) => (
                <Button
                  key={value}
                  active={tab === value}
                  onClick={() => setTab(value)}
                >
                  {value}
                </Button>
              ))}
            </div>
          )}
          {controls}
          <section className="inspector-section">
            <h3>Output policy</h3>
            <p>Original resolution</p>
            <p className="muted">
              Edited masters are independent of playback proxies. HDR and Dolby
              Vision release gates remain closed.
            </p>
          </section>
        </aside>
      </div>
      <div className="multitrack">
        <div className="track">
          <span>V2 · Titles</span>
          <button className="title-clip" onClick={() => setWorkspace("Motion")}>
            {title}
          </button>
        </div>
        <div className="track">
          <span>V1 · Video</span>
          {media
            .filter((asset) => asset.type === "video")
            .map((asset) => (
              <button
                className="video-clip"
                key={asset.id}
                onClick={() => openAsset(asset)}
              >
                <img src={asset.image} alt="" />
                {asset.name}
              </button>
            ))}
        </div>
        <div className="track">
          <span>A1 · Source audio</span>
          <button className="audio-clip" onClick={() => setWorkspace("Audio")}>
            <Icon name="mdiWaveform" />
            Original audio · channels preserved
          </button>
        </div>
      </div>
      {modal === "export" && (
        <Dialog title="Export video" close={() => setModal(null)}>
          <p className="notice">
            Simulation only. Production exports require a qualified studio
            worker.
          </p>
          <label>
            Format
            <select
              value={edit.exportFormat}
              onChange={(e) => changeEdit({ exportFormat: e.target.value })}
            >
              <option>MP4 · H.265 Main10</option>
              <option>MP4 · H.264</option>
              <option>WebM · AV1</option>
            </select>
          </label>
          <label>
            Color
            <select
              value={edit.exportColor}
              onChange={(e) => changeEdit({ exportColor: e.target.value })}
            >
              <option>Preserve source</option>
              <option>HDR10</option>
              <option>Dolby Vision · qualification required</option>
            </select>
          </label>
          <label>
            Destination
            <select
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
            >
              <option value="local">Home workstation · Local GPU</option>
              <option value="runpod">RunPod · Cloud GPU</option>
            </select>
          </label>
          <p>3840 × 2160 · Original channels · Revision snapshot</p>
          <div className="dialog-actions">
            <Button onClick={() => setModal(null)}>Cancel</Button>
            <Button
              primary
              onClick={() => {
                enqueue("Export");
                setModal(null);
              }}
            >
              Simulate export
            </Button>
          </div>
        </Dialog>
      )}
      {modal === "restore" && (
        <Dialog title="Restoration preview" wide close={() => setModal(null)}>
          <p className="notice">
            Comparison layout only. Both panes show the original; no AI output
            has been generated.
          </p>
          <div className="comparison-images">
            {["Original", `${mode} · pending model render`].map((value) => (
              <section key={value}>
                <img src={selected.image} alt={value} />
                <h3>{value}</h3>
              </section>
            ))}
          </div>
          <p>
            5-second sample · 2× upscale · 4K cap ·{" "}
            {destination === "local" ? "Home workstation" : "RunPod"}
          </p>
          <div className="dialog-actions">
            <Button onClick={() => setModal(null)}>Adjust settings</Button>
            <Button
              primary
              onClick={() => {
                enqueue("AI restoration");
                setModal(null);
              }}
            >
              Simulate full render
            </Button>
          </div>
        </Dialog>
      )}
      {modal === "review" && (
        <Dialog title="Project review" close={() => setModal(null)}>
          <p>Sample editor lease: Taylor. Other collaborators can review.</p>
          <label>
            Comment at{" "}
            {timecode(comment ? edit.commentTime : session.playbackPosition)}
            <textarea
              value={comment}
              onChange={(e) =>
                changeEdit({
                  comment: e.target.value,
                  commentTime: session.playbackPosition,
                })
              }
            />
          </label>
          <p className="muted">This is a local draft, not a shared comment.</p>
          <Button primary onClick={() => setModal(null)}>
            Keep draft
          </Button>
        </Dialog>
      )}
    </main>
  );
}

export function Processing({ jobs, setJobs, openStudio }) {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    if (!online) return;
    const timer = setInterval(
      () =>
        setJobs((items) =>
          items.map((job) =>
            ["queued", "preparing", "rendering", "validating"].includes(
              job.status,
            )
              ? {
                  ...job,
                  progress: Math.min(100, job.progress + 8),
                  status:
                    job.progress >= 92
                      ? "completed"
                      : job.progress >= 80
                        ? "validating"
                        : job.progress >= 8
                          ? "rendering"
                          : "preparing",
                }
              : job,
          ),
        ),
      1000,
    );
    return () => clearInterval(timer);
  }, [online]);
  const change = (id, status) =>
    setJobs((items) =>
      items.map((job) => (job.id === id ? { ...job, status } : job)),
    );
  return (
    <main className="workspace-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Processing</p>
          <h1>Activity</h1>
        </div>
        <Button
          icon={online ? "mdiWifiOff" : "mdiWifi"}
          onClick={() => setOnline(!online)}
        >
          {online ? "Simulate disconnect" : "Reconnect"}
        </Button>
      </div>
      <p className="muted">
        Prototype jobs are simulated and stored on this device. Progress
        advances only while Activity is open and connected. Leaving this page
        pauses the demonstration; it does not model a background worker. No
        media is uploaded, rendered, or exported.
      </p>
      {!online && (
        <p className="notice">
          Disconnected simulation. Drafts and jobs remain available.
        </p>
      )}
      {!jobs.length && (
        <div className="empty">
          <Icon name="mdiCheckCircleOutline" size={36} />
          <h2>Nothing processing</h2>
          <p>Start a simulated export or restoration preview from Studio.</p>
          <Button onClick={openStudio}>Open Studio</Button>
        </div>
      )}
      {jobs.map((job) => (
        <article className="job" key={job.id}>
          <Icon name="mdiMovieOpenOutline" size={30} />
          <div>
            <h3>{job.name}</h3>
            <p>
              {job.kind} ·{" "}
              {job.destination === "local" ? "Home workstation" : "RunPod"} ·
              Simulated
            </p>
            {job.snapshot && (
              <p className="muted">
                Frozen draft · {timecode(job.snapshot.edit.start)}–
                {timecode(job.snapshot.edit.end)} ·{" "}
                {job.snapshot.edit.restorationMode} ·{" "}
                {job.snapshot.edit.exportFormat} ·{" "}
                {job.snapshot.edit.exportColor}
              </p>
            )}
            {!job.snapshot && (
              <p className="muted">
                Earlier sample job · no saved revision snapshot
              </p>
            )}
            <progress
              aria-label={`${job.name} simulated progress`}
              max="100"
              value={job.progress}
            />
            <span className="muted">
              {job.status} · {job.progress}%
              {job.status === "completed" && " · No output file generated"}
            </span>
          </div>
          <div className="job-actions">
            {["queued", "preparing", "rendering"].includes(job.status) && (
              <Button onClick={() => change(job.id, "paused")}>Pause</Button>
            )}
            {job.status === "paused" && (
              <Button onClick={() => change(job.id, "rendering")}>
                Resume
              </Button>
            )}
            {!["completed", "cancelled"].includes(job.status) && (
              <Button onClick={() => change(job.id, "cancelled")}>
                Cancel
              </Button>
            )}
            {job.status === "cancelled" && (
              <Button onClick={() => change(job.id, "queued")}>Retry</Button>
            )}
          </div>
        </article>
      ))}
    </main>
  );
}

export function Workers({ destination, setDestination, notify, openActivity }) {
  const [form, setForm] = useState(false);
  return (
    <main className="workspace-page">
      <p className="eyebrow">Administration</p>
      <h1>GPU workers</h1>
      <p className="muted">
        Rendering and AI processing · Sample configuration
      </p>
      <div className="admin-tabs">
        {["GPU workers", "Users", "Storage", "Queues", "Server settings"].map(
          (name) => (
            <Button
              key={name}
              active={name === "GPU workers"}
              onClick={() =>
                name === "Queues"
                  ? openActivity()
                  : name !== "GPU workers" &&
                    notify(
                      `${name} is included in the administration migration manifest.`,
                    )
              }
            >
              {name}
            </Button>
          ),
        )}
      </div>
      <h3 className="eyebrow">Local workers</h3>
      <article className="worker">
        <Icon name="mdiDesktopTowerMonitor" size={34} />
        <div className="worker-body">
          <h2>Home workstation</h2>
          <p className="success">Sample endpoint · local preferred</p>
          <dl>
            <dt>GPU</dt>
            <dd>NVIDIA RTX 4070 Ti SUPER</dd>
            <dt>Memory</dt>
            <dd>16 GB</dd>
            <dt>Host</dt>
            <dd>render.home.arpa</dd>
          </dl>
          {[
            ["Studio rendering", "Qualification required"],
            ["Video restoration", "Model validation required"],
            ["Dolby Vision tools", "Setup needed"],
          ].map(([name, status]) => (
            <div className="capability" key={name}>
              <span>{name}</span>
              <span className={status === "Setup needed" ? "warning" : ""}>
                {status}
              </span>
            </div>
          ))}
          <Button
            onClick={() =>
              notify(
                "Sample endpoint only. Run the studio preflight harness against your actual worker.",
              )
            }
          >
            Test connection
          </Button>
        </div>
      </article>
      <h3 className="eyebrow">Cloud workers</h3>
      <article className="worker">
        <Icon name="mdiCloudOutline" size={34} />
        <div>
          <h2>RunPod</h2>
          <p>Stopped</p>
          <p className="muted">
            Cloud processing is used only when selected for a job.
          </p>
          <Button
            onClick={() => {
              setDestination("runpod");
              notify(
                "RunPod is now the saved default destination for simulated jobs.",
              );
            }}
          >
            Select destination
          </Button>
        </div>
      </article>
      <label className="default-worker">
        Default destination for simulated jobs
        <select
          value={destination}
          onChange={(e) => setDestination(e.target.value)}
        >
          <option value="local">Compatible local worker</option>
          <option value="runpod">RunPod</option>
        </select>
      </label>
      <Button primary icon="mdiPlus" onClick={() => setForm(true)}>
        Add worker
      </Button>
      {form && (
        <Dialog title="Add GPU worker" close={() => setForm(false)}>
          <label>
            Name
            <input placeholder="Home workstation" />
          </label>
          <label>
            Endpoint
            <input placeholder="https://worker.example" />
          </label>
          <p className="muted">
            This form demonstrates setup. No endpoint is contacted or
            registered.
          </p>
          <Button
            primary
            onClick={() => {
              setForm(false);
              notify(
                "Configuration preview complete. No endpoint was registered.",
              );
            }}
          >
            Preview connection check
          </Button>
        </Dialog>
      )}
    </main>
  );
}
