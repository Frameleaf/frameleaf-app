import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { mdiMagnet } from "@mdi/js";
import { Button, Dialog } from "./App";
import { Icon, IconPath } from "./Icon";
import { PersonAvatar } from "./People";
import { CloudJobDialog, useCloudState } from "./CloudJobDialog";
import { detectedWorker, lanWorker, workerGpu } from "./frameleaf-cloud-data.mjs";
import { estimateJob, estimateRange, jobQuantity, modelsFor } from "./cloud-jobs.mjs";
import { ModelSlider, resolveModelChoice, sliderContext } from "./ModelSlider";
import {
  INTERPOLATION_TRADEOFF,
  formatDuration as formatWorkTime,
  interpolationEstimate,
  interpolationWork,
} from "./gpu-model-catalog.mjs";
import { media as libraryMedia, people as libraryPeople } from "./media";
import {
  DEFAULT_FPS,
  activeSequence,
  addClip,
  addMusic,
  addReviewComment,
  addTitle,
  addVoiceover,
  canRedo,
  canUndo,
  captionLanguages,
  clipAt,
  clipEnd,
  clipFromAsset,
  commit,
  createHistory,
  defaultGrade,
  deleteClip,
  destinationName,
  destinations,
  estimateRender,
  exportColors,
  exportFormats,
  findClip,
  formatBytes,
  formatMoney,
  formatSeconds,
  frameTimecode,
  gradeFilter,
  isDefaultGrade,
  kenBurnsAt,
  kenBurnsPresets,
  linkedClips,
  loadProject,
  lookFilter,
  looks,
  makeId,
  moveClip,
  musicLibrary,
  normalizeRect,
  redo,
  removeReviewComment,
  renameProject,
  resolutions,
  restoreModes,
  sampleCaptions,
  sampleProject,
  saveProject,
  setActiveSequence,
  setCaptions,
  setKenBurns,
  setSequenceFields,
  setSettings,
  setSpeed,
  setTrack,
  setTransition,
  shortTimecode,
  snapPoints,
  snapTime,
  speeds,
  retimeMethods,
  splitClipAt,
  studioStorageKey,
  timelineLength,
  titleAnimations,
  titlePositions,
  titleStyles,
  trackAccepts,
  trackOfKind,
  transitionTypes,
  trimClipEnd,
  trimClipStart,
  undo,
  updateClip,
  updateReviewComment,
  upscales,
  waveform,
} from "./studio-project.mjs";
import "./studio.css";

/* ------------------------------------------------------------------ */
/* Constants and small helpers                                          */
/* ------------------------------------------------------------------ */

const TABS = ["Edit", "Color", "Audio", "Motion", "Captions", "Restore"];
const QUALITIES = ["Auto", "Full", "1/2", "1/4"];
const FRAME = 1 / DEFAULT_FPS;
const MIN_PPS = 3;
const MAX_PPS = 240;
const TRACK_META = {
  title: { label: "T1", icon: "mdiFormatTitle", height: 34 },
  overlay: { label: "V2", icon: "mdiLayersOutline", height: 34 },
  video: { label: "V1", icon: "mdiVideoOutline", height: 58 },
  audio: { label: "A1", icon: "mdiWaveform", height: 42 },
  music: { label: "A2", icon: "mdiMusicNoteOutline", height: 42 },
  voice: { label: "A3", icon: "mdiMicrophoneOutline", height: 38 },
};
const POSITION_LABELS = {
  tl: "Top left",
  tc: "Top centre",
  tr: "Top right",
  ml: "Middle left",
  mc: "Centre",
  mr: "Middle right",
  bl: "Bottom left",
  bc: "Bottom centre",
  br: "Bottom right",
};
const SHORTCUTS = [
  ["Space", "Play or pause"],
  ["J · K · L", "Shuttle back, stop, forward"],
  ["← →", "Step one frame (Shift: one second)"],
  ["S", "Split at playhead"],
  ["Delete", "Delete clip (Shift: leave a gap)"],
  ["⌘Z · ⇧⌘Z", "Undo · Redo"],
  ["+ −", "Zoom timeline"],
  [", .", "Nudge selected clip"],
  ["T", "Add a title at playhead"],
  ["Home · End", "Go to start · end"],
];

const slug = (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-");
const clampValue = (value, min, max) => Math.max(min, Math.min(max, value));
const isEditable = (element) =>
  !!element &&
  (["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName) || element.isContentEditable);
const dialogIsOpen = () =>
  typeof document !== "undefined" && !!document.querySelector("dialog[open]");
const rectTransform = (rect) =>
  `scale(${(1 / rect.w).toFixed(4)}) translate(${(-rect.x * 100).toFixed(3)}%, ${(-rect.y * 100).toFixed(3)}%)`;
const dbToGain = (db) => 10 ** (db / 20);
const clipTitle = (clip) => (clip.kind === "title" ? clip.text || "Title" : clip.name);
const clipLabel = (clip) =>
  `${clipTitle(clip)}, ${shortTimecode(clip.start)} to ${shortTimecode(clipEnd(clip))}`;
const hasSound = (clip) => ["video", "audio", "music", "voice"].includes(clip.kind);
const visualKinds = ["video", "photo", "overlay"];

function readStoredProject(assets) {
  try {
    return loadProject(localStorage.getItem(studioStorageKey), {
      assetIds: assets.map((asset) => asset.id),
    });
  } catch {
    return null;
  }
}

function useLatest(value) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

function titlePresentation(clip, time) {
  const elapsed = time - clip.start;
  const remaining = clipEnd(clip) - time;
  const enter = clampValue(elapsed / 0.7, 0, 1);
  const exit = clampValue(remaining / 0.5, 0, 1);
  let transform = "none";
  if (clip.animation === "Rise") transform = `translateY(${((1 - enter) * 24).toFixed(1)}px)`;
  if (clip.animation === "Slide") transform = `translateX(${((1 - enter) * -40).toFixed(1)}px)`;
  const typed =
    clip.animation === "Typewriter"
      ? clip.text.slice(0, Math.ceil(clampValue(elapsed / 1.4, 0, 1) * clip.text.length))
      : clip.text;
  return {
    text: typed,
    style: {
      opacity: clip.animation === "Typewriter" ? exit : Math.min(enter, exit),
      transform,
    },
  };
}

function transitionPresentation(clip, time) {
  if (!clip?.transitionIn) return null;
  const progress = (time - clip.start) / clip.transitionIn.duration;
  if (progress < 0 || progress >= 1) return null;
  const { type } = clip.transitionIn;
  const style = {};
  if (type === "Cross dissolve") style.opacity = progress;
  if (type === "Wipe") style.clipPath = `inset(0 ${((1 - progress) * 100).toFixed(2)}% 0 0)`;
  if (type === "Slide") style.transform = `translateX(${((1 - progress) * 100).toFixed(2)}%)`;
  if (type === "Zoom") {
    style.transform = `scale(${(0.7 + 0.3 * progress).toFixed(3)})`;
    style.opacity = progress;
  }
  return { type, progress, style, dip: type === "Dip to black" ? 1 - progress : 0 };
}

function rulerTicks(length, pps) {
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  const major = steps.find((step) => step * pps >= 72) || 600;
  const minor = major / (major >= 5 ? 5 : 4);
  const ticks = [];
  for (let time = 0; time <= length + major; time += minor) {
    const rounded = Math.round(time * 1000) / 1000;
    ticks.push({
      time: rounded,
      major: Math.abs(rounded / major - Math.round(rounded / major)) < 1e-6,
    });
  }
  return ticks;
}

function coverSource(image) {
  const width = image.naturalWidth || image.videoWidth || 16;
  const height = image.naturalHeight || image.videoHeight || 9;
  const target = 16 / 9;
  if (width / height > target) {
    const sw = height * target;
    return [(width - sw) / 2, 0, sw, height];
  }
  const sh = width / target;
  return [0, (height - sh) / 2, width, sh];
}

/* ------------------------------------------------------------------ */
/* Generic controls                                                     */
/* ------------------------------------------------------------------ */

function TabList({ label, tabs, value, onChange, className = "" }) {
  const refs = useRef([]);
  const onKeyDown = (event, index) => {
    let next = null;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = tabs.length - 1;
    if (next === null) return;
    event.preventDefault();
    onChange(tabs[next]);
    refs.current[next]?.focus();
  };
  return (
    <div role="tablist" aria-label={label} className={className}>
      {tabs.map((tab, index) => (
        <button
          key={tab}
          type="button"
          role="tab"
          aria-selected={value === tab}
          tabIndex={value === tab ? 0 : -1}
          className={value === tab ? "current" : ""}
          ref={(element) => {
            refs.current[index] = element;
          }}
          onClick={() => onChange(tab)}
          onKeyDown={(event) => onKeyDown(event, index)}
        >
          {tab}
        </button>
      ))}
    </div>
  );
}

function Menu({ label, icon, items, value, onSelect, ariaLabel }) {
  const [open, setOpen] = useState(false);
  const root = useRef(null);
  const refs = useRef([]);
  useEffect(() => {
    if (!open) return undefined;
    const close = (event) => {
      if (!root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  useEffect(() => {
    if (open) refs.current[Math.max(0, items.indexOf(value))]?.focus();
  }, [open, items, value]);
  const onKeyDown = (event, index) => {
    let next = null;
    if (event.key === "ArrowDown") next = (index + 1) % items.length;
    if (event.key === "ArrowUp") next = (index - 1 + items.length) % items.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = items.length - 1;
    if (event.key === "Escape" || event.key === "Tab") {
      setOpen(false);
      if (event.key === "Escape") root.current?.querySelector("button")?.focus();
      return;
    }
    if (next === null) return;
    event.preventDefault();
    refs.current[next]?.focus();
  };
  return (
    <div className="fls-menu" ref={root}>
      <Button
        icon={icon}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen(!open)}
      >
        {label}
        <Icon name="mdiChevronDown" size={14} />
      </Button>
      {open && (
        <div role="menu" className="fls-menu-list">
          {items.map((item, index) => (
            <button
              key={item}
              type="button"
              role="menuitemradio"
              aria-checked={item === value}
              ref={(element) => {
                refs.current[index] = element;
              }}
              onClick={() => {
                onSelect(item);
                setOpen(false);
              }}
              onKeyDown={(event) => onKeyDown(event, index)}
            >
              {item === value && <Icon name="mdiCheck" size={14} />}
              <span>{item}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function NumberField({ label, value, onCommit, min = 0, max = 1e6, step = 0.1, unit = "s", disabled }) {
  const format = (number) => String(Math.round(number * 100) / 100);
  const [draft, setDraft] = useState(format(value));
  useEffect(() => {
    setDraft(format(value));
  }, [value]);
  const submit = () => {
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) {
      setDraft(format(value));
      return;
    }
    const next = clampValue(parsed, min, max);
    if (Math.abs(next - value) > 1e-6) onCommit(next);
    else setDraft(format(value));
  };
  return (
    <label className="fls-field">
      <span>{label}</span>
      <span className="fls-field-input">
        <input
          type="number"
          inputMode="decimal"
          min={min}
          max={max}
          step={step}
          value={draft}
          disabled={disabled}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={submit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submit();
            }
          }}
        />
        <em>{unit}</em>
      </span>
    </label>
  );
}

function Slider({ label, value, min, max, step = 0.01, format, onChange, onBegin, onEnd }) {
  return (
    <label className="fls-slider">
      <span className="fls-slider-head">
        <span>{label}</span>
        <output>{format ? format(value) : value}</output>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onPointerDown={onBegin}
        onKeyDown={onBegin}
        onChange={(event) => onChange(Number(event.target.value))}
        onPointerUp={onEnd}
        onKeyUp={onEnd}
        onBlur={onEnd}
      />
    </label>
  );
}

function Switch({ label, checked, onChange, hint }) {
  return (
    <div className="fls-switch-row">
      <div>
        <span>{label}</span>
        {hint && <small className="muted">{hint}</small>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        className={`fls-switch${checked ? " is-on" : ""}`}
        onClick={() => onChange(!checked)}
      >
        <span />
      </button>
    </div>
  );
}

function WaveformSvg({ seed, width, tone }) {
  const samples = clampValue(Math.round(width / 3), 8, 600);
  const path = useMemo(
    () =>
      waveform(seed, samples)
        .map((level, index) => `M${index} ${(50 - level * 46).toFixed(1)}V${(50 + level * 46).toFixed(1)}`)
        .join(""),
    [seed, samples],
  );
  return (
    <svg
      className={`fls-wave fls-wave--${tone}`}
      viewBox={`0 0 ${samples} 100`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <path d={path} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Timeline pieces                                                      */
/* ------------------------------------------------------------------ */

function TrackHead({ track, meta, onToggle, extra }) {
  const audible = ["audio", "music", "voice"].includes(track.kind);
  return (
    <div className={`fls-track-head fls-track-head--${track.kind}`} style={{ height: meta.height }}>
      <span className="fls-track-label">
        <Icon name={meta.icon} size={14} />
        <b>{meta.label}</b>
        <span>{track.name}</span>
      </span>
      <span className="fls-track-tools">
        {extra}
        <button
          type="button"
          className={`fls-mini${track.muted ? " is-on" : ""}`}
          aria-label={`${track.muted ? "Unmute" : "Mute"} ${track.name}`}
          aria-pressed={track.muted}
          onClick={() => onToggle(track.id, { muted: !track.muted })}
        >
          M
        </button>
        {audible && (
          <button
            type="button"
            className={`fls-mini${track.solo ? " is-on" : ""}`}
            aria-label={`Solo ${track.name}`}
            aria-pressed={track.solo}
            onClick={() => onToggle(track.id, { solo: !track.solo })}
          >
            S
          </button>
        )}
        <button
          type="button"
          className={`fls-mini${track.locked ? " is-on" : ""}`}
          aria-label={`${track.locked ? "Unlock" : "Lock"} ${track.name}`}
          aria-pressed={track.locked}
          onClick={() => onToggle(track.id, { locked: !track.locked })}
        >
          <Icon name={track.locked ? "mdiLockOutline" : "mdiLockOpenVariantOutline"} size={13} />
        </button>
      </span>
    </div>
  );
}

function TimelineClip({
  clip,
  track,
  asset,
  pps,
  selected,
  linked,
  onPointerDown,
  onTrimPointerDown,
  onSelect,
  onOpenTransition,
  onSeek,
}) {
  const width = Math.max(6, clip.duration * pps);
  const { kind } = clip;
  const audible = ["audio", "music", "voice"].includes(kind);
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={clipLabel(clip)}
      aria-pressed={selected}
      className={`fls-clip fls-clip--${kind}${selected ? " is-selected" : ""}${linked ? " is-linked" : ""}${track.locked ? " is-locked" : ""}`}
      style={{ left: clip.start * pps, width }}
      onPointerDown={(event) => onPointerDown(event, clip, track)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          event.stopPropagation();
          onSelect(clip.id);
        }
      }}
      onDoubleClick={() => onSeek(clip.start)}
    >
      {visualKinds.includes(kind) && asset && (
        <div className="fls-clip-film" style={{ backgroundImage: `url(${asset.image})` }} aria-hidden="true" />
      )}
      {audible && <WaveformSvg seed={clip.seed} width={width} tone={kind} />}
      {clip.transitionIn && (
        <button
          type="button"
          className="fls-transition"
          style={{ width: Math.max(16, clip.transitionIn.duration * pps) }}
          aria-label={`${clip.transitionIn.type}, ${clip.transitionIn.duration} seconds`}
          title={clip.transitionIn.type}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onOpenTransition(clip.id);
          }}
        >
          <Icon name="mdiTransition" size={12} />
        </button>
      )}
      {width > 44 && <span className="fls-clip-name">{clipTitle(clip)}</span>}
      {clip.speed !== 1 && <span className="fls-badge">{clip.speed}×</span>}
      {clip.muted && (
        <span className="fls-badge">
          <Icon name="mdiVolumeOff" size={11} />
        </span>
      )}
      {!track.locked && (
        <>
          <div
            className="fls-trim fls-trim--start"
            onPointerDown={(event) => onTrimPointerDown(event, clip, track, "start")}
          />
          <div
            className="fls-trim fls-trim--end"
            onPointerDown={(event) => onTrimPointerDown(event, clip, track, "end")}
          />
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Smooth motion (frame interpolation)                                  */
/* ------------------------------------------------------------------ */

/** The Smooth motion model for a job, following the model slider and routing. */
function useInterpolationChoice(savedId) {
  const cloud = useCloudState();
  return { cloud, resolved: resolveModelChoice(cloud, "interpolation", savedId ?? cloud.processing.defaultModels?.interpolation) };
}

/**
 * How missing frames are made: duplicated, blended, or created by AI
 * interpolation (with the Smooth motion model slider, time or cost, and size).
 */
function FrameMethod({ legend, method, setMethod, modelId, setModel, durationSeconds, sourceFps, targetFps }) {
  const { cloud, resolved } = useInterpolationChoice(modelId);
  const work = interpolationWork({ durationSeconds, sourceFps, targetFps });
  const estimate = resolved
    ? interpolationEstimate(resolved.item, work, {
        ...sliderContext(cloud, "interpolation"),
        band: resolved.runsOn === "cloud" ? "cloud" : undefined,
      })
    : null;
  const chosen = retimeMethods.find((item) => item.id === method) ?? retimeMethods[1];
  return (
    <div className="fls-frame-method">
      <div className="fls-segmented" role="radiogroup" aria-label={legend}>
        {retimeMethods.map((item) => (
          <button
            key={item.id}
            type="button"
            role="radio"
            aria-checked={method === item.id}
            className={method === item.id ? "is-on" : ""}
            onClick={() => setMethod(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <p className="muted fls-note">{chosen.help}</p>
      {method === "ai" && (
        <>
          <ModelSlider
            state={cloud}
            workload="interpolation"
            value={resolved?.item.id}
            label="Smooth motion model"
            hideLegend
            onChange={(id) => setModel(id)}
          />
          {estimate && (
            <dl className="fls-facts">
              <dt>{estimate.runsOn === "cloud" ? "Cloud cost" : "Time"}</dt>
              <dd>
                {estimate.runsOn === "cloud"
                  ? `about ${estimateRange(estimate.cost)} · confirmed before anything is sent`
                  : `about ${formatWorkTime(estimate.seconds)} on ${estimate.runsOn === "gpu" ? "your GPU" : "the processor"}`}
              </dd>
              <dt>Size</dt>
              <dd>about {estimate.sizeFactor}× the frames</dd>
            </dl>
          )}
          <p className="muted fls-note">{INTERPOLATION_TRADEOFF}</p>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Inspector panels                                                     */
/* ------------------------------------------------------------------ */

function EditInspector({
  clip,
  track,
  asset,
  audioTwin,
  apply,
  quiet,
  beginGesture,
  endGesture,
  advanced,
  onOpenTransition,
  onGoToMotion,
  splitAtPlayhead,
  removeSelection,
  playhead,
  seek,
  notify,
}) {
  const soundClip = clip.kind === "video" ? audioTwin : hasSound(clip) ? clip : null;
  const bounded = Number.isFinite(clip.sourceDuration);
  const inside = playhead >= clip.start && playhead < clipEnd(clip);
  return (
    <div className="fls-panel">
      <div className="fls-clip-card">
        {asset ? (
          <img src={asset.image} alt="" />
        ) : (
          <span className={`fls-clip-card-icon fls-clip--${clip.kind}`}>
            <Icon name={TRACK_META[track.kind].icon} size={20} />
          </span>
        )}
        <div>
          <h3>{clipTitle(clip)}</h3>
          <p className="muted">
            {TRACK_META[track.kind].label} · {track.name} ·{" "}
            {bounded ? `${shortTimecode(clip.in)}–${shortTimecode(clip.out)} of ${shortTimecode(clip.sourceDuration)}` : `${clip.duration.toFixed(1)} s`}
          </p>
        </div>
      </div>
      {!inside && (
        <button type="button" className="fls-link" onClick={() => seek(clip.start)}>
          <Icon name="mdiChevronRight" size={14} /> Go to this clip
        </button>
      )}
      <section className="fls-section">
        <h4>Timing</h4>
        <div className="fls-grid-2">
          <NumberField
            label="Start"
            value={clip.start}
            onCommit={(value) => apply((project) => moveClip(project, clip.id, { start: value }))}
          />
          <NumberField
            label="Duration"
            value={clip.duration}
            min={0.1}
            onCommit={(value) =>
              apply((project) => trimClipEnd(project, clip.id, clip.start + value, { ripple: true }))
            }
          />
          {bounded && (
            <>
              <NumberField
                label="In"
                value={clip.in}
                max={clip.sourceDuration - 0.1}
                onCommit={(value) =>
                  apply((project) =>
                    trimClipStart(project, clip.id, clip.start + (value - clip.in) / clip.speed, { ripple: true }),
                  )
                }
              />
              <NumberField
                label="Out"
                value={clip.out}
                min={0.1}
                max={clip.sourceDuration}
                onCommit={(value) =>
                  apply((project) =>
                    trimClipEnd(project, clip.id, clip.start + (value - clip.in) / clip.speed, { ripple: true }),
                  )
                }
              />
            </>
          )}
        </div>
        {bounded && clip.kind !== "music" && (
          <label className="fls-field">
            <span>Speed</span>
            <select
              value={clip.speed}
              onChange={(event) => apply((project) => setSpeed(project, clip.id, Number(event.target.value)))}
            >
              {speeds.map((speed) => (
                <option key={speed} value={speed}>
                  {speed}× {speed === 1 ? "· normal" : speed < 1 ? "· slow motion" : "· fast"}
                </option>
              ))}
            </select>
          </label>
        )}
        {bounded && clip.kind === "video" && clip.speed < 1 && (
          <div className="fls-field" role="group" aria-label="Slow-motion frames">
            <span>Slow-motion frames</span>
            <FrameMethod
              legend="Slow-motion frames"
              method={clip.retime}
              setMethod={(retime) => apply((project) => updateClip(project, clip.id, { retime }))}
              modelId={clip.retimeModel}
              setModel={(retimeModel) => apply((project) => updateClip(project, clip.id, { retimeModel }))}
              durationSeconds={clip.duration * clip.speed}
              sourceFps={30}
              targetFps={30 / clip.speed}
            />
            <small className="muted fls-note">New frames are made when you export or render this sequence.</small>
          </div>
        )}
        {!["audio", "voice"].includes(clip.kind) && (
          <Button icon="mdiTransition" onClick={() => onOpenTransition(clip.id)}>
            {clip.transitionIn ? `${clip.transitionIn.type} · ${clip.transitionIn.duration}s` : "Add transition"}
          </Button>
        )}
      </section>
      {soundClip && (
        <section className="fls-section">
          <h4>Sound</h4>
          <Slider
            label="Volume"
            value={soundClip.volume}
            min={0}
            max={2}
            format={(value) => (value === 0 ? "Muted" : `${(20 * Math.log10(value)).toFixed(1)} dB`)}
            onBegin={beginGesture}
            onEnd={endGesture}
            onChange={(value) => quiet((project) => updateClip(project, soundClip.id, { volume: value }))}
          />
          <Switch
            label="Mute clip"
            checked={soundClip.muted}
            onChange={(checked) => apply((project) => updateClip(project, soundClip.id, { muted: checked }))}
          />
        </section>
      )}
      {clip.kind === "title" && (
        <section className="fls-section">
          <h4>Title</h4>
          <label className="fls-field">
            <span>Text</span>
            <input
              value={clip.text}
              maxLength={200}
              onChange={(event) => quiet((project) => updateClip(project, clip.id, { text: event.target.value }))}
              onFocus={beginGesture}
              onBlur={endGesture}
            />
          </label>
          <Button icon="mdiAnimationPlayOutline" onClick={onGoToMotion}>
            Style and animation
          </Button>
        </section>
      )}
      {["photo", "overlay"].includes(clip.kind) && (
        <section className="fls-section">
          <h4>Motion</h4>
          <p className="muted">
            {clip.kenBurns ? "Ken Burns move applied." : "Still photo, no motion."}
          </p>
          <Button icon="mdiCursorMove" onClick={onGoToMotion}>
            Edit Ken Burns
          </Button>
        </section>
      )}
      {advanced && visualKinds.includes(clip.kind) && (
        <section className="fls-section">
          <h4>Transform</h4>
          <div className="fls-grid-2">
            <NumberField label="Position X" unit="%" min={-100} max={100} step={1} value={(clip.transform?.x ?? 0) * 100} onCommit={(value) => apply((project) => updateClip(project, clip.id, { transform: { ...(clip.transform || {}), x: value / 100 } }))} />
            <NumberField label="Position Y" unit="%" min={-100} max={100} step={1} value={(clip.transform?.y ?? 0) * 100} onCommit={(value) => apply((project) => updateClip(project, clip.id, { transform: { ...(clip.transform || {}), y: value / 100 } }))} />
            <NumberField label="Scale" unit="%" min={10} max={400} step={1} value={(clip.transform?.scale ?? 1) * 100} onCommit={(value) => apply((project) => updateClip(project, clip.id, { transform: { ...(clip.transform || {}), scale: value / 100 } }))} />
            <NumberField label="Rotation" unit="°" min={-180} max={180} step={1} value={clip.transform?.rotation ?? 0} onCommit={(value) => apply((project) => updateClip(project, clip.id, { transform: { ...(clip.transform || {}), rotation: value } }))} />
            <NumberField label="Opacity" unit="%" min={0} max={100} step={1} value={(clip.transform?.opacity ?? 1) * 100} onCommit={(value) => apply((project) => updateClip(project, clip.id, { transform: { ...(clip.transform || {}), opacity: value / 100 } }))} />
          </div>
          <div className="fls-keyframes">
            <span className="muted">Keyframes</span>
            <Button icon="mdiRhombusOutline" onClick={() => notify(`Keyframe added at ${frameTimecode(playhead)}`)}>
              Add at playhead
            </Button>
          </div>
        </section>
      )}
      <section className="fls-section fls-actions">
        <Button icon="mdiScissorsCutting" onClick={splitAtPlayhead} disabled={!inside}>
          Split
        </Button>
        <Button icon="mdiDeleteOutline" onClick={() => removeSelection(true)}>
          Delete
        </Button>
        <Button onClick={() => removeSelection(false)}>Lift</Button>
      </section>
    </div>
  );
}

function SequenceSummary({ sequence, length, advanced }) {
  const count = sequence.tracks.reduce((total, track) => total + track.clips.length, 0);
  return (
    <div className="fls-panel">
      <section className="fls-section">
        <h4>{sequence.name}</h4>
        <dl className="fls-facts">
          <dt>Duration</dt>
          <dd>{frameTimecode(length, sequence.fps)}</dd>
          <dt>Clips</dt>
          <dd>{count}</dd>
          <dt>Frame</dt>
          <dd>
            {sequence.width} × {sequence.height} · {sequence.fps} fps
          </dd>
        </dl>
        <p className="muted">Select a clip in the timeline to edit it, or drag media from the bin.</p>
      </section>
      <section className="fls-section">
        <h4>Keyboard</h4>
        <ul className="fls-shortcuts">
          {SHORTCUTS.slice(0, advanced ? SHORTCUTS.length : 6).map(([keys, what]) => (
            <li key={keys}>
              <kbd>{keys}</kbd>
              <span>{what}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function ColorWheel({ label, value, onChange, onBegin, onEnd }) {
  const disc = useRef(null);
  const size = 84;
  const radius = size / 2 - 9;
  const set = (clientX, clientY) => {
    const rect = disc.current.getBoundingClientRect();
    let x = (clientX - rect.left - rect.width / 2) / radius;
    let y = -(clientY - rect.top - rect.height / 2) / radius;
    const length = Math.hypot(x, y);
    if (length > 1) {
      x /= length;
      y /= length;
    }
    onChange({ x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 });
  };
  const onPointerDown = (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    onBegin();
    set(event.clientX, event.clientY);
    const move = (moveEvent) => set(moveEvent.clientX, moveEvent.clientY);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      onEnd();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const onKeyDown = (event) => {
    const step = event.shiftKey ? 0.1 : 0.03;
    const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[event.key];
    if (!delta) return;
    event.preventDefault();
    onBegin();
    onChange({
      x: Math.round(clampValue(value.x + delta[0], -1, 1) * 100) / 100,
      y: Math.round(clampValue(value.y + delta[1], -1, 1) * 100) / 100,
    });
  };
  const angle = Math.round((Math.atan2(value.y, value.x) * 180) / Math.PI);
  const strength = Math.round(Math.hypot(value.x, value.y) * 100);
  return (
    <div className="fls-wheel">
      <div className="fls-wheel-disc" ref={disc} style={{ width: size, height: size }} onPointerDown={onPointerDown}>
        <button
          type="button"
          role="slider"
          aria-label={`${label} colour balance`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={strength}
          aria-valuetext={strength ? `${strength}% toward ${angle}°` : "neutral"}
          className="fls-wheel-puck"
          style={{ left: `${50 + value.x * 41}%`, top: `${50 - value.y * 41}%` }}
          onKeyDown={onKeyDown}
          onKeyUp={onEnd}
          onBlur={onEnd}
        />
      </div>
      <span>{label}</span>
      <button type="button" className="fls-link" onClick={() => onChange({ x: 0, y: 0 })}>
        Reset
      </button>
    </div>
  );
}

function Scopes({ sourceRef, filter, playhead, playing, active }) {
  const waveformRef = useRef(null);
  const vectorRef = useRef(null);
  const histogramRef = useRef(null);
  const offscreen = useRef(null);
  const last = useRef(0);
  useEffect(() => {
    if (!active) return;
    const now = performance.now();
    if (playing && now - last.current < 120) return;
    last.current = now;
    const source = sourceRef.current?.();
    const wave = waveformRef.current;
    const vector = vectorRef.current;
    const histogram = histogramRef.current;
    if (!source || !wave || !vector || !histogram) return;
    try {
      if (!offscreen.current) {
        offscreen.current = document.createElement("canvas");
        offscreen.current.width = 96;
        offscreen.current.height = 54;
      }
      const context = offscreen.current.getContext("2d", { willReadFrequently: true });
      if (!context) return;
      if ("filter" in context) context.filter = filter || "none";
      context.clearRect(0, 0, 96, 54);
      context.drawImage(source, ...coverSource(source), 0, 0, 96, 54);
      const { data } = context.getImageData(0, 0, 96, 54);
      const wctx = wave.getContext("2d");
      const vctx = vector.getContext("2d");
      const hctx = histogram.getContext("2d");
      if (!wctx || !vctx || !hctx) return;
      const W = wave.width;
      const H = wave.height;
      wctx.clearRect(0, 0, W, H);
      vctx.clearRect(0, 0, vector.width, vector.height);
      hctx.clearRect(0, 0, histogram.width, histogram.height);
      const bins = [new Uint32Array(64), new Uint32Array(64), new Uint32Array(64)];
      wctx.fillStyle = "rgba(125, 211, 160, 0.45)";
      vctx.fillStyle = "rgba(14, 165, 160, 0.6)";
      const cx = vector.width / 2;
      const cy = vector.height / 2;
      const scale = Math.min(cx, cy) / 140;
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const pixel = i / 4;
        const column = pixel % 96;
        const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        wctx.fillRect((column / 96) * W, H - (luma / 255) * H, Math.max(1, W / 96), 1.5);
        const cb = -0.1687 * r - 0.3313 * g + 0.5 * b;
        const cr = 0.5 * r - 0.4187 * g - 0.0813 * b;
        vctx.fillRect(cx + cb * scale, cy - cr * scale, 1.5, 1.5);
        bins[0][r >> 2] += 1;
        bins[1][g >> 2] += 1;
        bins[2][b >> 2] += 1;
      }
      const peak = Math.max(1, ...bins.flatMap((bin) => [...bin]));
      const colors = ["rgba(239, 83, 80, 0.55)", "rgba(125, 211, 160, 0.55)", "rgba(59, 130, 246, 0.55)"];
      bins.forEach((bin, channel) => {
        hctx.fillStyle = colors[channel];
        const bw = histogram.width / 64;
        bin.forEach((count, index) => {
          const height = (count / peak) * histogram.height;
          hctx.fillRect(index * bw, histogram.height - height, bw - 0.5, height);
        });
      });
      // Graticules.
      vctx.strokeStyle = "rgba(255,255,255,0.18)";
      vctx.beginPath();
      vctx.arc(cx, cy, Math.min(cx, cy) - 2, 0, Math.PI * 2);
      vctx.stroke();
      wctx.strokeStyle = "rgba(255,255,255,0.14)";
      for (const level of [0.25, 0.5, 0.75]) {
        wctx.beginPath();
        wctx.moveTo(0, H * level);
        wctx.lineTo(W, H * level);
        wctx.stroke();
      }
    } catch {
      /* The frame is not readable yet; try again on the next update. */
    }
  }, [active, playhead, playing, filter, sourceRef]);
  return (
    <div className="fls-scopes">
      <figure>
        <canvas ref={waveformRef} width={220} height={110} aria-label="Luma waveform" role="img" />
        <figcaption>Waveform</figcaption>
      </figure>
      <figure>
        <canvas ref={vectorRef} width={110} height={110} aria-label="Vectorscope" role="img" />
        <figcaption>Vectorscope</figcaption>
      </figure>
      <figure>
        <canvas ref={histogramRef} width={220} height={80} aria-label="RGB histogram" role="img" />
        <figcaption>Histogram</figcaption>
      </figure>
    </div>
  );
}

function ColorPanel({ clip, asset, apply, quiet, beginGesture, endGesture, advanced, sourceRef, playhead, playing, inside, seek }) {
  if (!clip) {
    return (
      <div className="fls-panel">
        <p className="muted">Put the playhead on a video or photo clip, or select one, to grade it.</p>
      </div>
    );
  }
  const grade = clip.grade || defaultGrade();
  const patch = (fields, gesture = false) =>
    (gesture ? quiet : apply)((project) => updateClip(project, clip.id, { grade: { ...grade, ...fields } }));
  const thumb = asset?.image;
  return (
    <div className="fls-panel">
      <div className="fls-panel-head">
        <h4>{clipTitle(clip)}</h4>
        {!inside && (
          <button type="button" className="fls-link" onClick={() => seek(clip.start)}>
            Go to clip
          </button>
        )}
      </div>
      {advanced && (
        <Scopes sourceRef={sourceRef} filter={gradeFilter(grade)} playhead={playhead} playing={playing} active={inside} />
      )}
      <section className="fls-section">
        <h4>Look</h4>
        <div className="fls-looks" role="radiogroup" aria-label="Look">
          {looks.map((look) => (
            <button
              key={look.id}
              type="button"
              role="radio"
              aria-checked={grade.look === look.id}
              className={`fls-look${grade.look === look.id ? " is-on" : ""}`}
              onClick={() => patch({ look: look.id })}
            >
              {thumb ? (
                <img src={thumb} alt="" style={{ filter: lookFilter(look.id) }} />
              ) : (
                <span className="fls-look-blank" style={{ filter: lookFilter(look.id) }} />
              )}
              <span>{look.name}</span>
            </button>
          ))}
        </div>
        <Slider
          label="Intensity"
          value={grade.intensity}
          min={0}
          max={1}
          format={(value) => `${Math.round(value * 100)}%`}
          onBegin={beginGesture}
          onEnd={endGesture}
          onChange={(value) => patch({ intensity: value }, true)}
        />
      </section>
      <section className="fls-section">
        <h4>Adjust</h4>
        <Slider label="Exposure" value={grade.exposure} min={-2} max={2} step={0.05} format={(value) => `${value > 0 ? "+" : ""}${value.toFixed(2)} EV`} onBegin={beginGesture} onEnd={endGesture} onChange={(value) => patch({ exposure: value }, true)} />
        <Slider label="Contrast" value={grade.contrast} min={-1} max={1} format={(value) => `${Math.round(value * 100)}`} onBegin={beginGesture} onEnd={endGesture} onChange={(value) => patch({ contrast: value }, true)} />
        <Slider label="Saturation" value={grade.saturation} min={-1} max={1} format={(value) => `${Math.round(value * 100)}`} onBegin={beginGesture} onEnd={endGesture} onChange={(value) => patch({ saturation: value }, true)} />
        <Slider label="Temperature" value={grade.temperature} min={-1} max={1} format={(value) => (value === 0 ? "Neutral" : value > 0 ? `Warm ${Math.round(value * 100)}` : `Cool ${Math.round(-value * 100)}`)} onBegin={beginGesture} onEnd={endGesture} onChange={(value) => patch({ temperature: value }, true)} />
      </section>
      {advanced && (
        <section className="fls-section">
          <h4>Colour wheels</h4>
          <div className="fls-wheels">
            {["lift", "gamma", "gain"].map((wheel) => (
              <ColorWheel
                key={wheel}
                label={wheel[0].toUpperCase() + wheel.slice(1)}
                value={grade.wheels[wheel]}
                onBegin={beginGesture}
                onEnd={endGesture}
                onChange={(value) => patch({ wheels: { ...grade.wheels, [wheel]: value } }, true)}
              />
            ))}
          </div>
        </section>
      )}
      <div className="fls-actions">
        <Button icon="mdiRestore" disabled={isDefaultGrade(clip.grade)} onClick={() => apply((project) => updateClip(project, clip.id, { grade: null }))}>
          Reset grade
        </Button>
      </div>
      <p className="muted fls-note">Monitor colour is a display approximation.</p>
    </div>
  );
}

function AudioPanel({ sequence, project, apply, quiet, beginGesture, endGesture, playhead, playing, notify, advanced }) {
  const tracks = sequence.tracks.filter((track) => ["audio", "music", "voice"].includes(track.kind));
  const anySolo = tracks.some((track) => track.solo);
  const voiceActive = !!clipAt(trackOfKind(sequence, "voice"), playhead);
  const ducking = project.settings.ducking;
  const level = (track, side) => {
    if (!playing || track.muted || (anySolo && !track.solo)) return 0;
    const clip = clipAt(track, playhead);
    if (!clip || clip.muted) return 0;
    const samples = waveform(clip.seed + side, 240);
    const raw = samples[Math.floor((playhead - clip.start) * 12) % samples.length];
    const duck = ducking && voiceActive && track.kind === "music" ? 0.35 : 1;
    return clampValue(raw * clip.volume * dbToGain(track.gain) * duck, 0, 1);
  };
  return (
    <div className="fls-panel">
      {tracks.map((track) => (
        <section className="fls-section fls-fader" key={track.id}>
          <div className="fls-fader-head">
            <span className="fls-track-label">
              <Icon name={TRACK_META[track.kind].icon} size={14} />
              <b>{TRACK_META[track.kind].label}</b>
              <span>{track.name}</span>
            </span>
            <span className="fls-track-tools">
              <button type="button" className={`fls-mini${track.muted ? " is-on" : ""}`} aria-pressed={track.muted} aria-label={`Mute ${track.name}`} onClick={() => apply((p) => setTrack(p, track.id, { muted: !track.muted }))}>M</button>
              <button type="button" className={`fls-mini${track.solo ? " is-on" : ""}`} aria-pressed={track.solo} aria-label={`Solo ${track.name}`} onClick={() => apply((p) => setTrack(p, track.id, { solo: !track.solo }))}>S</button>
            </span>
          </div>
          <div className="fls-meter" aria-hidden="true">
            {[0, 1].map((side) => (
              <span key={side} className="fls-meter-bar">
                <span style={{ transform: `scaleX(${level(track, side).toFixed(3)})` }} />
              </span>
            ))}
          </div>
          <Slider
            label="Gain"
            value={track.gain}
            min={-24}
            max={12}
            step={0.5}
            format={(value) => `${value > 0 ? "+" : ""}${value.toFixed(1)} dB`}
            onBegin={beginGesture}
            onEnd={endGesture}
            onChange={(value) => quiet((p) => setTrack(p, track.id, { gain: value }))}
          />
        </section>
      ))}
      <section className="fls-section">
        <Switch
          label="Duck music under voice"
          hint="Lowers music by 9 dB while a voiceover plays"
          checked={ducking}
          onChange={(checked) => apply((p) => setSettings(p, { ducking: checked }))}
        />
        <div className="fls-actions">
          <Button
            icon="mdiAutoFix"
            onClick={() => {
              apply((p) => {
                let next = p;
                for (const track of tracks) next = setTrack(next, track.id, { gain: 0 });
                return next;
              });
              notify("Levels normalised to −14 LUFS for the whole sequence.");
            }}
          >
            Normalise levels
          </Button>
        </div>
        {advanced && <p className="muted fls-note">Loudness target −14 LUFS · true peak −1 dBTP.</p>}
      </section>
    </div>
  );
}

function KenBurnsEditor({ asset, value, onChange, onBegin, onEnd }) {
  const frame = useRef(null);
  const [active, setActive] = useState("from");
  const still = useMemo(() => ({ from: normalizeRect({}), to: normalizeRect({}) }), []);
  const rects = value || still;
  const update = (key, rect) => onChange({ ...rects, [key]: normalizeRect(rect) });
  const startDrag = (event, key, mode) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    setActive(key);
    onBegin();
    const bounds = frame.current.getBoundingClientRect();
    const origin = { x: event.clientX, y: event.clientY, rect: rects[key] };
    const move = (moveEvent) => {
      const dx = (moveEvent.clientX - origin.x) / bounds.width;
      const dy = (moveEvent.clientY - origin.y) / bounds.height;
      if (mode === "move") update(key, { ...origin.rect, x: origin.rect.x + dx, y: origin.rect.y + dy });
      else {
        const size = clampValue(origin.rect.w + Math.max(dx, dy), 0.2, 1);
        update(key, { ...origin.rect, w: size, h: size });
      }
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      onEnd();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const onKeyDown = (event, key) => {
    const rect = rects[key];
    const step = 0.02;
    let next = null;
    if (event.shiftKey && (event.key === "ArrowUp" || event.key === "ArrowRight"))
      next = { ...rect, w: rect.w + step, h: rect.h + step };
    else if (event.shiftKey && (event.key === "ArrowDown" || event.key === "ArrowLeft"))
      next = { ...rect, w: rect.w - step, h: rect.h - step };
    else if (event.key === "ArrowLeft") next = { ...rect, x: rect.x - step };
    else if (event.key === "ArrowRight") next = { ...rect, x: rect.x + step };
    else if (event.key === "ArrowUp") next = { ...rect, y: rect.y - step };
    else if (event.key === "ArrowDown") next = { ...rect, y: rect.y + step };
    if (!next) return;
    event.preventDefault();
    onBegin();
    update(key, next);
  };
  const presetName =
    Object.entries(kenBurnsPresets).find(([, preset]) => JSON.stringify(preset) === JSON.stringify(value))?.[0] || "Custom";
  return (
    <div className="fls-kb">
      <div className="fls-kb-frame" ref={frame}>
        {asset && <img src={asset.image} alt="" />}
        {["from", "to"].map((key) => (
          <div
            key={key}
            role="button"
            tabIndex={0}
            aria-label={`${key === "from" ? "Start" : "End"} frame, ${Math.round(rects[key].w * 100)}% of the photo. Arrow keys move, Shift and arrows resize.`}
            className={`fls-kb-rect fls-kb-rect--${key}${active === key ? " is-active" : ""}`}
            style={{ left: `${rects[key].x * 100}%`, top: `${rects[key].y * 100}%`, width: `${rects[key].w * 100}%`, height: `${rects[key].h * 100}%` }}
            onPointerDown={(event) => startDrag(event, key, "move")}
            onFocus={() => setActive(key)}
            onKeyDown={(event) => onKeyDown(event, key)}
            onKeyUp={onEnd}
            onBlur={onEnd}
          >
            <span className="fls-kb-tag">{key === "from" ? "Start" : "End"}</span>
            <span className="fls-kb-handle" onPointerDown={(event) => startDrag(event, key, "resize")} />
          </div>
        ))}
        {rects.from.x === rects.to.x && rects.from.y === rects.to.y && rects.from.w === rects.to.w ? null : (
          <svg className="fls-kb-arrow" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            <line x1={(rects.from.x + rects.from.w / 2) * 100} y1={(rects.from.y + rects.from.h / 2) * 100} x2={(rects.to.x + rects.to.w / 2) * 100} y2={(rects.to.y + rects.to.h / 2) * 100} vectorEffect="non-scaling-stroke" />
          </svg>
        )}
      </div>
      <div className="fls-grid-2">
        <label className="fls-field">
          <span>Preset</span>
          <select
            value={presetName}
            onChange={(event) => {
              const preset = kenBurnsPresets[event.target.value];
              onChange(preset === undefined ? rects : preset);
            }}
          >
            {Object.keys(kenBurnsPresets).map((name) => (
              <option key={name}>{name}</option>
            ))}
            {presetName === "Custom" && <option>Custom</option>}
          </select>
        </label>
        <Button icon="mdiSwapHorizontal" onClick={() => onChange({ from: rects.to, to: rects.from })}>
          Swap
        </Button>
      </div>
    </div>
  );
}

function MotionPanel({ clip, asset, apply, quiet, beginGesture, endGesture, advanced, onAddTitle, playhead, seek }) {
  if (!clip) {
    return (
      <div className="fls-panel">
        <p className="muted">Select a title or a photo in the timeline to animate it.</p>
        <Button icon="mdiFormatTitle" onClick={onAddTitle}>
          Add a title at playhead
        </Button>
      </div>
    );
  }
  const inside = playhead >= clip.start && playhead < clipEnd(clip);
  if (clip.kind === "title") {
    return (
      <div className="fls-panel">
        <div className="fls-panel-head">
          <h4>Title</h4>
          {!inside && (
            <button type="button" className="fls-link" onClick={() => seek(clip.start + 0.8)}>
              Go to clip
            </button>
          )}
        </div>
        <label className="fls-field">
          <span>Text</span>
          <input
            value={clip.text}
            maxLength={200}
            onFocus={beginGesture}
            onBlur={endGesture}
            onChange={(event) => quiet((project) => updateClip(project, clip.id, { text: event.target.value }))}
          />
        </label>
        <section className="fls-section">
          <h4>Style</h4>
          <div className="fls-title-styles" role="radiogroup" aria-label="Title style">
            {titleStyles.map((style) => (
              <button
                key={style}
                type="button"
                role="radio"
                aria-checked={clip.style === style}
                className={`fls-title-style${clip.style === style ? " is-on" : ""}`}
                onClick={() => apply((project) => updateClip(project, clip.id, { style }))}
              >
                <span className={`fls-title-sample fls-title--${slug(style)}`} style={asset ? { backgroundImage: `url(${asset.image})` } : undefined}>
                  <span>{clip.text || "Title"}</span>
                </span>
                <span>{style}</span>
              </button>
            ))}
          </div>
        </section>
        <section className="fls-section">
          <h4>Position</h4>
          <div className="fls-grid-9" role="radiogroup" aria-label="Title position">
            {titlePositions.map((position) => (
              <button
                key={position}
                type="button"
                role="radio"
                aria-checked={clip.position === position}
                aria-label={POSITION_LABELS[position]}
                className={clip.position === position ? "is-on" : ""}
                onClick={() => apply((project) => updateClip(project, clip.id, { position }))}
              >
                <span />
              </button>
            ))}
          </div>
        </section>
        <section className="fls-section">
          <h4>Animation</h4>
          <div className="fls-segmented" role="radiogroup" aria-label="Animation">
            {titleAnimations.map((animation) => (
              <button
                key={animation}
                type="button"
                role="radio"
                aria-checked={clip.animation === animation}
                className={clip.animation === animation ? "is-on" : ""}
                onClick={() => apply((project) => updateClip(project, clip.id, { animation }))}
              >
                {animation}
              </button>
            ))}
          </div>
          <NumberField label="Duration" value={clip.duration} min={0.5} onCommit={(value) => apply((project) => trimClipEnd(project, clip.id, clip.start + value))} />
        </section>
      </div>
    );
  }
  if (["photo", "overlay"].includes(clip.kind)) {
    return (
      <div className="fls-panel">
        <div className="fls-panel-head">
          <h4>Ken Burns</h4>
          {!inside && (
            <button type="button" className="fls-link" onClick={() => seek(clip.start)}>
              Go to clip
            </button>
          )}
        </div>
        <KenBurnsEditor
          asset={asset}
          value={clip.kenBurns}
          onBegin={beginGesture}
          onEnd={endGesture}
          onChange={(value) => quiet((project) => setKenBurns(project, clip.id, value))}
        />
        <p className="muted fls-note">Drag a frame to move it, drag its corner to resize. Play to preview the move.</p>
        {clip.kind === "overlay" && (
          <section className="fls-section">
            <h4>Position</h4>
            <div className="fls-grid-9" role="radiogroup" aria-label="Overlay position">
              {titlePositions.map((position) => (
                <button key={position} type="button" role="radio" aria-checked={clip.position === position} aria-label={POSITION_LABELS[position]} className={clip.position === position ? "is-on" : ""} onClick={() => apply((project) => updateClip(project, clip.id, { position }))}>
                  <span />
                </button>
              ))}
            </div>
          </section>
        )}
      </div>
    );
  }
  return (
    <div className="fls-panel">
      <h4>{clipTitle(clip)}</h4>
      <p className="muted">Video clips keep their own motion. Titles and photos can be animated here.</p>
      {advanced && (
        <Switch
          label="Stabilise"
          hint="Smooths handheld camera movement on export"
          checked={!!clip.transform && clip.transform.scale > 1.001}
          onChange={(checked) => apply((project) => updateClip(project, clip.id, { transform: checked ? { ...(clip.transform || {}), scale: 1.06 } : null }))}
        />
      )}
      <Button icon="mdiFormatTitle" onClick={onAddTitle}>
        Add a title at playhead
      </Button>
    </div>
  );
}

function CaptionsPanel({ sequence, apply, quiet, beginGesture, endGesture, playhead, seek, notify }) {
  const [progress, setProgress] = useState(null);
  const listRef = useRef(null);
  const current = sequence.captions.find((line) => line.start <= playhead && playhead < line.end);
  useEffect(() => {
    if (progress === null) return undefined;
    if (progress >= 100) {
      apply((project) => setCaptions(project, sampleCaptions(activeSequence(project), activeSequence(project).captionLanguage)));
      setProgress(null);
      notify("Transcript ready. Review the lines below.");
      return undefined;
    }
    const timer = setTimeout(() => setProgress((value) => Math.min(100, value + 4 + Math.random() * 6)), 140);
    return () => clearTimeout(timer);
  }, [progress, apply, notify]);
  useEffect(() => {
    if (!current || !listRef.current) return;
    listRef.current.querySelector(`[data-caption="${current.id}"]`)?.scrollIntoView({ block: "nearest" });
  }, [current?.id]);
  const change = (id, patch, gesture = false) =>
    (gesture ? quiet : apply)((project) =>
      setCaptions(
        project,
        activeSequence(project).captions.map((line) => (line.id === id ? { ...line, ...patch } : line)),
      ),
    );
  return (
    <div className="fls-panel">
      <div className="fls-grid-2">
        <label className="fls-field">
          <span>Language</span>
          <select
            value={sequence.captionLanguage}
            onChange={(event) => apply((project) => setSequenceFields(project, { captionLanguage: event.target.value }))}
          >
            {captionLanguages.map((language) => (
              <option key={language}>{language}</option>
            ))}
          </select>
        </label>
        <Button icon="mdiTranslate" primary={!sequence.captions.length} disabled={progress !== null} onClick={() => setProgress(0)}>
          {sequence.captions.length ? "Transcribe again" : "Transcribe"}
        </Button>
      </div>
      {progress !== null && (
        <div className="fls-progress" role="status" aria-live="polite">
          <span>Listening to the sequence… {Math.round(progress)}%</span>
          <progress max={100} value={progress} aria-label="Transcription progress" />
        </div>
      )}
      {sequence.captions.length > 0 && (
        <>
          <Switch
            label="Burn captions into the export"
            checked={sequence.captionsBurnIn}
            onChange={(checked) => apply((project) => setSequenceFields(project, { captionsBurnIn: checked }))}
          />
          <ol className="fls-captions" ref={listRef} aria-label="Caption lines">
            {sequence.captions.map((line) => (
              <li key={line.id} data-caption={line.id} className={current?.id === line.id ? "is-current" : ""} aria-current={current?.id === line.id ? "time" : undefined}>
                <div className="fls-caption-times">
                  <button type="button" className="fls-link" onClick={() => seek(line.start)}>
                    {shortTimecode(line.start)}
                  </button>
                  <span>–</span>
                  <button type="button" className="fls-link" onClick={() => seek(Math.max(0, line.end - 0.05))}>
                    {shortTimecode(line.end)}
                  </button>
                  <span className="grow" />
                  <button
                    type="button"
                    className="fls-mini"
                    aria-label={`Delete caption at ${shortTimecode(line.start)}`}
                    onClick={() => apply((project) => setCaptions(project, activeSequence(project).captions.filter((item) => item.id !== line.id)))}
                  >
                    <Icon name="mdiClose" size={12} />
                  </button>
                </div>
                <textarea
                  aria-label={`Caption text at ${shortTimecode(line.start)}`}
                  value={line.text}
                  rows={2}
                  onFocus={beginGesture}
                  onBlur={endGesture}
                  onChange={(event) => change(line.id, { text: event.target.value }, true)}
                />
              </li>
            ))}
          </ol>
        </>
      )}
      <Button
        icon="mdiPlus"
        onClick={() =>
          apply((project) =>
            setCaptions(project, [
              ...activeSequence(project).captions,
              { id: makeId("caption"), start: playhead, end: playhead + 2.5, text: "" },
            ]),
          )
        }
      >
        Add a line at playhead
      </Button>
      {!sequence.captions.length && progress === null && (
        <p className="muted fls-note">Captions are generated on your server and stay editable here.</p>
      )}
    </div>
  );
}

function RestoreCompare({ frame, split, setSplit, loupe, mode }) {
  const area = useRef(null);
  const [pointer, setPointer] = useState(null);
  const [size, setSize] = useState({ width: 1, height: 1 });
  useEffect(() => {
    const element = area.current;
    if (!element) return undefined;
    const measure = () => setSize({ width: element.clientWidth || 1, height: element.clientHeight || 1 });
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, []);
  const positionFrom = (clientX) => {
    const rect = area.current.getBoundingClientRect();
    return clampValue(((clientX - rect.left) / rect.width) * 100, 0, 100);
  };
  const startDivider = (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    setSplit(positionFrom(event.clientX));
    const move = (moveEvent) => setSplit(positionFrom(moveEvent.clientX));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const after = mode === "Creative" ? "contrast(1.16) saturate(1.14) brightness(1.04) url(#fls-sharpen)" : "contrast(1.1) saturate(1.06) brightness(1.02) url(#fls-sharpen)";
  const track = (event) => {
    if (!loupe || !area.current) return;
    const rect = area.current.getBoundingClientRect();
    setPointer({ x: event.clientX - rect.left, y: event.clientY - rect.top });
  };
  return (
    <div className="fls-compare" ref={area} onPointerDown={startDivider} onPointerMove={track} onPointerLeave={() => setPointer(null)}>
      <svg width="0" height="0" aria-hidden="true" style={{ position: "absolute" }}>
        <filter id="fls-sharpen">
          <feConvolveMatrix order="3" kernelMatrix="0 -0.35 0 -0.35 2.4 -0.35 0 -0.35 0" preserveAlpha="true" />
        </filter>
      </svg>
      {frame ? (
        <>
          <img className="fls-compare-img" src={frame} alt="Before restoration" />
          <img className="fls-compare-img fls-compare-after" src={frame} alt={`After restoration, ${mode.toLowerCase()} preview`} style={{ clipPath: `inset(0 0 0 ${split}%)`, filter: after }} />
        </>
      ) : (
        <p className="fls-stage-empty">Move the playhead onto a clip to compare.</p>
      )}
      <span className="fls-compare-tag fls-compare-tag--before">Before</span>
      <span className="fls-compare-tag fls-compare-tag--after">After · preview</span>
      <div className="fls-divider" style={{ left: `${split}%` }}>
        <input
          type="range"
          min={0}
          max={100}
          step={0.5}
          value={split}
          aria-label="Comparison split"
          onChange={(event) => setSplit(Number(event.target.value))}
        />
        <span className="fls-divider-grip" aria-hidden="true">
          <Icon name="mdiArrowLeftRight" size={14} />
        </span>
      </div>
      {loupe && pointer && frame && (
        <div
          className="fls-loupe"
          aria-hidden="true"
          style={{
            left: pointer.x,
            top: pointer.y,
            backgroundImage: `url(${frame})`,
            backgroundSize: `${size.width * 2.5}px ${size.height * 2.5}px`,
            backgroundPosition: `${-(pointer.x * 2.5 - 70)}px ${-(pointer.y * 2.5 - 70)}px`,
            filter: pointer.x / size.width >= split / 100 ? after : "none",
          }}
        >
          <span>100%</span>
        </div>
      )}
    </div>
  );
}

/** The Frameleaf Cloud range for the chosen model; the job dialog confirms the real choice. */
function cloudRange(workload, durationSeconds, modelId) {
  const model = modelsFor(workload).find((item) => item.id === modelId) ?? modelsFor(workload)[0];
  const { quantity } = jobQuantity(workload, { durationSeconds });
  return model ? `about ${estimateRange(estimateJob(model.id, quantity))}` : "—";
}
const cloudCostText = (estimate, destination, workload, durationSeconds, modelId) =>
  destination === "cloud"
    ? cloudRange(workload, durationSeconds, modelId)
    : estimate.cloudCost.amount
      ? `${formatMoney(estimate.cloudCost.amount)} ± ${formatMoney(estimate.cloudCost.uncertainty)}`
      : "None";

/**
 * Where a Studio job runs, following Settings → Compute & jobs → Where each job
 * runs. Pick the local worker, then slide to a model: white and green models
 * run on that worker, blue ones on Frameleaf Cloud (with the cost confirmed
 * before anything is sent). A job never switches destination on its own.
 */
function DestinationSelect({ workload, destination, setDestination, choice, setChoice }) {
  const cloud = useCloudState();
  const workers = [detectedWorker(cloud), lanWorker];
  const workerId = choice?.worker ?? (destination === "lan" ? "lan" : "local");
  const worker = workers.find((item) => item.id === workerId) ?? workers[0];
  const resolved = resolveModelChoice(cloud, workload, choice?.model ?? cloud.processing.defaultModels?.[workload], {
    worker,
  });
  const target = resolved ? (resolved.runsOn === "cloud" ? "cloud" : worker.id) : null;
  useEffect(() => {
    if (target && target !== destination) setDestination(target);
  }, [target, destination]); // eslint-disable-line react-hooks/exhaustive-deps
  const describe = (item) => {
    const gpu = workerGpu(item, workload);
    return `${item.id === "local" ? `${item.name} · this server` : item.name} — ${gpu ? `${gpu.name}, ${gpu.vramGb} GB` : "processor only"}`;
  };
  return (
    <div className="fls-destination">
      <select
        value={worker.id}
        aria-label="Local worker"
        onChange={(event) => setChoice?.({ model: choice?.model, worker: event.target.value })}
      >
        {workers.map((item) => (
          <option key={item.id} value={item.id}>
            {describe(item)}
          </option>
        ))}
      </select>
      <ModelSlider
        state={cloud}
        workload={workload}
        worker={worker}
        value={resolved?.item.id}
        hideLegend
        label="Model"
        gpuLabel={`the ${worker.id === "local" ? "server's" : "LAN worker's"} GPU`}
        onChange={(id) => setChoice?.({ model: id, worker: worker.id })}
      />
      {!resolved && (
        <small className="muted fls-note">
          Nothing can run this job yet. Change where this work runs in Settings → Compute & jobs.
        </small>
      )}
    </div>
  );
}

function RestorePanel({ restore, setRestore, destination, setDestination, choice, setChoice, estimate, durationSeconds, onPreview, onFull, onRefreshFrame, advanced }) {
  const chosen = destinations.find((item) => item.id === destination) || destinations[0];
  return (
    <div className="fls-panel">
      <section className="fls-section">
        <h4>Restoration</h4>
        <div className="fls-segmented" role="radiogroup" aria-label="Restoration mode">
          {restoreModes.map((mode) => (
            <button key={mode} type="button" role="radio" aria-checked={restore.mode === mode} className={restore.mode === mode ? "is-on" : ""} onClick={() => setRestore({ mode })}>
              {mode}
            </button>
          ))}
        </div>
        <p className="muted fls-note">
          {restore.mode === "Faithful" ? "Removes noise and compression while keeping the original look." : "Rebuilds fine detail and may invent texture. Best for very small sources."}
        </p>
        <div className="fls-segmented" role="radiogroup" aria-label="Upscale">
          {upscales.map((factor) => (
            <button key={factor} type="button" role="radio" aria-checked={restore.upscale === factor} className={restore.upscale === factor ? "is-on" : ""} onClick={() => setRestore({ upscale: factor })}>
              {factor === 1 ? "Same size" : `${factor}×`}
            </button>
          ))}
        </div>
        <p className="muted fls-note">Output is capped at 4K · {restore.upscale === 1 ? "3840 × 2160" : "3840 × 2160 (capped)"}.</p>
      </section>
      <section className="fls-section">
        <h4>Destination</h4>
        <div className="fls-field" role="group" aria-label="Process on">
          <span>Process on</span>
          <DestinationSelect workload="restoration" destination={destination} setDestination={setDestination} choice={choice} setChoice={setChoice} />
        </div>
        <p className={`fls-note ${chosen.leaves ? "fls-warning" : "muted"}`}>
          {chosen.leaves ? (
            <>
              <Icon name="mdiCloudOutline" size={14} /> Previews leave this server for Frameleaf Cloud. You confirm the model and cost before anything is sent.
            </>
          ) : (
            "Media stays on your network."
          )}
        </p>
      </section>
      <section className="fls-section fls-estimate">
        <h4>Estimate</h4>
        <dl className="fls-facts">
          <dt>Time</dt>
          <dd>about {formatSeconds(estimate.seconds)}</dd>
          <dt>Output</dt>
          <dd>{formatBytes(estimate.sizeBytes)}</dd>
          <dt>Cloud cost</dt>
          <dd>{cloudCostText(estimate, destination, "restoration", durationSeconds, choice?.model)}</dd>
        </dl>
        <p className="muted fls-note">For {formatSeconds(durationSeconds)} of video in this sequence.</p>
      </section>
      <section className="fls-section">
        <div className="fls-actions">
          <Button icon="mdiCompare" aria-pressed={restore.loupe} active={restore.loupe} onClick={() => setRestore({ loupe: !restore.loupe })}>
            Loupe
          </Button>
          <Button icon="mdiRefresh" onClick={onRefreshFrame}>
            Use current frame
          </Button>
        </div>
        {advanced && (
          <Switch label="Keep film grain" hint="Preserves fine grain instead of smoothing it" checked={restore.grain} onChange={(checked) => setRestore({ grain: checked })} />
        )}
      </section>
      <div className="fls-actions fls-actions--stack">
        <Button icon="mdiPlayCircleOutline" onClick={onPreview}>
          Preview 5 seconds
        </Button>
        <Button primary icon="mdiAutoFix" onClick={onFull}>
          Restore full video
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Dialogs                                                              */
/* ------------------------------------------------------------------ */

function ExportDialog({ sequence, length, destination, setDestination, choice, setChoice, onExport, close }) {
  const [frameRate, setFrameRate] = useState(sequence.fps);
  const [conversion, setConversion] = useState("blend");
  const [interpolationModel, setInterpolationModel] = useState(null);
  const { resolved: interpolation } = useInterpolationChoice(interpolationModel);
  const rates = [...new Set([sequence.fps, 50, 60])].filter((rate) => rate >= sequence.fps).sort((a, b) => a - b);
  const converting = frameRate > sequence.fps;
  const [format, setFormat] = useState(exportFormats[0]);
  const [color, setColor] = useState(exportColors[0]);
  const [resolution, setResolution] = useState("2160p");
  const estimate = estimateRender({ durationSeconds: length, resolution, destination, kind: "export" });
  const chosen = destinations.find((item) => item.id === destination) || destinations[0];
  return (
    <Dialog
      title={`Export ${sequence.name}`}
      close={close}
      actions={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button primary icon="mdiExportVariant" data-initial-focus onClick={() =>
              onExport({
                format,
                color,
                resolution,
                estimate,
                frameRate,
                conversion: converting ? conversion : null,
                interpolation: converting && conversion === "ai" ? interpolation : null,
              })
            }
          >
            Export
          </Button>
        </>
      }
    >
      <div className="fls-dialog-grid">
        <label className="fls-field">
          <span>Format</span>
          <select value={format} onChange={(event) => setFormat(event.target.value)}>
            {exportFormats.map((item) => (
              <option key={item}>{item}</option>
            ))}
          </select>
        </label>
        <label className="fls-field">
          <span>Colour</span>
          <select value={color} onChange={(event) => setColor(event.target.value)}>
            {exportColors.map((item) => (
              <option key={item}>{item}</option>
            ))}
          </select>
        </label>
        <label className="fls-field">
          <span>Resolution</span>
          <select value={resolution} onChange={(event) => setResolution(event.target.value)}>
            {[...resolutions].reverse().map((item) => (
              <option key={item} value={item}>
                {item === "2160p" ? "2160p · 4K (original)" : item}
              </option>
            ))}
          </select>
        </label>
        <label className="fls-field">
          <span>Frame rate</span>
          <select value={frameRate} onChange={(event) => setFrameRate(Number(event.target.value))}>
            {rates.map((rate) => (
              <option key={rate} value={rate}>
                {rate} fps{rate === sequence.fps ? " (sequence)" : ""}
              </option>
            ))}
          </select>
        </label>
        {converting && (
          <div className="fls-field fls-field--wide" role="group" aria-label="Frame-rate conversion">
            <span>Frame-rate conversion</span>
            <FrameMethod
              legend="Frame-rate conversion"
              method={conversion}
              setMethod={setConversion}
              modelId={interpolationModel}
              setModel={setInterpolationModel}
              durationSeconds={length}
              sourceFps={sequence.fps}
              targetFps={frameRate}
            />
          </div>
        )}
        <div className="fls-field" role="group" aria-label="Render on">
          <span>Render on</span>
          <DestinationSelect workload="render" destination={destination} setDestination={setDestination} choice={choice} setChoice={setChoice} />
        </div>
      </div>
      {color === "Dolby Vision" && (
        <p className="fls-note fls-warning">
          <Icon name="mdiAlertOutline" size={14} /> Dolby Vision output needs a qualified worker; the export falls back to HDR10 otherwise.
        </p>
      )}
      <dl className="fls-facts fls-facts--row">
        <dt>Length</dt>
        <dd>{frameTimecode(length, sequence.fps)}</dd>
        <dt>Time</dt>
        <dd>about {formatSeconds(estimate.seconds)}</dd>
        <dt>Size</dt>
        <dd>{formatBytes(estimate.sizeBytes)}</dd>
        <dt>Cloud cost</dt>
        <dd>{cloudCostText(estimate, destination, "render", length, choice?.model)}</dd>
      </dl>
      <p className={`fls-note ${chosen.leaves ? "fls-warning" : "muted"}`}>
        {chosen.leaves
          ? "The sequence leaves this server for Frameleaf Cloud. Next you choose the model and confirm the cost."
          : "Rendered on your network. Progress appears in Activity."}
      </p>
    </Dialog>
  );
}

function ReviewDialog({ sequence, people, owner, playhead, seek, onAdd, onResolve, onRemove, close }) {
  const [text, setText] = useState("");
  const [time] = useState(playhead);
  const person = (name) => people.find((item) => item.name === name || item.id === name) || null;
  return (
    <Dialog
      title="Review"
      close={close}
      actions={
        <>
          <Button onClick={close}>Close</Button>
          <Button
            primary
            disabled={!text.trim()}
            onClick={() => {
              onAdd({ time, text: text.trim(), author: owner.name });
              setText("");
            }}
          >
            Post at {shortTimecode(time)}
          </Button>
        </>
      }
    >
      <ul className="fls-comments" aria-label="Comments">
        {!sequence.review.length && <li className="muted">No comments yet.</li>}
        {sequence.review.map((comment) => (
          <li key={comment.id} className={comment.resolved ? "is-resolved" : ""}>
            <PersonAvatar person={person(comment.author) || { id: comment.author, name: comment.author, image: "" }} size={28} />
            <div>
              <div className="fls-comment-head">
                <b>{comment.author}</b>
                <button type="button" className="fls-link" onClick={() => { seek(comment.time); close(); }}>
                  {shortTimecode(comment.time)}
                </button>
                <span className="grow" />
                <button type="button" className="fls-mini" aria-pressed={comment.resolved} aria-label={comment.resolved ? "Reopen" : "Resolve"} onClick={() => onResolve(comment.id, !comment.resolved)}>
                  <Icon name={comment.resolved ? "mdiCheckCircle" : "mdiCheckCircleOutline"} size={14} />
                </button>
                {comment.author === owner.name && (
                  <button type="button" className="fls-mini" aria-label="Delete comment" onClick={() => onRemove(comment.id)}>
                    <Icon name="mdiClose" size={12} />
                  </button>
                )}
              </div>
              <p>{comment.text}</p>
            </div>
          </li>
        ))}
      </ul>
      <label className="fls-field">
        <span>Comment at {shortTimecode(time)}</span>
        <textarea data-initial-focus value={text} rows={3} maxLength={1000} placeholder="What should change here?" onChange={(event) => setText(event.target.value)} />
      </label>
      <p className="muted fls-note">Comments stay with this project on your server.</p>
    </Dialog>
  );
}

function TransitionDialog({ clip, onApply, close }) {
  const [type, setType] = useState(clip.transitionIn?.type || "Cross dissolve");
  const [duration, setDuration] = useState(clip.transitionIn?.duration || 0.6);
  return (
    <Dialog
      title="Transition"
      close={close}
      actions={
        <>
          {clip.transitionIn && <Button onClick={() => onApply(null)}>Remove</Button>}
          <Button onClick={close}>Cancel</Button>
          <Button primary onClick={() => onApply({ type, duration })}>
            Apply
          </Button>
        </>
      }
    >
      <div className="fls-transitions" role="radiogroup" aria-label="Transition type">
        {transitionTypes.map((item) => (
          <button key={item} type="button" role="radio" aria-checked={type === item} className={`fls-transition-card${type === item ? " is-on" : ""}`} data-initial-focus={item === type ? true : undefined} onClick={() => setType(item)}>
            <span className={`fls-transition-demo fls-transition-demo--${slug(item)}`} aria-hidden="true">
              <i />
              <i />
            </span>
            <span>{item}</span>
          </button>
        ))}
      </div>
      <Slider label="Duration" value={duration} min={0.25} max={2} step={0.05} format={(value) => `${value.toFixed(2)} s`} onChange={setDuration} />
      <p className="muted fls-note">Applied to the start of “{clipTitle(clip)}”.</p>
    </Dialog>
  );
}

function MusicDialog({ playhead, onAdd, close }) {
  return (
    <Dialog title="Add music" close={close} wide>
      <ul className="fls-music" aria-label="Music library">
        {musicLibrary.map((track, index) => (
          <li key={track.id}>
            <span className="fls-music-wave" aria-hidden="true">
              <WaveformSvg seed={track.seed} width={240} tone="music" />
            </span>
            <div>
              <b>{track.name}</b>
              <span className="muted">
                {track.artist} · {track.mood} · {track.bpm} bpm · {shortTimecode(track.duration)}
              </span>
            </div>
            <Button icon="mdiPlus" data-initial-focus={index === 0 ? true : undefined} onClick={() => onAdd(track.id)}>
              Add at {shortTimecode(playhead)}
            </Button>
          </li>
        ))}
      </ul>
      <p className="muted fls-note">Royalty-free tracks included with Frameleaf.</p>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Studio                                                               */
/* ------------------------------------------------------------------ */

export function Studio({
  assets = libraryMedia,
  selectedId = null,
  onSelectAsset,
  destination = "local",
  setDestination,
  enqueue,
  back,
  notify: notifyProp,
  people = libraryPeople,
  onOpenActivity,
  finishJob,
  onOpenCloudSettings,
  onAddCredit,
}) {
  const [cloudRequest, setCloudRequest] = useState(null);
  // Per-workload model and local worker chosen on the Studio model sliders.
  const [jobChoice, setJobChoice] = useState({});
  // A job waiting for the confirmed Smooth motion job before it is queued.
  const nextJob = useRef(null);
  const assetMap = useMemo(() => new Map(assets.map((asset) => [asset.id, asset])), [assets]);
  const notifyRef = useLatest(notifyProp);
  // Stable identity so panels can list it as an effect dependency safely.
  const notify = useCallback((text) => notifyRef.current?.(text), [notifyRef]);
  const owner = people.find((person) => person.id === "Taylor") || people[0] || { id: "you", name: "You", image: "" };

  /* Project and history ------------------------------------------- */
  const [history, setHistory] = useState(() => createHistory(readStoredProject(assets) || sampleProject(assets)));
  const historyRef = useLatest(history);
  const project = history.present;
  const [dragProject, setDragProject] = useState(null);
  const shown = dragProject || project;
  const sequence = activeSequence(shown);
  const advanced = project.settings.mode === "advanced";
  const length = timelineLength(sequence);
  const lengthRef = useLatest(length);
  const fps = sequence.fps;

  const apply = useCallback((fn) => setHistory((current) => commit(current, fn(current.present))), []);
  const quiet = useCallback(
    (fn) =>
      setHistory((current) => {
        const next = fn(current.present);
        return next === current.present ? current : { ...current, present: next };
      }),
    [],
  );
  const gestureBase = useRef(null);
  const beginGesture = useCallback(() => {
    if (!gestureBase.current) gestureBase.current = historyRef.current.present;
  }, [historyRef]);
  const endGesture = useCallback(() => {
    const base = gestureBase.current;
    gestureBase.current = null;
    if (!base) return;
    setHistory((current) =>
      current.present === base ? current : { present: current.present, past: [...current.past, base].slice(-100), future: [] },
    );
  }, []);
  const undoAction = useCallback(() => setHistory((current) => undo(current)), []);
  const redoAction = useCallback(() => setHistory((current) => redo(current)), []);

  /* Autosave -------------------------------------------------------- */
  const [saveStatus, setSaveStatus] = useState("saved");
  const firstSave = useRef(true);
  useEffect(() => {
    if (firstSave.current) {
      firstSave.current = false;
      return undefined;
    }
    setSaveStatus("saving");
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(studioStorageKey, saveProject(project));
      } catch {
        /* Storage may be unavailable; the project stays in memory. */
      }
      setSaveStatus("saved");
    }, 600);
    return () => clearTimeout(timer);
  }, [project]);

  /* Playback -------------------------------------------------------- */
  const [playhead, setPlayheadState] = useState(0);
  const playheadRef = useRef(0);
  const setPlayhead = useCallback((value) => {
    const next = Math.max(0, Number.isFinite(value) ? value : 0);
    playheadRef.current = next;
    setPlayheadState(next);
  }, []);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const rateRef = useLatest(rate);
  const loop = project.settings.loop;
  const loopRef = useLatest(loop);
  const guides = project.settings.guides;
  const [quality, setQuality] = useState("Auto");
  const [fullscreen, setFullscreen] = useState(false);
  const seek = useCallback(
    (time) => setPlayhead(clampValue(time, 0, Math.max(lengthRef.current, 0))),
    [setPlayhead, lengthRef],
  );
  useEffect(() => {
    if (!playing) return undefined;
    let last = performance.now();
    let frame = 0;
    const tick = (now) => {
      const dt = Math.min(0.25, (now - last) / 1000);
      last = now;
      let next = playheadRef.current + dt * rateRef.current;
      const end = Math.max(lengthRef.current, FRAME);
      if (next >= end) {
        if (loopRef.current && rateRef.current > 0) next = 0;
        else {
          next = end;
          setPlaying(false);
        }
      }
      if (next <= 0 && rateRef.current < 0) {
        next = 0;
        setPlaying(false);
      }
      setPlayhead(next);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, setPlayhead, rateRef, lengthRef, loopRef]);
  const togglePlay = useCallback(() => {
    if (playing) {
      setPlaying(false);
      setRate(1);
      return;
    }
    if (playheadRef.current >= lengthRef.current - FRAME / 2) setPlayhead(0);
    setRate(1);
    setPlaying(true);
  }, [playing, setPlayhead, lengthRef]);
  const shuttle = useCallback(
    (direction) => {
      setRate((current) => (playing && Math.sign(current) === direction ? clampValue(current * 2, -8, 8) : direction));
      if (!playing) setPlaying(true);
    },
    [playing],
  );
  const stop = useCallback(() => {
    setPlaying(false);
    setRate(1);
  }, []);
  const step = useCallback(
    (delta) => {
      setPlaying(false);
      setRate(1);
      seek(playheadRef.current + delta);
    },
    [seek],
  );
  useEffect(() => {
    const onChange = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  /* Selection ------------------------------------------------------- */
  const [selection, setSelection] = useState(null);
  const [tab, setTab] = useState("Edit");
  const [binTab, setBinTab] = useState("Library");
  const [binQuery, setBinQuery] = useState("");
  const [dialog, setDialog] = useState(null);
  const [panel, setPanel] = useState(null);
  const [queued, setQueued] = useState(null);
  const [snapping, setSnapping] = useState(true);
  const [pps, setPps] = useState(12);
  const [restore, setRestoreState] = useState({ mode: "Faithful", upscale: 2, split: 50, loupe: false, grain: false });
  const setRestore = (patch) => setRestoreState((current) => ({ ...current, ...patch }));
  const [frame, setFrame] = useState(null);
  const [recording, setRecording] = useState(null);
  const recordingRef = useLatest(recording);
  const [binDrag, setBinDrag] = useState(null);
  const [dragInfo, setDragInfo] = useState(null);
  const [nameDraft, setNameDraft] = useState(project.name);
  useEffect(() => setNameDraft(project.name), [project.name]);

  const select = useCallback(
    (clipId) => {
      setSelection(clipId);
      if (clipId && onSelectAsset) {
        const found = findClip(historyRef.current.present, clipId);
        if (found?.clip.assetId) onSelectAsset(found.clip.assetId);
      }
    },
    [onSelectAsset, historyRef],
  );
  useEffect(() => {
    if (selection && !findClip(project, selection)) setSelection(null);
  }, [project, selection]);
  useEffect(() => {
    if (!selectedId) return;
    const found = activeSequence(project).tracks.flatMap((track) => track.clips).find((clip) => clip.assetId === selectedId);
    if (found) setSelection(found.id);
    // Only on mount: later selection changes flow from the timeline outward.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selected = selection ? findClip(shown, selection) : null;
  const selectedAudioTwin = selected?.clip.kind === "video" ? linkedClips(shown, selection).find((item) => item.clip.kind === "audio")?.clip || null : null;
  const linkedIds = useMemo(() => new Set(selection ? linkedClips(shown, selection).map((item) => item.clip.id) : []), [shown, selection]);

  /* Monitor state --------------------------------------------------- */
  const videoTrack = trackOfKind(sequence, "video");
  const overlayTrack = trackOfKind(sequence, "overlay");
  const titleTrack = trackOfKind(sequence, "title");
  const audioTrack = trackOfKind(sequence, "audio");
  const activeClip = clipAt(videoTrack, playhead);
  const activeAsset = activeClip ? assetMap.get(activeClip.assetId) : null;
  const activeIndex = activeClip ? videoTrack.clips.indexOf(activeClip) : -1;
  const previousClip = activeIndex > 0 ? videoTrack.clips[activeIndex - 1] : null;
  const previousAsset = previousClip ? assetMap.get(previousClip.assetId) : null;
  const overlayClip = clipAt(overlayTrack, playhead);
  const overlayAsset = overlayClip ? assetMap.get(overlayClip.assetId) : null;
  const titleClip = clipAt(titleTrack, playhead);
  const titleView = titleClip ? titlePresentation(titleClip, playhead) : null;
  const captionLine = sequence.captions.find((line) => line.start <= playhead && playhead < line.end) || null;
  const transition = transitionPresentation(activeClip, playhead);
  const progress = activeClip ? (playhead - activeClip.start) / activeClip.duration : 0;
  const stageFilter = gradeFilter(activeClip?.grade);
  const gradeTarget = selected && visualKinds.includes(selected.clip.kind) ? selected.clip : activeClip;
  const gradeAsset = gradeTarget ? assetMap.get(gradeTarget.assetId) : null;
  const motionTarget = selected ? selected.clip : titleClip || (activeClip?.kind === "photo" ? activeClip : null);
  const motionAsset = motionTarget?.assetId ? assetMap.get(motionTarget.assetId) : activeAsset;

  const videoRef = useRef(null);
  const photoRef = useRef(null);
  const monitorRef = useRef(null);
  const lastVideoSrc = useRef(null);
  if (activeClip?.kind === "video" && activeAsset?.mediaSrc) lastVideoSrc.current = activeAsset.mediaSrc;
  const videoSrc = lastVideoSrc.current;
  const anySolo = sequence.tracks.some((track) => track.solo);
  const audioTwin = activeClip?.kind === "video" ? clipAt(audioTrack, playhead) : null;
  const audible =
    !!audioTwin &&
    !audioTwin.muted &&
    !audioTrack.muted &&
    (!anySolo || audioTrack.solo) &&
    (!recording);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const isVideo = activeClip?.kind === "video";
    if (!isVideo) {
      if (!video.paused) video.pause();
      return;
    }
    const target = activeClip.in + (playhead - activeClip.start) * activeClip.speed;
    const drift = Math.abs((video.currentTime || 0) - target);
    video.muted = !audible;
    video.volume = clampValue((audioTwin?.volume ?? 1) * dbToGain(audioTrack.gain), 0, 1);
    if (playing && rate > 0) {
      const wanted = clampValue(activeClip.speed * rate, 0.25, 16);
      if (Math.abs(video.playbackRate - wanted) > 0.01) video.playbackRate = wanted;
      if (drift > 0.3) video.currentTime = target;
      if (video.paused) {
        const promise = video.play?.();
        if (promise?.catch) promise.catch(() => {});
      }
    } else {
      if (!video.paused) video.pause();
      if (drift > FRAME / 2) video.currentTime = target;
    }
  }, [activeClip, playhead, playing, rate, audible, audioTwin, audioTrack.gain]);

  const frameSource = useRef(() => null);
  frameSource.current = () => (activeClip?.kind === "video" ? videoRef.current : activeClip?.kind === "photo" ? photoRef.current : null);
  const captureFrame = useCallback(() => {
    const source = frameSource.current();
    if (!source) {
      setFrame(activeAsset?.image || null);
      return;
    }
    try {
      const canvas = document.createElement("canvas");
      canvas.width = 960;
      canvas.height = 540;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("no canvas");
      context.drawImage(source, ...coverSource(source), 0, 0, 960, 540);
      setFrame(canvas.toDataURL("image/jpeg", 0.9));
    } catch {
      setFrame(activeAsset?.image || null);
    }
  }, [activeAsset]);
  useEffect(() => {
    if (tab === "Restore") captureFrame();
    // Capture once when entering the tab or when the clip under the playhead changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, activeClip?.id]);

  /* Timeline geometry ----------------------------------------------- */
  const scrollerRef = useRef(null);
  const lanesRef = useRef(null);
  const timeFromX = useCallback(
    (clientX) => {
      const rect = lanesRef.current?.getBoundingClientRect();
      return rect ? Math.max(0, (clientX - rect.left) / pps) : 0;
    },
    [pps],
  );
  const fitTimeline = useCallback(() => {
    const width = scrollerRef.current?.clientWidth || 900;
    const available = Math.max(200, width - 150 - 48);
    setPps(clampValue(available / Math.max(lengthRef.current, 10), MIN_PPS, MAX_PPS));
  }, [lengthRef]);
  useEffect(() => {
    fitTimeline();
  }, [fitTimeline]);
  const zoom = useCallback((factor) => setPps((current) => clampValue(current * factor, MIN_PPS, MAX_PPS)), []);
  useEffect(() => {
    // Keep the playhead in view while playing.
    const scroller = scrollerRef.current;
    if (!scroller || !playing) return;
    const x = playhead * pps + 150;
    if (x > scroller.scrollLeft + scroller.clientWidth - 40) scroller.scrollLeft = x - 150 - 40;
    else if (x < scroller.scrollLeft + 150) scroller.scrollLeft = Math.max(0, x - 150 - 20);
  }, [playhead, playing, pps]);

  /* Commands -------------------------------------------------------- */
  const splitAtPlayhead = useCallback(() => {
    const time = playheadRef.current;
    apply((current) => {
      if (selection) {
        const next = splitClipAt(current, time, { clipIds: [selection] });
        if (next !== current) return next;
      }
      return splitClipAt(current, time);
    });
  }, [apply, selection]);
  const removeSelection = useCallback(
    (ripple) => {
      if (!selection) return;
      apply((current) => deleteClip(current, selection, { ripple }));
      setSelection(null);
    },
    [apply, selection],
  );
  const nudge = useCallback(
    (delta) => {
      if (!selection) return;
      apply((current) => {
        const found = findClip(current, selection);
        return found ? moveClip(current, selection, { start: Math.max(0, found.clip.start + delta) }) : current;
      });
    },
    [apply, selection],
  );
  const addAssetToTrack = useCallback(
    (asset, trackId, at) => {
      const id = makeId("clip");
      apply((current) => addClip(current, trackId, clipFromAsset(asset, { id }), at));
      select(id);
      notify(`${asset.name} added to the timeline.`);
    },
    [apply, select, notify],
  );
  const addTitleAtPlayhead = useCallback(() => {
    const id = makeId("title");
    apply((current) => addTitle(current, { id, text: "New title", at: playheadRef.current, duration: 4, style: "Minimal", position: "bc", animation: "Fade" }));
    select(id);
    setTab("Motion");
  }, [apply, select]);
  const toggleTrack = useCallback((trackId, patch) => apply((current) => setTrack(current, trackId, patch)), [apply]);
  const setMode = (mode) => quiet((current) => setSettings(current, { mode }));
  const toggleFullscreen = () => {
    const element = monitorRef.current;
    if (!element) return;
    if (document.fullscreenElement) document.exitFullscreen?.();
    else element.requestFullscreen?.().catch?.(() => notify("Fullscreen is not available here."));
  };
  const startRecording = () => {
    const start = playheadRef.current;
    setRecording({ start, seed: Math.floor(Math.random() * 1e6) });
    setRate(1);
    setPlaying(true);
    notify("Recording voiceover. Press Stop when you are done.");
  };
  const stopRecording = useCallback(() => {
    const current = recordingRef.current;
    if (!current) return;
    setRecording(null);
    setPlaying(false);
    setRate(1);
    const duration = playheadRef.current - current.start;
    if (duration < 0.5) {
      notify("Recording was too short to keep.");
      return;
    }
    const id = makeId("voice");
    apply((item) => {
      const count = trackOfKind(activeSequence(item), "voice").clips.length + 1;
      return addVoiceover(item, { id, at: current.start, duration, seed: current.seed, name: `Voiceover ${count}` });
    });
    select(id);
  }, [apply, select, notify, recordingRef]);
  useEffect(() => {
    if (!playing && recordingRef.current) stopRecording();
  }, [playing, stopRecording, recordingRef]);
  const recordLevel = recording && playing ? waveform(recording.seed, 300)[Math.floor((playhead - recording.start) * 20) % 300] : 0;

  const queueJob = (kind, payload, message, cloud) => {
    if (payload?.settings?.destination === "cloud" && !cloud) {
      setCloudRequest({ kind, payload, message });
      return null;
    }
    const id = enqueue?.(kind, { project, ...payload, ...(cloud ? { cloud } : {}) });
    setQueued(kind);
    notify(cloud ? `${kind} of ${project.name} sent to Frameleaf Cloud. Follow it in Activity.` : message);
    return id;
  };
  const restoreDuration = videoTrack.clips.filter((clip) => clip.kind === "video").reduce((total, clip) => total + clip.duration, 0);
  const restoreEstimate = estimateRender({
    durationSeconds: restoreDuration,
    resolution: "2160p",
    destination,
    mode: restore.mode,
    upscale: restore.upscale,
  });

  /* Drags ----------------------------------------------------------- */
  const startClipDrag = (event, clip, track, edge = null) => {
    if (event.button !== 0 || track.locked) return;
    event.preventDefault();
    event.stopPropagation();
    const base = historyRef.current.present;
    const origin = { x: event.clientX, y: event.clientY, start: clip.start, end: clipEnd(clip) };
    const state = { moved: false, project: null };
    const exclude = linkedClips(base, clip.id).map((item) => item.clip.id);
    const points = snapPoints(activeSequence(base), { exclude, extra: [playheadRef.current] });
    const move = (moveEvent) => {
      const dx = moveEvent.clientX - origin.x;
      if (!state.moved && Math.abs(dx) < 4 && Math.abs(moveEvent.clientY - origin.y) < 4) return;
      state.moved = true;
      const ripple = moveEvent.shiftKey;
      const dt = dx / pps;
      const threshold = snapping ? 8 / pps : 0;
      let next;
      if (edge === "start") next = trimClipStart(base, clip.id, snapTime(origin.start + dt, points, threshold), { ripple });
      else if (edge === "end") next = trimClipEnd(base, clip.id, snapTime(origin.end + dt, points, threshold), { ripple });
      else {
        const raw = origin.start + dt;
        const byStart = snapTime(raw, points, threshold);
        const byEnd = snapTime(raw + clip.duration, points, threshold) - clip.duration;
        const start = Math.abs(byStart - raw) <= Math.abs(byEnd - raw) ? byStart : byEnd;
        const lane = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY)?.closest?.("[data-track-id]");
        const trackId = lane?.dataset.trackId;
        next = moveClip(base, clip.id, { start: Math.max(0, start), trackId: trackId && trackId !== track.id ? trackId : undefined });
      }
      state.project = next;
      setDragProject(next);
      setDragInfo({ kind: edge ? "trim" : "move", ripple });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      if (state.moved && state.project) apply(() => state.project);
      select(clip.id);
      setDragProject(null);
      setDragInfo(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };
  const startScrub = (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    setPlaying(false);
    setRate(1);
    seek(timeFromX(event.clientX));
    const move = (moveEvent) => seek(timeFromX(moveEvent.clientX));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const startBinDrag = (event, asset) => {
    if (event.button !== 0 || event.pointerType === "touch") return;
    const origin = { x: event.clientX, y: event.clientY };
    const state = { moved: false, trackId: null, time: 0 };
    const kind = asset.type === "video" ? "video" : "photo";
    const move = (moveEvent) => {
      if (!state.moved && Math.abs(moveEvent.clientX - origin.x) < 5 && Math.abs(moveEvent.clientY - origin.y) < 5) return;
      state.moved = true;
      const lane = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY)?.closest?.("[data-track-id]");
      const trackId = lane?.dataset.trackId || null;
      const track = trackId ? activeSequence(historyRef.current.present).tracks.find((item) => item.id === trackId) : null;
      const valid = !!track && !track.locked && trackAccepts[track.kind].includes(kind);
      state.trackId = valid ? trackId : null;
      state.time = valid ? snapTime(timeFromX(moveEvent.clientX), snapPoints(activeSequence(historyRef.current.present), { extra: [playheadRef.current] }), snapping ? 8 / pps : 0) : 0;
      setBinDrag({ asset, x: moveEvent.clientX, y: moveEvent.clientY, valid, time: state.time });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      setBinDrag(null);
      if (state.moved && state.trackId) addAssetToTrack(asset, state.trackId, state.time);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  /* Keyboard -------------------------------------------------------- */
  const actions = useLatest({
    togglePlay,
    shuttle,
    stop,
    step,
    seek,
    splitAtPlayhead,
    removeSelection,
    nudge,
    zoom,
    undoAction,
    redoAction,
    addTitleAtPlayhead,
    length,
  });
  useEffect(() => {
    const handler = (event) => {
      if (dialogIsOpen() || isEditable(event.target)) return;
      const act = actions.current;
      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) act.redoAction();
        else act.undoAction();
        return;
      }
      if (meta || event.altKey) return;
      const unit = event.shiftKey ? 1 : FRAME;
      switch (event.key) {
        case " ":
          event.preventDefault();
          act.togglePlay();
          break;
        case "k":
        case "K":
          act.stop();
          break;
        case "j":
        case "J":
          act.shuttle(-1);
          break;
        case "l":
        case "L":
          act.shuttle(1);
          break;
        case "ArrowLeft":
          event.preventDefault();
          act.step(-unit);
          break;
        case "ArrowRight":
          event.preventDefault();
          act.step(unit);
          break;
        case "Home":
          event.preventDefault();
          act.seek(0);
          break;
        case "End":
          event.preventDefault();
          act.seek(act.length);
          break;
        case "s":
        case "S":
          act.splitAtPlayhead();
          break;
        case "Delete":
        case "Backspace":
          event.preventDefault();
          act.removeSelection(!event.shiftKey);
          break;
        case "+":
        case "=":
          act.zoom(1.25);
          break;
        case "-":
        case "_":
          act.zoom(0.8);
          break;
        case ",":
          act.nudge(-unit);
          break;
        case ".":
          act.nudge(unit);
          break;
        case "t":
        case "T":
          act.addTitleAtPlayhead();
          break;
        case "Escape":
          setSelection(null);
          setPanel(null);
          break;
        default:
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [actions]);

  /* Derived rendering data ------------------------------------------ */
  const contentWidth = Math.max((length + 12) * pps, 400);
  const ticks = useMemo(() => rulerTicks(length, pps), [length, pps]);
  const binAssets = assets.filter((asset) => !asset.isLocked && !asset.isSuppressed && asset.name.toLowerCase().includes(binQuery.trim().toLowerCase()));
  const usedAssetIds = [...new Set(project.sequences.flatMap((item) => item.tracks.flatMap((track) => track.clips.map((clip) => clip.assetId))).filter(Boolean))];
  const musicClips = sequence.tracks.filter((track) => track.kind === "music").flatMap((track) => track.clips);
  const dragTransition = dialog?.startsWith("transition:") ? findClip(project, dialog.slice(11))?.clip : null;

  const inspectorContent = (() => {
    if (tab === "Edit")
      return selected ? (
        <EditInspector
          clip={selected.clip}
          track={selected.track}
          asset={selected.clip.assetId ? assetMap.get(selected.clip.assetId) : null}
          audioTwin={selectedAudioTwin}
          apply={apply}
          quiet={quiet}
          beginGesture={beginGesture}
          endGesture={endGesture}
          advanced={advanced}
          onOpenTransition={(id) => setDialog(`transition:${id}`)}
          onGoToMotion={() => setTab("Motion")}
          splitAtPlayhead={splitAtPlayhead}
          removeSelection={removeSelection}
          playhead={playhead}
          seek={seek}
          notify={notify}
        />
      ) : (
        <SequenceSummary sequence={sequence} length={length} advanced={advanced} />
      );
    if (tab === "Color")
      return (
        <ColorPanel
          clip={gradeTarget}
          asset={gradeAsset}
          apply={apply}
          quiet={quiet}
          beginGesture={beginGesture}
          endGesture={endGesture}
          advanced={advanced}
          sourceRef={frameSource}
          playhead={playhead}
          playing={playing}
          inside={!!gradeTarget && gradeTarget.id === activeClip?.id}
          seek={seek}
        />
      );
    if (tab === "Audio")
      return (
        <AudioPanel
          sequence={sequence}
          project={project}
          apply={apply}
          quiet={quiet}
          beginGesture={beginGesture}
          endGesture={endGesture}
          playhead={playhead}
          playing={playing}
          notify={notify}
          advanced={advanced}
        />
      );
    if (tab === "Motion")
      return (
        <MotionPanel
          clip={motionTarget}
          asset={motionAsset}
          apply={apply}
          quiet={quiet}
          beginGesture={beginGesture}
          endGesture={endGesture}
          advanced={advanced}
          onAddTitle={addTitleAtPlayhead}
          playhead={playhead}
          seek={seek}
        />
      );
    if (tab === "Captions")
      return (
        <CaptionsPanel
          sequence={sequence}
          apply={apply}
          quiet={quiet}
          beginGesture={beginGesture}
          endGesture={endGesture}
          playhead={playhead}
          seek={seek}
          notify={notify}
        />
      );
    return (
      <RestorePanel
        restore={restore}
        setRestore={setRestore}
        destination={destination}
        setDestination={setDestination || (() => {})}
        choice={jobChoice.restoration}
        setChoice={(value) => setJobChoice((current) => ({ ...current, restoration: value }))}
        estimate={restoreEstimate}
        durationSeconds={restoreDuration}
        advanced={advanced}
        onRefreshFrame={captureFrame}
        onPreview={() =>
          queueJob(
            "AI restoration",
            {
              estimate: estimateRender({ durationSeconds: 5, resolution: "2160p", destination, mode: restore.mode, upscale: restore.upscale }),
              preview: true,
              settings: { ...restore, destination },
            },
            "5-second restoration preview queued.",
          )
        }
        onFull={() =>
          queueJob("AI restoration", { estimate: restoreEstimate, preview: false, settings: { ...restore, destination } }, `Restoration of ${project.name} queued.`)
        }
      />
    );
  })();

  return (
    <main className={`fls${advanced ? " is-advanced" : ""}${dragInfo ? ` is-dragging is-${dragInfo.kind}` : ""}`} aria-label="Studio">
      <header className="fls-header">
        <Button icon="mdiArrowLeft" onClick={back}>
          Library
        </Button>
        <div className="fls-project">
          <input
            className="fls-project-name"
            aria-label="Project name"
            value={nameDraft}
            maxLength={120}
            onChange={(event) => setNameDraft(event.target.value)}
            onBlur={() => {
              if (nameDraft.trim() && nameDraft.trim() !== project.name) apply((current) => renameProject(current, nameDraft));
              else setNameDraft(project.name);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") {
                setNameDraft(project.name);
                event.currentTarget.blur();
              }
            }}
          />
          <span className="fls-save" role="status" aria-live="polite">
            {saveStatus === "saving" ? (
              "Saving…"
            ) : (
              <>
                <Icon name="mdiCheckCircle" size={14} /> All changes saved
              </>
            )}
          </span>
        </div>
        <span className="grow" />
        {queued && (
          <button type="button" className="fls-queued" onClick={() => onOpenActivity?.()}>
            <Icon name="mdiProgressClock" size={14} />
            <span>{queued} queued · Open Activity</span>
          </button>
        )}
        <div className="fls-mode" role="radiogroup" aria-label="Editing mode">
          <button type="button" role="radio" aria-checked={!advanced} className={!advanced ? "is-on" : ""} onClick={() => setMode("basic")}>
            Basic
          </button>
          <button type="button" role="radio" aria-checked={advanced} className={advanced ? "is-on" : ""} onClick={() => setMode("advanced")}>
            Advanced
          </button>
        </div>
        <span className="fls-editor-as">
          <PersonAvatar person={owner} size={26} />
          <span>Editing as {owner.name}</span>
        </span>
        <Button className="fls-narrow-only" icon="mdiImageMultipleOutline" aria-label="Media bin" aria-pressed={panel === "bin"} onClick={() => setPanel(panel === "bin" ? null : "bin")} />
        <Button className="fls-narrow-only" icon="mdiTuneVariant" aria-label="Inspector" aria-pressed={panel === "inspector"} onClick={() => setPanel(panel === "inspector" ? null : "inspector")} />
        <Button icon="mdiCommentTextOutline" onClick={() => setDialog("review")}>
          Review
          {sequence.review.some((comment) => !comment.resolved) && <span className="fls-count">{sequence.review.filter((comment) => !comment.resolved).length}</span>}
        </Button>
        <Button primary icon="mdiExportVariant" onClick={() => setDialog("export")}>
          Export
        </Button>
      </header>

      <div className="fls-tabbar">
        <TabList label="Studio workspaces" tabs={TABS} value={tab} onChange={(next) => { setTab(next); if (panel === "bin") setPanel(null); }} className="fls-tabs" />
        <span className="grow" />
        <span className="fls-sample-note muted">Preview · sample data</span>
      </div>

      <div className={`fls-body${panel ? ` has-${panel}` : ""}`}>
        <aside className={`fls-bin${panel === "bin" ? " is-open" : ""}`} aria-label="Media bin">
          <div className="fls-bin-top">
            <TabList label="Media source" tabs={["Library", "Project"]} value={binTab} onChange={setBinTab} className="fls-segmented fls-segmented--tabs" />
            <Button className="fls-panel-close" icon="mdiClose" aria-label="Close media bin" onClick={() => setPanel(null)} />
          </div>
          {binTab === "Library" && (
            <>
              <label className="fls-search">
                <Icon name="mdiMagnify" size={16} />
                <input type="search" placeholder="Search media" aria-label="Search media" value={binQuery} onChange={(event) => setBinQuery(event.target.value)} />
              </label>
              <div className="fls-bin-grid" role="list" aria-label="Library media">
                {binAssets.map((asset) => (
                  <div key={asset.id} role="listitem" className={`fls-bin-item${asset.id === selectedId ? " is-active" : ""}`}>
                    <button
                      type="button"
                      className="fls-bin-thumb"
                      aria-label={`${asset.name}${asset.type === "video" ? `, ${shortTimecode(asset.duration)}` : ", photo"}. Drag to the timeline.`}
                      onPointerDown={(event) => startBinDrag(event, asset)}
                      onClick={() => onSelectAsset?.(asset.id)}
                    >
                      <img src={asset.image} alt="" draggable={false} />
                      <span className="fls-bin-badge">{asset.type === "video" ? shortTimecode(asset.duration) : <Icon name="mdiImageOutline" size={11} />}</span>
                    </button>
                    <span className="fls-bin-name" title={asset.name}>
                      {asset.name}
                    </span>
                    <button type="button" className="fls-bin-add" aria-label={`Add ${asset.name} at playhead`} onClick={() => addAssetToTrack(asset, videoTrack.id, playheadRef.current)}>
                      <Icon name="mdiPlus" size={14} />
                    </button>
                  </div>
                ))}
                {!binAssets.length && <p className="muted">No media matches.</p>}
              </div>
            </>
          )}
          {binTab === "Project" && (
            <div className="fls-bin-project">
              <h4>Sequences</h4>
              <ul className="fls-list" aria-label="Sequences">
                {project.sequences.map((item) => (
                  <li key={item.id}>
                    <button type="button" className={`fls-row${item.id === sequence.id ? " is-on" : ""}`} aria-current={item.id === sequence.id ? "true" : undefined} onClick={() => { quiet((current) => setActiveSequence(current, item.id)); setSelection(null); seek(0); }}>
                      <Icon name="mdiMovieOpenOutline" size={16} />
                      <span>{item.name}</span>
                      <span className="muted">{shortTimecode(timelineLength(item))}</span>
                    </button>
                  </li>
                ))}
              </ul>
              <h4>Used media</h4>
              <div className="fls-bin-grid" role="list" aria-label="Media in this project">
                {usedAssetIds.map((id) => assetMap.get(id)).filter(Boolean).map((asset) => (
                  <div key={asset.id} role="listitem" className="fls-bin-item">
                    <button type="button" className="fls-bin-thumb" aria-label={`${asset.name}. Drag to the timeline.`} onPointerDown={(event) => startBinDrag(event, asset)} onClick={() => onSelectAsset?.(asset.id)}>
                      <img src={asset.image} alt="" draggable={false} />
                    </button>
                    <span className="fls-bin-name">{asset.name}</span>
                    <button type="button" className="fls-bin-add" aria-label={`Add ${asset.name} at playhead`} onClick={() => addAssetToTrack(asset, videoTrack.id, playheadRef.current)}>
                      <Icon name="mdiPlus" size={14} />
                    </button>
                  </div>
                ))}
              </div>
              <h4>Music</h4>
              <ul className="fls-list" aria-label="Music in this sequence">
                {musicClips.map((clip) => (
                  <li key={clip.id}>
                    <button type="button" className="fls-row" onClick={() => { select(clip.id); seek(clip.start); }}>
                      <Icon name="mdiMusicNoteOutline" size={16} />
                      <span>{clip.name}</span>
                      <span className="muted">{shortTimecode(clip.duration)}</span>
                    </button>
                  </li>
                ))}
                <li>
                  <button type="button" className="fls-row" onClick={() => setDialog("music")}>
                    <Icon name="mdiPlus" size={16} />
                    <span>Add music</span>
                  </button>
                </li>
              </ul>
            </div>
          )}
        </aside>

        <section className="fls-program" aria-label="Program monitor">
          <div className={`fls-monitor${fullscreen ? " is-fullscreen" : ""}`} ref={monitorRef}>
            {tab === "Restore" ? (
              <RestoreCompare frame={frame} split={restore.split} setSplit={(split) => setRestore({ split })} loupe={restore.loupe} mode={restore.mode} />
            ) : (
              <div className="fls-stage">
                {transition && transition.type !== "Dip to black" && previousAsset && (
                  <img className="fls-stage-prev" src={previousAsset.image} alt="" style={{ transform: rectTransform(kenBurnsAt(previousClip, 1)) }} />
                )}
                <div className="fls-stage-layer" style={{ filter: stageFilter, ...(transition?.style || {}) }}>
                  <video ref={videoRef} className="fls-video" src={videoSrc || undefined} playsInline preload="auto" style={{ visibility: activeClip?.kind === "video" ? "visible" : "hidden" }} />
                  {activeClip?.kind === "photo" && activeAsset && (
                    <img ref={photoRef} className="fls-photo" src={activeAsset.image} alt="" style={{ transform: rectTransform(kenBurnsAt(activeClip, progress)) }} />
                  )}
                </div>
                {transition?.dip > 0 && <div className="fls-dip" style={{ opacity: transition.dip }} />}
                {!activeClip && (
                  <p className="fls-stage-empty">
                    {length ? "Gap · nothing on the video track here" : "Drag media from the bin to start your film"}
                  </p>
                )}
                {overlayClip && overlayAsset && (
                  <img className={`fls-pip fls-pos-${overlayClip.position}`} src={overlayAsset.image} alt="" />
                )}
                {titleClip && titleView && (
                  <div className={`fls-title fls-title--${slug(titleClip.style)} fls-pos-${titleClip.position}`} style={titleView.style}>
                    <span>{titleView.text}</span>
                  </div>
                )}
                {captionLine && captionLine.text && <div className="fls-caption">{captionLine.text}</div>}
                {guides && (
                  <div className="fls-guides" aria-hidden="true">
                    <div className="fls-guide fls-guide--action" />
                    <div className="fls-guide fls-guide--title" />
                  </div>
                )}
                {quality !== "Auto" && <span className="fls-quality-tag">{quality}</span>}
                {recording && (
                  <span className="fls-rec" role="status">
                    <i /> Recording {shortTimecode(playhead - recording.start)}
                  </span>
                )}
              </div>
            )}
          </div>
          <div className="fls-transport">
            <span className="fls-timecode" aria-label="Playhead position">
              {frameTimecode(playhead, fps)}
            </span>
            <span className="fls-timecode fls-timecode--total">/ {frameTimecode(length, fps)}</span>
            <span className="grow" />
            <Button icon="mdiSkipPrevious" aria-label="Go to start" onClick={() => step(-Infinity)} />
            <Button icon="mdiSkipBackward" aria-label="Step back one frame" onClick={() => step(-FRAME)} />
            <Button className="fls-play" icon={playing ? "mdiPause" : "mdiPlay"} aria-label={playing ? "Pause" : "Play"} onClick={togglePlay} />
            <Button icon="mdiSkipForward" aria-label="Step forward one frame" onClick={() => step(FRAME)} />
            <Button icon="mdiSkipNext" aria-label="Go to end" onClick={() => step(Infinity)} />
            {playing && rate !== 1 && <span className="fls-rate">{rate < 0 ? "◀" : "▶"} {Math.abs(rate)}×</span>}
            <span className="grow" />
            <Button icon="mdiRepeat" aria-label="Loop playback" aria-pressed={loop} active={loop} onClick={() => quiet((current) => setSettings(current, { loop: !loop }))} />
            <Button icon="mdiVectorSquare" aria-label="Safe area guides" aria-pressed={guides} active={guides} onClick={() => quiet((current) => setSettings(current, { guides: !guides }))} />
            <Menu label={quality} icon="mdiMonitor" items={QUALITIES} value={quality} onSelect={setQuality} ariaLabel="Playback quality" />
            <Button icon={fullscreen ? "mdiFullscreenExit" : "mdiFullscreen"} aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"} onClick={toggleFullscreen} />
          </div>
          <div className="fls-monitor-meta">
            <span>{activeAsset ? activeAsset.name : sequence.name}</span>
            <span>
              {sequence.width} × {sequence.height} · {fps} fps
            </span>
          </div>
        </section>

        <aside className={`fls-inspector${panel === "inspector" ? " is-open" : ""}`} aria-label="Inspector">
          <div className="fls-inspector-head">
            <h3>{tab === "Edit" ? (selected ? "Clip" : "Sequence") : tab}</h3>
            <Button className="fls-panel-close" icon="mdiClose" aria-label="Close inspector" onClick={() => setPanel(null)} />
          </div>
          {inspectorContent}
        </aside>
        {panel && <button type="button" className="fls-scrim" aria-label="Close panel" onClick={() => setPanel(null)} />}
      </div>

      <section className="fls-timeline" aria-label="Timeline">
        <div className="fls-tl-toolbar">
          <TabList label="Sequences" tabs={project.sequences.map((item) => item.name)} value={sequence.name} onChange={(name) => { const item = project.sequences.find((entry) => entry.name === name); if (item) { quiet((current) => setActiveSequence(current, item.id)); setSelection(null); seek(0); } }} className="fls-seq-tabs" />
          <span className="fls-tl-sep" />
          <Button icon="mdiUndo" aria-label="Undo" disabled={!canUndo(history)} onClick={undoAction} />
          <Button icon="mdiRedo" aria-label="Redo" disabled={!canRedo(history)} onClick={redoAction} />
          <span className="fls-tl-sep" />
          <Button icon="mdiScissorsCutting" aria-label="Split at playhead (S)" title="Split at playhead (S)" onClick={splitAtPlayhead} />
          <Button icon="mdiDeleteOutline" aria-label="Delete selected clip" title="Delete (Shift: leave a gap)" disabled={!selection} onClick={() => removeSelection(true)} />
          <button type="button" className={`button${snapping ? " active" : ""}`} aria-pressed={snapping} aria-label="Snapping" title="Snapping" onClick={() => setSnapping(!snapping)}>
            <IconPath path={mdiMagnet} size={18} />
          </button>
          <span className="fls-tl-hint muted">{dragInfo ? (dragInfo.ripple ? "Ripple · later clips follow" : dragInfo.kind === "trim" ? "Hold Shift to ripple" : "Drop to insert") : "Drag clips to move · edges to trim · Shift for ripple"}</span>
          <span className="grow" />
          <Button icon="mdiMagnifyMinusOutline" aria-label="Zoom out" onClick={() => zoom(0.8)} />
          <input type="range" className="fls-zoom" min={MIN_PPS} max={MAX_PPS} step={1} value={pps} aria-label="Timeline zoom" onChange={(event) => setPps(Number(event.target.value))} />
          <Button icon="mdiMagnifyPlusOutline" aria-label="Zoom in" onClick={() => zoom(1.25)} />
          <Button icon="mdiArrowExpandAll" aria-label="Fit timeline" onClick={fitTimeline} />
        </div>
        <div className="fls-tl-scroller" ref={scrollerRef}>
          <div className="fls-tl-heads">
            <div className="fls-tl-corner">
              <span className="muted">{shortTimecode(length)}</span>
            </div>
            {sequence.tracks.map((track) => (
              <TrackHead
                key={track.id}
                track={track}
                meta={TRACK_META[track.kind]}
                onToggle={toggleTrack}
                extra={
                  track.kind === "music" ? (
                    <button type="button" className="fls-mini fls-mini--wide" aria-label="Add music" onClick={() => setDialog("music")}>
                      <Icon name="mdiPlus" size={12} /> <span>Music</span>
                    </button>
                  ) : track.kind === "voice" ? (
                    recording ? (
                      <button type="button" className="fls-mini fls-mini--wide is-rec" aria-label="Stop recording" onClick={stopRecording}>
                        <Icon name="mdiStop" size={12} /> Stop
                        <span className="fls-rec-meter" aria-hidden="true">
                          <span style={{ transform: `scaleX(${recordLevel.toFixed(2)})` }} />
                        </span>
                      </button>
                    ) : (
                      <button type="button" className="fls-mini fls-mini--wide" aria-label="Record voiceover" disabled={track.locked} onClick={startRecording}>
                        <Icon name="mdiRecord" size={12} /> <span>Record</span>
                      </button>
                    )
                  ) : track.kind === "title" ? (
                    <button type="button" className="fls-mini fls-mini--wide" aria-label="Add title at playhead" onClick={addTitleAtPlayhead}>
                      <Icon name="mdiPlus" size={12} /> <span>Title</span>
                    </button>
                  ) : null
                }
              />
            ))}
          </div>
          <div className="fls-tl-lanes" ref={lanesRef} style={{ width: contentWidth }}>
            <div className="fls-ruler" onPointerDown={startScrub}>
              {ticks.map((tick) => (
                <span key={tick.time} className={`fls-tick${tick.major ? " is-major" : ""}`} style={{ left: tick.time * pps }}>
                  {tick.major && <em>{frameTimecode(tick.time, fps).slice(3)}</em>}
                </span>
              ))}
              <div className="fls-playhead-handle" style={{ left: playhead * pps }} role="slider" aria-label="Playhead" aria-valuemin={0} aria-valuemax={Math.round(length * 100) / 100} aria-valuenow={Math.round(playhead * 100) / 100} aria-valuetext={frameTimecode(playhead, fps)} tabIndex={0} onKeyDown={(event) => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); event.stopPropagation(); step(event.key === "ArrowLeft" ? -(event.shiftKey ? 1 : FRAME) : event.shiftKey ? 1 : FRAME); } }} />
            </div>
            {sequence.tracks.map((track) => (
              <div key={track.id} className={`fls-lane fls-lane--${track.kind}${track.locked ? " is-locked" : ""}${track.muted ? " is-muted" : ""}${binDrag ? (binDrag.valid && trackAccepts[track.kind].includes(binDrag.asset.type === "video" ? "video" : "photo") ? " is-droppable" : "") : ""}`} data-track-id={track.id} style={{ height: TRACK_META[track.kind].height }} onPointerDown={(event) => { if (event.target === event.currentTarget) { setSelection(null); startScrub(event); } }}>
                {track.clips.map((clip) => (
                  <TimelineClip
                    key={clip.id}
                    clip={clip}
                    track={track}
                    asset={clip.assetId ? assetMap.get(clip.assetId) : null}
                    pps={pps}
                    selected={clip.id === selection}
                    linked={clip.id !== selection && linkedIds.has(clip.id)}
                    onPointerDown={(event, item, owner) => startClipDrag(event, item, owner)}
                    onTrimPointerDown={(event, item, owner, edge) => startClipDrag(event, item, owner, edge)}
                    onSelect={select}
                    onOpenTransition={(id) => setDialog(`transition:${id}`)}
                    onSeek={seek}
                  />
                ))}
                {recording && track.kind === "voice" && (
                  <div className="fls-clip fls-clip--voice is-recording" style={{ left: recording.start * pps, width: Math.max(4, (playhead - recording.start) * pps) }} aria-hidden="true">
                    <span className="fls-clip-name">Recording…</span>
                  </div>
                )}
              </div>
            ))}
            <div className="fls-playhead" style={{ left: playhead * pps }} aria-hidden="true" />
          </div>
        </div>
      </section>

      {binDrag && (
        <div className={`fls-drag-ghost${binDrag.valid ? " is-valid" : ""}`} style={{ left: binDrag.x, top: binDrag.y }} aria-hidden="true">
          <img src={binDrag.asset.image} alt="" />
          <span>{binDrag.valid ? `Insert at ${shortTimecode(binDrag.time)}` : binDrag.asset.name}</span>
        </div>
      )}

      {cloudRequest && (
        <CloudJobDialog
          key={cloudRequest.kind}
          title={
            cloudRequest.workload === "interpolation"
              ? "Smooth motion on Frameleaf Cloud"
              : cloudRequest.kind === "Export"
                ? "Render on Frameleaf Cloud"
                : "Restore on Frameleaf Cloud"
          }
          workload={cloudRequest.workload ?? (cloudRequest.kind === "Export" ? "render" : "restoration")}
          {...(() => {
            if (cloudRequest.quantity) return { quantity: cloudRequest.quantity, quantityLabel: cloudRequest.quantityLabel };
            const seconds = cloudRequest.payload.preview ? 5 : cloudRequest.kind === "Export" ? length : restoreDuration;
            const { quantity, label } = jobQuantity("restoration", { durationSeconds: seconds });
            return { quantity, quantityLabel: label };
          })()}
          preview={cloudRequest.payload.preview}
          summary={project.name}
          modelId={cloudRequest.modelId ?? jobChoice[cloudRequest.kind === "Export" ? "render" : "restoration"]?.model}
          worker={
            !cloudRequest.workload && jobChoice[cloudRequest.kind === "Export" ? "render" : "restoration"]?.worker === "lan"
              ? lanWorker
              : undefined
          }
          onSubmit={(meta) => {
            if (cloudRequest.next) nextJob.current = cloudRequest.next;
            return queueJob(cloudRequest.kind, cloudRequest.payload, cloudRequest.message, meta);
          }}
          onRunLocal={
            cloudRequest.workload === "interpolation"
              ? (model) => {
                  queueJob(cloudRequest.kind, { ...cloudRequest.payload, settings: { ...cloudRequest.payload.settings, model } }, cloudRequest.message);
                  if (cloudRequest.next) nextJob.current = cloudRequest.next;
                }
              : undefined
          }
          onFinish={finishJob}
          onOpenSettings={(section) => {
            setCloudRequest(null);
            onOpenCloudSettings?.(section);
          }}
          onAddCredit={
            onAddCredit &&
            (() => {
              setCloudRequest(null);
              onAddCredit();
            })
          }
          close={() => {
            const next = nextJob.current;
            nextJob.current = null;
            setCloudRequest(null);
            if (next) queueJob(next.kind, next.payload, next.message);
          }}
        />
      )}
      {dialog === "export" && (
        <ExportDialog
          sequence={sequence}
          length={length}
          destination={destination}
          setDestination={setDestination || (() => {})}
          choice={jobChoice.render}
          setChoice={(value) => setJobChoice((current) => ({ ...current, render: value }))}
          close={() => setDialog(null)}
          onExport={({ format, color, resolution, estimate, frameRate, conversion, interpolation }) => {
            const settings = {
              format,
              color,
              resolution,
              destination,
              frameRate,
              ...(conversion ? { frameConversion: conversion } : {}),
              ...(interpolation ? { interpolationModel: interpolation.item.id } : {}),
            };
            const exportJob = { kind: "Export", payload: { estimate, preview: false, settings }, message: `Export of ${project.name} queued.` };
            setDialog(null);
            if (interpolation?.runsOn === "cloud") {
              // AI interpolation on Frameleaf Cloud is its own confirmed job; the export follows it.
              const work = interpolationWork({ durationSeconds: length, sourceFps: sequence.fps, targetFps: frameRate });
              setCloudRequest({
                kind: "Smooth motion",
                workload: "interpolation",
                quantity: work.units,
                quantityLabel: `${formatWorkTime(length)} · ${sequence.fps} → ${frameRate} fps`,
                modelId: interpolation.item.id,
                payload: { settings: { targetFps: frameRate, sourceFps: sequence.fps, model: interpolation.item.id } },
                message: `Smooth motion for ${project.name} queued.`,
                next: exportJob,
              });
            } else queueJob(exportJob.kind, exportJob.payload, exportJob.message);
          }}
        />
      )}
      {dialog === "review" && (
        <ReviewDialog
          sequence={sequence}
          people={people}
          owner={owner}
          playhead={playhead}
          seek={seek}
          close={() => setDialog(null)}
          onAdd={(comment) => quiet((current) => addReviewComment(current, { ...comment, createdAt: new Date().toISOString() }))}
          onResolve={(id, resolved) => quiet((current) => updateReviewComment(current, id, { resolved }))}
          onRemove={(id) => quiet((current) => removeReviewComment(current, id))}
        />
      )}
      {dialog === "music" && (
        <MusicDialog
          playhead={playhead}
          close={() => setDialog(null)}
          onAdd={(musicId) => {
            const id = makeId("music");
            apply((current) => addMusic(current, musicId, playheadRef.current, { id }));
            select(id);
            setDialog(null);
            notify("Music added to the timeline.");
          }}
        />
      )}
      {dragTransition && (
        <TransitionDialog
          clip={dragTransition}
          close={() => setDialog(null)}
          onApply={(value) => {
            apply((current) => setTransition(current, dragTransition.id, value));
            setDialog(null);
          }}
        />
      )}
    </main>
  );
}
