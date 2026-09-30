import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { Button, Dialog } from "./Controls";
import { Icon } from "./Icon";
import { DEVELOP_PARAMS, PRESETS, aspectRatioValue } from "./develop.mjs";
import { fitCropRect, histogramBins, normalizeRect, tonePixels } from "./develop.mjs";
import { redo, undo } from "./studio-project.mjs";
import {
  CHANNELS, PRESET_KEYS, cancelBatch, clone, createBatch, defaultEdit, makeMask,
  normalizePhotos, normalizePoint, photographyStorageKey, previewFor,
  readSession, retryBatch, saveSession, saveVersion, syncEdits, tickBatch, uid, updatePhoto,
} from "./photography-edit.mjs";
import "./photography-editor.css";

const TABS = ["Develop", "Masks", "Presets", "Versions"];
const COLOURS = ["#dc7777", "#d79869", "#ccbb69", "#75ab80", "#69b7b5", "#7f9ec7"];
const editable = (target) => target?.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName);
const safeStorage = () => { try { return window.localStorage; } catch { return null; } };
const isEdited = (edit) => JSON.stringify(edit) !== JSON.stringify(defaultEdit());
const pointsPath = (points) => points.map((point, i) => `${i ? "L" : "M"}${point.x * 100},${point.y * 100}`).join(" ");

function Slider({ label, value, min = -100, max = 100, step = 1, format, onChange }) {
  const id = useId();
  return <label className="pe-slider" htmlFor={id}>
    <span><span>{label}</span><output>{format ? format(value) : `${value > 0 && min < 0 ? "+" : ""}${Math.round(value)}`}</output></span>
    <input id={id} type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} />
  </label>;
}

function Stars({ rating, onChange, compact = false }) {
  return <div className={`pe-stars ${compact ? "compact" : ""}`} aria-label={`Rated ${rating} of 5 stars`}>
    {[1, 2, 3, 4, 5].map((value) => <button type="button" key={value} aria-label={`Rate ${value} ${value === 1 ? "star" : "stars"}`} aria-pressed={rating >= value} onClick={() => onChange(value === rating ? 0 : value)}>
      <Icon name={value <= rating ? "mdiStar" : "mdiStarOutline"} size={compact ? 13 : 17} />
    </button>)}
  </div>;
}

function MaskShape({ mask, colour = "white" }) {
  const x = mask.center.x * 100, y = mask.center.y * 100;
  if (mask.type === "radial") return <ellipse cx={x} cy={y} rx={mask.radius.x * 100} ry={mask.radius.y * 100} fill={colour} />;
  // Subject/Sky regions are fixed demonstration suggestions, never inferred sensor masks.
  if (mask.type === "subject") return <path d="M50 19 C37 19 36 38 43 44 C28 46 25 63 27 96 H74 C76 66 71 48 57 44 C65 35 62 19 50 19Z" fill={colour} />;
  if (mask.type === "sky") return <path d="M0 0 H100 V30 L81 34 L61 26 L40 39 L20 31 L0 42Z" fill={colour} />;
  if (mask.type === "gradient") return <rect width="100" height="100" fill={`url(#${mask.id}-gradient)`} />;
  return null;
}

function MaskDefinitions({ mask, id }) {
  const base = mask.invert ? "white" : "black";
  const add = mask.invert ? "black" : "white";
  const subtract = mask.invert ? "white" : "black";
  return <>
    <linearGradient id={`${mask.id}-gradient`} gradientUnits="userSpaceOnUse" x1={mask.start.x * 100} y1={mask.start.y * 100} x2={mask.end.x * 100} y2={mask.end.y * 100}>
      <stop offset="0" stopColor={add} /><stop offset="1" stopColor={base} />
    </linearGradient>
    <filter id={`${id}-feather`} x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation={mask.feather / 22} /></filter>
    <mask id={id} maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100" style={{ maskType: "luminance" }}>
      <rect width="100" height="100" fill={base} />
      <g filter={mask.feather ? `url(#${id}-feather)` : undefined}>
        <MaskShape mask={mask} colour={add} />
        {mask.strokes.map((stroke, index) => <path key={index} d={pointsPath(stroke.points)} fill="none" stroke={stroke.mode === "subtract" ? subtract : add} strokeWidth={stroke.size * 100} strokeLinecap="round" strokeLinejoin="round" />)}
        {mask.strokes.filter((stroke) => stroke.points.length === 1).map((stroke, index) => <circle key={`dot-${index}`} cx={stroke.points[0].x * 100} cy={stroke.points[0].y * 100} r={stroke.size * 50} fill={stroke.mode === "subtract" ? subtract : add} />)}
      </g>
    </mask>
  </>;
}

function MasksPreview({ masks, image, overlay, selectedId, prefix }) {
  return <svg className="pe-mask-preview" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
    <defs>{masks.filter((mask) => mask.enabled).map((mask) => <MaskDefinitions key={mask.id} mask={mask} id={`${prefix}-${mask.id}`} />)}</defs>
    {masks.filter((mask) => mask.enabled).map((mask) => <g key={mask.id} mask={`url(#${prefix}-${mask.id})`}>
      <image href={image} width="100" height="100" preserveAspectRatio="none" style={{ filter: `brightness(${2 ** mask.exposure})` }} />
      {overlay && selectedId === mask.id && <rect width="100" height="100" fill={["subject", "sky"].includes(mask.type) ? "#818cf8" : "#72ba95"} opacity="0.35" />}
    </g>)}
  </svg>;
}

function Histogram({ imageRef, edit, loaded }) {
  const [bins, setBins] = useState(null);
  useEffect(() => {
    const image = imageRef.current;
    if (!image?.naturalWidth) return;
    try {
      const canvas = document.createElement("canvas"); canvas.width = 96; canvas.height = 64;
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0, 96, 64);
      const pixels = context.getImageData(0, 0, 96, 64);
      const preview = previewFor(edit); tonePixels(pixels.data, preview.numeric, preview.params);
      setBins(histogramBins(pixels, 48));
    } catch { setBins(null); }
  }, [imageRef, edit, loaded]);
  return <svg className="pe-histogram" viewBox="0 0 240 70" role="img" aria-label="Sample preview histogram">
    {[60, 120, 180].map((x) => <path key={x} d={`M${x} 0V70`} className="pe-grid-line" />)}
    {bins && ["red", "green", "blue", "luma"].map((channel) => <path key={channel} className={`pe-hist-${channel}`} d={`M0 70 ${bins[channel].map((n, i) => `L${i * 240 / 47} ${68 - n / Math.max(1, bins.max) * 60}`).join(" ")} L240 70Z`} />)}
  </svg>;
}

function Curve({ curve, onChange }) {
  const options = { Linear: [0, 0.25, 0.5, 0.75, 1], "Soft contrast": [0, 0.18, 0.5, 0.82, 1], "Lifted shadows": [0.07, 0.32, 0.54, 0.77, 1] };
  return <details className="pe-section" open>
    <summary>Tone curve</summary>
    <svg className="pe-curve" viewBox="0 0 240 110" role="img" aria-label="Tone curve from shadows to highlights">
      {[27, 55, 82].map((y) => <path key={y} d={`M0 ${y}H240`} className="pe-grid-line" />)}
      {[60, 120, 180].map((x) => <path key={x} d={`M${x} 0V110`} className="pe-grid-line" />)}
      <path d="M0 110L240 0" className="pe-curve-reference" />
      <polyline points={curve.map((n, i) => `${i * 60},${110 - n * 110}`).join(" ")} className="pe-curve-line" />
      {curve.map((n, i) => <circle key={i} cx={i * 60} cy={110 - n * 110} r="3" className="pe-curve-dot" />)}
    </svg>
    <label className="pe-select">Curve preset<select value="" onChange={(event) => { if (options[event.target.value]) onChange(options[event.target.value]); }}><option value="">Choose a curve…</option>{Object.keys(options).map((name) => <option key={name}>{name}</option>)}</select></label>
    {["Shadows", "Midtones", "Highlights"].map((label, i) => <Slider key={label} label={label} min={0} max={100} value={curve[i + 1] * 100} onChange={(value) => onChange(curve.map((n, j) => j === i + 1 ? value / 100 : n))} />)}
  </details>;
}

function ExportQueue({ queue, onCancel, onRetry }) {
  if (!queue) return <p className="pe-muted">Queue 2–5 photos for a local export simulation.</p>;
  return <>
    <div className="pe-section-heading"><span>{queue.settings.format}{queue.settings.bitDepth === 16 ? " 16-bit" : ""} · {queue.settings.profile} · Mock</span>{queue.status === "running" && <button type="button" onClick={onCancel}>Cancel queue</button>}</div>
    {queue.items.map((item) => <div className="pe-queue-item" key={item.id}><div><span>{item.name}</span><small>{item.status === "complete" ? "Done" : item.status}</small></div><progress max="100" value={item.progress} aria-label={`${item.name} export progress`} />
      {item.error && <p role="status">{item.error}</p>}
      {["failed", "cancelled"].includes(item.status) && <button type="button" onClick={() => onRetry(item)}>{item.status === "failed" ? "Retry preview" : "Resume this photo"}</button>}
    </div>)}
    <p className="pe-muted" role="status">{queue.status === "running" ? "Rendering demo previews…" : queue.status === "issues" ? "Finished with issues. Retry the preview above." : queue.status === "cancelled" ? "Queue cancelled. Completed photos are retained." : "Mock batch complete. Originals are unchanged."}</p>
  </>;
}

/** Full-resolution demo JPEG, from immutable generated preview pixels. RAW, TIFF and ICC conversion are out of scope. */
async function downloadJpeg(image, edit, name) {
  if (!image?.complete || !image.naturalWidth) throw new Error("The preview is still loading. Try again in a moment.");
  const width = image.naturalWidth, height = image.naturalHeight;
  const source = document.createElement("canvas"); source.width = width; source.height = height;
  const context = source.getContext("2d");
  context.filter = previewFor(edit).filter; context.drawImage(image, 0, 0); context.filter = "none";
  for (const layer of previewFor(edit).layers) {
    if (!["temperature", "tint"].includes(layer.id)) continue;
    context.globalCompositeOperation = "overlay"; context.globalAlpha = layer.style.opacity;
    context.fillStyle = layer.style.background; context.fillRect(0, 0, width, height);
  }
  context.globalCompositeOperation = "source-over"; context.globalAlpha = 1;
  for (const mask of edit.masks.filter((item) => item.enabled)) {
    const region = document.createElement("canvas"); region.width = width; region.height = height;
    const shape = region.getContext("2d");
    shape.fillStyle = "white"; shape.strokeStyle = "white";
    shape.save(); shape.scale(width / 100, height / 100);
    if (mask.type === "radial") { shape.beginPath(); shape.ellipse(mask.center.x * 100, mask.center.y * 100, mask.radius.x * 100, mask.radius.y * 100, 0, 0, Math.PI * 2); shape.fill(); }
    if (mask.type === "subject") shape.fill(new Path2D("M50 19 C37 19 36 38 43 44 C28 46 25 63 27 96 H74 C76 66 71 48 57 44 C65 35 62 19 50 19Z"));
    if (mask.type === "sky") shape.fill(new Path2D("M0 0 H100 V30 L81 34 L61 26 L40 39 L20 31 L0 42Z"));
    if (mask.type === "gradient") {
      const gradient = shape.createLinearGradient(mask.start.x * 100, mask.start.y * 100, mask.end.x * 100, mask.end.y * 100);
      gradient.addColorStop(0, "white"); gradient.addColorStop(1, "transparent"); shape.fillStyle = gradient; shape.fillRect(0, 0, 100, 100); shape.fillStyle = "white";
    }
    for (const stroke of mask.strokes) {
      shape.globalCompositeOperation = stroke.mode === "subtract" ? "destination-out" : "source-over";
      shape.lineWidth = stroke.size * 100; shape.lineCap = "round"; shape.lineJoin = "round";
      shape.stroke(new Path2D(pointsPath(stroke.points)));
      if (stroke.points.length === 1) { shape.beginPath(); shape.arc(stroke.points[0].x * 100, stroke.points[0].y * 100, stroke.size * 50, 0, 2 * Math.PI); shape.fill(); }
    }
    shape.restore(); shape.globalCompositeOperation = "source-in";
    shape.fillStyle = mask.exposure > 0 ? "white" : "black"; shape.fillRect(0, 0, width, height);
    if (mask.invert) {
      const inverse = document.createElement("canvas"); inverse.width = width; inverse.height = height;
      const inverseContext = inverse.getContext("2d"); inverseContext.fillStyle = shape.fillStyle; inverseContext.fillRect(0, 0, width, height); inverseContext.globalCompositeOperation = "destination-out"; inverseContext.drawImage(region, 0, 0);
      context.globalAlpha = Math.min(0.65, Math.abs(mask.exposure) / 3); context.filter = `blur(${mask.feather / 100 * width * 0.03}px)`; context.drawImage(inverse, 0, 0);
    } else { context.globalAlpha = Math.min(0.65, Math.abs(mask.exposure) / 3); context.filter = `blur(${mask.feather / 100 * width * 0.03}px)`; context.drawImage(region, 0, 0); }
    context.globalAlpha = 1; context.filter = "none";
  }
  const crop = edit.crop, cw = Math.max(1, Math.round(crop.w * width)), ch = Math.max(1, Math.round(crop.h * height));
  const radians = (edit.rotation + edit.straighten) * Math.PI / 180;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(Math.abs(Math.cos(radians)) * cw + Math.abs(Math.sin(radians)) * ch));
  canvas.height = Math.max(1, Math.round(Math.abs(Math.sin(radians)) * cw + Math.abs(Math.cos(radians)) * ch));
  const output = canvas.getContext("2d"); output.fillStyle = "#111"; output.fillRect(0, 0, canvas.width, canvas.height);
  output.translate(canvas.width / 2, canvas.height / 2); output.rotate(radians);
  output.drawImage(source, crop.x * width, crop.y * height, cw, ch, -cw / 2, -ch / 2, cw, ch);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.96));
  if (!blob) throw new Error("The browser could not create the preview JPEG.");
  const url = URL.createObjectURL(blob), anchor = document.createElement("a");
  anchor.href = url; anchor.download = `${name.replace(/\.[^.]+$/, "")}-edited-preview-srgb.jpg`;
  document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  return `${canvas.width} × ${canvas.height}`;
}

export function PhotographyEditor({ photos = [], shoot, onBack, onProof, notify }) {
  const sources = useMemo(() => normalizePhotos(photos), [photos]);
  const key = photographyStorageKey(shoot);
  return <PhotographyWorkspace key={`${key}:${sources.map((photo) => photo.id).join(",")}`} photos={sources} shoot={shoot} storageKey={key} onBack={onBack} onProof={onProof} notify={notify} />;
}

function PhotographyWorkspace({ photos, shoot, storageKey, onBack, onProof, notify }) {
  const [session, setSession] = useState(() => readSession(photos, safeStorage(), storageKey));
  const [tab, setTab] = useState("Develop"), [inspectorOpen, setInspectorOpen] = useState(false);
  const [compare, setCompare] = useState(false), [zoom, setZoom] = useState("fit"), [cropTool, setCropTool] = useState(false);
  const [selectedMaskId, setSelectedMaskId] = useState(null), [overlay, setOverlay] = useState(true);
  const [maskGesture, setMaskGesture] = useState("brush");
  const [brushMode, setBrushMode] = useState("add"), [brushSize, setBrushSize] = useState(0.08);
  const [dragEdit, setDragEdit] = useState(null), [saveStatus, setSaveStatus] = useState("Saved on this browser");
  const [channel, setChannel] = useState("Orange"), [presetName, setPresetName] = useState("");
  const [dialog, setDialog] = useState(null), [syncGroups, setSyncGroups] = useState(["tone", "colour", "detail"]);
  const [exportSettings, setExportSettings] = useState({ format: "JPEG", profile: "sRGB", simulateFailure: false });
  const [exportStatus, setExportStatus] = useState(""), [queue, setQueue] = useState(null), [message, setMessage] = useState("");
  const [stageSize, setStageSize] = useState({ width: 800, height: 650 }), [natural, setNatural] = useState({ width: 1024, height: 1024 });
  const sessionRef = useRef(session), gesture = useRef(null), imageRef = useRef(null), stageRef = useRef(null), exportBusy = useRef(false);
  const prefix = useId().replace(/:/g, "");
  sessionRef.current = session;
  const photo = photos.find((item) => item.id === session.activeId) || photos[0];
  const record = session.records[photo.id], edit = dragEdit || record.history.present;
  const shown = compare ? defaultEdit() : edit, preview = previewFor(shown);
  const activeMask = edit.masks.find((mask) => mask.id === selectedMaskId) || edit.masks.at(-1);
  const selected = photos.filter((item) => session.selected.includes(item.id));
  const targets = selected.filter((item) => item.id !== photo.id);
  const currentIndex = photos.findIndex((item) => item.id === photo.id);
  const say = (text) => { setMessage(text); notify?.(text); };
  const apply = (patch) => setSession((current) => updatePhoto(current, photo.id, patch));
  const select = (id) => { setSession((current) => ({ ...current, activeId: id })); setSelectedMaskId(null); setDragEdit(null); setCompare(false); gesture.current = null; };
  const historyAction = (fn) => setSession((current) => ({ ...current, records: { ...current.records, [photo.id]: { ...current.records[photo.id], history: fn(current.records[photo.id].history) } } }));
  const rate = (id, rating) => setSession((current) => ({ ...current, records: { ...current.records, [id]: { ...current.records[id], rating } } }));
  const toggleSelected = (id) => setSession((current) => ({ ...current, selected: current.selected.includes(id) ? current.selected.filter((item) => item !== id) : [...current.selected, id] }));
  const editMask = (patch) => activeMask && apply({ masks: edit.masks.map((mask) => mask.id === activeMask.id ? { ...mask, ...patch } : mask) });
  const persist = () => saveSession(safeStorage(), storageKey, sessionRef.current);
  const returnPhotos = (items) => items.map((item) => ({ ...item, rating: session.records[item.id].rating, edited: isEdited(session.records[item.id].history.present), previewFilter: previewFor(session.records[item.id].history.present).filter }));
  const returnToProof = () => { persist(); const result = returnPhotos(photos); onProof ? onProof({ shoot, photos: result, selectedIds: session.selected }) : say(`${result.length} photos prepared for proofing.`); };

  useEffect(() => {
    setSaveStatus("Saving…");
    const timer = setTimeout(() => setSaveStatus(saveSession(safeStorage(), storageKey, session) ? "Saved on this browser" : "In memory · storage unavailable"), 500);
    return () => clearTimeout(timer);
  }, [session, storageKey]);
  useEffect(() => {
    const save = () => saveSession(safeStorage(), storageKey, sessionRef.current);
    window.addEventListener("pagehide", save);
    return () => { window.removeEventListener("pagehide", save); save(); };
  }, [storageKey]);
  useEffect(() => {
    const element = stageRef.current;
    if (!element) return;
    const measure = () => setStageSize({ width: element.clientWidth || 800, height: element.clientHeight || 650 });
    measure();
    if (typeof ResizeObserver === "undefined") { window.addEventListener("resize", measure); return () => window.removeEventListener("resize", measure); }
    const observer = new ResizeObserver(measure); observer.observe(element); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const down = (event) => {
      if (editable(event.target) || event.target.closest?.('[role="tablist"]') || document.querySelector("dialog[open]")) return;
      if (event.key === "\\" && !event.metaKey && !event.ctrlKey && !event.altKey) { event.preventDefault(); setCompare(true); }
      if (["ArrowLeft", "ArrowRight"].includes(event.key)) { event.preventDefault(); select(photos[(currentIndex + (event.key === "ArrowRight" ? 1 : -1) + photos.length) % photos.length].id); }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") { event.preventDefault(); historyAction(event.shiftKey ? redo : undo); }
    };
    const up = (event) => { if (event.key === "\\" || event.code === "Backslash") setCompare(false); };
    const blur = () => setCompare(false);
    window.addEventListener("keydown", down); window.addEventListener("keyup", up); window.addEventListener("blur", blur);
    return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); window.removeEventListener("blur", blur); };
  });
  useEffect(() => {
    if (queue?.status !== "running") return;
    // Local timer advances a fictional queue; it never reads a provider or starts compute.
    const timer = setTimeout(() => setQueue((current) => tickBatch(current)), 420);
    return () => clearTimeout(timer);
  }, [queue]);
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(""), 5000); return () => clearTimeout(timer);
  }, [message]);

  const sourcePoint = (event) => {
    const svg = event.currentTarget;
    try {
      const point = svg.createSVGPoint(); point.x = event.clientX; point.y = event.clientY;
      const mapped = point.matrixTransform(svg.getScreenCTM().inverse());
      return normalizePoint({ x: mapped.x / 100, y: mapped.y / 100 });
    } catch {
      const box = svg.getBoundingClientRect(); return normalizePoint({ x: (event.clientX - box.left) / box.width, y: (event.clientY - box.top) / box.height });
    }
  };
  const beginDraw = (event) => {
    if (compare || event.button !== 0 || event.target.closest?.("button,input,select")) return;
    if (!cropTool && (tab !== "Masks" || !activeMask || !activeMask.enabled)) return;
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
    const start = sourcePoint(event), base = clone(edit);
    const kind = cropTool ? "crop" : maskGesture === "place" && ["radial", "gradient"].includes(activeMask.type) ? activeMask.type : "brush";
    gesture.current = { start, base, id: photo.id, pointerId: event.pointerId, maskId: activeMask?.id, kind };
    if (kind === "brush") {
      const stroke = { mode: brushMode, size: brushSize, points: [start] };
      gesture.current.stroke = stroke;
      base.masks = base.masks.map((mask) => mask.id === activeMask.id ? { ...mask, strokes: [...mask.strokes, stroke] } : mask);
      setDragEdit(base);
    }
  };
  const draw = (event) => {
    const current = gesture.current;
    if (!current || event.pointerId !== current.pointerId) return;
    const point = sourcePoint(event), next = clone(current.base);
    if (current.kind === "crop") {
      next.crop = normalizeRect({ x: Math.min(current.start.x, point.x), y: Math.min(current.start.y, point.y), w: Math.abs(point.x - current.start.x), h: Math.abs(point.y - current.start.y) }); next.aspect = "Free";
    } else {
      if (current.stroke) current.stroke.points.push(point);
      next.masks = next.masks.map((mask) => mask.id !== current.maskId ? mask : current.kind === "radial"
        ? { ...mask, center: current.start, radius: { x: Math.max(0.02, Math.abs(point.x - current.start.x)), y: Math.max(0.02, Math.abs(point.y - current.start.y)) } }
        : current.kind === "gradient" ? { ...mask, start: current.start, end: point }
          : { ...mask, strokes: [...current.base.masks.find((item) => item.id === mask.id).strokes.slice(0, -1), clone(current.stroke)] });
    }
    current.next = next; setDragEdit(next);
  };
  const endDraw = (event, cancelled = false) => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    if (!cancelled) setSession((state) => updatePhoto(state, current.id, current.next || current.base));
    gesture.current = null; setDragEdit(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const addMask = (type) => {
    if (edit.masks.length >= 20) { say("This prototype supports up to 20 masks per photo."); return; }
    const mask = makeMask(type, edit.masks.length); apply({ masks: [...edit.masks, mask] }); setSelectedMaskId(mask.id); setMaskGesture(["radial", "gradient"].includes(type) ? "place" : "brush"); setTab("Masks"); setCropTool(false); setOverlay(true);
  };
  const saveCurrentVersion = () => { setSession((current) => saveVersion(current, photo.id)); say("Version saved. Your original stays untouched."); };
  const currentExport = async () => {
    if (exportBusy.current) return;
    if (exportSettings.format === "TIFF") { setExportStatus(`16-bit TIFF · ${exportSettings.profile} settings simulated. No TIFF file created.`); return; }
    exportBusy.current = true; setExportStatus("Preparing full-size demo JPEG…");
    try { const size = await downloadJpeg(imageRef.current, record.history.present, photo.name); setExportStatus(`Downloaded ${size} demo JPEG in browser sRGB.`); }
    catch (error) { setExportStatus(error.message); }
    finally { exportBusy.current = false; }
  };
  const enqueue = () => {
    try { setQueue(createBatch(photos, session.selected, exportSettings)); setDialog(null); say(`${selected.length} photos added to the mock export queue.`); }
    catch (error) { setExportStatus(error.message); }
  };
  const queueActions = { queue, onCancel: () => setQueue((current) => cancelBatch(current)), onRetry: (item) => setQueue((current) => retryBatch(current, item.id, { previewOnly: item.status === "failed" })) };
  const quarterTurn = Math.abs(Math.round(shown.rotation / 90)) % 2;
  const ratio = natural.width / natural.height;
  const fitWidth = Math.max(80, Math.min(quarterTurn ? stageSize.height - 70 : stageSize.width - 48, (quarterTurn ? stageSize.width - 48 : stageSize.height - 70) * ratio));
  const scale = zoom === "fit" ? 1 : natural.width / fitWidth * Number(zoom) / 100;
  const frameWidth = fitWidth * scale, frameHeight = frameWidth / ratio;
  const crop = shown.crop;

  return <main className="pe-workspace" aria-label="Photography editor">
    <header className="pe-header">
      <Button icon="mdiArrowLeft" onClick={() => { persist(); onBack ? onBack({ shoot, photos: returnPhotos(photos) }) : say("Edits saved on this browser."); }}>Back to shoot</Button>
      <div className="pe-heading"><strong>{shoot?.name || "Mountain portraits"}</strong><span>Photography editor</span></div>
      <span className="pe-prototype">Prototype</span><span className="pe-save-status">{saveStatus}</span>
      <Button icon="mdiContentDuplicate" onClick={saveCurrentVersion}>Save version</Button>
      <Button icon="mdiImageMultipleOutline" onClick={returnToProof}>Proof</Button>
      <Button primary icon="mdiExportVariant" onClick={() => { setExportStatus(""); setDialog("export"); }}>Export</Button>
    </header>

    <aside className="pe-left" aria-label="Shoot and export queue">
      <div className="pe-left-title"><Icon name="mdiCameraIris" /><strong>Darkroom</strong></div>
      <div className="pe-file-block"><span className="pe-file-type">{photo.raw === false ? "PHOTO" : "RAW"} / {photo.extension}</span><h2>{photo.name}</h2><p>{photo.camera}</p><span className="pe-local"><span />Local preview</span></div>
      <div className="pe-left-section"><Histogram imageRef={imageRef} edit={shown} loaded={`${photo.id}:${natural.width}`} /><div className="pe-hist-caption"><span>Preview histogram</span><span>{natural.width} × {natural.height}</span></div></div>
      <div className="pe-left-section"><div className="pe-section-heading"><strong>This shoot</strong><span>{photos.length} photos</span></div>
        <div className="pe-shoot-list">{photos.slice(0, 6).map((item) => <button type="button" key={item.id} className={item.id === photo.id ? "active" : ""} aria-current={item.id === photo.id ? "true" : undefined} onClick={() => select(item.id)}><img src={item.image} alt="" /><span><strong>{item.name}</strong><small>{session.records[item.id].rating ? `${session.records[item.id].rating} stars` : "Unrated"}{isEdited(session.records[item.id].history.present) ? " · Edited" : ""}</small></span>{item.id === photo.id && <Icon name="mdiCheck" size={15} />}</button>)}</div>
      </div>
      <div className="pe-left-section"><div className="pe-section-heading"><strong>Selected for sync</strong><span>{selected.length}</span></div><p className="pe-muted">Use the filmstrip checkboxes to select photos.</p>
        <Button icon="mdiSync" disabled={!targets.length} onClick={() => setDialog("sync")}>Sync settings to {targets.length} {targets.length === 1 ? "photo" : "photos"}</Button>
        <Button icon="mdiSelectAll" onClick={() => setSession((current) => ({ ...current, selected: photos.map((item) => item.id) }))}>Select shoot</Button>
      </div>
      <div className="pe-left-section pe-queue"><div className="pe-section-heading"><strong>Export queue</strong></div><ExportQueue {...queueActions} /></div>
    </aside>

    <section className={`pe-centre ${cropTool ? "crop-open" : ""}`} aria-label="Photo preview and filmstrip">
      <div className="pe-preview-toolbar">
        <div><Button icon="mdiUndo" aria-label="Undo edit" disabled={!record.history.past.length} onClick={() => historyAction(undo)} /><Button icon="mdiRedo" aria-label="Redo edit" disabled={!record.history.future.length} onClick={() => historyAction(redo)} /><span className="pe-toolbar-divider" /><Button icon="mdiCropRotate" active={cropTool} onClick={() => { setCropTool(!cropTool); setZoom("fit"); }}>Crop</Button></div>
        <div><Button icon="mdiCompare" aria-label="Hold to compare original, or hold backslash" aria-pressed={compare} onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); setCompare(true); }} onPointerUp={() => setCompare(false)} onPointerCancel={() => setCompare(false)} onLostPointerCapture={() => setCompare(false)} onKeyDown={(event) => { if ([" ", "Enter"].includes(event.key)) { event.preventDefault(); setCompare(true); } }} onKeyUp={() => setCompare(false)} onBlur={() => setCompare(false)}>Hold original <kbd>\</kbd></Button><select aria-label="Preview zoom" value={zoom} onChange={(event) => setZoom(event.target.value)}><option value="fit">Fit</option><option value="100">100%</option><option value="150">150%</option><option value="200">200%</option></select><Button className="pe-inspector-toggle" icon="mdiTune" aria-expanded={inspectorOpen} onClick={() => setInspectorOpen(!inspectorOpen)}>Inspector</Button></div>
      </div>
      <div className={`pe-stage ${cropTool || tab === "Masks" && activeMask ? "pe-drawing" : ""}`} ref={stageRef}>
        <div className="pe-stage-inner"><div className="pe-photo-wrap" style={{ width: quarterTurn ? frameHeight : frameWidth, height: quarterTurn ? frameWidth : frameHeight }}>
          <div className="pe-photo" style={{ width: frameWidth, height: frameHeight, transform: `translate(-50%, -50%) rotate(${shown.rotation + shown.straighten}deg)` }}>
            <div className="pe-toned" style={{ filter: preview.filter, transform: shown.lens ? "scale(1.006)" : undefined }}>
              <img ref={imageRef} src={photo.image} alt={`${photo.name}, ${compare ? "original" : "edited demo preview"}`} draggable="false" onLoad={(event) => setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} onError={(event) => { if (!event.currentTarget.src.endsWith("/media/portrait.png")) event.currentTarget.src = "/media/portrait.png"; }} />
              {preview.layers.map((layer) => <span className="pe-tone-layer" key={layer.id} style={layer.style} />)}
              <MasksPreview masks={shown.masks} image={photo.image} selectedId={activeMask?.id} overlay={tab === "Masks" && overlay && !compare} prefix={prefix} />
            </div>
            <svg className={`pe-input-svg ${cropTool || tab === "Masks" && activeMask?.enabled ? "enabled" : ""}`} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true" onPointerDown={beginDraw} onPointerMove={draw} onPointerUp={endDraw} onPointerCancel={(event) => endDraw(event, true)}>
              <defs><mask id={`${prefix}-crop`}><rect width="100" height="100" fill="white" /><rect x={crop.x * 100} y={crop.y * 100} width={crop.w * 100} height={crop.h * 100} fill="black" /></mask></defs>
              <rect width="100" height="100" fill="black" opacity="0.64" mask={`url(#${prefix}-crop)`} />
              {cropTool && <><rect x={crop.x * 100} y={crop.y * 100} width={crop.w * 100} height={crop.h * 100} fill="none" stroke="white" strokeWidth="0.3" />{[1, 2].map((n) => <g key={n} stroke="white" strokeWidth="0.15" opacity="0.5"><path d={`M${(crop.x + crop.w * n / 3) * 100} ${crop.y * 100}v${crop.h * 100}`} /><path d={`M${crop.x * 100} ${(crop.y + crop.h * n / 3) * 100}h${crop.w * 100}`} /></g>)}</>}
              {tab === "Masks" && activeMask && overlay && activeMask.type === "gradient" && <path d={`M${activeMask.start.x * 100} ${activeMask.start.y * 100}L${activeMask.end.x * 100} ${activeMask.end.y * 100}`} stroke="white" strokeWidth="0.35" strokeDasharray="1 1" />}
            </svg>
          </div>
        </div></div>
        {compare && <span className="pe-original-label">Original</span>}
        {tab === "Masks" && activeMask && !compare && <span className="pe-canvas-hint">{maskGesture === "place" && activeMask.type === "radial" ? "Drag from the centre outward" : maskGesture === "place" && activeMask.type === "gradient" ? "Drag to place the gradient" : `${brushMode === "subtract" ? "Subtract" : "Add"} with the brush`}</span>}
        {cropTool && <span className="pe-canvas-hint">Drag a new crop frame</span>}
      </div>
      {cropTool && <div className="pe-crop-bar"><label>Aspect<select value={edit.aspect} onChange={(event) => apply({ aspect: event.target.value, crop: fitCropRect(aspectRatioValue(event.target.value, natural.width, natural.height), natural.width, natural.height) })}>{["Original", "Free", "1:1", "3:2", "4:5", "16:9"].map((aspect) => <option key={aspect}>{aspect}</option>)}</select></label><Button icon="mdiRotateLeft" aria-label="Rotate left 90 degrees" onClick={() => apply({ rotation: ((edit.rotation - 90) % 360) })} /><Button icon="mdiRotateRight" aria-label="Rotate right 90 degrees" onClick={() => apply({ rotation: ((edit.rotation + 90) % 360) })} /><Slider label="Straighten" min={-20} max={20} step={0.1} value={edit.straighten} format={(value) => `${value.toFixed(1)}°`} onChange={(value) => apply({ straighten: value })} /><Button onClick={() => apply({ crop: defaultEdit().crop, aspect: "Original", rotation: 0, straighten: 0 })}>Reset</Button><Button active onClick={() => setCropTool(false)}>Done</Button></div>}
      <div className="pe-image-status"><span>{photo.name}</span><Stars rating={record.rating} onChange={(rating) => rate(photo.id, rating)} /><Button className="pe-inline-sync" icon="mdiSync" disabled={!targets.length} onClick={() => setDialog("sync")}>Sync {targets.length}</Button><span>{currentIndex + 1} of {photos.length}</span></div>
      <div className="pe-filmstrip" aria-label="Shoot filmstrip">{photos.map((item, index) => <div className={`pe-film-frame ${photo.id === item.id ? "current" : ""} ${session.selected.includes(item.id) ? "selected" : ""}`} key={item.id}>
        <button type="button" className="pe-film-photo" aria-label={`Open ${item.name}`} aria-current={photo.id === item.id ? "true" : undefined} onClick={() => select(item.id)}><img src={item.image} alt="" draggable="false" /><span>{String(index + 1).padStart(2, "0")}</span>{isEdited(session.records[item.id].history.present) && <i title="Edited"><Icon name="mdiTune" size={13} /></i>}</button>
        <label className="pe-film-select"><input type="checkbox" aria-label={`Select ${item.name} for sync and batch export`} checked={session.selected.includes(item.id)} onChange={() => toggleSelected(item.id)} /><span>{item.extension}</span></label><Stars compact rating={session.records[item.id].rating} onChange={(rating) => rate(item.id, rating)} />
      </div>)}</div>
    </section>

    <aside className={`pe-inspector ${inspectorOpen ? "open" : ""}`} aria-label="Develop inspector">
      <div className="pe-inspector-tabs" role="tablist" aria-label="Editing tools">{TABS.map((name) => <button type="button" role="tab" id={`${prefix}-tab-${name}`} aria-controls={`${prefix}-panel-${name}`} aria-selected={tab === name} tabIndex={tab === name ? 0 : -1} key={name} onClick={() => { setTab(name); setCropTool(false); }} onKeyDown={(event) => { if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return; event.preventDefault(); event.stopPropagation(); const index = event.key === "Home" ? 0 : event.key === "End" ? 3 : (TABS.indexOf(name) + (event.key === "ArrowRight" ? 1 : -1) + 4) % 4; setTab(TABS[index]); setCropTool(false); event.currentTarget.parentElement.children[index].focus(); }}>{name}</button>)}</div>
      <div className="pe-inspector-body" role="tabpanel" id={`${prefix}-panel-${tab}`} aria-labelledby={`${prefix}-tab-${tab}`}>
        {tab === "Develop" && <>
          <div className="pe-inspector-heading"><strong>Develop</strong><button type="button" onClick={() => { apply(defaultEdit()); say("Develop settings reset. Saved versions remain available."); }}>Reset</button></div>
          <details className="pe-section" open><summary>Light</summary>{["exposure", "contrast", "highlights", "shadows", "whites", "blacks"].map((key) => { const spec = DEVELOP_PARAMS.find((item) => item.id === key); return <Slider key={key} label={spec.label} min={spec.min} max={spec.max} step={spec.step} value={edit[key]} format={key === "exposure" ? (value) => `${value > 0 ? "+" : ""}${value.toFixed(2)} EV` : undefined} onChange={(value) => apply({ [key]: value })} />; })}</details>
          <details className="pe-section" open><summary>White balance</summary><Slider label="Temperature" value={edit.temperature} format={(value) => `${Math.round(5500 + value * 35)} K`} onChange={(value) => apply({ temperature: value })} /><Slider label="Tint" value={edit.tint} onChange={(value) => apply({ tint: value })} /><div className="pe-wb-actions"><button type="button" onClick={() => apply({ temperature: 0, tint: 0 })}>As shot</button><button type="button" onClick={() => apply({ temperature: 6, tint: 3 })}>Daylight</button><button type="button" onClick={() => apply({ temperature: -28, tint: 4 })}>Tungsten</button></div></details>
          <Curve curve={edit.curve} onChange={(curve) => apply({ curve })} />
          <details className="pe-section"><summary>Colour mixer</summary><div className="pe-colour-channels" aria-label="HSL colour channels">{CHANNELS.map((name, i) => <button type="button" key={name} title={name} aria-label={`${name} HSL channel`} aria-pressed={channel === name} style={{ "--pe-channel": COLOURS[i] }} onClick={() => setChannel(name)} />)}</div><p className="pe-muted">{channel}</p>{["hue", "saturation", "luminance"].map((key) => <Slider key={key} label={key[0].toUpperCase() + key.slice(1)} value={edit.hsl[channel][key]} onChange={(value) => apply({ hsl: { ...edit.hsl, [channel]: { ...edit.hsl[channel], [key]: value } } })} />)}<Slider label="Vibrance" value={edit.vibrance} onChange={(value) => apply({ vibrance: value })} /></details>
          <details className="pe-section"><summary>Detail & lens</summary><Slider label="Sharpness" min={0} value={edit.sharpen} onChange={(value) => apply({ sharpen: value })} /><Slider label="Denoise" min={0} value={edit.noiseReduction} onChange={(value) => apply({ noiseReduction: value })} /><label className="pe-check"><input type="checkbox" checked={edit.lens} onChange={(event) => apply({ lens: event.target.checked })} />Lens profile correction</label><p className="pe-muted">Preview adjustments are simulated on demo pixels.</p></details>
          <details className="pe-section"><summary>Crop geometry</summary>{[["x", "Left"], ["y", "Top"], ["w", "Width"], ["h", "Height"]].map(([key, label]) => <Slider key={key} label={label} min={key === "w" || key === "h" ? 5 : 0} max={100} value={edit.crop[key] * 100} format={(value) => `${Math.round(value)}%`} onChange={(value) => apply({ crop: normalizeRect({ ...edit.crop, [key]: value / 100 }), aspect: "Free" })} />)}<Button icon="mdiCropRotate" onClick={() => { setCropTool(true); setZoom("fit"); }}>Crop & rotate</Button></details>
        </>}
        {tab === "Masks" && <>
          <div className="pe-inspector-heading"><strong>Local adjustments</strong><span>{edit.masks.length}</span></div>
          <div className="pe-mask-tools">{[["brush", "mdiBrush", "Brush"], ["radial", "mdiCircleOutline", "Radial"], ["gradient", "mdiGradientVertical", "Gradient"]].map(([type, icon, label]) => <Button key={type} icon={icon} onClick={() => addMask(type)}>{label}</Button>)}</div>
          <div className="pe-ai-tools"><Button className="pe-ai" icon="mdiCreation" onClick={() => addMask("subject")}>Subject</Button><Button className="pe-ai" icon="mdiCreation" onClick={() => addMask("sky")}>Sky</Button></div><p className="pe-muted">Subject and Sky suggest demo regions. Refine them with the brush.</p>
          {!edit.masks.length && <div className="pe-empty-mask"><Icon name="mdiBrush" size={28} /><p>Add a mask, then paint on the photo.</p></div>}
          {edit.masks.map((mask) => <div key={mask.id} className={`pe-mask-row ${activeMask?.id === mask.id ? "active" : ""}`}><button type="button" onClick={() => setSelectedMaskId(mask.id)}><Icon name={["subject", "sky"].includes(mask.type) ? "mdiCreation" : mask.type === "radial" ? "mdiCircleOutline" : "mdiBrush"} className={["subject", "sky"].includes(mask.type) ? "pe-ai" : undefined} /><span>{mask.name}</span></button><input type="checkbox" aria-label={`Enable ${mask.name}`} checked={mask.enabled} onChange={(event) => apply({ masks: edit.masks.map((item) => item.id === mask.id ? { ...item, enabled: event.target.checked } : item) })} /><button type="button" aria-label={`Delete ${mask.name}`} onClick={() => apply({ masks: edit.masks.filter((item) => item.id !== mask.id) })}><Icon name="mdiClose" size={15} /></button></div>)}
          {activeMask && <div className="pe-mask-settings"><div className="pe-section-heading"><strong>{activeMask.name}</strong>{["subject", "sky"].includes(activeMask.type) && <span className="pe-ai">Suggested</span>}</div>
            {["radial", "gradient"].includes(activeMask.type) && <div className="pe-brush-mode"><button type="button" aria-pressed={maskGesture === "place"} onClick={() => setMaskGesture("place")}>Place region</button><button type="button" aria-pressed={maskGesture === "brush"} onClick={() => setMaskGesture("brush")}>Refine with brush</button></div>}
            <div className="pe-brush-mode"><button type="button" aria-pressed={brushMode === "add" && maskGesture === "brush"} onClick={() => { setBrushMode("add"); setMaskGesture("brush"); }}>Add</button><button type="button" aria-pressed={brushMode === "subtract" && maskGesture === "brush"} onClick={() => { setBrushMode("subtract"); setMaskGesture("brush"); }}>Subtract</button></div>
            <Slider label="Brush size" min={1} max={40} value={brushSize * 100} format={(value) => `${Math.round(value)}%`} onChange={(value) => setBrushSize(value / 100)} /><Slider label="Feather" min={0} max={100} value={activeMask.feather} onChange={(value) => editMask({ feather: value })} /><Slider label="Mask exposure" min={-2} max={2} step={0.05} value={activeMask.exposure} format={(value) => `${value.toFixed(2)} EV`} onChange={(value) => editMask({ exposure: value })} />
            <label className="pe-check"><input type="checkbox" checked={activeMask.invert} onChange={(event) => editMask({ invert: event.target.checked })} />Invert mask</label><label className="pe-check"><input type="checkbox" checked={overlay} onChange={(event) => setOverlay(event.target.checked)} />Show coloured overlay</label>
            {activeMask.type === "radial" && <><Slider label="Centre X" min={0} max={100} value={activeMask.center.x * 100} onChange={(value) => editMask({ center: { ...activeMask.center, x: value / 100 } })} /><Slider label="Centre Y" min={0} max={100} value={activeMask.center.y * 100} onChange={(value) => editMask({ center: { ...activeMask.center, y: value / 100 } })} /><Slider label="Radius X" min={2} max={100} value={activeMask.radius.x * 100} onChange={(value) => editMask({ radius: { ...activeMask.radius, x: value / 100 } })} /><Slider label="Radius Y" min={2} max={100} value={activeMask.radius.y * 100} onChange={(value) => editMask({ radius: { ...activeMask.radius, y: value / 100 } })} /></>}
            {activeMask.type === "gradient" && <><Slider label="Gradient start" min={0} max={100} value={activeMask.start.y * 100} onChange={(value) => editMask({ start: { ...activeMask.start, y: value / 100 } })} /><Slider label="Gradient end" min={0} max={100} value={activeMask.end.y * 100} onChange={(value) => editMask({ end: { ...activeMask.end, y: value / 100 } })} /></>}
            <Button icon="mdiEraser" disabled={!activeMask.strokes.length} onClick={() => editMask({ strokes: [] })}>Clear brush refinement</Button>
          </div>}
        </>}
        {tab === "Presets" && <>
          <div className="pe-inspector-heading"><strong>Looks</strong><span>Local</span></div>
          <div className="pe-presets">{PRESETS.filter((preset) => !preset.scope).map((preset) => <button type="button" key={preset.id} aria-pressed={edit.preset === preset.id} onClick={() => apply({ preset: preset.id })}><img src={photo.image} alt="" style={{ filter: previewFor({ ...defaultEdit(), preset: preset.id }).filter }} /><span>{preset.label}</span>{edit.preset === preset.id && <Icon name="mdiCheck" size={15} />}</button>)}</div>
          <Slider label="Preset strength" min={0} max={100} value={edit.presetStrength} format={(value) => `${value}%`} onChange={(value) => apply({ presetStrength: value })} />
          <form className="pe-preset-save" onSubmit={(event) => { event.preventDefault(); if (!presetName.trim()) return; const preset = { id: uid("preset"), name: presetName.trim(), edit: { ...defaultEdit(), ...Object.fromEntries(PRESET_KEYS.map((key) => [key, clone(edit[key])])) } }; setSession((current) => ({ ...current, presets: [...current.presets, preset].slice(-20) })); setPresetName(""); say("Preset saved with tone, colour and detail settings."); }}><label>Save these settings<input required maxLength={50} placeholder="Name your preset" value={presetName} onChange={(event) => setPresetName(event.target.value)} /></label><Button type="submit" icon="mdiPlus" disabled={!presetName.trim()}>Save preset</Button></form>
          {session.presets.length > 0 && <div className="pe-saved-presets"><h3>Your presets</h3>{session.presets.map((preset) => <div key={preset.id}><button type="button" onClick={() => apply(Object.fromEntries(PRESET_KEYS.map((key) => [key, clone(preset.edit[key])])))}>{preset.name}</button><button type="button" aria-label={`Delete preset ${preset.name}`} onClick={() => setSession((current) => ({ ...current, presets: current.presets.filter((item) => item.id !== preset.id) }))}><Icon name="mdiClose" size={15} /></button></div>)}</div>}
        </>}
        {tab === "Versions" && <>
          <div className="pe-inspector-heading"><strong>Versions</strong><button type="button" onClick={saveCurrentVersion}>Save current</button></div>
          <p className="pe-muted">Save a point to return to. Your original is always available.</p>
          <button type="button" className="pe-version" onClick={() => apply(defaultEdit())}><img src={photo.image} alt="" /><span><strong>Original</strong><small>Immutable source preview</small></span><Icon name="mdiRestore" size={17} /></button>
          {[...record.versions].reverse().map((version) => <button type="button" className="pe-version" key={version.id} onClick={() => { apply(version.edit); say(`${version.name} restored.`); }}><img src={photo.image} alt="" style={{ filter: previewFor(version.edit).filter }} /><span><strong>{version.name}</strong><small>{version.at ? new Date(version.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "Saved locally"}</small></span><Icon name="mdiRestore" size={17} /></button>)}
          <div className="pe-version-history"><span>{record.history.past.length} undo steps</span><Button icon="mdiUndo" disabled={!record.history.past.length} onClick={() => historyAction(undo)}>Undo</Button><Button icon="mdiRedo" disabled={!record.history.future.length} onClick={() => historyAction(redo)}>Redo</Button></div>
        </>}
      </div>
      <div className="pe-inspector-footer"><Icon name="mdiShieldCheckOutline" size={15} /><span>Original kept untouched</span></div>
    </aside>
    {message && <div className="pe-toast" role="status">{message}</div>}

    {dialog === "sync" && <Dialog title={`Sync from ${photo.name}`} close={() => setDialog(null)} actions={<><Button onClick={() => setDialog(null)}>Cancel</Button><Button primary disabled={!syncGroups.length || !targets.length} onClick={() => { setSession((current) => syncEdits(current, photo.id, targets.map((item) => item.id), syncGroups)); setDialog(null); say(`Settings synced to ${targets.length} photos.`); }}>Sync to {targets.length} photos</Button></>}><div className="pe-dialog-content"><p>Apply the checked settings to your selected photos.</p>{[["tone", "Light & curve"], ["colour", "White balance, HSL & preset"], ["detail", "Detail & lens"], ["geometry", "Crop & rotation"], ["masks", "Masks & brush strokes"]].map(([key, label]) => <label className="pe-check" key={key}><input type="checkbox" checked={syncGroups.includes(key)} onChange={(event) => setSyncGroups((current) => event.target.checked ? [...current, key] : current.filter((item) => item !== key))} />{label}</label>)}<p className="pe-muted">{targets.map((item) => item.name).join(", ")}</p></div></Dialog>}
    {dialog === "export" && <Dialog title="Export photos" close={() => setDialog(null)} actions={<><Button onClick={() => setDialog(null)}>Close</Button><Button primary disabled={selected.length < 2 || selected.length > 5 || queue?.status === "running"} onClick={enqueue}>Queue {selected.length} photos</Button></>}><div className="pe-dialog-content"><label className="pe-select">Format<select value={exportSettings.format} onChange={(event) => setExportSettings((current) => ({ ...current, format: event.target.value }))}><option value="JPEG">JPEG · 8-bit</option><option value="TIFF">TIFF · 16-bit</option></select></label><label className="pe-select">Colour profile<select value={exportSettings.profile} onChange={(event) => setExportSettings((current) => ({ ...current, profile: event.target.value }))}>{["sRGB", "Adobe RGB", "Display P3"].map((profile) => <option key={profile}>{profile}</option>)}</select></label><p className="pe-muted">JPEG downloads full-size demo pixels in browser sRGB. TIFF and other profiles are simulated.</p><Button icon="mdiDownloadOutline" onClick={currentExport}>{exportSettings.format === "TIFF" ? "Simulate current TIFF" : "Download current JPEG"}</Button>{exportStatus && <p className="pe-export-status" role="status">{exportStatus}</p>}<hr /><h3>Batch export</h3><p>{selected.length} selected. Choose 2–5 photos in the filmstrip.</p><label className="pe-check"><input type="checkbox" checked={exportSettings.simulateFailure} onChange={(event) => setExportSettings((current) => ({ ...current, simulateFailure: event.target.checked }))} />Simulate one unsupported RAW format</label>{queue && <ExportQueue {...queueActions} />}</div></Dialog>}
  </main>;
}
