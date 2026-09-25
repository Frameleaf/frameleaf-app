import React, {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button, Dialog } from "./App";
import { Icon } from "./Icon";
import { media, timecode } from "./media";
import { durationFor, hasTimeline, normalizeEdit } from "./state.mjs";
import { CloudJobDialog, useCloudState } from "./CloudJobDialog";
import { ModelSlider, resolveModelChoice, sliderContext } from "./ModelSlider";
import { cloudAdmission } from "./frameleaf-cloud-data.mjs";
import { creditLabel, estimateRange, jobQuantity } from "./cloud-jobs.mjs";
import {
  INTERPOLATION_PREVIEW_SECONDS,
  INTERPOLATION_TRADEOFF,
  formatDuration,
  interpolationEstimate,
  interpolationWork,
} from "./gpu-model-catalog.mjs";
import {
  ASPECTS,
  AUTO_TONE,
  DEVELOP_GROUPS,
  DEVELOP_PARAMS,
  SOCIAL_PRESETS,
  SPEEDS,
  TEXT_POSITIONS,
  aspectRatioValue,
  autoToneApplied,
  cssFilterFor,
  developDefaults,
  filmstripTimes,
  fitCropRect,
  groupIsDefault,
  groupReset,
  histogramBins,
  isCompareKey,
  isFullRect,
  paramsInGroup,
  pickSettings,
  presetsFor,
  renderedDuration,
  resizeCropRect,
  speedAt,
  straightenScale,
  tonePixels,
} from "./develop.mjs";
import "./editor.css";

/* Shared helpers ------------------------------------------------------- */

const FULL_RECT = { x: 0, y: 0, w: 1, h: 1 };
const TOOLS = [
  { id: "trim", label: "Trim", icon: "mdiContentCut", video: true },
  { id: "speed", label: "Speed", icon: "mdiSpeedometer", video: true },
  { id: "adjust", label: "Adjust", icon: "mdiTune" },
  { id: "crop", label: "Crop", icon: "mdiCropRotate" },
  { id: "audio", label: "Audio", icon: "mdiVolumeHigh", video: true },
  { id: "text", label: "Text", icon: "mdiFormatText", video: true },
  { id: "enhance", label: "Enhance", icon: "mdiAutoFix" },
  { id: "presets", label: "Presets", icon: "mdiImageFilterVintage" },
];
const SWATCHES = ["#ffffff", "#f5d76e", "#7fd1ae", "#ff6b6b", "#101112"];
const POSITION_LABELS = {
  "top-left": "Top left",
  top: "Top",
  "top-right": "Top right",
  left: "Left",
  center: "Centre",
  right: "Right",
  "bottom-left": "Bottom left",
  bottom: "Bottom",
  "bottom-right": "Bottom right",
};
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const round = (value, places = 2) =>
  Math.round(value * 10 ** places) / 10 ** places;
const precise = (seconds) => {
  const safe = Math.max(0, seconds || 0);
  const minutes = Math.floor(safe / 60);
  const rest = safe - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${rest.toFixed(1).padStart(4, "0")}`;
};
const formatParam = (spec, value) => {
  const sign = spec.min < 0 && value > 0 ? "+" : "";
  if (spec.id === "exposure") return `${sign}${value.toFixed(2)} ${spec.unit}`;
  return `${sign}${Math.round(value)}${spec.unit}`;
};
const isEditable = (target) =>
  ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName) ||
  target?.isContentEditable;
const rotateRect = (rect, clockwise) =>
  clockwise
    ? { x: 1 - rect.y - rect.h, y: rect.x, w: rect.h, h: rect.w }
    : { x: rect.y, y: 1 - rect.x - rect.w, w: rect.h, h: rect.w };
const rotateAspect = (aspect) =>
  ({ "16:9": "9:16", "9:16": "16:9", Original: "Original", "1:1": "1:1", Free: "Free" })[
    aspect
  ] || "Free";
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const newId = () =>
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID().slice(0, 8)
    : String(Date.now());

function startDrag(event, onMove, onEnd) {
  const target = event.currentTarget;
  const id = event.pointerId;
  try {
    target.setPointerCapture(id);
  } catch {}
  const move = (e) => {
    if (e.pointerId === id) onMove(e);
  };
  const end = (e) => {
    if (e.pointerId !== id) return;
    target.removeEventListener("pointermove", move);
    target.removeEventListener("pointerup", end);
    target.removeEventListener("pointercancel", end);
    try {
      target.releasePointerCapture(id);
    } catch {}
    onEnd?.(e);
  };
  target.addEventListener("pointermove", move);
  target.addEventListener("pointerup", end);
  target.addEventListener("pointercancel", end);
}

function useElementSize(ref) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const update = () => {
      const box = element.getBoundingClientRect();
      setSize((current) =>
        current.w === box.width && current.h === box.height
          ? current
          : { w: box.width, h: box.height },
      );
    };
    update();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", update);
      return () => window.removeEventListener("resize", update);
    }
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

/** Twelve real frames from the clip, falling back to the poster. */
function useFilmstrip(asset, duration, enabled) {
  const [frames, setFrames] = useState(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!enabled) {
      setFrames(null);
      return undefined;
    }
    const times = filmstripTimes(duration, 12);
    const fallback = times.map(() => asset.image);
    setFrames(fallback);
    if (!asset.mediaSrc || typeof document === "undefined") return undefined;
    let cancelled = false;
    const video = document.createElement("video");
    video.muted = true;
    video.preload = "auto";
    video.playsInline = true;
    video.src = asset.mediaSrc;
    const canvas = document.createElement("canvas");
    const captured = [];
    const finish = (list) => {
      if (!cancelled) {
        setFrames(list);
        setLoading(false);
      }
    };
    const seekTo = (time) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timeout")), 2500);
        const done = () => {
          clearTimeout(timer);
          video.removeEventListener("seeked", done);
          resolve();
        };
        video.addEventListener("seeked", done);
        const limit = Math.max(0, (video.duration || duration) - 0.05);
        video.currentTime = Math.min(time, limit);
      });
    const run = async () => {
      try {
        await new Promise((resolve, reject) => {
          if (video.readyState >= 1) return resolve();
          video.addEventListener("loadedmetadata", resolve, { once: true });
          video.addEventListener("error", () => reject(new Error("load")), {
            once: true,
          });
        });
        const width = 96;
        const height = Math.max(
          1,
          Math.round((width * (video.videoHeight || 9)) / (video.videoWidth || 16)),
        );
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        for (const time of times) {
          if (cancelled) return;
          await seekTo(time);
          context.drawImage(video, 0, 0, width, height);
          captured.push(canvas.toDataURL("image/jpeg", 0.72));
          if (!cancelled)
            setFrames([...captured, ...fallback.slice(captured.length)]);
        }
        finish(captured);
      } catch {
        finish(captured.length ? [...captured, ...fallback.slice(captured.length)] : fallback);
      }
    };
    setLoading(true);
    run();
    return () => {
      cancelled = true;
      video.removeAttribute("src");
      try {
        video.load();
      } catch {}
    };
  }, [asset.id, asset.mediaSrc, asset.image, duration, enabled]);
  return { frames, loading };
}

function drawHistogram(canvas, bins) {
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || 268;
  const height = canvas.clientHeight || 90;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const context = canvas.getContext("2d");
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  const max = bins.max || 1;
  const trace = (values, fill, stroke) => {
    const last = values.length - 1;
    context.beginPath();
    context.moveTo(0, height);
    values.forEach((value, index) => {
      const x = (index / last) * width;
      const y = height - (value / max) ** 0.65 * (height - 6);
      context.lineTo(x, y);
    });
    context.lineTo(width, height);
    context.closePath();
    if (fill) {
      context.fillStyle = fill;
      context.fill();
    }
    if (stroke) {
      context.strokeStyle = stroke;
      context.lineWidth = 1;
      context.stroke();
    }
  };
  context.globalCompositeOperation = "screen";
  trace(bins.red, "rgba(240, 92, 92, 0.55)");
  trace(bins.green, "rgba(96, 214, 132, 0.55)");
  trace(bins.blue, "rgba(96, 150, 255, 0.55)");
  context.globalCompositeOperation = "source-over";
  trace(bins.luma, null, "rgba(236, 238, 241, 0.85)");
}

/** Samples the live preview pixels and redraws the histogram on the next frame. */
function useHistogram(canvasRef, getSource, filterInfo, enabled, tick) {
  const [status, setStatus] = useState("idle");
  const [clipped, setClipped] = useState({ shadows: 0, highlights: 0 });
  const sampler = useRef(null);
  useEffect(() => {
    if (!enabled) return undefined;
    const frame = requestAnimationFrame(() => {
      const canvas = canvasRef.current;
      const source = getSource();
      if (!canvas || !source) return;
      const isVideo = source.tagName === "VIDEO";
      const ready = isVideo
        ? source.readyState >= 2
        : source.complete && source.naturalWidth > 0;
      if (!ready) return;
      try {
        const sourceWidth = isVideo ? source.videoWidth : source.naturalWidth;
        const sourceHeight = isVideo ? source.videoHeight : source.naturalHeight;
        const width = 128;
        const height = Math.max(1, Math.round((width * sourceHeight) / sourceWidth));
        const offscreen =
          sampler.current || (sampler.current = document.createElement("canvas"));
        offscreen.width = width;
        offscreen.height = height;
        const context = offscreen.getContext("2d", { willReadFrequently: true });
        context.drawImage(source, 0, 0, width, height);
        const image = context.getImageData(0, 0, width, height);
        tonePixels(image.data, filterInfo.numeric, filterInfo.params);
        const bins = histogramBins(image, 64);
        drawHistogram(canvas, bins);
        setClipped(bins.clipped);
        setStatus("ok");
      } catch {
        setStatus("unavailable");
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [enabled, filterInfo, tick, canvasRef, getSource]);
  return { status, clipped };
}

/* Small presentational pieces ------------------------------------------ */

function Tool({ label, icon, children, className = "", primary, active, ...props }) {
  return (
    <button
      type="button"
      className={`ed-tool ${primary ? "primary" : ""} ${active ? "active" : ""} ${children ? "labelled" : ""} ${className}`}
      aria-label={children ? undefined : label}
      title={label}
      {...props}
    >
      {icon && <Icon name={icon} size={20} />}
      {children && <span>{children}</span>}
    </button>
  );
}

function Slider({ id, label, value, min, max, step, defaultValue, format, onChange, disabled }) {
  const inputId = useId();
  const percent = (v) => ((v - min) / (max - min)) * 100;
  const zero = min < 0 && max > 0 ? percent(0) : 0;
  const fillStart = Math.min(zero, percent(value));
  const fillEnd = Math.max(zero, percent(value));
  const bipolar = min < 0 && max > 0;
  return (
    <div
      className={`ed-slider ${bipolar ? "bipolar" : ""} ${value !== defaultValue ? "changed" : ""}`}
    >
      <label htmlFor={inputId}>{label}</label>
      <output htmlFor={inputId}>{format ? format(value) : value}</output>
      <input
        id={inputId}
        data-param={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        title="Double-click to reset"
        style={{ "--fill-start": `${fillStart}%`, "--fill-end": `${fillEnd}%` }}
        onChange={(event) => onChange(Number(event.target.value))}
        onDoubleClick={() => onChange(defaultValue)}
      />
    </div>
  );
}

function Group({ group, open, toggle, edit, changeEdit }) {
  const bodyId = useId();
  const params = paramsInGroup(group.id);
  const isDefault = groupIsDefault(edit, group.id);
  return (
    <section className="ed-group">
      <div className="ed-group-head">
        <button
          type="button"
          className="ed-group-toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={toggle}
        >
          <Icon name="mdiChevronRight" size={18} className="ed-chevron" />
          <span>{group.label}</span>
          {!isDefault && <i className="ed-dot" aria-hidden="true" />}
        </button>
        <button
          type="button"
          className="ed-icon"
          aria-label={`Reset ${group.label}`}
          title={`Reset ${group.label}`}
          disabled={isDefault}
          onClick={() => changeEdit(groupReset(group.id))}
        >
          <Icon name="mdiRestore" size={18} />
        </button>
      </div>
      {open && (
        <div id={bodyId} className="ed-group-body">
          {params.map((spec) => (
            <Slider
              key={spec.id}
              id={spec.id}
              label={spec.label}
              value={edit[spec.id]}
              min={spec.min}
              max={spec.max}
              step={spec.step}
              defaultValue={spec.default}
              format={(value) => formatParam(spec, value)}
              onChange={(value) => changeEdit({ [spec.id]: value })}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function Menu({ label, items, close, children }) {
  const ref = useRef(null);
  useEffect(() => {
    const first = ref.current?.querySelector('[role^="menuitem"]:not(:disabled)');
    first?.focus();
    const outside = (event) => {
      if (ref.current && !ref.current.contains(event.target)) close(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, []);
  const keyDown = (event) => {
    const options = Array.from(
      ref.current.querySelectorAll('[role^="menuitem"]:not(:disabled)'),
    );
    const index = options.indexOf(document.activeElement);
    const go = (next) => {
      event.preventDefault();
      options[(next + options.length) % options.length]?.focus();
    };
    if (event.key === "ArrowDown") go(index + 1);
    else if (event.key === "ArrowUp") go(index - 1);
    else if (event.key === "Home") go(0);
    else if (event.key === "End") go(options.length - 1);
    else if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    }
  };
  return (
    <div className="ed-popover" role="menu" aria-label={label} ref={ref} onKeyDown={keyDown}>
      {children}
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role={item.checked === undefined ? "menuitem" : "menuitemradio"}
          aria-checked={item.checked}
          disabled={item.disabled}
          onClick={() => {
            item.onSelect();
            close(true);
          }}
        >
          {item.icon && <Icon name={item.icon} size={18} />}
          {item.label}
          {item.note && <small>{item.note}</small>}
        </button>
      ))}
    </div>
  );
}

/* The full-screen quick editor ---------------------------------------- */

function QuickEditor(props) {
  const {
    selected,
    edit,
    changeEdit,
    initialEdit,
    session,
    dispatch,
    undo = [],
    redo = [],
    undoEdit,
    redoEdit,
    saveVersion,
    close,
    openStudio,
    notify = () => {},
    people,
    onExportFrame,
    onCopySettings,
    pasteSettings,
    versions = [],
    onApplyVersion,
    enqueue,
    finishJob,
    onOpenCloudSettings,
    onAddCredit,
  } = props;
  const duration = durationFor(selected);
  const isVideo = hasTimeline(selected);
  const [cloudJob, setCloudJob] = useState(null);
  const cloud = useCloudState();
  const enhanceWorkload = isVideo ? "restoration" : "upscale";
  // The model slider decides where Enhance runs: white/green stay on this
  // server, blue goes to Frameleaf Cloud and always asks to confirm the cost.
  const [enhancePick, setEnhancePick] = useState({});
  const enhanceChoice = resolveModelChoice(
    cloud,
    enhanceWorkload,
    enhancePick[enhanceWorkload] ?? cloud.processing.defaultModels?.[enhanceWorkload],
  );
  const enhanceDestination = enhanceChoice?.runsOn ?? null;
  const [cloudModel, setCloudModel] = useState(null);
  // Smooth motion (frame interpolation): preview 5 s first, then the whole
  // video is saved as a new version; the original stays untouched.
  const [smoothFps, setSmoothFps] = useState(60);
  const [smoothPick, setSmoothPick] = useState(null);
  const [smoothPreviewed, setSmoothPreviewed] = useState(false);
  const [smoothJob, setSmoothJob] = useState(null);
  const sourceFps = Number(selected.fps) || 30;
  const smoothChoice = resolveModelChoice(
    cloud,
    "interpolation",
    smoothPick ?? cloud.processing.defaultModels?.interpolation,
  );
  const smoothWork = (preview) =>
    interpolationWork({
      durationSeconds: preview ? Math.min(INTERPOLATION_PREVIEW_SECONDS, duration || 5) : duration,
      sourceFps,
      targetFps: smoothFps,
    });
  const smoothEstimate = smoothChoice
    ? interpolationEstimate(smoothChoice.item, smoothWork(false), {
        ...sliderContext(cloud, "interpolation"),
        band: smoothChoice.runsOn === "cloud" ? "cloud" : undefined,
      })
    : null;
  const smoothSettings = (preview, model) => ({
    targetFps: smoothFps,
    sourceFps,
    model,
    ...(preview ? { preview: true, seconds: INTERPOLATION_PREVIEW_SECONDS } : { output: "new version" }),
  });
  const playhead = clamp(session?.playbackPosition || 0, 0, duration);
  const tools = TOOLS.filter((tool) => isVideo || !tool.video);

  const [tool, setTool] = useState(isVideo ? "trim" : "adjust");
  const [playing, setPlaying] = useState(false);
  const [before, setBefore] = useState(false);
  const [split, setSplit] = useState(false);
  const [splitAt, setSplitAt] = useState(0.5);
  const [popover, setPopover] = useState(null);
  const [natural, setNatural] = useState(null);
  const [videoError, setVideoError] = useState(!selected.mediaSrc);
  const [dragRect, setDragRect] = useState(null);
  const [dragTrim, setDragTrim] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [tick, setTick] = useState(0);
  const [localCopy, setLocalCopy] = useState(null);
  const [analyzing, setAnalyzing] = useState({});
  const [openGroups, setOpenGroups] = useState({
    light: true,
    color: true,
    effects: false,
    detail: false,
  });
  const [announce, setAnnounce] = useState("");

  const dialog = useRef(null);
  const closeButton = useRef(null);
  const canvasRef = useRef(null);
  const videoRef = useRef(null);
  const imageRef = useRef(null);
  const mirrorRef = useRef(null);
  const stripRef = useRef(null);
  const histogramRef = useRef(null);
  const versionsButton = useRef(null);
  const moreButton = useRef(null);
  const opened = useRef(edit);
  const timers = useRef([]);

  const stage = useElementSize(canvasRef);
  const filterInfo = useMemo(() => cssFilterFor(edit), [edit]);
  const { frames, loading: stripLoading } = useFilmstrip(selected, duration, isVideo);
  const getSource = useMemo(
    () => () => (isVideo && !videoError ? videoRef.current : imageRef.current),
    [isVideo, videoError],
  );
  const histogram = useHistogram(
    histogramRef,
    getSource,
    filterInfo,
    tool === "adjust",
    tick,
  );

  /* Lifecycle */
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return undefined;
    const previous = document.activeElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    if (typeof element.showModal === "function") {
      try {
        if (!element.open) element.showModal();
      } catch {
        element.setAttribute("open", "");
      }
    } else element.setAttribute("open", "");
    closeButton.current?.focus();
    return () => {
      document.body.style.overflow = overflow;
      timers.current.forEach(clearTimeout);
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  useEffect(() => {
    setTool(isVideo ? "trim" : "adjust");
    setVideoError(!selected.mediaSrc);
    setNatural(null);
    setPlaying(false);
    opened.current = edit;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected.id]);

  /* Video playback */
  useEffect(() => {
    const element = videoRef.current;
    if (!element || videoError) return;
    if (playing) {
      if (element.currentTime < edit.start || element.currentTime >= edit.end - 0.02)
        element.currentTime = edit.start;
      element.play().catch(() => setPlaying(false));
    } else element.pause();
  }, [playing, videoError]);
  useEffect(() => {
    const element = videoRef.current;
    if (!element) return;
    element.volume = clamp(edit.volume / 100, 0, 1);
    element.muted = edit.volume === 0;
    element.playbackRate = clamp(speedAt(edit, element.currentTime), 0.0625, 16);
  }, [edit.volume, edit.speed, edit.speedSegments, natural, videoError]);
  useEffect(() => {
    const element = videoRef.current;
    if (!element || playing || videoError) return;
    if (Math.abs(element.currentTime - playhead) > 0.05) {
      element.currentTime = playhead;
      setTick((value) => value + 1);
    }
  }, [playhead, playing, videoError]);
  useEffect(() => {
    // Still preview or unavailable video: advance the playhead on a timer.
    if (!playing || !isVideo || !videoError) return undefined;
    const timer = setInterval(() => {
      const next = playhead + 0.2 * edit.speed;
      dispatch({ type: "playback", time: next >= edit.end ? edit.start : next });
    }, 200);
    return () => clearInterval(timer);
  }, [playing, isVideo, videoError, playhead, edit.start, edit.end, edit.speed]);
  useEffect(() => {
    // Split view mirrors the live video into the "before" canvas.
    if (!split || !isVideo || videoError) return undefined;
    let frame;
    const draw = () => {
      const source = videoRef.current;
      const target = mirrorRef.current;
      if (source && target && source.readyState >= 2) {
        if (target.width !== source.videoWidth) {
          target.width = source.videoWidth;
          target.height = source.videoHeight;
        }
        target.getContext("2d").drawImage(source, 0, 0);
      }
      frame = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(frame);
  }, [split, isVideo, videoError]);
  useEffect(() => {
    // A held compare key or pointer can lose its release when the window loses focus.
    if (!before) return undefined;
    const release = () => setBefore(false);
    window.addEventListener("blur", release);
    document.addEventListener("visibilitychange", release);
    return () => {
      window.removeEventListener("blur", release);
      document.removeEventListener("visibilitychange", release);
    };
  }, [before]);

  const seek = (time) => {
    const value = round(clamp(time, 0, duration), 2);
    dispatch({ type: "playback", time: value });
    const element = videoRef.current;
    if (element && !videoError && Math.abs(element.currentTime - value) > 0.02)
      element.currentTime = value;
  };
  const onTimeUpdate = (event) => {
    const element = event.currentTarget;
    const time = element.currentTime;
    if (playing && time >= edit.end - 0.02) element.currentTime = edit.start;
    element.playbackRate = clamp(speedAt(edit, time), 0.0625, 16);
    dispatch({ type: "playback", time: round(time, 2) });
    setTick((value) => value + 1);
  };

  /* Geometry */
  const rect = dragRect || edit.cropRect || FULL_RECT;
  const cropping = tool === "crop";
  // Holding compare on a photo shows the untouched original, geometry included,
  // like Apple Photos. Split view and video keep the edited framing.
  const showingOriginal = before && !split && !isVideo;
  const frame = useMemo(() => {
    if (!stage.w || !stage.h) return null;
    const source = natural || {
      w: selected.width || 16,
      h: selected.height || 9,
    };
    const rotated = !showingOriginal && edit.rotation % 180 !== 0;
    const ow = rotated ? source.h : source.w;
    const oh = rotated ? source.w : source.h;
    const view = cropping || showingOriginal ? FULL_RECT : rect;
    const scale = Math.min(stage.w / (ow * view.w), stage.h / (oh * view.h));
    const fw = ow * scale;
    const fh = oh * scale;
    return {
      fw,
      fh,
      rotated,
      dx: (view.x + view.w / 2 - 0.5) * fw,
      dy: (view.y + view.h / 2 - 0.5) * fh,
    };
  }, [stage.w, stage.h, natural, selected.width, selected.height, edit.rotation, cropping, showingOriginal, rect]);

  const timeAt = isVideo ? playhead : 0;
  const visibleTexts = (edit.textOverlays || []).filter(
    (item) => item.text && (!isVideo || (timeAt >= item.start && timeAt <= item.end)),
  );

  const frameStyle = (kind) => {
    if (!frame) return {};
    const { fw, fh, dx, dy } = frame;
    let top = 0;
    let right = 0;
    let bottom = 0;
    let left = 0;
    if (!cropping && !showingOriginal) {
      top = rect.y * fh;
      left = rect.x * fw;
      right = (1 - rect.x - rect.w) * fw;
      bottom = (1 - rect.y - rect.h) * fh;
    }
    if (split) {
      const frameLeft = stage.w / 2 - fw / 2 - dx;
      const splitX = clamp(splitAt * stage.w - frameLeft, 0, fw);
      if (kind === "after") left = Math.max(left, splitX);
      else right = Math.max(right, fw - splitX);
    }
    return {
      width: fw,
      height: fh,
      marginLeft: -fw / 2,
      marginTop: -fh / 2,
      transform: `translate(${-dx}px, ${-dy}px)`,
      clipPath:
        top || right || bottom || left
          ? `inset(${top}px ${right}px ${bottom}px ${left}px)`
          : "none",
    };
  };
  const mediaStyle = (plain) => {
    if (!frame) return {};
    const width = frame.rotated ? frame.fh : frame.fw;
    const height = frame.rotated ? frame.fw : frame.fh;
    return {
      width,
      height,
      transform: showingOriginal
        ? "translate(-50%, -50%) scale(1, 1) rotate(0deg)"
        : `translate(-50%, -50%) scale(${edit.flipH ? -1 : 1}, ${edit.flipV ? -1 : 1}) rotate(${edit.rotation}deg)`,
      filter: plain ? "none" : filterInfo.filter,
    };
  };
  const straightenStyle = frame
    ? {
        transform: showingOriginal
          ? "rotate(0deg) scale(1)"
          : `rotate(${edit.straighten}deg) scale(${straightenScale(frame.fw, frame.fh, edit.straighten)})`,
      }
    : undefined;

  const renderMedia = (plain) =>
    isVideo && !videoError ? (
      <video
        ref={videoRef}
        src={selected.mediaSrc}
        poster={selected.image}
        playsInline
        preload="auto"
        style={mediaStyle(plain)}
        onLoadedMetadata={(event) => {
          setNatural({
            w: event.currentTarget.videoWidth,
            h: event.currentTarget.videoHeight,
          });
          if (Math.abs(event.currentTarget.currentTime - playhead) > 0.05)
            event.currentTarget.currentTime = playhead;
          setTick((value) => value + 1);
        }}
        onLoadedData={() => setTick((value) => value + 1)}
        onSeeked={() => setTick((value) => value + 1)}
        onTimeUpdate={onTimeUpdate}
        onEnded={() => setPlaying(false)}
        onError={() => setVideoError(true)}
      />
    ) : (
      <img
        ref={imageRef}
        src={selected.image}
        alt={selected.name}
        draggable={false}
        style={mediaStyle(plain)}
        onLoad={(event) => {
          setNatural({
            w: event.currentTarget.naturalWidth,
            h: event.currentTarget.naturalHeight,
          });
          setTick((value) => value + 1);
        }}
      />
    );

  const renderFrame = (kind) => {
    const isBefore = kind === "before";
    const plain = isBefore || before;
    const windowStyle = frame
      ? {
          left: rect.x * frame.fw,
          top: rect.y * frame.fh,
          width: rect.w * frame.fw,
          height: rect.h * frame.fh,
        }
      : undefined;
    const textScale = frame ? (rect.w * frame.fw) / 1280 : 1;
    return (
      <div
        key={kind}
        className={`ed-frame ${kind}`}
        style={frameStyle(kind)}
        aria-hidden={isBefore || undefined}
      >
        <div className="ed-media" style={straightenStyle}>
          {isBefore ? (
            isVideo && !videoError ? (
              <canvas ref={mirrorRef} style={mediaStyle(true)} />
            ) : (
              <img src={selected.image} alt="" draggable={false} style={mediaStyle(true)} />
            )
          ) : (
            renderMedia(plain)
          )}
        </div>
        {!plain && (
          <div className="ed-window" style={windowStyle}>
            {filterInfo.layers.map((layer) => (
              <div key={layer.id} className="ed-layer" style={layer.style} />
            ))}
            {visibleTexts.length > 0 && (
              <div className="ed-text-layer">
                {visibleTexts.map((item) => {
                  const index = TEXT_POSITIONS.indexOf(item.position);
                  const column = (index % 3) + 1;
                  const row = Math.floor(index / 3) + 1;
                  const justify = ["flex-start", "center", "flex-end"][column - 1];
                  const align = ["flex-start", "center", "flex-end"][row - 1];
                  return (
                    <div
                      key={item.id}
                      className={`ed-text ${item.shadow ? "shadow" : ""}`}
                      style={{
                        gridColumn: column,
                        gridRow: row,
                        justifyContent: justify,
                        alignItems: align,
                        textAlign: ["left", "center", "right"][column - 1],
                        color: item.color,
                        fontSize: Math.max(9, item.fontSize * textScale),
                      }}
                    >
                      <span>{item.text}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  /* Crop interactions */
  const aspectRatio = frame ? aspectRatioValue(edit.crop, frame.fw, frame.fh) : null;
  const beginCrop = (handle) => (event) => {
    if (!frame || (event.pointerType === "mouse" && event.button !== 0)) return;
    event.stopPropagation();
    event.preventDefault();
    const origin = { x: event.clientX, y: event.clientY };
    const startRect = rect;
    let latest = startRect;
    setDragging(true);
    startDrag(
      event,
      (e) => {
        const dx = (e.clientX - origin.x) / frame.fw;
        const dy = (e.clientY - origin.y) / frame.fh;
        latest = resizeCropRect(startRect, handle, dx, dy, {
          ratio: aspectRatio,
          frameWidth: frame.fw,
          frameHeight: frame.fh,
        });
        setDragRect(latest);
      },
      () => {
        setDragging(false);
        setDragRect(null);
        if (!same(latest, startRect)) changeEdit({ cropRect: latest });
      },
    );
  };
  const nudgeCrop = (event) => {
    const step = event.shiftKey ? 0.05 : 0.01;
    const moves = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    changeEdit({ cropRect: resizeCropRect(rect, "move", move[0], move[1]) });
  };
  const chooseAspect = (id) => {
    if (!frame) return;
    const ratio = aspectRatioValue(id, frame.fw, frame.fh);
    changeEdit({
      crop: id,
      cropRect:
        id === "Free" ? edit.cropRect : fitCropRect(ratio, frame.fw, frame.fh),
    });
  };
  const rotate = (clockwise) =>
    changeEdit({
      rotation: (edit.rotation + (clockwise ? 90 : 270)) % 360,
      cropRect: rotateRect(edit.cropRect, clockwise),
      crop: rotateAspect(edit.crop),
    });
  const flip = (axis) =>
    changeEdit(
      axis === "h"
        ? {
            flipH: !edit.flipH,
            cropRect: { ...edit.cropRect, x: round(1 - edit.cropRect.x - edit.cropRect.w, 4) },
          }
        : {
            flipV: !edit.flipV,
            cropRect: { ...edit.cropRect, y: round(1 - edit.cropRect.y - edit.cropRect.h, 4) },
          },
    );
  const resetCrop = () =>
    changeEdit({
      crop: "Original",
      cropRect: { ...FULL_RECT },
      straighten: 0,
      rotation: 0,
      flipH: false,
      flipV: false,
    });
  const geometryDefault =
    edit.crop === "Original" &&
    isFullRect(edit.cropRect) &&
    !edit.straighten &&
    !edit.rotation &&
    !edit.flipH &&
    !edit.flipV;

  /* Trim interactions */
  const trimStart = dragTrim?.key === "start" ? dragTrim.value : edit.start;
  const trimEnd = dragTrim?.key === "end" ? dragTrim.value : edit.end;
  const beginTrim = (key) => (event) => {
    event.stopPropagation();
    event.preventDefault();
    const strip = stripRef.current?.getBoundingClientRect();
    if (!strip) return;
    const initial = edit[key];
    let latest = initial;
    startDrag(
      event,
      (e) => {
        const time = round(clamp(((e.clientX - strip.left) / strip.width) * duration, 0, duration), 2);
        latest =
          key === "start"
            ? clamp(time, 0, round(edit.end - 0.1, 2))
            : clamp(time, round(edit.start + 0.1, 2), duration);
        setDragTrim({ key, value: latest });
        seek(latest);
      },
      () => {
        setDragTrim(null);
        if (latest !== initial) changeEdit({ [key]: latest });
      },
    );
  };
  const trimKey = (key) => (event) => {
    const step = event.shiftKey ? 1 : 0.1;
    let next = null;
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") next = edit[key] - step;
    if (event.key === "ArrowRight" || event.key === "ArrowUp") next = edit[key] + step;
    if (event.key === "Home") next = key === "start" ? 0 : edit.start + 0.1;
    if (event.key === "End") next = key === "start" ? edit.end - 0.1 : duration;
    if (next === null) return;
    event.preventDefault();
    const value =
      key === "start"
        ? clamp(round(next, 2), 0, round(edit.end - 0.1, 2))
        : clamp(round(next, 2), round(edit.start + 0.1, 2), duration);
    changeEdit({ [key]: value });
    seek(value);
  };
  const scrubStrip = (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const strip = stripRef.current?.getBoundingClientRect();
    if (!strip) return;
    const at = (e) => seek(((e.clientX - strip.left) / strip.width) * duration);
    at(event);
    setPlaying(false);
    startDrag(event, at);
  };
  const setIn = (time) => {
    const value = clamp(round(time, 2), 0, round(edit.end - 0.1, 2));
    changeEdit({ start: value });
    setAnnounce(`In point ${precise(value)}`);
  };
  const setOut = (time) => {
    const value = clamp(round(time, 2), round(edit.start + 0.1, 2), duration);
    changeEdit({ end: value });
    setAnnounce(`Out point ${precise(value)}`);
  };

  /* Split divider */
  const beginSplit = (event) => {
    event.preventDefault();
    const box = canvasRef.current?.getBoundingClientRect();
    if (!box) return;
    startDrag(event, (e) =>
      setSplitAt(clamp((e.clientX - box.left) / box.width, 0.04, 0.96)),
    );
  };

  /* Top bar actions */
  const dirty = !same(edit, opened.current);
  const cancel = () => {
    if (dirty) {
      changeEdit(opened.current);
      notify("Edits discarded");
    }
    close();
  };
  const revert = () =>
    changeEdit(normalizeEdit({ ...initialEdit, end: duration }, selected));
  const copySettings = () => {
    const settings = pickSettings(edit);
    if (onCopySettings) onCopySettings(settings);
    else setLocalCopy(settings);
    notify("Adjustments copied");
  };
  const pasteSource = pasteSettings || localCopy;
  const paste = () => {
    if (!pasteSource) return;
    changeEdit(pickSettings(pasteSource));
    notify("Adjustments pasted");
  };
  const applyVersion = (value) => {
    if (onApplyVersion) onApplyVersion(value);
    else changeEdit(normalizeEdit(value, selected));
  };
  const exportFrame = () => {
    if (onExportFrame) onExportFrame(selected.id, timeAt);
    else notify(`Frame at ${precise(timeAt)} saved as a new photo`);
  };
  const closeMenu = (restore) => {
    const trigger = popover === "versions" ? versionsButton : moreButton;
    setPopover(null);
    if (restore) trigger.current?.focus();
  };
  const assetVersions = versions.filter((item) => item.assetId === selected.id);
  const original = normalizeEdit({ ...initialEdit, end: duration }, selected);
  const versionItems = [
    {
      id: "original",
      label: "Original",
      icon: "mdiImageOutline",
      checked: same(edit, original),
      onSelect: () => applyVersion(original),
    },
    ...assetVersions.map((item) => ({
      id: String(item.id),
      label: item.name,
      icon: "mdiHistory",
      checked: same(edit, normalizeEdit(item.edit, selected)),
      onSelect: () => applyVersion(item.edit),
    })),
  ];
  const moreItems = [
    { id: "copy", label: "Copy adjustments", icon: "mdiContentCopy", onSelect: copySettings },
    {
      id: "paste",
      label: "Paste adjustments",
      icon: "mdiContentDuplicate",
      disabled: !pasteSource,
      onSelect: paste,
    },
    { id: "revert", label: "Revert to original", icon: "mdiRestore", onSelect: revert },
    ...(isVideo
      ? [{ id: "frame", label: "Export frame as photo", icon: "mdiCameraIris", onSelect: exportFrame }]
      : []),
    { id: "studio", label: "Open in Studio", icon: "mdiOpenInApp", onSelect: openStudio },
  ];

  /* Keyboard */
  const keyDown = (event) => {
    if (event.key === "Escape") return;
    // Compare also works while an adjustment slider has focus, so you can nudge and check.
    const typing = isEditable(event.target) && event.target.type !== "range";
    if (!typing && isCompareKey(event)) {
      event.preventDefault();
      if (!event.repeat) setBefore(true);
      return;
    }
    if (isEditable(event.target)) return;
    const key = event.key.toLowerCase();
    if (
      key === " " &&
      isVideo &&
      event.target.tagName !== "BUTTON" &&
      event.target.getAttribute("role") !== "slider"
    ) {
      event.preventDefault();
      setPlaying((value) => !value);
    } else if (key === "i" && isVideo && !event.metaKey && !event.ctrlKey) setIn(timeAt);
    else if (key === "o" && isVideo && !event.metaKey && !event.ctrlKey) setOut(timeAt);
  };
  const keyUp = (event) => {
    if (isCompareKey(event, { release: true })) setBefore(false);
  };
  const railKey = (event) => {
    const index = tools.findIndex((item) => item.id === tool);
    let next = null;
    if (["ArrowDown", "ArrowRight"].includes(event.key)) next = index + 1;
    if (["ArrowUp", "ArrowLeft"].includes(event.key)) next = index - 1;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = tools.length - 1;
    if (next === null) return;
    event.preventDefault();
    const target = tools[(next + tools.length) % tools.length];
    setTool(target.id);
    event.currentTarget.querySelector(`[data-tool="${target.id}"]`)?.focus();
  };

  /* Enhance simulation */
  const toggleEnhance = (key) => {
    const next = !edit[key];
    changeEdit({ [key]: next });
    if (next) {
      setAnalyzing((current) => ({ ...current, [key]: true }));
      const timer = setTimeout(
        () => setAnalyzing((current) => ({ ...current, [key]: false })),
        1800,
      );
      timers.current.push(timer);
    }
  };

  /* Text overlays */
  const overlays = edit.textOverlays || [];
  const updateOverlay = (id, patch) =>
    changeEdit({
      textOverlays: overlays.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    });
  const addOverlay = () =>
    changeEdit({
      textOverlays: [
        ...overlays,
        {
          id: newId(),
          text: "Title",
          position: "bottom",
          start: round(timeAt, 2),
          end: round(Math.min(duration, timeAt + 4), 2),
          fontSize: 32,
          color: "#ffffff",
          shadow: true,
        },
      ],
    });

  /* Speed segments */
  const segments = edit.speedSegments || [];
  const addSegment = () => {
    const span = Math.max(0.5, (edit.end - edit.start) / 5);
    const from = timeAt >= edit.end - 0.2 ? edit.start : Math.max(edit.start, timeAt);
    changeEdit({
      speedSegments: [
        ...segments,
        { start: round(from, 2), end: round(Math.min(edit.end, from + span), 2), speed: 2 },
      ],
    });
  };
  const updateSegment = (index, patch) =>
    changeEdit({
      speedSegments: segments.map((item, i) => (i === index ? { ...item, ...patch } : item)),
    });

  const peopleNames = (people || [])
    .filter((person) => (selected.personIds || selected.people || []).includes(person.id))
    .map((person) => person.name);
  const dimensions =
    natural || (selected.width && selected.height)
      ? `${natural?.w || selected.width} × ${natural?.h || selected.height}`
      : "";
  const currentPreset = presetsFor(isVideo ? "video" : "photo").find(
    (item) => item.id === edit.preset,
  );
  const allAdjustDefault = DEVELOP_PARAMS.every((spec) => edit[spec.id] === spec.default);
  const activeTool = tools.find((item) => item.id === tool) || tools[0];

  /* Panels */
  const adjustPanel = (
    <div className="ed-panel-body" key="adjust">
      <div className="ed-panel-head">
        <h2>Adjust</h2>
        <button
          type="button"
          className="ed-icon"
          aria-label="Reset all adjustments"
          title="Reset all adjustments"
          disabled={allAdjustDefault}
          onClick={() => changeEdit(developDefaults())}
        >
          <Icon name="mdiRestore" size={18} />
        </button>
      </div>
      <div className="ed-histogram" role="img" aria-label="Histogram of the current preview">
        <canvas ref={histogramRef} />
        {histogram.clipped.shadows > 0.01 && (
          <span className="ed-clip left" title="Shadows are clipping" />
        )}
        {histogram.clipped.highlights > 0.01 && (
          <span className="ed-clip right" title="Highlights are clipping" />
        )}
        {histogram.status === "unavailable" && (
          <span className="ed-histogram-note">Histogram unavailable for this preview</span>
        )}
      </div>
      <div className="ed-row spread">
        <button
          type="button"
          className="ed-button"
          aria-pressed={autoToneApplied(edit)}
          onClick={() =>
            changeEdit(
              autoToneApplied(edit)
                ? Object.fromEntries(Object.keys(AUTO_TONE).map((key) => [key, 0]))
                : AUTO_TONE,
            )
          }
        >
          <Icon name="mdiAutoFix" size={18} />
          Auto
        </button>
        <span className="muted" style={{ fontSize: 11 }}>
          Double-click a slider to reset
        </span>
      </div>
      {DEVELOP_GROUPS.map((group) => (
        <Group
          key={group.id}
          group={group}
          open={openGroups[group.id]}
          toggle={() =>
            setOpenGroups((current) => ({ ...current, [group.id]: !current[group.id] }))
          }
          edit={edit}
          changeEdit={changeEdit}
        />
      ))}
    </div>
  );

  const cropPanel = (
    <div className="ed-panel-body" key="crop">
      <div className="ed-panel-head">
        <h2>Crop and straighten</h2>
        <button
          type="button"
          className="ed-icon"
          aria-label="Reset crop"
          title="Reset crop"
          disabled={geometryDefault}
          onClick={resetCrop}
        >
          <Icon name="mdiRestore" size={18} />
        </button>
      </div>
      <h3>Aspect</h3>
      <div className="ed-row" role="radiogroup" aria-label="Aspect ratio">
        {ASPECTS.map((aspect) => (
          <button
            key={aspect.id}
            type="button"
            role="radio"
            className="ed-chip"
            aria-checked={edit.crop === aspect.id}
            onClick={() => chooseAspect(aspect.id)}
          >
            {aspect.label}
          </button>
        ))}
      </div>
      <h3>Straighten</h3>
      <div
        className="ed-dial"
        style={{ "--dial-x": `${edit.straighten * 8}px` }}
        onDoubleClick={() => changeEdit({ straighten: 0 })}
      >
        <output aria-hidden="true">
          {edit.straighten > 0 ? "+" : ""}
          {edit.straighten.toFixed(1)}°
        </output>
        <input
          type="range"
          aria-label="Straighten"
          min="-45"
          max="45"
          step="0.5"
          value={edit.straighten}
          aria-valuetext={`${edit.straighten.toFixed(1)} degrees`}
          onChange={(event) => changeEdit({ straighten: Number(event.target.value) })}
        />
      </div>
      <h3>Orientation</h3>
      <div className="ed-grid-2">
        <button type="button" className="ed-button" onClick={() => rotate(false)}>
          <Icon name="mdiRotateLeft" size={18} />
          Rotate left
        </button>
        <button type="button" className="ed-button" onClick={() => rotate(true)}>
          <Icon name="mdiRotateRight" size={18} />
          Rotate right
        </button>
        <button
          type="button"
          className="ed-button"
          aria-pressed={edit.flipH}
          onClick={() => flip("h")}
        >
          <Icon name="mdiFlipHorizontal" size={18} />
          Flip horizontal
        </button>
        <button
          type="button"
          className="ed-button"
          aria-pressed={edit.flipV}
          onClick={() => flip("v")}
        >
          <Icon name="mdiFlipVertical" size={18} />
          Flip vertical
        </button>
      </div>
      <p className="ed-note">
        Drag the corners or edges to reshape the crop, drag inside to move it.
        With the crop focused, <span className="ed-kbd">←</span>{" "}
        <span className="ed-kbd">→</span> <span className="ed-kbd">↑</span>{" "}
        <span className="ed-kbd">↓</span> nudge it and Shift moves further.
      </p>
    </div>
  );

  const presetsPanel = (
    <div className="ed-panel-body" key="presets">
      <div className="ed-panel-head">
        <h2>Presets</h2>
      </div>
      <div className="ed-presets" role="radiogroup" aria-label="Looks">
        {presetsFor(isVideo ? "video" : "photo").map((preset) => {
          const look = cssFilterFor({ ...edit, preset: preset.id, presetStrength: 100 });
          return (
            <button
              key={preset.id}
              type="button"
              role="radio"
              className="ed-preset"
              aria-checked={edit.preset === preset.id}
              onClick={() =>
                changeEdit({
                  preset: preset.id,
                  presetStrength: edit.preset === preset.id ? edit.presetStrength : 100,
                })
              }
            >
              <span className="ed-preset-thumb">
                <img src={selected.image} alt="" style={{ filter: look.filter }} />
                {look.layers.map((layer) => (
                  <span key={layer.id} className="ed-layer" style={layer.style} />
                ))}
              </span>
              <span>{preset.label}</span>
            </button>
          );
        })}
      </div>
      <Slider
        id="presetStrength"
        label={`${currentPreset?.label || "Preset"} strength`}
        value={edit.presetStrength}
        min={0}
        max={100}
        step={1}
        defaultValue={100}
        disabled={edit.preset === "Original"}
        format={(value) => `${value}%`}
        onChange={(value) => changeEdit({ presetStrength: value })}
      />
      <h3>Social formats</h3>
      <div className="ed-row">
        {SOCIAL_PRESETS.map((item) => (
          <button
            key={item.id}
            type="button"
            className="ed-chip"
            aria-pressed={edit.crop === item.aspect}
            onClick={() => chooseAspect(item.aspect)}
          >
            {item.label}
            <small>{item.note}</small>
          </button>
        ))}
      </div>
      <p>Formats set the crop and aspect; fine-tune the framing in Crop.</p>
    </div>
  );

  const trimPanel = (
    <div className="ed-panel-body" key="trim">
      <div className="ed-panel-head">
        <h2>Trim</h2>
        <button
          type="button"
          className="ed-icon"
          aria-label="Reset trim"
          title="Reset trim"
          disabled={edit.start === 0 && edit.end === duration}
          onClick={() => changeEdit({ start: 0, end: duration })}
        >
          <Icon name="mdiRestore" size={18} />
        </button>
      </div>
      <div className="ed-row" role="radiogroup" aria-label="Trim mode">
        {[
          ["precise", "Precise"],
          ["fast", "Fast · keyframes"],
        ].map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="radio"
            className="ed-chip"
            aria-checked={edit.trim === value}
            onClick={() => changeEdit({ trim: value })}
          >
            {label}
          </button>
        ))}
      </div>
      <p>
        {edit.trim === "fast"
          ? `Cuts snap to keyframes, roughly ${Math.floor(edit.start / 2) * 2}s to ${Math.min(duration, Math.ceil(edit.end / 2) * 2)}s, and finish in seconds without re-encoding.`
          : "Frame-accurate cuts. The clip is re-encoded from the original."}
      </p>
      <div className="ed-grid-2">
        <label className="ed-field">
          In (seconds)
          <input
            type="number"
            min="0"
            max={round(edit.end - 0.1, 2)}
            step="0.1"
            value={edit.start}
            onChange={(event) => setIn(Number(event.target.value))}
          />
        </label>
        <label className="ed-field">
          Out (seconds)
          <input
            type="number"
            min={round(edit.start + 0.1, 2)}
            max={duration}
            step="0.1"
            value={edit.end}
            onChange={(event) => setOut(Number(event.target.value))}
          />
        </label>
        <button type="button" className="ed-button" onClick={() => setIn(timeAt)}>
          Set in at playhead
        </button>
        <button type="button" className="ed-button" onClick={() => setOut(timeAt)}>
          Set out at playhead
        </button>
      </div>
      <p>
        Clip {precise(edit.start)} – {precise(edit.end)} · {precise(edit.end - edit.start)}{" "}
        selected
        {renderedDuration(edit) !== round(edit.end - edit.start, 3) &&
          ` · ${precise(renderedDuration(edit))} after speed changes`}
        . Press <span className="ed-kbd">I</span> or <span className="ed-kbd">O</span> to
        mark the playhead.
      </p>
    </div>
  );

  const speedPanel = (
    <div className="ed-panel-body" key="speed">
      <div className="ed-panel-head">
        <h2>Speed</h2>
        <button
          type="button"
          className="ed-icon"
          aria-label="Reset speed"
          title="Reset speed"
          disabled={edit.speed === 1 && !segments.length}
          onClick={() => changeEdit({ speed: 1, speedSegments: [] })}
        >
          <Icon name="mdiRestore" size={18} />
        </button>
      </div>
      <h3>Whole clip</h3>
      <div className="ed-row" role="radiogroup" aria-label="Clip speed">
        {SPEEDS.map((value) => (
          <button
            key={value}
            type="button"
            role="radio"
            className="ed-chip"
            aria-checked={edit.speed === value}
            onClick={() => changeEdit({ speed: value })}
          >
            {value}×
          </button>
        ))}
      </div>
      <div className="ed-row spread" style={{ marginTop: 18 }}>
        <h3 style={{ margin: 0 }}>Ranges</h3>
        <button type="button" className="ed-button" onClick={addSegment}>
          <Icon name="mdiPlus" size={18} />
          Add range at playhead
        </button>
      </div>
      {!segments.length && (
        <p className="ed-empty">
          Speed ranges slow down or speed up part of the clip. They appear as blue bands on
          the filmstrip.
        </p>
      )}
      {segments.map((segment, index) => (
        <div className="ed-card" key={`${index}-${segment.start}`}>
          <div className="ed-card-head">
            <strong>Range {index + 1}</strong>
            <button
              type="button"
              className="ed-icon"
              aria-label={`Remove range ${index + 1}`}
              onClick={() =>
                changeEdit({ speedSegments: segments.filter((_, i) => i !== index) })
              }
            >
              <Icon name="mdiClose" size={18} />
            </button>
          </div>
          <div className="ed-grid-2">
            <label className="ed-field">
              Start
              <input
                type="number"
                step="0.1"
                min={edit.start}
                max={segment.end - 0.1}
                value={segment.start}
                onChange={(event) =>
                  updateSegment(index, {
                    start: clamp(Number(event.target.value), edit.start, segment.end - 0.1),
                  })
                }
              />
            </label>
            <label className="ed-field">
              End
              <input
                type="number"
                step="0.1"
                min={segment.start + 0.1}
                max={edit.end}
                value={segment.end}
                onChange={(event) =>
                  updateSegment(index, {
                    end: clamp(Number(event.target.value), segment.start + 0.1, edit.end),
                  })
                }
              />
            </label>
          </div>
          <div className="ed-row" role="radiogroup" aria-label={`Range ${index + 1} speed`}>
            {SPEEDS.map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                className="ed-chip"
                aria-checked={segment.speed === value}
                onClick={() => updateSegment(index, { speed: value })}
              >
                {value}×
              </button>
            ))}
          </div>
        </div>
      ))}
      <p>
        Output {precise(renderedDuration(edit))} · playback rate at the playhead{" "}
        {speedAt(edit, timeAt)}×. Audio pitch is preserved up to 2×.
      </p>
    </div>
  );

  const audioPanel = (
    <div className="ed-panel-body" key="audio">
      <div className="ed-panel-head">
        <h2>Audio</h2>
        <button
          type="button"
          className="ed-icon"
          aria-label="Reset audio"
          title="Reset audio"
          disabled={edit.volume === 100}
          onClick={() => changeEdit({ volume: 100 })}
        >
          <Icon name="mdiRestore" size={18} />
        </button>
      </div>
      <Slider
        id="volume"
        label="Clip gain"
        value={edit.volume}
        min={0}
        max={150}
        step={1}
        defaultValue={100}
        format={(value) => `${value}%`}
        onChange={(value) => changeEdit({ volume: value })}
      />
      <div className="ed-toggle">
        <strong>Mute clip</strong>
        <button
          type="button"
          role="switch"
          className="ed-switch"
          aria-checked={edit.volume === 0}
          aria-label="Mute clip"
          onClick={() => changeEdit({ volume: edit.volume ? 0 : 100 })}
        />
        <p>Silences the source track. Gain above 100% is limited to avoid clipping.</p>
      </div>
      <p>
        Original channels are preserved: stereo stays stereo and surround stays surround
        when the clip is saved.
      </p>
    </div>
  );

  const textPanel = (
    <div className="ed-panel-body" key="text">
      <div className="ed-panel-head">
        <h2>Text</h2>
        <button type="button" className="ed-button" onClick={addOverlay}>
          <Icon name="mdiPlus" size={18} />
          Add text
        </button>
      </div>
      {!overlays.length && (
        <p className="ed-empty">
          Titles and captions appear over the video between their start and end times.
        </p>
      )}
      {overlays.map((item, index) => (
        <div className="ed-card" key={item.id}>
          <div className="ed-card-head">
            <strong>Text {index + 1}</strong>
            <button
              type="button"
              className="ed-icon"
              aria-label={`Remove text ${index + 1}`}
              onClick={() =>
                changeEdit({ textOverlays: overlays.filter((other) => other.id !== item.id) })
              }
            >
              <Icon name="mdiClose" size={18} />
            </button>
          </div>
          <label className="ed-field">
            Content
            <input
              value={item.text}
              maxLength={200}
              onChange={(event) => updateOverlay(item.id, { text: event.target.value })}
            />
          </label>
          <div className="ed-row spread">
            <div className="ed-nine" role="radiogroup" aria-label={`Text ${index + 1} position`}>
              {TEXT_POSITIONS.map((position) => (
                <button
                  key={position}
                  type="button"
                  role="radio"
                  aria-checked={item.position === position}
                  aria-label={POSITION_LABELS[position]}
                  title={POSITION_LABELS[position]}
                  onClick={() => updateOverlay(item.id, { position })}
                />
              ))}
            </div>
            <div className="ed-grid-2" style={{ flex: 1 }}>
              <label className="ed-field">
                Start
                <input
                  type="number"
                  step="0.1"
                  min="0"
                  max={item.end}
                  value={item.start}
                  onChange={(event) =>
                    updateOverlay(item.id, {
                      start: clamp(Number(event.target.value), 0, item.end),
                    })
                  }
                />
              </label>
              <label className="ed-field">
                End
                <input
                  type="number"
                  step="0.1"
                  min={item.start}
                  max={duration}
                  value={item.end}
                  onChange={(event) =>
                    updateOverlay(item.id, {
                      end: clamp(Number(event.target.value), item.start, duration),
                    })
                  }
                />
              </label>
            </div>
          </div>
          <Slider
            id={`size-${item.id}`}
            label="Size"
            value={item.fontSize}
            min={12}
            max={96}
            step={1}
            defaultValue={32}
            format={(value) => `${value} pt`}
            onChange={(value) => updateOverlay(item.id, { fontSize: value })}
          />
          <div className="ed-row spread">
            <div className="ed-swatches" role="radiogroup" aria-label={`Text ${index + 1} colour`}>
              {SWATCHES.map((color) => (
                <button
                  key={color}
                  type="button"
                  role="radio"
                  className="ed-swatch"
                  style={{ background: color }}
                  aria-checked={item.color === color}
                  aria-label={color}
                  onClick={() => updateOverlay(item.id, { color })}
                />
              ))}
              <input
                type="color"
                aria-label={`Text ${index + 1} custom colour`}
                value={item.color}
                onChange={(event) => updateOverlay(item.id, { color: event.target.value })}
              />
            </div>
            <label className="ed-check">
              <input
                type="checkbox"
                checked={item.shadow}
                onChange={(event) => updateOverlay(item.id, { shadow: event.target.checked })}
              />
              Shadow
            </label>
          </div>
        </div>
      ))}
    </div>
  );

  const enhancePanel = (
    <div className="ed-panel-body" key="enhance">
      <div className="ed-panel-head">
        <h2>Enhance</h2>
      </div>
      {[
        {
          key: "stabilize",
          label: "Stabilize",
          icon: "mdiVideoStabilization",
          text: "Smooths handheld shake by tracking motion across the clip. Edges are cropped slightly to hide the correction.",
          busy: "Analyzing motion…",
        },
        {
          key: "autoEnhance",
          label: "Auto-enhance",
          icon: "mdiShimmer",
          text: "Balances exposure, white balance and colour scene by scene, so mixed light looks the way you remember it.",
          busy: "Analyzing scenes…",
        },
      ]
        .filter(() => isVideo)
        .map((item) => (
        <div className="ed-toggle" key={item.key}>
          <strong>
            <Icon name={item.icon} size={16} /> {item.label}
          </strong>
          <button
            type="button"
            role="switch"
            className="ed-switch"
            aria-checked={edit[item.key]}
            aria-label={item.label}
            onClick={() => toggleEnhance(item.key)}
          />
          <p>{item.text}</p>
          {edit[item.key] && (
            <span
              className={`ed-status ${analyzing[item.key] ? "busy" : ""}`}
              role="status"
            >
              {analyzing[item.key] ? item.busy : "Ready · applied when the version is saved"}
            </span>
          )}
        </div>
      ))}
      <div className="ed-toggle ed-cloud">
        <strong>
          <Icon name={isVideo ? "mdiMovieFilterOutline" : "mdiImageSizeSelectLarge"} size={16} />{" "}
          {isVideo ? "Restore video" : "Enhance & upscale"}
        </strong>
        <p>
          {isVideo
            ? "Removes noise and compression, then upscales up to 4K."
            : "Up to 4× larger with face refinement."}{" "}
          Slide to a heavier model for more detail. Blue models run on Frameleaf Cloud and show
          the cost before anything is sent.
        </p>
        <ModelSlider
          state={cloud}
          workload={enhanceWorkload}
          value={enhanceChoice?.item.id}
          label={isVideo ? "Restoration model" : "Enhance model"}
          onChange={(id) => setEnhancePick((current) => ({ ...current, [enhanceWorkload]: id }))}
        />
        <Button
          primary
          icon={enhanceDestination === "cloud" ? "mdiCloudOutline" : "mdiServerOutline"}
          disabled={!enhanceDestination}
          onClick={() => {
            if (enhanceDestination === "cloud") {
              setCloudModel(enhanceChoice.item.id);
              setCloudJob(enhanceWorkload);
            } else
              enqueue?.(isVideo ? "AI restoration" : "Upscale", {
                keepOpen: true,
                destination: "local",
                settings: {
                  ...(isVideo ? { mode: edit.restorationMode } : { upscale: 4 }),
                  model: enhanceChoice.item.id,
                },
              });
          }}
        >
          {enhanceDestination === "cloud"
            ? `${isVideo ? "Restore" : "Upscale"} on Frameleaf Cloud…`
            : `${isVideo ? "Restore" : "Upscale"} on this server`}
        </Button>
        {enhanceDestination === "cloud" && (
          <span className="ed-status ed-cloud-credit">
            {cloudAdmission(cloud, null) ?? `AI credit ${creditLabel(cloud)} · you confirm the cost next`}
          </span>
        )}
        {onOpenCloudSettings && (
          <button type="button" className="fc-link ed-routing-link" onClick={() => onOpenCloudSettings("cloud-processing")}>
            Change where this work runs
          </button>
        )}
      </div>
      {isVideo && (
        <div className="ed-toggle ed-cloud ed-smooth">
          <strong>
            <Icon name="mdiMotionPlayOutline" size={16} /> Smooth motion
          </strong>
          <p>
            Adds in-between frames for a higher frame rate. {INTERPOLATION_TRADEOFF} The result is saved
            as a new version; the original stays untouched.
          </p>
          <div className="ed-segmented" role="radiogroup" aria-label="Target frame rate">
            {[
              [60, "60 fps"],
              [50, "50 fps · PAL-era video"],
            ].map(([fps, label]) => (
              <button
                key={fps}
                type="button"
                role="radio"
                aria-checked={smoothFps === fps}
                className={smoothFps === fps ? "is-on" : ""}
                onClick={() => {
                  setSmoothFps(fps);
                  setSmoothPreviewed(false);
                }}
              >
                {label}
              </button>
            ))}
          </div>
          {sourceFps >= smoothFps ? (
            <span className="ed-status">This video is already {sourceFps} fps; nothing to add.</span>
          ) : (
            <>
              <ModelSlider
                state={cloud}
                workload="interpolation"
                value={smoothChoice?.item.id}
                label="Smooth motion model"
                hideLegend
                onChange={(id) => {
                  setSmoothPick(id);
                  setSmoothPreviewed(false);
                }}
              />
              {smoothEstimate && (
                <dl className="ed-facts">
                  <dt>{smoothEstimate.runsOn === "cloud" ? "Estimated cost" : "Estimated time"}</dt>
                  <dd>
                    {smoothEstimate.runsOn === "cloud"
                      ? `about ${estimateRange(smoothEstimate.cost)}`
                      : `about ${formatDuration(smoothEstimate.seconds)} on ${
                          smoothEstimate.runsOn === "gpu" ? "your GPU" : "the processor"
                        }`}
                  </dd>
                  <dt>File size</dt>
                  <dd>
                    about {smoothEstimate.sizeFactor}× larger ({sourceFps} → {smoothFps} fps)
                  </dd>
                </dl>
              )}
              <div className="ed-actions">
                <Button
                  icon="mdiPlayCircleOutline"
                  disabled={!smoothChoice}
                  onClick={() => {
                    if (smoothChoice.runsOn === "cloud") setSmoothJob({ preview: true });
                    else {
                      enqueue?.("Smooth motion preview", {
                        keepOpen: true,
                        destination: "local",
                        settings: smoothSettings(true, smoothChoice.item.id),
                      });
                      setSmoothPreviewed(true);
                    }
                  }}
                >
                  Preview {INTERPOLATION_PREVIEW_SECONDS} seconds{smoothChoice?.runsOn === "cloud" ? "…" : ""}
                </Button>
                <Button
                  primary
                  icon={smoothChoice?.runsOn === "cloud" ? "mdiCloudOutline" : "mdiServerOutline"}
                  disabled={!smoothChoice || !smoothPreviewed}
                  onClick={() => {
                    if (smoothChoice.runsOn === "cloud") setSmoothJob({ preview: false });
                    else
                      enqueue?.("Smooth motion", {
                        keepOpen: true,
                        destination: "local",
                        settings: smoothSettings(false, smoothChoice.item.id),
                      });
                  }}
                >
                  Smooth whole video{smoothChoice?.runsOn === "cloud" ? "…" : ""}
                </Button>
              </div>
              {!smoothPreviewed && smoothChoice && (
                <span className="ed-status">Check the {INTERPOLATION_PREVIEW_SECONDS}-second preview first.</span>
              )}
            </>
          )}
        </div>
      )}
      <p className="ed-note">Preview · sample data</p>
    </div>
  );

  const panels = {
    adjust: adjustPanel,
    crop: cropPanel,
    presets: presetsPanel,
    trim: trimPanel,
    speed: speedPanel,
    audio: audioPanel,
    text: textPanel,
    enhance: enhancePanel,
  };

  const cropVisible = cropping && frame && !showingOriginal;
  const previewLabel = split ? null : before ? "Original" : null;

  return (
    <dialog
      ref={dialog}
      className="fl-editor"
      aria-label={`Edit ${selected.name}`}
      onKeyDown={keyDown}
      onKeyUp={keyUp}
      onCancel={(event) => {
        event.preventDefault();
        if (popover) closeMenu(true);
        else cancel();
      }}
    >
      <div className="ed-shell">
        <header className="ed-top">
          <Tool
            ref={closeButton}
            icon="mdiClose"
            label="Cancel and close editor"
            className="compact"
            onClick={cancel}
          >
            Cancel
          </Tool>
          <div className="ed-title">
            <strong>{selected.name}</strong>
            <span>
              {isVideo ? "Video" : "Photo"}
              {dimensions ? ` · ${dimensions}` : ""}
              {isVideo ? ` · ${timecode(duration)}` : ""}
              {dirty ? " · Edited" : ""}
              {peopleNames.length ? (
                <span className="people"> · with {peopleNames.join(", ")}</span>
              ) : null}
            </span>
          </div>
          <Tool icon="mdiUndo" label="Undo" disabled={!undo.length} onClick={undoEdit} />
          <Tool icon="mdiRedo" label="Redo" disabled={!redo.length} onClick={redoEdit} />
          <span className="ed-sep" aria-hidden="true" />
          <Tool
            icon="mdiCompare"
            label="Hold to show the original (\ or Y)"
            aria-pressed={before}
            onPointerDown={(event) => {
              if (event.pointerType === "mouse" && event.button !== 0) return;
              setBefore(true);
            }}
            onPointerUp={() => setBefore(false)}
            onPointerLeave={() => setBefore(false)}
            onPointerCancel={() => setBefore(false)}
            onKeyDown={(event) => {
              if (event.key === " " || event.key === "Enter") {
                event.preventDefault();
                setBefore(true);
              }
            }}
            onKeyUp={(event) => {
              if (event.key === " " || event.key === "Enter") setBefore(false);
            }}
            onClick={(event) => event.preventDefault()}
          />
          <Tool
            icon="mdiCompareHorizontal"
            label="Split view before and after"
            aria-pressed={split}
            onClick={() => setSplit((value) => !value)}
          />
          <span className="ed-sep ed-wide" aria-hidden="true" />
          <Tool icon="mdiContentCopy" label="Copy adjustments" className="ed-wide" onClick={copySettings}>
            Copy
          </Tool>
          <Tool
            icon="mdiContentDuplicate"
            label="Paste adjustments"
            className="ed-wide"
            disabled={!pasteSource}
            onClick={paste}
          >
            Paste
          </Tool>
          <Tool icon="mdiRestore" label="Revert to original" className="ed-wide" onClick={revert}>
            Revert
          </Tool>
          <Tool
            ref={versionsButton}
            icon="mdiHistory"
            label="Versions"
            aria-haspopup="menu"
            aria-expanded={popover === "versions"}
            onClick={() => setPopover(popover === "versions" ? null : "versions")}
          >
            Versions
          </Tool>
          <Tool
            ref={moreButton}
            icon="mdiDotsVertical"
            label="More actions"
            className="ed-narrow"
            aria-haspopup="menu"
            aria-expanded={popover === "more"}
            onClick={() => setPopover(popover === "more" ? null : "more")}
          />
          <Tool icon="mdiOpenInApp" label="Open in Studio" className="ed-wide" onClick={openStudio}>
            Open in Studio
          </Tool>
          <Tool primary label="Save version" onClick={saveVersion}>
            Save version
          </Tool>
          {popover === "versions" && (
            <Menu label="Versions" items={versionItems} close={closeMenu}>
              <h3>Versions</h3>
              {!assetVersions.length && (
                <p>No saved versions yet. Save version keeps this edit as a new one.</p>
              )}
            </Menu>
          )}
          {popover === "more" && <Menu label="More actions" items={moreItems} close={closeMenu} />}
        </header>

        <div className="ed-stage-wrap">
          <div
            className={`ed-stage ${cropping ? "cropping" : ""} ${dragging ? "dragging" : ""} ${before && !split ? "comparing" : ""}`}
            aria-label="Preview"
          >
            <div className="ed-canvas" ref={canvasRef} style={{ position: "relative", width: "100%", height: "100%" }}>
              {frame && split && renderFrame("before")}
              {frame && renderFrame("after")}
              {!frame && (
                <div className="ed-unavailable">
                  <strong>Preparing preview</strong>
                </div>
              )}
              {frame && cropVisible && (
                <div
                  className="ed-crop"
                  role="group"
                  tabIndex={0}
                  aria-label="Crop area. Use the arrow keys to nudge it."
                  style={{
                    left: stage.w / 2 - frame.fw / 2 + rect.x * frame.fw,
                    top: stage.h / 2 - frame.fh / 2 + rect.y * frame.fh,
                    width: rect.w * frame.fw,
                    height: rect.h * frame.fh,
                  }}
                  onPointerDown={beginCrop("move")}
                  onKeyDown={nudgeCrop}
                >
                  {["n", "s", "e", "w", "nw", "ne", "sw", "se"].map((handle) => (
                    <span
                      key={handle}
                      className={`ed-handle ${handle}`}
                      aria-hidden="true"
                      style={{
                        left: handle.includes("w") ? 0 : handle.includes("e") ? "100%" : "50%",
                        top: handle.includes("n") ? 0 : handle.includes("s") ? "100%" : "50%",
                      }}
                      onPointerDown={beginCrop(handle)}
                    />
                  ))}
                  <span className="ed-crop-size" aria-hidden="true">
                    {Math.round(rect.w * (frame.rotated ? natural?.h || selected.height || 0 : natural?.w || selected.width || 0))}{" "}
                    ×{" "}
                    {Math.round(rect.h * (frame.rotated ? natural?.w || selected.width || 0 : natural?.h || selected.height || 0))}
                    {edit.crop !== "Free" ? ` · ${edit.crop}` : ""}
                  </span>
                </div>
              )}
              {frame && split && (
                <button
                  type="button"
                  className="ed-divider"
                  role="slider"
                  aria-label="Before and after divider"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(splitAt * 100)}
                  style={{ left: `${splitAt * 100}%` }}
                  onPointerDown={beginSplit}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowLeft") setSplitAt((value) => clamp(value - 0.02, 0.04, 0.96));
                    if (event.key === "ArrowRight") setSplitAt((value) => clamp(value + 0.02, 0.04, 0.96));
                  }}
                />
              )}
            </div>
            {split && (
              <>
                <span className="ed-badge">Before</span>
                <span className="ed-badge right">After</span>
              </>
            )}
            {previewLabel && <span className="ed-badge ed-original">{previewLabel}</span>}
            {isVideo && videoError && <span className="ed-badge centre">Preview still</span>}
          </div>
          {isVideo && (
            <div className="ed-transport">
              <div className="ed-transport-row">
                <Tool
                  icon={playing ? "mdiPause" : "mdiPlay"}
                  label={playing ? "Pause" : "Play"}
                  onClick={() => setPlaying((value) => !value)}
                />
                <span className="ed-timecode">
                  {precise(timeAt)} / {precise(duration)}
                </span>
                <input
                  className="ed-scrub"
                  type="range"
                  aria-label="Playhead"
                  min="0"
                  max={duration}
                  step="0.01"
                  value={timeAt}
                  onChange={(event) => seek(Number(event.target.value))}
                />
                <span className="ed-rate" aria-label="Playback rate">
                  {speedAt(edit, timeAt)}×
                </span>
                <Tool icon="mdiCameraIris" label="Export frame as photo" className="compact" onClick={exportFrame}>
                  Export frame
                </Tool>
              </div>
              <div className="ed-strip" ref={stripRef} onPointerDown={scrubStrip}>
                <div className={`ed-frames ${stripLoading ? "loading" : ""}`} aria-hidden="true">
                  {(frames || []).map((src, index) => (
                    <img src={src} alt="" key={index} draggable={false} />
                  ))}
                </div>
                <div className="ed-dim" style={{ left: 0, width: `${(trimStart / duration) * 100}%` }} />
                <div className="ed-dim" style={{ left: `${(trimEnd / duration) * 100}%`, right: 0 }} />
                <div
                  className="ed-range"
                  style={{
                    left: `${(trimStart / duration) * 100}%`,
                    width: `${((trimEnd - trimStart) / duration) * 100}%`,
                  }}
                />
                {segments.map((segment, index) => (
                  <div
                    key={index}
                    className="ed-segment"
                    style={{
                      left: `${(segment.start / duration) * 100}%`,
                      width: `${((segment.end - segment.start) / duration) * 100}%`,
                    }}
                  >
                    <span>{segment.speed}×</span>
                  </div>
                ))}
                <button
                  type="button"
                  className="ed-trim-handle in"
                  role="slider"
                  aria-label="Trim in"
                  aria-valuemin={0}
                  aria-valuemax={round(edit.end - 0.1, 2)}
                  aria-valuenow={trimStart}
                  aria-valuetext={precise(trimStart)}
                  style={{ left: `${(trimStart / duration) * 100}%` }}
                  onPointerDown={beginTrim("start")}
                  onKeyDown={trimKey("start")}
                />
                <button
                  type="button"
                  className="ed-trim-handle out"
                  role="slider"
                  aria-label="Trim out"
                  aria-valuemin={round(edit.start + 0.1, 2)}
                  aria-valuemax={duration}
                  aria-valuenow={trimEnd}
                  aria-valuetext={precise(trimEnd)}
                  style={{ left: `${(trimEnd / duration) * 100}%` }}
                  onPointerDown={beginTrim("end")}
                  onKeyDown={trimKey("end")}
                />
                <div className="ed-playhead" style={{ left: `${(timeAt / duration) * 100}%` }} />
              </div>
              <div className="ed-ruler" aria-hidden="true">
                {Array.from({ length: 7 }, (_, i) => (duration * i) / 6).map((value) => (
                  <span key={value}>{timecode(value)}</span>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="ed-side">
          <nav
            className="ed-rail"
            role="tablist"
            aria-label="Editing tools"
            aria-orientation="vertical"
            onKeyDown={railKey}
          >
            {tools.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                data-tool={item.id}
                className="ed-rail-tool"
                aria-selected={tool === item.id}
                aria-controls="ed-panel"
                tabIndex={tool === item.id ? 0 : -1}
                title={item.label}
                onClick={() => setTool(item.id)}
              >
                <Icon name={item.icon} size={22} />
                <span>{item.label}</span>
              </button>
            ))}
          </nav>
          <section
            className="ed-panel"
            id="ed-panel"
            role="tabpanel"
            aria-label={activeTool.label}
          >
            {panels[activeTool.id]}
          </section>
        </div>
      </div>
      <div className="ed-live" role="status" aria-live="polite">
        {announce}
      </div>
      {cloudJob && (
        <CloudJobDialog
          title={cloudJob === "restoration" ? "Restore on Frameleaf Cloud" : "Upscale on Frameleaf Cloud"}
          workload={cloudJob}
          {...(() => {
            const { quantity, label } = jobQuantity(cloudJob, {
              durationSeconds: duration,
              count: 1,
            });
            return { quantity, quantityLabel: cloudJob === "upscale" ? "1 image" : label };
          })()}
          summary={selected.name}
          modelId={cloudModel}
          onRunLocal={(model) =>
            enqueue?.(cloudJob === "restoration" ? "AI restoration" : "Upscale", {
              keepOpen: true,
              destination: "local",
              settings: {
                ...(cloudJob === "restoration" ? { mode: edit.restorationMode } : { upscale: 4 }),
                model,
              },
            })
          }
          onSubmit={(meta) =>
            enqueue?.(cloudJob === "restoration" ? "AI restoration" : "Upscale", {
              cloud: meta,
              keepOpen: true,
              settings: cloudJob === "restoration" ? { mode: edit.restorationMode } : { upscale: 4 },
            })
          }
          onFinish={finishJob}
          onOpenSettings={(section) => {
            setCloudJob(null);
            onOpenCloudSettings?.(section);
          }}
          onAddCredit={
            onAddCredit &&
            (() => {
              setCloudJob(null);
              onAddCredit();
            })
          }
          close={() => setCloudJob(null)}
        />
      )}
      {smoothJob && smoothChoice && (
        <CloudJobDialog
          title={smoothJob.preview ? "Preview smooth motion on Frameleaf Cloud" : "Smooth motion on Frameleaf Cloud"}
          workload="interpolation"
          {...(() => {
            const work = smoothWork(smoothJob.preview);
            const seconds = smoothJob.preview ? Math.min(INTERPOLATION_PREVIEW_SECONDS, duration || 5) : duration;
            return {
              quantity: work.units,
              quantityLabel: `${smoothJob.preview ? `${Math.round(seconds)} s preview` : formatDuration(seconds)} · ${sourceFps} → ${smoothFps} fps`,
            };
          })()}
          preview={smoothJob.preview}
          summary={selected.name}
          modelId={smoothChoice.item.id}
          onRunLocal={(model) => {
            enqueue?.(smoothJob.preview ? "Smooth motion preview" : "Smooth motion", {
              keepOpen: true,
              destination: "local",
              settings: smoothSettings(smoothJob.preview, model),
            });
            if (smoothJob.preview) setSmoothPreviewed(true);
          }}
          onSubmit={(meta) => {
            if (smoothJob.preview) setSmoothPreviewed(true);
            return enqueue?.(smoothJob.preview ? "Smooth motion preview" : "Smooth motion", {
              cloud: meta,
              keepOpen: true,
              settings: smoothSettings(smoothJob.preview, meta.modelId),
            });
          }}
          onFinish={finishJob}
          onOpenSettings={(section) => {
            setSmoothJob(null);
            onOpenCloudSettings?.(section);
          }}
          onAddCredit={
            onAddCredit &&
            (() => {
              setSmoothJob(null);
              onAddCredit();
            })
          }
          close={() => setSmoothJob(null)}
        />
      )}
    </dialog>
  );
}

/* Studio (legacy timeline workspace) ---------------------------------- */

function StudioEditor(props) {
  const {
    selected,
    edit,
    changeEdit,
    session,
    dispatch,
    undo,
    redo,
    undoEdit,
    redoEdit,
    destination,
    setDestination,
    enqueue,
    back,
    openAsset,
    notify,
    finishJob,
    onOpenCloudSettings,
    onAddCredit,
  } = props;
  const [cloudKind, setCloudKind] = useState(null);
  /** Local jobs queue straight away; Frameleaf Cloud jobs confirm model, cost and consent first. */
  const submitJob = (kind) => {
    if (destination === "cloud") setCloudKind(kind);
    else enqueue(kind);
  };
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
    filter: cssFilterFor(edit).filter,
  };
  const preview = (
    <div className="monitor">
      <img src={selected.image} alt={selected.name} style={visualStyle} />
      {/^\d+:\d+$/.test(edit.crop) && (
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
            Saturation <output>{edit.saturation > 0 ? "+" : ""}{edit.saturation}</output>
            <input
              aria-label="Saturation"
              type="range"
              min="-100"
              max="100"
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
              <option value="cloud">Frameleaf Cloud</option>
            </select>
          </label>
          <p className="muted">
            {destination === "local"
              ? "Media stays on your network."
              : "Frameleaf Cloud asks you to confirm the model, cost and what leaves this server for every job."}
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
              <option value="cloud">Frameleaf Cloud</option>
            </select>
          </label>
          <p>3840 × 2160 · Original channels · Revision snapshot</p>
          <div className="dialog-actions">
            <Button onClick={() => setModal(null)}>Cancel</Button>
            <Button
              primary
              onClick={() => {
                submitJob("Export");
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
            {destination === "local" ? "Home workstation" : "Frameleaf Cloud"}
          </p>
          <div className="dialog-actions">
            <Button onClick={() => setModal(null)}>Adjust settings</Button>
            <Button
              primary
              onClick={() => {
                submitJob("AI restoration");
                setModal(null);
              }}
            >
              Simulate full render
            </Button>
          </div>
        </Dialog>
      )}
      {cloudKind && (
        <CloudJobDialog
          title={cloudKind === "Export" ? "Render on Frameleaf Cloud" : "Restore on Frameleaf Cloud"}
          workload={cloudKind === "Export" ? "render" : "restoration"}
          {...(() => {
            const { quantity, label } = jobQuantity("restoration", {
              durationSeconds: Math.max(0, (edit.end ?? duration) - (edit.start ?? 0)),
            });
            return { quantity, quantityLabel: label };
          })()}
          summary={selected.name}
          onSubmit={(meta) => enqueue(cloudKind, { cloud: meta, keepOpen: true })}
          onFinish={finishJob}
          onOpenSettings={(section) => {
            setCloudKind(null);
            onOpenCloudSettings?.(section);
          }}
          onAddCredit={
            onAddCredit &&
            (() => {
              setCloudKind(null);
              onAddCredit();
            })
          }
          close={() => setCloudKind(null)}
        />
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

export function Editor(props) {
  if (props.quick) return <QuickEditor key={props.selected?.id} {...props} />;
  return <StudioEditor {...props} />;
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
              {job.destination === "local" ? "Home workstation" : "Frameleaf Cloud"} ·
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
          <h2>Frameleaf Cloud</h2>
          <p>Optional · needs a Frameleaf account and AI credit</p>
          <p className="muted">
            Used only when you choose it for a job. Each job shows its model,
            cost and what leaves this server before anything is sent.
          </p>
          <Button
            onClick={() => {
              setDestination("cloud");
              notify(
                "Frameleaf Cloud is now the default destination. Every job still asks before it runs.",
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
          <option value="cloud">Frameleaf Cloud</option>
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
