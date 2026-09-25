import React, {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Icon } from "./Icon";
import { Button, Dialog } from "./App";
import { PersonAvatar } from "./People";
import { ItemRestoreDialog } from "./FrameleafCloud";
import {
  backupManifests,
  loadCloudState,
  restoreRunActive,
  saveCloudState,
  startRestoreRun,
} from "./frameleaf-cloud-data.mjs";
import {
  viewerAssets,
  viewerCanShare,
  viewerMedia,
  videoSources,
  livePhotoSource,
  slideshowOrder,
  slideshowNeighbor,
  fitDimensions,
  clampPan,
  panoramaLayout,
  clampPanorama,
  panoramaWindow,
  viewerHeadline,
  exposureParts,
  cameraLabel,
  dimensionsLabel,
  megapixels,
  formatFileSize,
  formatDuration,
  folderOf,
  locationLabel,
  osmLink,
  validCoordinate,
  splitDateTime,
  joinDateTime,
  formatCaptureDate,
  timezoneOptions,
  personChipLabel,
  ageAtCapture,
  peopleChips,
  stackMembers,
  stackNeighbor,
  ownerLine,
  sensitivityReview,
  descriptionReview,
  ocrRegions,
  ratingValue,
  albumsForAsset,
  parseViewerPreferences,
  VIEWER_PREFERENCES_KEY,
  normalizeAvailableActions,
  viewerActionGroups,
  SLIDESHOW_TRANSITIONS,
  effectiveTransition,
  kenBurnsMove,
} from "./media-viewer.mjs";
import { prefersReducedMotion } from "./interactions";
import "./media-viewer.css";

const readPreferences = () => {
  try {
    return parseViewerPreferences(localStorage.getItem(VIEWER_PREFERENCES_KEY));
  } catch {
    return parseViewerPreferences(null);
  }
};
const focusable =
  'a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),video[controls],[tabindex="0"]';
const ratingLabel = (value) =>
  value === 0 ? "Not rated" : `${value} ${value === 1 ? "star" : "stars"}`;
const stopKeys = (event) => event.stopPropagation();

function Tool({
  label,
  icon,
  children,
  active,
  className = "",
  title,
  ...props
}) {
  return (
    <button
      type="button"
      className={`mv-tool ${active ? "active" : ""} ${className}`}
      aria-label={label}
      title={title || label}
      {...props}
    >
      {icon && <Icon name={icon} size={21} />}
      {children && <span>{children}</span>}
    </button>
  );
}
/** Arrow-key navigation for a role="menu" container; returns true when handled. */
function menuKeys(event, container, close) {
  const key = event.key;
  if (key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    close();
    return true;
  }
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(key)) return false;
  event.preventDefault();
  event.stopPropagation();
  const items = [
    ...(container?.querySelectorAll('[role="menuitem"]:not(:disabled)') || []),
  ];
  if (!items.length) return true;
  const index = items.indexOf(document.activeElement);
  items[
    key === "Home"
      ? 0
      : key === "End"
        ? items.length - 1
        : (index + (key === "ArrowDown" ? 1 : -1) + items.length) % items.length
  ]?.focus();
  return true;
}
export function MediaViewer({
  assets,
  assetId,
  onClose,
  onNavigateAsset,
  onFavorite,
  onEdit,
  onTrash,
  onShare,
  onAction,
  onUpdate,
  onFaceAction,
  availableActions,
  slideshow = false,
  onSlideshowChange,
  allowLocked = false,
  trash = false,
  albumId = null,
  initialTime = 0,
  onPlaybackChange,
  onTagPeople,
  personProfiles,
  people,
  faces = [],
  albums = [],
  tagOptions = [],
  castDevices = [],
  rating,
  ratings,
  users = [],
  currentUserId = "taylor",
  slideshowTitle = "",
}) {
  const profiles = people || personProfiles || [];
  const collection = viewerAssets(assets, { allowLocked, allowTrashed: trash }),
    asset = collection.find((item) => item.id === assetId),
    media = viewerMedia(asset),
    sources = videoSources(asset),
    liveSource = livePhotoSource(asset),
    available = normalizeAvailableActions(availableActions);
  const ids = collection.map((item) => item.id),
    idsKey = JSON.stringify(ids);
  const [prefs, setPrefs] = useState(readPreferences);
  const [playing, setPlaying] = useState(Boolean(slideshow)),
    [order, setOrder] = useState(() =>
      slideshowOrder(ids, assetId, prefs.order),
    ),
    [direction, setDirection] = useState(1);
  const [showInfo, setShowInfo] = useState(false),
    [settingsOpen, setSettingsOpen] = useState(false),
    [menuOpen, setMenuOpen] = useState(false),
    [ratingOpen, setRatingOpen] = useState(false),
    [castOpen, setCastOpen] = useState(false),
    [chooser, setChooser] = useState(null),
    [confirm, setConfirm] = useState(null),
    [focusRequest, setFocusRequest] = useState(null);
  const [zoom, setZoom] = useState(1),
    [pan, setPan] = useState({ x: 0, y: 0 }),
    [natural, setNatural] = useState(null),
    [viewport, setViewport] = useState({ width: 0, height: 0 }),
    [panorama, setPanorama] = useState(false),
    [videoSource, setVideoSource] = useState("original"),
    [livePlaying, setLivePlaying] = useState(false),
    [highlight, setHighlight] = useState(null),
    [showOcr, setShowOcr] = useState(false),
    [castDevice, setCastDevice] = useState(null);
  const [imageError, setImageError] = useState(null),
    [videoError, setVideoError] = useState(null),
    [error, setError] = useState(""),
    [status, setStatus] = useState(""),
    [manualIds, setManualIds] = useState(() => new Set()),
    [fullscreen, setFullscreen] = useState(false),
    [hidden, setHidden] = useState(
      () => typeof document !== "undefined" && document.hidden,
    );
  // #13 tap hides the controls; a downward swipe at normal zoom closes the viewer.
  const [chromeHidden, setChromeHidden] = useState(false),
    [dragging, setDragging] = useState(false);
  const dismiss = useRef(null),
    titleShown = useRef(false);
  const dialog = useRef(null),
    closeButton = useRef(null),
    stage = useRef(null),
    video = useRef(null),
    menuButton = useRef(null),
    menu = useRef(null),
    ratingButton = useRef(null),
    ratingPopover = useRef(null),
    filmstrip = useRef(null),
    drag = useRef(null),
    timer = useRef(null),
    statusTimer = useRef(null),
    epoch = useRef(0),
    resumeTime = useRef(null),
    pendingNavigation = useRef(null),
    invalidClosed = useRef(null),
    latest = useRef(null),
    alive = useRef(false);
  const stack = stackMembers(collection, asset);
  latest.current = {
    asset,
    collection,
    order,
    playing,
    repeat: prefs.repeat,
    stack,
    onClose,
    onNavigateAsset,
    onSlideshowChange,
    initialTime,
    onPlaybackChange,
  };
  const cancelTimer = () => {
    epoch.current++;
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  function announce(text) {
    if (statusTimer.current) window.clearTimeout(statusTimer.current);
    setStatus(text);
    statusTimer.current = window.setTimeout(() => {
      if (alive.current) setStatus("");
    }, 2800);
  }
  function setPreference(patch) {
    setPrefs((current) => {
      const next = { ...current, ...patch };
      try {
        localStorage.setItem(VIEWER_PREFERENCES_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  }
  function play(value) {
    if (
      value &&
      (!latest.current.onNavigateAsset || latest.current.collection.length < 2)
    )
      return;
    cancelTimer();
    setPlaying(value);
    latest.current.onSlideshowChange?.(value);
  }
  function close() {
    cancelTimer();
    setPlaying(false);
    onSlideshowChange?.(false);
    onClose?.();
  }
  function navigate(id, towards = 1) {
    const live = latest.current;
    if (
      !id ||
      id === live.asset?.id ||
      !live.collection.some((item) => item.id === id) ||
      !live.onNavigateAsset ||
      pendingNavigation.current
    )
      return false;
    cancelTimer();
    setDirection(towards);
    const request = { from: live.asset?.id, to: id };
    pendingNavigation.current = request;
    const failed = () => {
      if (!alive.current || pendingNavigation.current !== request) return;
      pendingNavigation.current = null;
      play(false);
      setError("This item could not be opened. Try again.");
    };
    try {
      const result = live.onNavigateAsset(id);
      if (result === false) {
        failed();
        return false;
      }
      if (result && typeof result.then === "function")
        Promise.resolve(result).then((value) => {
          if (value === false) failed();
        }, failed);
      return true;
    } catch {
      failed();
      return false;
    }
  }
  function step(towards, automatic = false) {
    const live = latest.current;
    if (!live.asset) return;
    const next = slideshowNeighbor(
      live.order,
      live.asset.id,
      towards,
      automatic ? live.repeat : true,
    );
    if (next) navigate(next, towards);
    else if (automatic) play(false);
  }
  function stepStack(towards) {
    const next = stackNeighbor(
      latest.current.stack,
      latest.current.asset?.id,
      towards,
    );
    if (next) navigate(next, towards);
  }
  const stepRef = useRef(step);
  stepRef.current = step;
  useEffect(() => {
    setOrder(slideshowOrder(ids, latest.current.asset?.id, prefs.order));
  }, [idsKey, prefs.order]);
  useEffect(() => {
    setPlaying(Boolean(slideshow));
    cancelTimer();
  }, [slideshow]);
  useEffect(() => {
    pendingNavigation.current = null;
    drag.current = null;
    resumeTime.current = null;
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setNatural(null);
    setImageError(null);
    setVideoError(null);
    setMenuOpen(false);
    setRatingOpen(false);
    setChooser(null);
    setConfirm(null);
    setLivePlaying(false);
    setHighlight(null);
    setShowOcr(false);
    setVideoSource("original");
    setPanorama(Boolean(asset?.isPanorama));
    setError("");
  }, [asset?.id]);
  useEffect(() => {
    if (!asset && invalidClosed.current !== assetId) {
      invalidClosed.current = assetId;
      cancelTimer();
      onSlideshowChange?.(false);
      onClose?.();
    } else if (asset) invalidClosed.current = null;
  }, [asset?.id, assetId]);
  useLayoutEffect(() => {
    if (!asset || !dialog.current) return;
    const element = dialog.current,
      previous = document.activeElement,
      overflow = document.body.style.overflow;
    alive.current = true;
    document.body.style.overflow = "hidden";
    if (typeof element.showModal === "function") {
      try {
        element.showModal();
      } catch {
        element.setAttribute("open", "");
      }
    } else element.setAttribute("open", "");
    closeButton.current?.focus();
    return () => {
      alive.current = false;
      cancelTimer();
      if (statusTimer.current) window.clearTimeout(statusTimer.current);
      try {
        video.current?.pause();
      } catch {}
      if (document.fullscreenElement === element)
        document.exitFullscreen?.().catch?.(() => {});
      document.body.style.overflow = overflow;
      if (previous?.isConnected) previous.focus();
    };
  }, [Boolean(asset)]);
  useEffect(() => {
    const visibility = () => setHidden(document.hidden),
      full = () => setFullscreen(document.fullscreenElement === dialog.current);
    document.addEventListener("visibilitychange", visibility);
    document.addEventListener("fullscreenchange", full);
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      document.removeEventListener("fullscreenchange", full);
    };
  }, []);
  useLayoutEffect(() => {
    const element = stage.current;
    if (!element) return;
    const measure = () =>
      setViewport((current) => {
        const width = element.clientWidth,
          height = element.clientHeight;
        return current.width === width && current.height === height
          ? current
          : { width, height };
      });
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [Boolean(asset), showInfo, prefs.filmstrip]);
  const overlayOpen =
    settingsOpen ||
    menuOpen ||
    ratingOpen ||
    castOpen ||
    !!chooser ||
    !!confirm;
  const activeVideo =
    videoSource === "encoded" ? sources.encoded : sources.original;
  const playable = Boolean(activeVideo && videoError !== activeVideo);
  useEffect(() => {
    cancelTimer();
    if (
      !playing ||
      !asset ||
      hidden ||
      overlayOpen ||
      playable ||
      !onNavigateAsset
    )
      return;
    const token = epoch.current,
      scheduledId = asset.id;
    timer.current = window.setTimeout(() => {
      if (
        epoch.current === token &&
        latest.current.asset?.id === scheduledId &&
        latest.current.playing
      )
        stepRef.current(1, true);
    }, prefs.interval * 1000);
    return cancelTimer;
  }, [
    playing,
    asset?.id,
    idsKey,
    JSON.stringify(order),
    prefs.interval,
    prefs.repeat,
    hidden,
    overlayOpen,
    playable,
    Boolean(onNavigateAsset),
  ]);
  useEffect(() => {
    if (!playable || !video.current) return;
    const element = video.current;
    if (playing && !hidden && !overlayOpen) {
      const result = element.play();
      result?.catch(() => {
        if (
          alive.current &&
          video.current === element &&
          latest.current.asset?.id === asset?.id
        ) {
          setError("Press play on the video to continue.");
          play(false);
        }
      });
    } else element.pause();
  }, [playing, playable, asset?.id, hidden, overlayOpen]);
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    return () => {
      try {
        element.pause();
      } catch {}
    };
  }, [playable, asset?.id, activeVideo]);
  useEffect(() => {
    if (menuOpen)
      menu.current?.querySelector('[role="menuitem"]:not(:disabled)')?.focus();
  }, [menuOpen]);
  useEffect(() => {
    if (ratingOpen) ratingPopover.current?.querySelector("button")?.focus();
  }, [ratingOpen]);
  useEffect(() => {
    if (settingsOpen)
      dialog.current?.querySelector('[aria-label="Photo duration"]')?.focus();
  }, [settingsOpen]);
  useEffect(() => {
    if (!prefs.filmstrip || !filmstrip.current) return;
    filmstrip.current.querySelector('[aria-current="true"]')?.scrollIntoView?.({
      block: "nearest",
      inline: "center",
      behavior: "smooth",
    });
  }, [asset?.id, prefs.filmstrip]);
  useEffect(() => {
    if (!focusRequest || !showInfo) return;
    const target = dialog.current?.querySelector(focusRequest);
    if (target) {
      target.focus();
      setFocusRequest(null);
    }
  }, [focusRequest, showInfo]);
  function setScale(next) {
    play(false);
    setZoom(Math.max(1, Math.min(32, next)));
    setPan({ x: 0, y: 0 });
  }
  function startPan(event) {
    if (
      zoom <= 1 &&
      event.button <= 0 &&
      !event.target.closest?.("button,video,a,input,select,textarea")
    ) {
      dismiss.current = {
        x: event.clientX,
        y: event.clientY,
        time: performance.now(),
        dy: 0,
      };
      return;
    }
    if (
      zoom <= 1 ||
      event.button > 0 ||
      event.target.closest?.("button,video,a")
    )
      return;
    drag.current = { x: event.clientX, y: event.clientY, pan };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }
  function trackDismiss(event) {
    const gesture = dismiss.current;
    if (!gesture) return false;
    gesture.dy = Math.max(0, event.clientY - gesture.y);
    if (gesture.dy < 8) return true;
    if (!dragging) setDragging(true);
    const progress = Math.min(1, gesture.dy / 400);
    stage.current.style.transform = `translate(${(event.clientX - gesture.x) * 0.5}px, ${gesture.dy}px) scale(${1 - progress * 0.25})`;
    dialog.current.style.backgroundColor = `rgb(0 0 0 / ${1 - progress})`;
    return true;
  }
  function endDismiss(event) {
    const gesture = dismiss.current;
    dismiss.current = null;
    if (!gesture) return;
    setDragging(false);
    stage.current.style.transform = "";
    dialog.current.style.backgroundColor = "";
    const moved = Math.hypot(
      event.clientX - gesture.x,
      event.clientY - gesture.y,
    );
    if (gesture.dy > 110) close();
    else if (moved < 6 && performance.now() - gesture.time < 280)
      setChromeHidden((value) => !value);
  }
  function movePan(event) {
    if (trackDismiss(event)) return;
    if (!drag.current) return;
    const dimensions = fitDimensions(
      natural?.width,
      natural?.height,
      viewport.width || 1,
      viewport.height || 1,
    );
    setPan(
      clampPan(
        {
          x: drag.current.pan.x + event.clientX - drag.current.x,
          y: drag.current.pan.y + event.clientY - drag.current.y,
        },
        dimensions,
        { width: viewport.width || 1, height: viewport.height || 1 },
        zoom,
      ),
    );
  }
  async function action(callback, ...args) {
    const actingId = latest.current.asset?.id;
    if (!actingId || typeof callback !== "function") return false;
    play(false);
    setMenuOpen(false);
    setRatingOpen(false);
    const failed = () => {
      if (alive.current && latest.current.asset?.id === actingId)
        setError("The action could not be completed. Try again.");
    };
    try {
      if ((await callback(...args)) === false) {
        failed();
        return false;
      }
      return true;
    } catch {
      failed();
      return false;
    }
  }
  const run = (id, payload) =>
    asset && onAction && available.includes(id)
      ? action(onAction, id, asset.id, payload)
      : Promise.resolve(false);
  const update = async (patch, message = "Saved") => {
    if (!asset || !onUpdate) return false;
    const ok = await action(onUpdate, asset.id, patch);
    if (ok && message) announce(message);
    return ok;
  };
  async function rate(value) {
    if (!canEdit) return;
    const next = ratingValue(value);
    if ((await update({ rating: next }, "")) !== false)
      announce(next ? `Rated ${ratingLabel(next)}` : "Rating cleared");
  }
  function menuChoice(item) {
    setMenuOpen(false);
    menuButton.current?.focus();
    if (item.chooser) setChooser({ kind: item.chooser, actionId: item.id });
    else if (item.id === "delete-permanently") setConfirm("delete-permanently");
    else if (item.id === "copy-image") copyImage();
    else run(item.id, item.payload);
  }
  async function copyImage() {
    if (!asset || !media.image) return;
    play(false);
    let copied = false;
    try {
      if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write)
        throw new Error("unsupported");
      const image = new Image();
      image.crossOrigin = "anonymous";
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = reject;
        image.src = media.image;
      });
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      canvas.getContext("2d").drawImage(image, 0, 0);
      const blob = await new Promise((resolve, reject) =>
        canvas.toBlob(
          (value) => (value ? resolve(value) : reject()),
          "image/png",
        ),
      );
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": blob }),
      ]);
      copied = true;
      announce("Image copied");
    } catch {
      setError(
        "Copying images is not available here. Download the photo instead.",
      );
    }
    if (onAction && available.includes("copy-image"))
      try {
        await onAction("copy-image", asset.id, { copied });
      } catch {}
  }
  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement === dialog.current)
        await document.exitFullscreen?.();
      else await dialog.current?.requestFullscreen?.();
    } catch {
      setError("Full screen is unavailable in this window.");
    }
  }
  function switchVideoSource(next) {
    if (next === videoSource || !sources[next]) return;
    resumeTime.current = video.current?.currentTime || 0;
    setVideoError(null);
    setVideoSource(next);
  }
  function toggleVideoPlayback() {
    const element = video.current;
    if (!element) return;
    if (element.paused) element.play()?.catch?.(() => {});
    else element.pause();
  }
  function keyDown(event) {
    if (
      event.defaultPrevented ||
      event.repeat ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey
    )
      return;
    const top = [
      ...document.querySelectorAll('dialog[open],[role="dialog"]'),
    ].at(-1);
    if (top && top !== dialog.current) return;
    if (event.key === "Tab") {
      const elements = [...dialog.current.querySelectorAll(focusable)].filter(
        (el) => !el.closest("[hidden]"),
      );
      const first = elements[0],
        last = elements.at(-1);
      if (
        event.shiftKey &&
        (document.activeElement === first ||
          document.activeElement === dialog.current)
      ) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      if (menuOpen) {
        setMenuOpen(false);
        menuButton.current?.focus();
      } else if (ratingOpen) {
        setRatingOpen(false);
        ratingButton.current?.focus();
      } else if (settingsOpen) {
        setSettingsOpen(false);
        dialog.current
          ?.querySelector('.mv-footer [aria-label="Slideshow settings"]')
          ?.focus();
      } else if (fullscreen) document.exitFullscreen?.().catch?.(() => {});
      else close();
      return;
    }
    if (
      event.target.closest?.(
        'input,select,textarea,[contenteditable="true"],video,[role="slider"],[role="combobox"]',
      )
    )
      return;
    if (event.shiftKey) {
      if (event.key === "A" && canEdit && !trash) {
        event.preventDefault();
        run(archived ? "unarchive" : "archive");
      } else if (event.key === "D") {
        event.preventDefault();
        run("download");
      } else if (event.key === "F") {
        event.preventDefault();
        setPreference({ filmstrip: !prefs.filmstrip });
      } else if (event.key === "Delete" && canEdit) {
        event.preventDefault();
        if (available.includes("delete-permanently"))
          setConfirm("delete-permanently");
      }
      return;
    }
    const key = event.key.toLowerCase();
    if (key === "arrowright" || key === "arrowleft") {
      event.preventDefault();
      step(key === "arrowright" ? 1 : -1);
    } else if (key === "arrowup" || key === "arrowdown") {
      if (stack.length > 1) {
        event.preventDefault();
        stepStack(key === "arrowdown" ? 1 : -1);
      }
    } else if (key === " " && event.target.tagName !== "BUTTON") {
      event.preventDefault();
      if (playable) toggleVideoPlayback();
      else play(!playing);
    } else if (key === "s") {
      event.preventDefault();
      play(!playing);
    } else if (key === "i") {
      event.preventDefault();
      play(false);
      setShowInfo((value) => !value);
    } else if (key === "f" && onFavorite && !readOnly) {
      event.preventDefault();
      action(onFavorite, asset.id);
    } else if (key === "e" && onEdit && !readOnly) {
      event.preventDefault();
      action(onEdit, asset.id, {
        currentTime: video.current?.currentTime || 0,
      });
    } else if (key === "l" && canEdit && !trash) {
      event.preventDefault();
      run("add-to-album");
    } else if (key === "t" && canEdit) {
      event.preventDefault();
      play(false);
      setShowInfo(true);
      setFocusRequest('[data-mv-focus="tags"]');
    } else if (key === "p" && onTagPeople && !readOnly) {
      event.preventDefault();
      action(onTagPeople, asset.id);
    } else if (key === "delete" || key === "backspace") {
      if (!canEdit) return;
      event.preventDefault();
      if (trash) setConfirm("delete-permanently");
      else if (onTrash) action(onTrash, asset.id);
    } else if (/^[1-5]$/.test(key)) {
      event.preventDefault();
      rate(Number(key));
    } else if (key === "0") {
      event.preventDefault();
      if (zoom !== 1) setScale(1);
      else rate(0);
    } else if ((key === "+" || key === "=") && !media.isVideo && !panorama) {
      event.preventDefault();
      setScale(zoom * 1.25);
    } else if (key === "-" && !media.isVideo && !panorama) {
      event.preventDefault();
      setScale(zoom / 1.25);
    } else if (key === "z" && !media.isVideo && !panorama) {
      event.preventDefault();
      setScale(zoom === 1 ? 2 : 1);
    }
  }
  // Memories opens with a title card, once per run.
  const [showTitleCard, setShowTitleCard] = useState(false);
  const memoriesOn =
    playing &&
    effectiveTransition(prefs.transition, prefersReducedMotion()) ===
      "memories";
  useEffect(() => {
    if (!memoriesOn) {
      titleShown.current = false;
      setShowTitleCard(false);
      return;
    }
    if (titleShown.current) return;
    titleShown.current = true;
    setShowTitleCard(true);
    const timer = setTimeout(() => setShowTitleCard(false), 3200);
    return () => clearTimeout(timer);
  }, [memoriesOn]);
  const memoriesSubtitle = (() => {
    const dates = collection
      .map((item) => item.date)
      .filter(Boolean)
      .sort();
    return dates.length
      ? dates[0] === dates.at(-1)
        ? dates[0]
        : `${dates[0]} – ${dates.at(-1)}`
      : "";
  })();
  // #6 keep the screen awake while a slideshow plays.
  useEffect(() => {
    if (!playing || !navigator.wakeLock) return;
    let sentinel = null,
      released = false;
    const request = () =>
      navigator.wakeLock
        .request("screen")
        .then((lock) => {
          if (released) lock.release();
          else sentinel = lock;
        })
        .catch(() => {});
    request();
    const visibility = () =>
      document.visibilityState === "visible" && request();
    document.addEventListener("visibilitychange", visibility);
    return () => {
      released = true;
      document.removeEventListener("visibilitychange", visibility);
      sentinel?.release().catch(() => {});
    };
  }, [playing]);
  // #7 lock screen, Control Center, headphones and media keys.
  useEffect(() => {
    if (
      !asset ||
      !("mediaSession" in navigator) ||
      typeof MediaMetadata !== "function"
    )
      return;
    const session = navigator.mediaSession;
    session.metadata = new MediaMetadata({
      title: asset.name || "Photo",
      artist: slideshowTitle || "Frameleaf",
      album: [asset.date, asset.city].filter(Boolean).join(" · "),
      artwork: media.image ? [{ src: media.image, sizes: "512x512" }] : [],
    });
    const handlers = {
      play: () => play(true),
      pause: () => play(false),
      previoustrack: () => step(-1),
      nexttrack: () => step(1),
    };
    for (const [action, handler] of Object.entries(handlers)) {
      try {
        session.setActionHandler(action, handler);
      } catch {}
    }
    if (!media.isVideo) session.playbackState = playing ? "playing" : "paused";
    return () => {
      for (const action of Object.keys(handlers)) {
        try {
          session.setActionHandler(action, null);
        } catch {}
      }
    };
  }, [asset?.id, media.image, playing]);
  if (!asset) return null;
  const index = collection.findIndex((item) => item.id === asset.id),
    readOnly = asset.readOnly === true || asset.canEdit === false,
    canEdit = !readOnly && typeof onUpdate === "function",
    archived = asset.visibility === "archive" || asset.isArchived === true,
    favorite = Boolean(asset.favorite || asset.isFavorite);
  const currentRating = ratingValue(
    rating ??
      (typeof ratings === "function"
        ? ratings(asset.id)
        : ratings?.[asset.id]) ??
      asset.rating,
  );
  const assetAlbums = albumsForAsset(albums, asset);
  const groups = onAction
    ? viewerActionGroups(asset, {
        available,
        trash,
        albumId,
        albumCount: assetAlbums.length,
        peopleCount: peopleChips({
          faces,
          people: profiles,
          personIds: asset.personIds || [],
        }).chips.filter((chip) => chip.person).length,
        readOnly,
      })
    : [];
  const position = `${index + 1} of ${collection.length}`,
    name = asset.name || asset.originalFileName || "Photo",
    headline = viewerHeadline(asset).join(" · "),
    lookActive = playing || settingsOpen,
    look = lookActive ? prefs.look : "fit",
    fit = fitDimensions(
      natural?.width,
      natural?.height,
      viewport.width,
      viewport.height,
    ),
    activeTransition = effectiveTransition(
      prefs.transition,
      prefersReducedMotion(),
    ),
    transitionClass =
      playing && activeTransition !== "none"
        ? activeTransition === "fade"
          ? "fade"
          : activeTransition === "slide"
            ? direction < 0
              ? "slide-prev"
              : "slide-next"
            : `fade ${activeTransition}`
        : "",
    kenBurns =
      playing &&
      ["ken-burns", "memories"].includes(activeTransition) &&
      !media.isVideo;
  const ocrBoxes = showOcr && asset.ocr ? ocrRegions(asset.ocr) : [];
  const stackOpen = stack.length > 1;
  return (
    <dialog
      ref={dialog}
      className={`media-viewer ${chromeHidden ? "chrome-hidden" : ""} ${dragging ? "dragging" : ""}`}
      aria-label={`Media viewer: ${name}`}
      onKeyDown={keyDown}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        className={`mv-shell ${showInfo ? "with-info" : ""} ${prefs.filmstrip ? "with-filmstrip" : ""}`}
      >
        <header className="mv-header">
          <button
            className="mv-tool mv-close"
            type="button"
            ref={closeButton}
            aria-label="Close viewer"
            title="Close viewer (Escape)"
            onClick={close}
          >
            <Icon name="mdiArrowLeft" size={21} />
          </button>
          <div className="mv-title">
            <strong>
              {name}
              <small>
                {position}
                {media.isVideo
                  ? " · Video"
                  : asset.isLivePhoto
                    ? " · Live"
                    : ""}
                {asset.isPanorama ? " · Panorama" : ""}
              </small>
            </strong>
            {headline && <span>{headline}</span>}
          </div>
          <div className="mv-actions" aria-label="Media actions">
            {onShare && viewerCanShare(asset) && !trash && (
              <Tool
                label="Share"
                icon="mdiShareVariantOutline"
                onClick={() => action(onShare, asset.id)}
              />
            )}
            {onAction &&
              available.includes("cast") &&
              castDevices.length > 0 &&
              !trash && (
                <Tool
                  label={castDevice ? "Cast · connected" : "Cast"}
                  icon={castDevice ? "mdiCastConnected" : "mdiCast"}
                  active={Boolean(castDevice)}
                  onClick={() => {
                    play(false);
                    setCastOpen(true);
                  }}
                />
              )}
            {!media.isVideo &&
              media.image &&
              available.includes("copy-image") && (
                <Tool
                  label="Copy image"
                  icon="mdiContentCopy"
                  className="mv-wide-only"
                  onClick={copyImage}
                />
              )}
            <Tool
              label="Information"
              title="Information (I)"
              icon="mdiInformationOutline"
              active={showInfo}
              aria-pressed={showInfo}
              onClick={() => {
                play(false);
                setShowInfo((value) => !value);
              }}
            />
            {onFavorite && !readOnly && !trash && (
              <Tool
                label={favorite ? "Remove from favorites" : "Add to favorites"}
                title={`${favorite ? "Remove from favorites" : "Add to favorites"} (F)`}
                icon={favorite ? "mdiHeart" : "mdiHeartOutline"}
                active={favorite}
                aria-pressed={favorite}
                onClick={() => action(onFavorite, asset.id)}
              />
            )}
            {canEdit && !trash && (
              <div className="mv-menu-wrap">
                <Tool
                  ref={ratingButton}
                  label={`Rating · ${ratingLabel(currentRating)}`}
                  icon={currentRating ? "mdiStar" : "mdiStarOutline"}
                  active={ratingOpen || currentRating > 0}
                  aria-haspopup="true"
                  aria-expanded={ratingOpen}
                  onClick={() => {
                    play(false);
                    setMenuOpen(false);
                    setRatingOpen((value) => !value);
                  }}
                />
                {ratingOpen && (
                  <div
                    className="mv-popover mv-rating-popover"
                    role="group"
                    aria-label="Rate this item"
                    ref={ratingPopover}
                    onKeyDown={(event) => {
                      if (["ArrowRight", "ArrowLeft"].includes(event.key)) {
                        event.preventDefault();
                        event.stopPropagation();
                        const buttons = [
                          ...ratingPopover.current.querySelectorAll("button"),
                        ];
                        const i = buttons.indexOf(document.activeElement);
                        buttons[
                          (i +
                            (event.key === "ArrowRight" ? 1 : -1) +
                            buttons.length) %
                            buttons.length
                        ]?.focus();
                      }
                    }}
                  >
                    <RatingStars
                      value={currentRating}
                      onRate={(value) => {
                        setRatingOpen(false);
                        ratingButton.current?.focus();
                        rate(value);
                      }}
                    />
                  </div>
                )}
              </div>
            )}
            {onEdit && !readOnly && !trash && (
              <Tool
                label="Edit"
                title="Edit (E)"
                icon="mdiPencilOutline"
                onClick={() =>
                  action(onEdit, asset.id, {
                    currentTime: video.current?.currentTime || 0,
                  })
                }
              />
            )}
            {trash ? (
              <>
                {available.includes("restore") && !readOnly && (
                  <Tool
                    label="Restore"
                    icon="mdiDeleteRestore"
                    onClick={() => run("restore")}
                  />
                )}
                {available.includes("delete-permanently") && !readOnly && (
                  <Tool
                    label="Delete permanently"
                    icon="mdiDeleteForeverOutline"
                    className="danger"
                    onClick={() => setConfirm("delete-permanently")}
                  />
                )}
              </>
            ) : (
              onTrash &&
              !readOnly && (
                <Tool
                  label="Move to trash"
                  title="Move to trash (Delete)"
                  icon="mdiDeleteOutline"
                  onClick={() => action(onTrash, asset.id)}
                />
              )
            )}
            <div className="mv-menu-wrap">
              <button
                ref={menuButton}
                className={`mv-tool ${menuOpen ? "active" : ""}`}
                type="button"
                aria-label="More actions"
                title="More actions"
                aria-expanded={menuOpen}
                aria-haspopup="menu"
                onClick={() => {
                  setRatingOpen(false);
                  setMenuOpen((value) => !value);
                }}
              >
                <Icon name="mdiDotsHorizontal" size={21} />
              </button>
              {menuOpen && (
                <div
                  className="mv-menu"
                  role="menu"
                  aria-label="More actions"
                  ref={menu}
                  onKeyDown={(event) =>
                    menuKeys(event, menu.current, () => {
                      setMenuOpen(false);
                      menuButton.current?.focus();
                    })
                  }
                >
                  {groups.map((group) => (
                    <div role="group" aria-label={group.label} key={group.id}>
                      <div className="mv-menu-label" aria-hidden="true">
                        {group.label}
                      </div>
                      {group.items.map((item) => (
                        <button
                          type="button"
                          key={item.id}
                          role="menuitem"
                          className={item.danger ? "danger" : ""}
                          onClick={() => menuChoice(item)}
                        >
                          <Icon name={item.icon} size={17} />
                          {item.label}
                        </button>
                      ))}
                    </div>
                  ))}
                  <div role="group" aria-label="Viewer">
                    <div className="mv-menu-label" aria-hidden="true">
                      Viewer
                    </div>
                    {onTagPeople && !readOnly && !trash && (
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => action(onTagPeople, asset.id)}
                      >
                        <Icon name="mdiAccountPlusOutline" size={17} />
                        Tag people
                      </button>
                    )}
                    {onAction &&
                      available.includes("cast") &&
                      castDevices.length > 0 && (
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setMenuOpen(false);
                            play(false);
                            setCastOpen(true);
                          }}
                        >
                          <Icon name="mdiCast" size={17} />
                          Cast
                        </button>
                      )}
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false);
                        setPreference({ filmstrip: !prefs.filmstrip });
                      }}
                    >
                      <Icon name="mdiFilmstrip" size={17} />
                      {prefs.filmstrip ? "Hide filmstrip" : "Show filmstrip"}
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      disabled={!onNavigateAsset || collection.length < 2}
                      onClick={() => {
                        setMenuOpen(false);
                        play(!playing);
                      }}
                    >
                      <Icon
                        name={playing ? "mdiPause" : "mdiPlayCircleOutline"}
                        size={17}
                      />
                      {playing ? "Pause slideshow" : "Play slideshow"}
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false);
                        setSettingsOpen(true);
                      }}
                    >
                      <Icon name="mdiCogOutline" size={17} />
                      Slideshow settings
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </header>
        <main
          className={`mv-canvas ${look === "blur" ? "blurred" : ""}`}
          ref={stage}
          tabIndex={0}
          aria-label={
            media.isVideo ? "Video viewing area" : "Image viewing area"
          }
          onPointerDown={startPan}
          onPointerMove={movePan}
          onPointerUp={(event) => {
            drag.current = null;
            endDismiss(event);
          }}
          onPointerCancel={() => {
            drag.current = null;
            dismiss.current = null;
            setDragging(false);
            stage.current.style.transform = "";
            dialog.current.style.backgroundColor = "";
          }}
          onDoubleClick={(event) => {
            if (
              !media.isVideo &&
              !panorama &&
              !event.target.closest?.("button,a")
            )
              setScale(zoom === 1 ? 2 : 1);
          }}
          style={{
            cursor: zoom > 1 ? "grab" : undefined,
            touchAction: zoom > 1 ? "none" : "pan-y",
          }}
        >
          {asset.isOffline && (
            <div className="mv-offline" role="alert">
              <Icon name="mdiLinkOff" size={18} />
              <div>
                <strong>Original file unavailable</strong>
                <span>
                  {asset.originalPath ||
                    "The file could not be found in its library."}
                </span>
              </div>
              {onAction && available.includes("open-folder") && (
                <button
                  type="button"
                  className="mv-inline-button"
                  onClick={() => run("open-folder")}
                >
                  Relink
                </button>
              )}
            </div>
          )}
          {look === "blur" && media.image && (
            <div
              className="mv-blur"
              style={{ backgroundImage: `url("${media.image}")` }}
              aria-hidden="true"
            />
          )}
          {playing &&
            activeTransition === "memories" &&
            look !== "blur" &&
            media.image && (
              <div
                className="mv-blur"
                style={{ backgroundImage: `url("${media.image}")` }}
                aria-hidden="true"
              />
            )}
          <div
            className={`mv-stage-item ${transitionClass}`}
            key={`${asset.id}:${transitionClass}`}
            style={
              kenBurns
                ? {
                    "--kb-from": kenBurnsMove(asset.id).from,
                    "--kb-to": kenBurnsMove(asset.id).to,
                    "--kb-duration": `${prefs.interval + 1}s`,
                  }
                : undefined
            }
          >
            {playable ? (
              <video
                key={`${asset.id}:${activeVideo}`}
                ref={video}
                src={activeVideo}
                poster={media.image || undefined}
                controls
                playsInline
                preload="metadata"
                aria-label={name}
                onLoadedMetadata={(event) => {
                  if (latest.current.asset?.id !== asset.id) return;
                  const time =
                    resumeTime.current !== null
                      ? resumeTime.current
                      : Number(latest.current.initialTime);
                  resumeTime.current = null;
                  if (Number.isFinite(time) && time >= 0)
                    event.currentTarget.currentTime = Math.min(
                      time,
                      Number.isFinite(event.currentTarget.duration)
                        ? event.currentTarget.duration
                        : time,
                    );
                }}
                onTimeUpdate={(event) => {
                  if (latest.current.asset?.id === asset.id)
                    latest.current.onPlaybackChange?.(
                      asset.id,
                      event.currentTarget.currentTime,
                    );
                }}
                onPause={(event) => {
                  if (latest.current.asset?.id === asset.id)
                    latest.current.onPlaybackChange?.(
                      asset.id,
                      event.currentTarget.currentTime,
                    );
                }}
                onEnded={() => {
                  if (
                    latest.current.playing &&
                    latest.current.asset?.id === asset.id
                  )
                    stepRef.current(1, true);
                }}
                onError={() => {
                  if (latest.current.asset?.id !== asset.id) return;
                  setVideoError(activeVideo);
                  setError(
                    "This video could not be played. Its preview is still available.",
                  );
                }}
              />
            ) : media.image && imageError !== media.image ? (
              panorama ? (
                <PanoramaStage
                  key={asset.id}
                  src={media.image}
                  alt={name}
                  natural={natural}
                  viewport={viewport}
                  onNatural={(size) => {
                    if (latest.current.asset?.id === asset.id) setNatural(size);
                  }}
                  onError={() => {
                    if (latest.current.asset?.id === asset.id)
                      setImageError(media.image);
                  }}
                />
              ) : (
                <div
                  className={`mv-photo ${look === "fill" ? "fill" : ""} ${fit && look !== "fill" ? "measured" : ""}`}
                  style={{
                    ...(fit && look !== "fill"
                      ? { width: fit.width, height: fit.height }
                      : {}),
                    transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                  }}
                >
                  <img
                    key={`${asset.id}:${media.image}`}
                    className="mv-image"
                    src={media.image}
                    alt={name}
                    draggable="false"
                    onLoad={(event) => {
                      if (latest.current.asset?.id === asset.id)
                        setNatural({
                          width: event.currentTarget.naturalWidth,
                          height: event.currentTarget.naturalHeight,
                        });
                    }}
                    onError={() => {
                      if (latest.current.asset?.id === asset.id)
                        setImageError(media.image);
                    }}
                  />
                  {liveSource && livePlaying && (
                    <video
                      className="mv-live-video"
                      src={liveSource}
                      autoPlay
                      muted
                      playsInline
                      aria-label={`${name} live clip`}
                      onEnded={() => setLivePlaying(false)}
                      onError={() => {
                        setLivePlaying(false);
                        setError("The live clip could not be played.");
                      }}
                    />
                  )}
                  {highlight?.box && (
                    <div
                      className="mv-face-box"
                      style={{
                        left: `${highlight.box.x * 100}%`,
                        top: `${highlight.box.y * 100}%`,
                        width: `${highlight.box.width * 100}%`,
                        height: `${highlight.box.height * 100}%`,
                      }}
                    >
                      <span>{highlight.label}</span>
                    </div>
                  )}
                  {ocrBoxes.map((box) => (
                    <div
                      className="mv-ocr-box"
                      key={box.id}
                      title={box.text}
                      style={{
                        left: `${box.x * 100}%`,
                        top: `${box.y * 100}%`,
                        width: `${box.width * 100}%`,
                        height: `${box.height * 100}%`,
                      }}
                    />
                  ))}
                </div>
              )
            ) : (
              <div className="mv-unavailable">
                <strong>Image unavailable</strong>
                <span>
                  The source could not be displayed. Try another item.
                </span>
              </div>
            )}
          </div>
          {liveSource &&
            !playable &&
            media.image &&
            imageError !== media.image &&
            !panorama && (
              <button
                type="button"
                className={`mv-live-badge ${livePlaying ? "playing" : ""}`}
                aria-pressed={livePlaying}
                aria-label={livePlaying ? "Stop live clip" : "Play live clip"}
                title="Live photo · hover or press to play"
                onPointerEnter={(event) => {
                  if (event.pointerType === "mouse") setLivePlaying(true);
                }}
                onPointerLeave={(event) => {
                  if (event.pointerType === "mouse") setLivePlaying(false);
                }}
                onClick={() => setLivePlaying((value) => !value)}
              >
                <Icon name="mdiMotionPlayOutline" size={16} />
                Live
              </button>
            )}
          {media.isVideo &&
            !playable &&
            media.image &&
            imageError !== media.image && (
              <div className="mv-still-label">
                Video preview · playback source unavailable
              </div>
            )}
          {collection.length > 1 && onNavigateAsset && (
            <>
              <Tool
                label="Previous item"
                icon="mdiChevronLeft"
                className="mv-side previous"
                onClick={() => step(-1)}
              />
              <Tool
                label="Next item"
                icon="mdiChevronRight"
                className="mv-side next"
                onClick={() => step(1)}
              />
            </>
          )}
          {playing && activeTransition === "memories" && showTitleCard && (
            <div className="mv-title-card" aria-hidden="true">
              <h2>{slideshowTitle || "Memories"}</h2>
              <p>{memoriesSubtitle}</p>
            </div>
          )}
          {playing && activeTransition === "memories" && !showTitleCard && (
            <div className="mv-lower-third" key={asset.id} aria-hidden="true">
              <strong>{asset.city || slideshowTitle}</strong>
              <span>{asset.date}</span>
            </div>
          )}
          {playing &&
            prefs.caption !== "off" &&
            (asset.description || prefs.caption === "details") && (
              <div className="mv-caption">
                <strong>{asset.description || name}</strong>
                {prefs.caption === "details" && (
                  <span>
                    {[
                      formatCaptureDate(asset.takenAt || asset.date).date,
                      locationLabel(asset),
                      cameraLabel(asset),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                )}
              </div>
            )}
          {playing && prefs.progress && !playable && (
            <div
              className="mv-progress"
              aria-hidden="true"
              key={`${asset.id}:${prefs.interval}`}
            >
              <span style={{ animationDuration: `${prefs.interval}s` }} />
            </div>
          )}
          {stackOpen && (
            <StackStrip
              members={stack}
              currentId={asset.id}
              onPick={(id) =>
                navigate(
                  id,
                  stack.findIndex((m) => m.id === id) >
                    stack.findIndex((m) => m.id === asset.id)
                    ? 1
                    : -1,
                )
              }
            />
          )}
        </main>
        {prefs.filmstrip && (
          <nav className="mv-filmstrip" aria-label="Filmstrip" ref={filmstrip}>
            {collection.map((item) => {
              const thumb = viewerMedia(item).image;
              return (
                <button
                  type="button"
                  key={item.id}
                  aria-current={item.id === asset.id ? "true" : undefined}
                  aria-label={item.name || item.originalFileName || "Item"}
                  title={item.name || item.originalFileName || "Item"}
                  onClick={() =>
                    navigate(item.id, collection.indexOf(item) > index ? 1 : -1)
                  }
                >
                  {thumb ? (
                    <img src={thumb} alt="" loading="lazy" draggable="false" />
                  ) : (
                    <Icon name="mdiImageOutline" size={20} />
                  )}
                  {viewerMedia(item).isVideo && (
                    <Icon
                      name="mdiPlay"
                      size={14}
                      className="mv-filmstrip-badge"
                    />
                  )}
                </button>
              );
            })}
          </nav>
        )}
        {showInfo && (
          <InfoPanel
            asset={asset}
            name={name}
            media={media}
            readOnly={readOnly}
            canEdit={canEdit}
            trash={trash}
            available={available}
            onAction={onAction}
            onUpdate={onUpdate}
            onFaceAction={onFaceAction}
            onTagPeople={onTagPeople}
            run={run}
            update={update}
            action={action}
            announce={announce}
            rating={currentRating}
            onRate={rate}
            faces={faces}
            profiles={profiles}
            albums={assetAlbums}
            tagOptions={tagOptions}
            users={users}
            currentUserId={currentUserId}
            manual={manualIds.has(asset.id)}
            onManual={() =>
              setManualIds((current) => new Set(current).add(asset.id))
            }
            highlight={highlight}
            onHighlight={setHighlight}
            showOcr={showOcr}
            onShowOcr={setShowOcr}
            onClose={() => setShowInfo(false)}
            onPause={() => play(false)}
          />
        )}
        <footer className="mv-footer">
          <div className="mv-playback">
            <Tool
              label={playing ? "Pause slideshow" : "Play slideshow"}
              title={`${playing ? "Pause" : "Play"} slideshow (S)`}
              icon={playing ? "mdiPause" : "mdiPlay"}
              disabled={!onNavigateAsset || collection.length < 2}
              aria-pressed={playing}
              onClick={() => {
                setZoom(1);
                setPan({ x: 0, y: 0 });
                play(!playing);
              }}
            />
            <span aria-live="polite" className="mv-position">
              {position}
            </span>
            <Tool
              label="Slideshow settings"
              icon="mdiCogOutline"
              active={settingsOpen}
              aria-expanded={settingsOpen}
              onClick={() => setSettingsOpen((value) => !value)}
            />
            <Tool
              label={prefs.filmstrip ? "Hide filmstrip" : "Show filmstrip"}
              title={`${prefs.filmstrip ? "Hide" : "Show"} filmstrip (Shift+F)`}
              icon="mdiFilmstrip"
              active={prefs.filmstrip}
              aria-pressed={prefs.filmstrip}
              onClick={() => setPreference({ filmstrip: !prefs.filmstrip })}
            />
          </div>
          <span className="mv-key-hint">
            ← → Browse{" "}
            {stackOpen && (
              <>
                <span>·</span> ↑ ↓ Stack{" "}
              </>
            )}
            <span>·</span> I Info <span>·</span> Esc Close
          </span>
          <div className="mv-zoom">
            {media.isVideo && sources.original && (
              <div
                className="mv-segment"
                role="group"
                aria-label="Video source"
              >
                <button
                  type="button"
                  aria-pressed={videoSource === "original"}
                  onClick={() => switchVideoSource("original")}
                >
                  Play original
                </button>
                <button
                  type="button"
                  aria-pressed={videoSource === "encoded"}
                  onClick={() => switchVideoSource("encoded")}
                  title={
                    sources.hasEncoded
                      ? "Encoded rendition"
                      : "Encoded rendition · same source in this preview"
                  }
                >
                  Play encoded
                </button>
              </div>
            )}
            {asset.isPanorama && !media.isVideo && (
              <Tool
                label={panorama ? "Fit panorama" : "Look around panorama"}
                icon={panorama ? "mdiPanoramaVariantOutline" : "mdiPanorama"}
                active={panorama}
                aria-pressed={panorama}
                onClick={() => {
                  setScale(1);
                  setPanorama((value) => !value);
                }}
              />
            )}
            {!media.isVideo && !panorama && (
              <>
                <Tool
                  label="Zoom out"
                  icon="mdiMagnifyMinusOutline"
                  disabled={zoom <= 1}
                  onClick={() => setScale(zoom / 1.25)}
                />
                <button
                  type="button"
                  className="mv-fit"
                  onClick={() => setScale(1)}
                  title="Fit image to window"
                >
                  {zoom === 1 ? "Fit" : `${Math.round(zoom * 100)}% of fit`}
                </button>
                <Tool
                  label="Zoom in"
                  icon="mdiMagnifyPlusOutline"
                  disabled={zoom >= 32}
                  onClick={() => setScale(zoom * 1.25)}
                />
              </>
            )}
            <Tool
              label={fullscreen ? "Exit full screen" : "Enter full screen"}
              icon={fullscreen ? "mdiFullscreenExit" : "mdiFullscreen"}
              disabled={
                !dialog.current?.requestFullscreen &&
                !(typeof document !== "undefined" && document.fullscreenEnabled)
              }
              onClick={toggleFullscreen}
            />
          </div>
        </footer>
        {settingsOpen && (
          <SlideshowSettings
            prefs={prefs}
            onChange={setPreference}
            onClose={() => setSettingsOpen(false)}
          />
        )}
        {error && (
          <div className="mv-error" role="alert">
            <span>{error}</span>
            <Tool
              label="Dismiss viewer message"
              icon="mdiClose"
              onClick={() => setError("")}
            />
          </div>
        )}
        <div className="mv-status" role="status" aria-live="polite">
          {status && (
            <span>
              <Icon name="mdiCheck" size={15} />
              {status}
            </span>
          )}
        </div>
        {castOpen && (
          <CastDialog
            devices={castDevices}
            connected={castDevice}
            close={() => setCastOpen(false)}
            onConnect={async (deviceId) => {
              if ((await run("cast", { deviceId })) !== false) {
                setCastDevice(deviceId);
                announce(deviceId ? "Casting" : "Cast ended");
              }
            }}
          />
        )}
        {chooser && (
          <ChooserDialog
            kind={chooser.kind}
            albums={assetAlbums}
            people={peopleChips({
              faces,
              people: profiles,
              personIds: asset.personIds || [],
            })
              .chips.filter((chip) => chip.person)
              .map((chip) => chip.person)}
            close={() => setChooser(null)}
            onPick={(payload) => {
              setChooser(null);
              run(chooser.actionId, payload);
            }}
          />
        )}
        {confirm === "delete-permanently" && (
          <Dialog
            title="Delete permanently?"
            close={() => setConfirm(null)}
            actions={
              <>
                <Button onClick={() => setConfirm(null)}>Keep</Button>
                <Button
                  primary
                  className="mv-danger-button"
                  data-initial-focus
                  onClick={() => {
                    setConfirm(null);
                    run("delete-permanently");
                  }}
                >
                  Delete permanently
                </Button>
              </>
            }
          >
            <p className="mv-dialog-copy">
              {name} will be removed from every album and cannot be recovered
              afterwards.
            </p>
          </Dialog>
        )}
      </div>
    </dialog>
  );
}
/* ---------- Canvas pieces ---------- */
function PanoramaStage({ src, alt, natural, viewport, onNatural, onError }) {
  const [offset, setOffset] = useState(null),
    gesture = useRef(null),
    layout = panoramaLayout(natural, viewport),
    id = useId();
  const current = clampPanorama(
    offset === null && layout ? layout.maxOffset / 2 : offset,
    layout,
  );
  const windowBox = panoramaWindow(current, layout, viewport);
  const percent = layout?.maxOffset
    ? Math.round((current / layout.maxOffset) * 100)
    : 0;
  const nudge = (delta) => setOffset(clampPanorama(current + delta, layout));
  return (
    <div
      className="mv-panorama"
      onPointerDown={(event) => {
        if (
          event.button > 0 ||
          event.target.closest?.("button,[role='slider']")
        )
          return;
        gesture.current = { x: event.clientX, offset: current };
        event.currentTarget.setPointerCapture?.(event.pointerId);
        event.preventDefault();
      }}
      onPointerMove={(event) => {
        if (!gesture.current) return;
        setOffset(
          clampPanorama(
            gesture.current.offset - (event.clientX - gesture.current.x),
            layout,
          ),
        );
      }}
      onPointerUp={() => (gesture.current = null)}
      onPointerCancel={() => (gesture.current = null)}
      onWheel={(event) => {
        if (!layout) return;
        nudge(event.deltaX || event.deltaY);
      }}
      style={{ cursor: gesture.current ? "grabbing" : "grab" }}
    >
      <img
        className="mv-panorama-image"
        src={src}
        alt={alt}
        draggable="false"
        style={
          layout
            ? {
                width: layout.width,
                height: layout.height,
                transform: `translateX(${-current}px)`,
              }
            : undefined
        }
        onLoad={(event) =>
          onNatural({
            width: event.currentTarget.naturalWidth,
            height: event.currentTarget.naturalHeight,
          })
        }
        onError={onError}
      />
      {layout && layout.maxOffset > 0 && (
        <div className="mv-minimap">
          <div
            className="mv-minimap-track"
            role="slider"
            tabIndex={0}
            aria-label="Panorama position"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            aria-valuetext={`${percent}% across`}
            aria-describedby={`${id}-hint`}
            style={{ backgroundImage: `url("${src}")` }}
            onKeyDown={(event) => {
              const large = event.shiftKey ? 5 : 1;
              const stepSize = (layout.maxOffset / 40) * large;
              if (event.key === "ArrowLeft" || event.key === "ArrowUp")
                nudge(-stepSize);
              else if (event.key === "ArrowRight" || event.key === "ArrowDown")
                nudge(stepSize);
              else if (event.key === "Home") setOffset(0);
              else if (event.key === "End") setOffset(layout.maxOffset);
              else return;
              event.preventDefault();
              event.stopPropagation();
            }}
            onPointerDown={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              const fraction =
                (event.clientX - rect.left) / rect.width - windowBox.width / 2;
              setOffset(clampPanorama(fraction * layout.width, layout));
              gesture.current = null;
              event.stopPropagation();
            }}
          >
            <span
              className="mv-minimap-window"
              style={{
                left: `${windowBox.left * 100}%`,
                width: `${windowBox.width * 100}%`,
              }}
            />
          </div>
          <small id={`${id}-hint`}>
            Drag the photo to look around · arrows move the view
          </small>
        </div>
      )}
    </div>
  );
}
function StackStrip({ members, currentId, onPick }) {
  return (
    <div className="mv-stack" aria-label="Stack">
      <div className="mv-stack-heading">
        <Icon name="mdiLayersTripleOutline" size={15} />
        Stack · {members.length} items
      </div>
      <ul className="mv-stack-items">
        {members.map((member) => {
          const thumb = viewerMedia(member).image;
          return (
            <li key={member.id}>
              <button
                type="button"
                aria-current={member.id === currentId ? "true" : undefined}
                aria-label={`${member.name || member.originalFileName || "Item"}${member.stackPrimary ? " · primary" : ""}`}
                title={member.name || member.originalFileName}
                onClick={() => member.id !== currentId && onPick(member.id)}
              >
                {thumb ? (
                  <img src={thumb} alt="" draggable="false" loading="lazy" />
                ) : (
                  <Icon name="mdiImageOutline" />
                )}
                {member.stackPrimary && (
                  <span className="mv-stack-primary">
                    <Icon name="mdiCrownOutline" size={12} />
                    Primary
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
function RatingStars({ value, onRate, compact = false }) {
  return (
    <div
      className={`mv-stars ${compact ? "compact" : ""}`}
      role="group"
      aria-label="Rating"
    >
      {[1, 2, 3, 4, 5].map((star) => (
        <button
          type="button"
          key={star}
          className={star <= value ? "filled" : ""}
          aria-label={`Rate ${star} ${star === 1 ? "star" : "stars"}`}
          aria-pressed={star === value}
          onClick={() => onRate(star === value ? 0 : star)}
        >
          <Icon
            name={star <= value ? "mdiStar" : "mdiStarOutline"}
            size={compact ? 18 : 22}
          />
        </button>
      ))}
      <button
        type="button"
        className="mv-stars-clear"
        disabled={!value}
        onClick={() => onRate(0)}
      >
        Clear
      </button>
    </div>
  );
}
function SlideshowSettings({ prefs, onChange, onClose }) {
  return (
    <section className="mv-slideshow-settings" aria-label="Slideshow settings">
      <header>
        <h2>Slideshow</h2>
        <Tool
          label="Close slideshow settings"
          icon="mdiClose"
          onClick={onClose}
        />
      </header>
      <label>
        Photo duration
        <select
          aria-label="Photo duration"
          value={prefs.interval}
          onChange={(event) =>
            onChange({ interval: Number(event.target.value) })
          }
        >
          {[2, 3, 5, 10, 15, 30].map((seconds) => (
            <option key={seconds} value={seconds}>
              {seconds} seconds
            </option>
          ))}
        </select>
      </label>
      <label>
        Image fit
        <select
          aria-label="Image fit"
          value={prefs.look}
          onChange={(event) => onChange({ look: event.target.value })}
        >
          <option value="fit">Fit entire photo</option>
          <option value="fill">Fill screen</option>
          <option value="blur">Blurred background</option>
        </select>
      </label>
      <label>
        Caption
        <select
          aria-label="Slideshow caption"
          value={prefs.caption}
          onChange={(event) => onChange({ caption: event.target.value })}
        >
          <option value="off">Off</option>
          <option value="description">Description</option>
          <option value="details">Description & details</option>
        </select>
      </label>
      <label>
        Order
        <select
          aria-label="Slideshow order"
          value={prefs.order}
          onChange={(event) => onChange({ order: event.target.value })}
        >
          <option value="ascending">Ascending</option>
          <option value="descending">Descending</option>
          <option value="shuffle">Shuffle</option>
        </select>
      </label>
      <label>
        Transition
        <select
          aria-label="Slideshow transition"
          value={prefs.transition}
          onChange={(event) => onChange({ transition: event.target.value })}
        >
          {SLIDESHOW_TRANSITIONS.map(([id, label]) => (
            <option key={id} value={id}>
              {label}
              {id === "fade" ? " (default)" : ""}
            </option>
          ))}
        </select>
      </label>
      <label className="mv-check">
        <input
          type="checkbox"
          checked={prefs.repeat}
          onChange={(event) => onChange({ repeat: event.target.checked })}
        />
        Repeat collection
      </label>
      <label className="mv-check">
        <input
          type="checkbox"
          checked={prefs.progress}
          onChange={(event) => onChange({ progress: event.target.checked })}
        />
        Show progress bar
      </label>
      <p>Videos play to their end. Photos follow the duration above.</p>
    </section>
  );
}
function CastDialog({ devices, connected, close, onConnect }) {
  const [busy, setBusy] = useState(null);
  const iconFor = (type) =>
    ({
      tv: "mdiTelevision",
      television: "mdiTelevision",
      monitor: "mdiMonitor",
      display: "mdiMonitor",
      phone: "mdiCellphone",
      speaker: "mdiVolumeHigh",
    })[String(type || "").toLowerCase()] || "mdiDevices";
  return (
    <Dialog title="Cast" close={close}>
      {devices.length === 0 ? (
        <p className="mv-dialog-copy">
          No cast devices were found on this network.
        </p>
      ) : (
        <ul className="mv-cast-list">
          {devices.map((device) => {
            const active = device.id === connected;
            return (
              <li key={device.id} className={active ? "connected" : ""}>
                <Icon name={iconFor(device.type)} size={20} />
                <div>
                  <strong>{device.name}</strong>
                  <span>
                    {active
                      ? "Connected"
                      : busy === device.id
                        ? "Connecting…"
                        : device.type || "Device"}
                  </span>
                </div>
                <Button
                  primary={!active}
                  disabled={busy !== null}
                  data-initial-focus={
                    active || (!connected && device === devices[0])
                      ? ""
                      : undefined
                  }
                  onClick={async () => {
                    setBusy(device.id);
                    await onConnect(active ? null : device.id);
                    setBusy(null);
                  }}
                >
                  {active ? "Disconnect" : "Connect"}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </Dialog>
  );
}
function ChooserDialog({ kind, albums, people, close, onPick }) {
  const rows =
    kind === "album"
      ? albums.map((album) => ({
          key: album.id,
          label: album.name,
          image: album.cover,
          payload: { albumId: album.id },
        }))
      : people.map((person) => ({
          key: person.id,
          label: person.name,
          person,
          payload: { personId: person.id },
        }));
  return (
    <Dialog
      title={kind === "album" ? "Set as album cover" : "Set as featured photo"}
      close={close}
    >
      {rows.length === 0 ? (
        <p className="mv-dialog-copy">
          {kind === "album"
            ? "This item is not in any album yet."
            : "No people are tagged in this item yet."}
        </p>
      ) : (
        <div className="mv-choice-list">
          {rows.map((row, index) => (
            <button
              type="button"
              key={row.key}
              data-initial-focus={index === 0 ? "" : undefined}
              onClick={() => onPick(row.payload)}
            >
              {row.person ? (
                <PersonAvatar person={row.person} size={36} />
              ) : row.image ? (
                <img src={row.image} alt="" />
              ) : (
                <Icon name="mdiImageAlbum" size={20} />
              )}
              <span>{row.label}</span>
              <Icon name="mdiChevronRight" size={18} />
            </button>
          ))}
        </div>
      )}
    </Dialog>
  );
}
/* ---------- Information panel ---------- */
function InfoPanel(props) {
  const {
    asset,
    name,
    media,
    readOnly,
    canEdit,
    trash,
    available,
    onAction,
    onFaceAction,
    onTagPeople,
    run,
    update,
    action,
    announce,
    rating,
    onRate,
    faces,
    profiles,
    albums,
    tagOptions,
    users,
    currentUserId,
    manual,
    onManual,
    highlight,
    onHighlight,
    showOcr,
    onShowOcr,
    onClose,
    onPause,
  } = props;
  const [dateOpen, setDateOpen] = useState(false),
    [locationOpen, setLocationOpen] = useState(false);
  const description = descriptionReview(asset),
    sensitivity = sensitivityReview(asset),
    captured = formatCaptureDate(asset.takenAt || asset.date),
    owner = ownerLine(asset, currentUserId, users),
    link = osmLink(asset.latitude, asset.longitude),
    place = locationLabel(asset),
    coords =
      validCoordinate(asset.latitude, 90) !== null &&
      validCoordinate(asset.longitude, 180) !== null
        ? `${Number(asset.latitude).toFixed(4)}, ${Number(asset.longitude).toFixed(4)}`
        : null;
  return (
    <aside className="mv-info" aria-label="Media information">
      <header>
        <span className="mv-sheet-handle" aria-hidden="true" />
        <h2>Information</h2>
        <Tool label="Close information" icon="mdiClose" onClick={onClose} />
      </header>
      <div className="mv-info-scroll">
        <DescriptionEditor
          key={asset.id}
          asset={asset}
          canEdit={canEdit}
          badge={description ? (manual ? "Manual" : description.status) : null}
          ai={
            description && !manual && description.generated
              ? {
                  detail: [
                    description.model,
                    description.confidence !== null
                      ? `${description.confidence}% confident`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · "),
                }
              : null
          }
          onSave={async (value) => {
            if ((await update({ description: value })) !== false) onManual();
          }}
        />
        {(description || sensitivity) && (
          <EnrichmentCard
            description={description}
            manual={manual}
            sensitivity={sensitivity}
            canEdit={canEdit}
            available={available}
            hasAction={Boolean(onAction)}
            run={run}
            onClear={() => update({ description: "" }, "Description cleared")}
          />
        )}
        {canEdit && !trash && (
          <section>
            <h3>Rating</h3>
            <RatingStars value={rating} onRate={onRate} compact />
          </section>
        )}
        <PeopleSection
          asset={asset}
          faces={faces}
          profiles={profiles}
          readOnly={readOnly || trash}
          available={available}
          onAction={onAction}
          onFaceAction={onFaceAction}
          onTagPeople={onTagPeople}
          run={run}
          action={action}
          announce={announce}
          onHighlight={onHighlight}
        />
        <section>
          <h3>Captured</h3>
          <div className="mv-rows">
            <button
              type="button"
              className="mv-row"
              disabled={!canEdit}
              aria-label={canEdit ? "Edit date and time" : undefined}
              onClick={() => {
                onPause();
                setDateOpen(true);
              }}
            >
              <Icon name="mdiCalendarClock" size={20} />
              <span>
                <strong>{captured.date || "Date unknown"}</strong>
                <small>
                  {[
                    captured.time,
                    asset.timezone ? asset.timezone.replace(/_/g, " ") : null,
                  ]
                    .filter(Boolean)
                    .join(" · ") || "Add a capture time"}
                </small>
              </span>
              {canEdit && (
                <Icon
                  name="mdiPencilOutline"
                  size={16}
                  className="mv-row-edit"
                />
              )}
            </button>
            <button
              type="button"
              className="mv-row"
              disabled={!canEdit}
              aria-label={canEdit ? "Edit location" : undefined}
              onClick={() => {
                onPause();
                setLocationOpen(true);
              }}
            >
              <Icon name="mdiMapMarkerOutline" size={20} />
              <span>
                <strong>{place || "No location"}</strong>
                <small>
                  {coords || (canEdit ? "Add a location" : "Location unknown")}
                </small>
              </span>
              {canEdit && (
                <Icon
                  name="mdiPencilOutline"
                  size={16}
                  className="mv-row-edit"
                />
              )}
            </button>
            {link && (
              <a
                className="mv-link"
                href={link}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Icon name="mdiOpenInNew" size={15} />
                Open in OpenStreetMap
              </a>
            )}
          </div>
        </section>
        <DetailsSection
          asset={asset}
          name={name}
          media={media}
          available={available}
          hasAction={Boolean(onAction)}
          run={run}
        />
        <TagsSection
          asset={asset}
          canEdit={canEdit && !trash}
          tagOptions={tagOptions}
          update={update}
        />
        {albums.length > 0 && (
          <section>
            <h3>Appears in</h3>
            <div className="mv-albums">
              {albums.map((album) => (
                <button
                  type="button"
                  key={album.id}
                  disabled={!onAction || !available.includes("open-album")}
                  onClick={() => run("open-album", { albumId: album.id })}
                >
                  {album.cover ? (
                    <img src={album.cover} alt="" loading="lazy" />
                  ) : (
                    <Icon name="mdiImageAlbum" size={20} />
                  )}
                  <span>
                    <strong>{album.name}</strong>
                    {album.count != null && <small>{album.count} items</small>}
                  </span>
                  <Icon name="mdiChevronRight" size={18} />
                </button>
              ))}
            </div>
          </section>
        )}
        {owner && (
          <p className="mv-owner">
            <Icon name="mdiAccountOutline" size={16} />
            {owner}
          </p>
        )}
        {asset.ocr && (
          <OcrSection
            text={asset.ocr}
            showOcr={showOcr}
            onShowOcr={onShowOcr}
            announce={announce}
          />
        )}
      </div>
      {dateOpen && (
        <DateTimeDialog
          asset={asset}
          close={() => setDateOpen(false)}
          onSave={async (patch) => {
            if ((await update(patch, "Date updated")) !== false)
              setDateOpen(false);
          }}
        />
      )}
      {locationOpen && (
        <LocationDialog
          asset={asset}
          close={() => setLocationOpen(false)}
          onSave={async (patch) => {
            if ((await update(patch, "Location updated")) !== false)
              setLocationOpen(false);
          }}
        />
      )}
    </aside>
  );
}
function DescriptionEditor({ asset, canEdit, badge, ai, onSave }) {
  const [value, setValue] = useState(asset.description || ""),
    [editing, setEditing] = useState(false),
    area = useRef(null),
    id = useId();
  useEffect(() => {
    if (!editing) setValue(asset.description || "");
  }, [asset.description, editing]);
  useLayoutEffect(() => {
    const element = area.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.max(44, element.scrollHeight)}px`;
  }, [value, canEdit]);
  const commit = () => {
    setEditing(false);
    const next = value.trim();
    if (next !== (asset.description || "")) onSave(next);
    else setValue(asset.description || "");
  };
  return (
    <section className="mv-description-section">
      <div className="mv-section-heading">
        <h3 id={id}>Description</h3>
        {badge === "Generated" ? (
          <span
            className="mv-badge mv-ai-badge"
            title={
              ai?.detail ? `Written by AI · ${ai.detail}` : "Written by AI"
            }
          >
            <Icon name="mdiShimmer" size={12} />
            AI
          </span>
        ) : badge === "Manual" ? (
          <span className="mv-badge" title="Written by you">
            <Icon name="mdiPencilOutline" size={11} />
            Yours
          </span>
        ) : (
          badge && <span className="mv-badge">{badge}</span>
        )}
      </div>
      {canEdit ? (
        <textarea
          ref={area}
          className="mv-description-input"
          aria-labelledby={id}
          placeholder="Add a description"
          rows={1}
          value={value}
          onFocus={() => setEditing(true)}
          onChange={(event) => setValue(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.blur();
            } else if (event.key === "Escape") {
              event.preventDefault();
              setValue(asset.description || "");
              setEditing(false);
              window.setTimeout(() => area.current?.blur(), 0);
            }
          }}
        />
      ) : (
        <p className="mv-description">
          {asset.description || "No description"}
        </p>
      )}
    </section>
  );
}
function EnrichmentCard({
  description,
  manual,
  sensitivity,
  canEdit,
  available,
  hasAction,
  run,
  onClear,
}) {
  const can = (id) => hasAction && available.includes(id);
  const tone =
    sensitivity?.status === "Needs review"
      ? "warning"
      : sensitivity?.status === "Overridden"
        ? "blue"
        : "teal";
  const aiDescription = description && !manual && description.generated;
  const likelihood =
    sensitivity?.score !== null && sensitivity?.score !== undefined
      ? `${Math.round(sensitivity.score * 100)}% likely sensitive`
      : null;
  return (
    <section className="mv-enrichment" aria-label="AI enrichment">
      <div className="mv-enrich-head">
        <span className="mv-ai-mark" aria-hidden="true">
          <Icon name="mdiShimmer" size={14} />
        </span>
        <h3>Enrichment</h3>
        <small className="mv-note">Preview · sample data</small>
      </div>
      <div className="mv-enrich-list">
        {description && (
          <div className="mv-enrich-row">
            <span
              className={`mv-enrich-icon ${aiDescription ? "ai" : "manual"}`}
              aria-hidden="true"
            >
              <Icon
                name={aiDescription ? "mdiShimmer" : "mdiPencilOutline"}
                size={15}
              />
            </span>
            <div className="mv-enrich-text">
              <strong>Description</strong>
              <span>
                {aiDescription
                  ? [
                      "Written by AI",
                      description.model,
                      description.confidence !== null
                        ? `${description.confidence}% confident`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")
                  : manual || !description.generated
                    ? "Written by you"
                    : description.status}
              </span>
            </div>
            <div className="mv-enrich-actions">
              {aiDescription && can("accept-description") && canEdit && (
                <button type="button" onClick={() => run("accept-description")}>
                  Accept
                </button>
              )}
              {can("rerun-description") && canEdit && (
                <button
                  type="button"
                  aria-label="Rewrite description with AI"
                  title="Rewrite with AI"
                  onClick={() => run("rerun-description")}
                >
                  <Icon name="mdiRefresh" size={14} />
                </button>
              )}
              {canEdit && (
                <button
                  type="button"
                  aria-label="Clear description"
                  title="Clear"
                  onClick={onClear}
                >
                  <Icon name="mdiClose" size={14} />
                </button>
              )}
            </div>
          </div>
        )}
        {sensitivity && (
          <div className="mv-enrich-row">
            <span className={`mv-enrich-icon ${tone}`} aria-hidden="true">
              <Icon
                name={
                  sensitivity.status === "Needs review"
                    ? "mdiShieldAlertOutline"
                    : "mdiShieldCheckOutline"
                }
                size={15}
              />
            </span>
            <div className="mv-enrich-text">
              <strong>
                Sensitive content
                <em className={`mv-pill ${tone}`}>{sensitivity.status}</em>
              </strong>
              <span>
                {["Checked by AI", likelihood].filter(Boolean).join(" · ")}
              </span>
            </div>
            <div className="mv-enrich-actions">
              {canEdit &&
                (sensitivity.marked ? can("unlock") : can("lock")) && (
                  <button
                    type="button"
                    onClick={() => run(sensitivity.marked ? "unlock" : "lock")}
                  >
                    {sensitivity.marked ? "Mark safe" : "Mark sensitive"}
                  </button>
                )}
              {can("rerun-sensitive") && canEdit && (
                <button
                  type="button"
                  aria-label="Check again with AI"
                  title="Check again"
                  onClick={() => run("rerun-sensitive")}
                >
                  <Icon name="mdiRefresh" size={14} />
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
function PeopleSection({
  asset,
  faces,
  profiles,
  readOnly,
  available,
  onAction,
  onFaceAction,
  onTagPeople,
  run,
  action,
  announce,
  onHighlight,
}) {
  const [showHidden, setShowHidden] = useState(false),
    [openKey, setOpenKey] = useState(null),
    [mode, setMode] = useState("menu"),
    [query, setQuery] = useState(""),
    [newName, setNewName] = useState(""),
    menuRef = useRef(null),
    buttons = useRef(new Map());
  const { chips, hiddenCount } = peopleChips({
    faces,
    people: profiles,
    personIds: asset.personIds || [],
    showHidden,
  });
  const takenAt = asset.takenAt || asset.date;
  const canFace = typeof onFaceAction === "function" && !readOnly;
  const closeMenu = (restore = true) => {
    const key = openKey;
    setOpenKey(null);
    setMode("menu");
    setQuery("");
    setNewName("");
    if (restore && key) buttons.current.get(key)?.focus();
  };
  useEffect(() => {
    if (openKey && mode === "menu")
      menuRef.current?.querySelector('[role="menuitem"]')?.focus();
    else if (openKey) menuRef.current?.querySelector("input")?.focus();
  }, [openKey, mode]);
  const face = (chip, payload) => {
    closeMenu();
    action(onFaceAction, asset.id, { ...payload, faceId: chip.faceId });
  };
  if (!chips.length && !onTagPeople && !hiddenCount) return null;
  const matches = profiles.filter((person) =>
    person.name?.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  return (
    <section>
      <div className="mv-section-heading">
        <h3>People</h3>
        <div className="mv-heading-actions">
          {hiddenCount > 0 && (
            <button
              type="button"
              className="mv-text-button"
              aria-pressed={showHidden}
              onClick={() => setShowHidden((value) => !value)}
            >
              <Icon
                name={showHidden ? "mdiEyeOffOutline" : "mdiEyeOutline"}
                size={15}
              />
              {showHidden ? "Hide hidden" : `Show hidden (${hiddenCount})`}
            </button>
          )}
          {onTagPeople && !readOnly && (
            <button
              type="button"
              className="mv-text-button"
              aria-label="Add person"
              onClick={() => action(onTagPeople, asset.id)}
            >
              <Icon name="mdiAccountPlusOutline" size={15} />
              Add
            </button>
          )}
        </div>
      </div>
      {chips.length === 0 ? (
        <p className="mv-no-people">No people tagged yet.</p>
      ) : (
        <div className="mv-people-list">
          {chips.map((chip) => {
            const label = chip.person
              ? personChipLabel(chip.person, takenAt)
              : chip.name;
            const age = chip.person
              ? ageAtCapture(
                  chip.person.birthday || chip.person.birthDate,
                  takenAt,
                )
              : null;
            const open = openKey === chip.key;
            const highlightChip = () =>
              onHighlight(
                chip.box ? { box: chip.box, label: chip.name } : null,
              );
            return (
              <div
                className={`mv-chip-wrap ${chip.hidden ? "hidden-person" : ""}`}
                key={chip.key}
                onPointerEnter={highlightChip}
                onPointerLeave={() => onHighlight(null)}
                onFocus={highlightChip}
                onBlur={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget))
                    onHighlight(null);
                }}
              >
                <button
                  type="button"
                  className="mv-chip"
                  title={label}
                  disabled={
                    !chip.person ||
                    !onAction ||
                    !available.includes("open-person")
                  }
                  onClick={() =>
                    run("open-person", { personId: chip.person.id })
                  }
                >
                  <PersonAvatar
                    person={
                      chip.person || { name: chip.name, avatarColor: "gray" }
                    }
                    size={34}
                  />
                  <span>
                    {chip.name}
                    {age !== null && <small aria-hidden="true"> · {age}</small>}
                    {chip.hidden && <Icon name="mdiEyeOffOutline" size={13} />}
                  </span>
                </button>
                {(chip.person || chip.faceId) && (onAction || canFace) && (
                  <button
                    type="button"
                    className="mv-chip-more"
                    aria-label={`Options for ${chip.name}`}
                    aria-haspopup="menu"
                    aria-expanded={open}
                    ref={(element) => {
                      if (element) buttons.current.set(chip.key, element);
                      else buttons.current.delete(chip.key);
                    }}
                    onClick={() =>
                      open
                        ? closeMenu(false)
                        : (setMode("menu"), setOpenKey(chip.key))
                    }
                  >
                    <Icon name="mdiDotsVertical" size={16} />
                  </button>
                )}
                {open && mode === "menu" && (
                  <div
                    className="mv-menu mv-chip-menu"
                    role="menu"
                    aria-label={`Options for ${chip.name}`}
                    ref={menuRef}
                    onKeyDown={(event) =>
                      menuKeys(event, menuRef.current, closeMenu)
                    }
                  >
                    {chip.person &&
                      onAction &&
                      available.includes("open-person") && (
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => (
                            closeMenu(),
                            run("open-person", { personId: chip.person.id })
                          )}
                        >
                          <Icon name="mdiAccountOutline" size={16} />
                          Open person
                        </button>
                      )}
                    {chip.faceId && canFace && (
                      <>
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => setMode("reassign")}
                        >
                          <Icon name="mdiAccountEditOutline" size={16} />
                          Reassign face…
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => setMode("create")}
                        >
                          <Icon name="mdiAccountPlusOutline" size={16} />
                          Create new person…
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => face(chip, { type: "remove" })}
                        >
                          <Icon name="mdiClose" size={16} />
                          Remove face
                        </button>
                        {!chip.hidden && (
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => face(chip, { type: "hide" })}
                          >
                            <Icon name="mdiEyeOffOutline" size={16} />
                            Hide face
                          </button>
                        )}
                      </>
                    )}
                  </div>
                )}
                {open && mode === "reassign" && (
                  <div
                    className="mv-menu mv-chip-menu mv-picker"
                    role="group"
                    aria-label="Reassign face"
                    ref={menuRef}
                    onKeyDown={(event) =>
                      event.key === "Escape" &&
                      (event.preventDefault(),
                      event.stopPropagation(),
                      closeMenu())
                    }
                  >
                    <input
                      type="search"
                      aria-label="Find a person"
                      placeholder="Find a person"
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      onKeyDown={(event) => {
                        event.stopPropagation();
                        if (event.key === "Escape") {
                          event.preventDefault();
                          closeMenu();
                        } else if (event.key === "Enter" && matches[0]) {
                          event.preventDefault();
                          face(chip, {
                            type: "reassign",
                            personId: matches[0].id,
                          });
                        }
                      }}
                    />
                    <div className="mv-picker-list">
                      {matches.slice(0, 8).map((person) => (
                        <button
                          type="button"
                          key={person.id}
                          disabled={person.id === chip.person?.id}
                          onClick={() =>
                            face(chip, {
                              type: "reassign",
                              personId: person.id,
                            })
                          }
                        >
                          <PersonAvatar person={person} size={26} />
                          {person.name}
                        </button>
                      ))}
                      {matches.length === 0 && (
                        <p className="mv-no-people">No people match.</p>
                      )}
                    </div>
                  </div>
                )}
                {open && mode === "create" && (
                  <form
                    className="mv-menu mv-chip-menu mv-picker"
                    ref={menuRef}
                    aria-label="Create new person"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (newName.trim())
                        face(chip, { type: "create", name: newName.trim() });
                    }}
                    onKeyDown={(event) => {
                      event.stopPropagation();
                      if (event.key === "Escape") {
                        event.preventDefault();
                        closeMenu();
                      }
                    }}
                  >
                    <input
                      aria-label="New person name"
                      placeholder="Name"
                      value={newName}
                      onChange={(event) => setNewName(event.target.value)}
                    />
                    <div className="mv-picker-actions">
                      <button type="button" onClick={() => closeMenu()}>
                        Cancel
                      </button>
                      <button
                        type="submit"
                        className="primary"
                        disabled={!newName.trim()}
                      >
                        Create
                      </button>
                    </div>
                  </form>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
/** Sample: the newest kept backup that holds this item, derived from its id. */
function newestBackupFor(asset) {
  let value = 0;
  for (const character of String(asset.id ?? asset.originalFileName ?? "")) value = (value * 31 + character.charCodeAt(0)) >>> 0;
  return backupManifests[value % 2];
}

function DetailsSection({ asset, name, media, available, hasAction, run }) {
  const can = (id) => hasAction && available.includes(id);
  const [cloud] = useState(() => loadCloudState());
  const [restoring, setRestoring] = useState(false);
  const [restoreNote, setRestoreNote] = useState("");
  const inBackup = cloud.backup.configured ? newestBackupFor(asset) : null;
  const dimensions = dimensionsLabel(asset),
    pixels = megapixels(asset.width, asset.height),
    size = formatFileSize(asset.fileSizeInBytes),
    camera = cameraLabel(asset),
    exposure = exposureParts(asset).join(" · ");
  const rows = [
    ["Filename", asset.originalFileName || name, "mdiFileDocumentOutline"],
    asset.originalPath && [
      "Path",
      <span className="mv-path" key="path">
        <code>{asset.originalPath}</code>
        {can("open-folder") && (
          <button
            type="button"
            className="mv-text-button"
            onClick={() => run("open-folder")}
          >
            <Icon name="mdiFolderOpenOutline" size={14} />
            Show in folder
          </button>
        )}
      </span>,
      "mdiFolderOutline",
    ],
    (dimensions || pixels || size) && [
      "Image",
      [dimensions, pixels, size].filter(Boolean).join(" · "),
      "mdiAspectRatio",
    ],
    camera && [
      "Camera",
      can("search-camera") ? (
        <button
          type="button"
          className="mv-link-button"
          key="camera"
          onClick={() =>
            run("search-camera", { make: asset.make, model: asset.model })
          }
        >
          {camera}
        </button>
      ) : (
        camera
      ),
      "mdiCameraOutline",
    ],
    asset.lensModel && [
      "Lens",
      can("search-camera") ? (
        <button
          type="button"
          className="mv-link-button"
          key="lens"
          onClick={() => run("search-camera", { lensModel: asset.lensModel })}
        >
          {asset.lensModel}
        </button>
      ) : (
        asset.lensModel
      ),
      "mdiCameraIris",
    ],
    exposure && ["Exposure", exposure, "mdiTune"],
    media.isVideo &&
      (asset.frameRate || asset.duration) && [
        "Video",
        [
          asset.frameRate ? `${asset.frameRate} fps` : null,
          formatDuration(asset.duration),
        ]
          .filter(Boolean)
          .join(" · "),
        "mdiVideoOutline",
      ],
    asset.checksum && [
      "Checksum",
      <code key="sum">{asset.checksum}</code>,
      "mdiHarddisk",
    ],
    inBackup && [
      "Backup",
      <span className="mv-path" key="backup">
        In backup ·{" "}
        {new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(new Date(inBackup.createdAt))}
        <button type="button" className="mv-text-button" onClick={() => setRestoring(true)}>
          <Icon name="mdiBackupRestore" size={14} />
          Restore from backup
        </button>
        {restoreNote && <small role="status">{restoreNote}</small>}
      </span>,
      "mdiCloudCheckOutline",
    ],
  ].filter(Boolean);
  return (
    <section>
      <h3>Details</h3>
      <dl className="mv-details">
        {rows.map(([label, value, icon]) => (
          <div key={label}>
            <dt>
              <Icon name={icon} size={16} />
              {label}
            </dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {restoring && (
        <ItemRestoreDialog
          item={{ name: asset.originalFileName || name, path: asset.originalPath, newest: inBackup.id }}
          close={() => setRestoring(false)}
          onRestore={({ manifest }) => {
            setRestoring(false);
            const current = loadCloudState();
            if (!restoreRunActive(current))
              saveCloudState(
                startRestoreRun(current, { title: `Restore “${asset.originalFileName || name}”`, files: 1 }),
              );
            setRestoreNote(
              `Restoring from ${new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(new Date(manifest.createdAt))}. Follow it in Activity.`,
            );
          }}
        />
      )}
    </section>
  );
}
function TagsSection({ asset, canEdit, tagOptions, update }) {
  const [query, setQuery] = useState(""),
    [open, setOpen] = useState(false),
    [active, setActive] = useState(0),
    listId = useId();
  const current = Array.isArray(asset.tagIds)
    ? asset.tagIds
    : Array.isArray(asset.tags)
      ? asset.tags.map((tag) => (typeof tag === "string" ? tag : tag.id))
      : [];
  const labelOf = (id) =>
    tagOptions.find((tag) => tag.id === id)?.label ||
    tagOptions.find((tag) => tag.id === id)?.name ||
    id;
  const term = query.trim().toLocaleLowerCase();
  const options = tagOptions
    .filter((tag) => !current.includes(tag.id))
    .filter(
      (tag) =>
        !term ||
        String(tag.label || tag.name || tag.id)
          .toLocaleLowerCase()
          .includes(term),
    )
    .slice(0, 8)
    .map((tag) => ({
      id: tag.id,
      label: tag.label || tag.name || tag.id,
      create: false,
    }));
  const exact = tagOptions.some(
    (tag) =>
      String(tag.label || tag.name || tag.id).toLocaleLowerCase() === term,
  );
  if (
    term &&
    !exact &&
    !current.some((id) => String(id).toLocaleLowerCase() === term)
  )
    options.push({
      id: query.trim(),
      label: `Create “${query.trim()}”`,
      create: true,
    });
  const choose = async (option) => {
    setQuery("");
    setOpen(false);
    setActive(0);
    await update(
      { tagIds: [...current, option.id] },
      option.create ? "Tag created" : "Tag added",
    );
  };
  if (!current.length && !canEdit) return null;
  return (
    <section>
      <h3>Tags</h3>
      <div className="mv-chips">
        {current.map((id) => (
          <span key={id} className="mv-tag">
            <Icon name="mdiTagOutline" size={13} />
            {labelOf(id)}
            {canEdit && (
              <button
                type="button"
                aria-label={`Remove tag ${labelOf(id)}`}
                onClick={() =>
                  update(
                    { tagIds: current.filter((item) => item !== id) },
                    "Tag removed",
                  )
                }
              >
                <Icon name="mdiClose" size={13} />
              </button>
            )}
          </span>
        ))}
        {!current.length && <span className="mv-no-people">No tags yet.</span>}
      </div>
      {canEdit && (
        <div className="mv-combobox">
          <Icon name="mdiTagPlusOutline" size={16} />
          <input
            data-mv-focus="tags"
            role="combobox"
            aria-label="Add a tag"
            aria-expanded={open && options.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={
              open && options[active] ? `${listId}-${active}` : undefined
            }
            placeholder="Add a tag"
            value={query}
            onFocus={() => setOpen(true)}
            onBlur={() => window.setTimeout(() => setOpen(false), 120)}
            onChange={(event) => {
              setQuery(event.target.value);
              setOpen(true);
              setActive(0);
            }}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setOpen(true);
                setActive((value) => Math.min(options.length - 1, value + 1));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActive((value) => Math.max(0, value - 1));
              } else if (event.key === "Enter") {
                event.preventDefault();
                if (options[active]) choose(options[active]);
              } else if (event.key === "Escape") {
                event.preventDefault();
                if (open || query) {
                  setOpen(false);
                  setQuery("");
                } else event.currentTarget.blur();
              }
            }}
          />
          {open && options.length > 0 && (
            <ul
              className="mv-listbox"
              role="listbox"
              id={listId}
              aria-label="Tag suggestions"
            >
              {options.map((option, index) => (
                <li
                  key={`${option.create ? "new" : "tag"}:${option.id}`}
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={index === active}
                  className={index === active ? "active" : ""}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(option)}
                >
                  <Icon
                    name={option.create ? "mdiPlus" : "mdiTagOutline"}
                    size={14}
                  />
                  {option.label}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
function OcrSection({ text, showOcr, onShowOcr, announce }) {
  const paragraph = useRef(null);
  const selectText = () => {
    try {
      const range = document.createRange();
      range.selectNodeContents(paragraph.current);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    } catch {}
  };
  return (
    <section>
      <div className="mv-section-heading">
        <h3>Text in this photo</h3>
        <button
          type="button"
          className="mv-text-button"
          aria-pressed={showOcr}
          onClick={() => onShowOcr(!showOcr)}
        >
          <Icon name="mdiTextRecognition" size={15} />
          {showOcr ? "Hide text regions" : "Show text regions"}
        </button>
      </div>
      <p className="mv-ocr" ref={paragraph}>
        {text}
      </p>
      <div className="mv-heading-actions">
        <button type="button" className="mv-text-button" onClick={selectText}>
          <Icon name="mdiSelectAll" size={15} />
          Select text
        </button>
        <button
          type="button"
          className="mv-text-button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(text);
              announce("Text copied");
            } catch {
              selectText();
              announce("Select the text and copy it with your keyboard");
            }
          }}
        >
          <Icon name="mdiContentCopy" size={15} />
          Copy text
        </button>
      </div>
    </section>
  );
}
function DateTimeDialog({ asset, close, onSave }) {
  const initial = splitDateTime(asset.takenAt || asset.date);
  const [date, setDate] = useState(initial.date),
    [time, setTime] = useState(initial.time || "00:00"),
    [zone, setZone] = useState(asset.timezone || "");
  const zones = timezoneOptions(asset.timezone);
  const takenAt = joinDateTime(date, time);
  return (
    <Dialog
      title="Edit date and time"
      close={close}
      actions={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button
            primary
            disabled={!takenAt}
            onClick={() =>
              onSave({ takenAt, date, ...(zone ? { timezone: zone } : {}) })
            }
          >
            Save
          </Button>
        </>
      }
    >
      <div className="mv-form">
        <label>
          Date
          <input
            type="date"
            value={date}
            data-initial-focus
            onChange={(event) => setDate(event.target.value)}
          />
        </label>
        <label>
          Time
          <input
            type="time"
            value={time}
            onChange={(event) => setTime(event.target.value)}
          />
        </label>
        <label>
          Time zone
          <select
            value={zone}
            onChange={(event) => setZone(event.target.value)}
          >
            <option value="">Keep the current time zone</option>
            {zones.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <p className="mv-dialog-copy">
          {takenAt
            ? `Capture time becomes ${formatCaptureDate(takenAt).date} · ${formatCaptureDate(takenAt).time}.`
            : "Enter a valid date and time."}
        </p>
      </div>
    </Dialog>
  );
}
const MAP_W = 460,
  MAP_H = 260,
  SPAN = { lat: 0.5, lon: 0.9 };
function PinMap({ latitude, longitude, onChange }) {
  const id = useId();
  const [center] = useState(() => ({
    lat: validCoordinate(latitude, 90) ?? 51.4,
    lon: validCoordinate(longitude, 180) ?? -116.2,
  }));
  const dragging = useRef(false);
  const lat = validCoordinate(latitude, 90),
    lon = validCoordinate(longitude, 180);
  const toPoint = (la, lo) => ({
    x: ((lo - (center.lon - SPAN.lon / 2)) / SPAN.lon) * MAP_W,
    y: ((center.lat + SPAN.lat / 2 - la) / SPAN.lat) * MAP_H,
  });
  const fromEvent = (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = Math.max(
        0,
        Math.min(1, (event.clientX - rect.left) / rect.width),
      ),
      y = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
    return {
      lat: Number((center.lat + SPAN.lat / 2 - y * SPAN.lat).toFixed(5)),
      lon: Number((center.lon - SPAN.lon / 2 + x * SPAN.lon).toFixed(5)),
    };
  };
  const pin = lat !== null && lon !== null ? toPoint(lat, lon) : null;
  const nudge = (dLat, dLon) =>
    onChange(
      Number(((lat ?? center.lat) + dLat).toFixed(5)),
      Number(((lon ?? center.lon) + dLon).toFixed(5)),
    );
  const label = pin
    ? `Pin at ${lat.toFixed(4)}, ${lon.toFixed(4)}`
    : "No pin placed";
  return (
    <div className="mv-map-wrap">
      <svg
        className="mv-map"
        viewBox={`0 0 ${MAP_W} ${MAP_H}`}
        role="img"
        tabIndex={0}
        aria-label={`Map. ${label}. Click to place the pin, drag to move it, arrow keys nudge it.`}
        aria-describedby={`${id}-hint`}
        onPointerDown={(event) => {
          if (event.button > 0) return;
          dragging.current = true;
          event.currentTarget.setPointerCapture?.(event.pointerId);
          const next = fromEvent(event);
          onChange(next.lat, next.lon);
          event.preventDefault();
        }}
        onPointerMove={(event) => {
          if (!dragging.current) return;
          const next = fromEvent(event);
          onChange(next.lat, next.lon);
        }}
        onPointerUp={() => (dragging.current = false)}
        onPointerCancel={() => (dragging.current = false)}
        onKeyDown={(event) => {
          const size = event.shiftKey ? 0.05 : 0.005;
          if (event.key === "ArrowUp") nudge(size, 0);
          else if (event.key === "ArrowDown") nudge(-size, 0);
          else if (event.key === "ArrowLeft") nudge(0, -size);
          else if (event.key === "ArrowRight") nudge(0, size);
          else return;
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <rect className="mv-map-land" width={MAP_W} height={MAP_H} />
        <path
          className="mv-map-ridge"
          d="M0 190 L60 120 L110 150 L170 70 L230 130 L290 90 L350 140 L410 80 L460 120 L460 260 L0 260 Z"
        />
        <path
          className="mv-map-ridge far"
          d="M0 120 L50 80 L120 105 L200 40 L280 95 L340 60 L420 100 L460 70 L460 260 L0 260 Z"
        />
        <ellipse className="mv-map-water" cx="300" cy="185" rx="70" ry="24" />
        <path
          className="mv-map-road"
          d="M0 230 C120 210 180 250 300 215 S420 190 460 200"
        />
        {[0.25, 0.5, 0.75].map((f) => (
          <React.Fragment key={f}>
            <line
              x1={f * MAP_W}
              y1="0"
              x2={f * MAP_W}
              y2={MAP_H}
              className="mv-map-grid"
            />
            <line
              x1="0"
              y1={f * MAP_H}
              x2={MAP_W}
              y2={f * MAP_H}
              className="mv-map-grid"
            />
          </React.Fragment>
        ))}
        <text x="8" y="16" className="mv-map-text">
          {(center.lat + SPAN.lat / 2).toFixed(2)}°
        </text>
        <text x="8" y={MAP_H - 8} className="mv-map-text">
          {(center.lat - SPAN.lat / 2).toFixed(2)}°
        </text>
        <text x={MAP_W - 62} y={MAP_H - 8} className="mv-map-text">
          {(center.lon + SPAN.lon / 2).toFixed(2)}°
        </text>
        {pin && (
          <g className="mv-map-pin" transform={`translate(${pin.x} ${pin.y})`}>
            <path d="M0 0 C-9 -12 -12 -18 -12 -24 A12 12 0 1 1 12 -24 C12 -18 9 -12 0 0 Z" />
            <circle cy="-24" r="4.5" />
          </g>
        )}
      </svg>
      <small id={`${id}-hint`}>
        Click or drag on the map to place the pin · arrow keys nudge · Shift for
        larger steps
      </small>
    </div>
  );
}
function LocationDialog({ asset, close, onSave }) {
  const [city, setCity] = useState(asset.city || ""),
    [state, setState] = useState(asset.state || ""),
    [country, setCountry] = useState(asset.country || ""),
    [latitude, setLatitude] = useState(
      asset.latitude != null ? String(asset.latitude) : "",
    ),
    [longitude, setLongitude] = useState(
      asset.longitude != null ? String(asset.longitude) : "",
    );
  const lat = validCoordinate(latitude, 90),
    lon = validCoordinate(longitude, 180);
  const coordinatesValid =
    (latitude.trim() === "" && longitude.trim() === "") ||
    (lat !== null && lon !== null);
  return (
    <Dialog
      title="Edit location"
      close={close}
      wide
      actions={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button
            primary
            disabled={!coordinatesValid}
            onClick={() =>
              onSave({
                city: city.trim(),
                state: state.trim(),
                country: country.trim(),
                latitude: lat,
                longitude: lon,
              })
            }
          >
            Save
          </Button>
        </>
      }
    >
      <div className="mv-location-grid">
        <div className="mv-form">
          <label>
            City
            <input
              value={city}
              data-initial-focus
              onChange={(event) => setCity(event.target.value)}
            />
          </label>
          <label>
            State or region
            <input
              value={state}
              onChange={(event) => setState(event.target.value)}
            />
          </label>
          <label>
            Country
            <input
              value={country}
              onChange={(event) => setCountry(event.target.value)}
            />
          </label>
          <div className="mv-form-row">
            <label>
              Latitude
              <input
                inputMode="decimal"
                value={latitude}
                aria-invalid={latitude.trim() !== "" && lat === null}
                onChange={(event) => setLatitude(event.target.value)}
              />
            </label>
            <label>
              Longitude
              <input
                inputMode="decimal"
                value={longitude}
                aria-invalid={longitude.trim() !== "" && lon === null}
                onChange={(event) => setLongitude(event.target.value)}
              />
            </label>
          </div>
          {!coordinatesValid && (
            <p className="mv-form-error">
              Enter both coordinates as decimal degrees, or leave both empty.
            </p>
          )}
        </div>
        <PinMap
          latitude={latitude}
          longitude={longitude}
          onChange={(nextLat, nextLon) => {
            setLatitude(String(nextLat));
            setLongitude(String(nextLon));
          }}
        />
      </div>
    </Dialog>
  );
}
