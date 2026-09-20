import { PersonAvatar } from "./People";
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  mdiArrowLeft,
  mdiChevronLeft,
  mdiChevronRight,
  mdiClose,
  mdiCogOutline,
  mdiDeleteOutline,
  mdiDotsHorizontal,
  mdiFullscreen,
  mdiFullscreenExit,
  mdiHeart,
  mdiHeartOutline,
  mdiInformationOutline,
  mdiMagnifyMinusOutline,
  mdiMagnifyPlusOutline,
  mdiPause,
  mdiPencilOutline,
  mdiPlay,
  mdiShareVariantOutline,
} from "@mdi/js";
import {
  viewerAssets,
  viewerCanShare,
  viewerMedia,
  slideshowOrder,
  slideshowNeighbor,
  viewerMetadata,
  fitDimensions,
  clampPan,
} from "./media-viewer.mjs";
import "./media-viewer.css";
const DEFAULT_ACTIONS = [
  "download",
  "download-original",
  "add-to-album",
  "archive",
  "unarchive",
  "stack",
  "view-in-timeline",
  "find-similar",
  "view-on-map",
];
const icon = (path) => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d={path} />
  </svg>
);
function Tool({ label, path, children, active, ...props }) {
  return (
    <button
      type="button"
      className={`mv-tool ${active ? "active" : ""}`}
      aria-label={label}
      title={label}
      {...props}
    >
      {path && icon(path)}
      {children && <span>{children}</span>}
    </button>
  );
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
  availableActions = DEFAULT_ACTIONS,
  slideshow = false,
  onSlideshowChange,
  allowLocked = false,
  initialTime = 0,
  onPlaybackChange,
  onTagPeople,
  personProfiles = [],
}) {
  const collection = viewerAssets(assets, { allowLocked }),
    asset = collection.find((item) => item.id === assetId),
    media = viewerMedia(asset);
  const ids = collection.map((item) => item.id),
    idsKey = JSON.stringify(ids);
  const [playing, setPlaying] = useState(Boolean(slideshow)),
    [interval, setIntervalSeconds] = useState(5),
    [shuffle, setShuffle] = useState(false),
    [repeat, setRepeat] = useState(false);
  const [order, setOrder] = useState(() => slideshowOrder(ids, assetId)),
    [showInfo, setShowInfo] = useState(false),
    [settingsOpen, setSettingsOpen] = useState(false),
    [menuOpen, setMenuOpen] = useState(false);
  const [overlay, setOverlay] = useState("description"),
    [look, setLook] = useState("fit"),
    [zoom, setZoom] = useState(1),
    [pan, setPan] = useState({ x: 0, y: 0 }),
    [natural, setNatural] = useState(null);
  const [imageError, setImageError] = useState(null),
    [videoError, setVideoError] = useState(null),
    [error, setError] = useState(""),
    [fullscreen, setFullscreen] = useState(false),
    [hidden, setHidden] = useState(
      () => typeof document !== "undefined" && document.hidden,
    );
  const dialog = useRef(null),
    closeButton = useRef(null),
    stage = useRef(null),
    video = useRef(null),
    menuButton = useRef(null),
    menu = useRef(null),
    drag = useRef(null),
    timer = useRef(null),
    epoch = useRef(0),
    pendingNavigation = useRef(null),
    invalidClosed = useRef(null),
    latest = useRef(null),
    alive = useRef(false);
  latest.current = {
    asset,
    collection,
    order,
    playing,
    repeat,
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
  function navigate(id) {
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
  function step(direction, automatic = false) {
    const live = latest.current;
    if (!live.asset) return;
    const next = slideshowNeighbor(
      live.order,
      live.asset.id,
      direction,
      automatic ? live.repeat : true,
    );
    if (next) navigate(next);
    else if (automatic) play(false);
  }
  const stepRef = useRef(step);
  stepRef.current = step;
  useEffect(() => {
    setOrder(slideshowOrder(ids, latest.current.asset?.id, shuffle));
  }, [idsKey, shuffle]);
  useEffect(() => {
    setPlaying(Boolean(slideshow));
    cancelTimer();
  }, [slideshow]);
  useEffect(() => {
    pendingNavigation.current = null;
    drag.current = null;
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setNatural(null);
    setImageError(null);
    setVideoError(null);
    setMenuOpen(false);
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
  const playable = Boolean(media.video && videoError !== media.video);
  useEffect(() => {
    cancelTimer();
    if (
      !playing ||
      !asset ||
      hidden ||
      settingsOpen ||
      menuOpen ||
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
    }, interval * 1000);
    return cancelTimer;
  }, [
    playing,
    asset?.id,
    idsKey,
    JSON.stringify(order),
    interval,
    repeat,
    hidden,
    settingsOpen,
    menuOpen,
    playable,
    Boolean(onNavigateAsset),
  ]);
  useEffect(() => {
    if (!playable || !video.current) return;
    const element = video.current;
    if (playing && !hidden && !settingsOpen && !menuOpen) {
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
  }, [playing, playable, asset?.id, hidden, settingsOpen, menuOpen]);
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    return () => {
      try {
        element.pause();
      } catch {}
    };
  }, [playable, asset?.id, media.video]);
  useEffect(() => {
    if (menuOpen) menu.current?.querySelector("button:not(:disabled)")?.focus();
  }, [menuOpen]);
  useEffect(() => {
    if (settingsOpen)
      dialog.current?.querySelector('[aria-label="Photo duration"]')?.focus();
  }, [settingsOpen]);
  function setScale(next) {
    play(false);
    setZoom(Math.max(1, Math.min(32, next)));
    setPan({ x: 0, y: 0 });
  }
  function size() {
    return {
      width: stage.current?.clientWidth || 1,
      height: stage.current?.clientHeight || 1,
    };
  }
  function startPan(event) {
    if (zoom <= 1 || event.button > 0 || event.target.closest?.("button,video"))
      return;
    drag.current = { x: event.clientX, y: event.clientY, pan };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }
  function movePan(event) {
    if (!drag.current) return;
    const viewport = size(),
      dimensions = fitDimensions(
        natural?.width,
        natural?.height,
        viewport.width,
        viewport.height,
      );
    setPan(
      clampPan(
        {
          x: drag.current.pan.x + event.clientX - drag.current.x,
          y: drag.current.pan.y + event.clientY - drag.current.y,
        },
        dimensions,
        viewport,
        zoom,
      ),
    );
  }
  async function action(callback, ...args) {
    const actingId = latest.current.asset?.id;
    if (!actingId || typeof callback !== "function") return;
    play(false);
    setMenuOpen(false);
    const failed = () => {
      if (alive.current && latest.current.asset?.id === actingId)
        setError("The action could not be completed. Try again.");
    };
    try {
      if ((await callback(...args)) === false) failed();
    } catch {
      failed();
    }
  }
  function moreAction(id) {
    action(onAction, id, asset.id);
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
      const elements = [
        ...dialog.current.querySelectorAll(
          'button:not(:disabled),input:not(:disabled),select:not(:disabled),video[controls],[tabindex="0"]',
        ),
      ].filter((el) => !el.closest("[hidden]"));
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
      } else if (settingsOpen) {
        setSettingsOpen(false);
        dialog.current
          ?.querySelector('.mv-footer [aria-label="Slideshow settings"]')
          ?.focus();
      } else close();
      return;
    }
    if (
      event.target.closest?.(
        'input,select,textarea,[contenteditable="true"],video',
      )
    )
      return;
    const key = event.key.toLowerCase();
    if (menuOpen && ["arrowdown", "arrowup", "home", "end"].includes(key)) {
      event.preventDefault();
      const items = [...menu.current.querySelectorAll("button:not(:disabled)")],
        index = items.indexOf(document.activeElement);
      items[
        key === "home"
          ? 0
          : key === "end"
            ? items.length - 1
            : (index + (key === "arrowdown" ? 1 : -1) + items.length) %
              items.length
      ]?.focus();
      return;
    }
    if (key === "arrowright" || key === "arrowleft") {
      event.preventDefault();
      step(key === "arrowright" ? 1 : -1);
    } else if (key === " " && event.target.tagName !== "BUTTON") {
      event.preventDefault();
      play(!playing);
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
    } else if ((key === "+" || key === "=") && !media.isVideo) {
      event.preventDefault();
      setScale(zoom * 1.25);
    } else if (key === "-" && !media.isVideo) {
      event.preventDefault();
      setScale(zoom / 1.25);
    } else if ((key === "0" || key === "z") && !media.isVideo) {
      event.preventDefault();
      setScale(zoom === 1 ? 2 : 1);
    }
  }
  if (!asset) return null;
  const index = collection.findIndex((item) => item.id === asset.id),
    readOnly = asset.readOnly === true || asset.canEdit === false,
    archive = asset.visibility === "archive" || asset.isArchived;
  const options = [
    ["download", "Download"],
    ...(asset.isEdited ? [["download-original", "Download original"]] : []),
    ...(!readOnly
      ? [
          ["add-to-album", "Add to album"],
          [
            archive ? "unarchive" : "archive",
            archive ? "Unarchive" : "Archive",
          ],
          ["stack", "Add to stack"],
          ["lock", "Mark Sensitive"],
          ["unlock", "Unmark Sensitive"],
        ]
      : []),
    ["view-in-timeline", "View in timeline"],
    ["find-similar", "Find similar"],
    ...(asset.city || asset.latitude != null
      ? [["view-on-map", "View on map"]]
      : []),
  ].filter(
    ([id]) =>
      onAction &&
      availableActions.includes(id) &&
      !(id.startsWith("download") && asset.canDownload === false),
  );
  const position = `${index + 1} of ${collection.length}`,
    name = asset.name || asset.originalFileName || "Photo",
    metadata = viewerMetadata(asset);
  return (
    <dialog
      ref={dialog}
      className="media-viewer"
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
      <div className={`mv-shell ${showInfo ? "with-info" : ""}`}>
        <header className="mv-header">
          <button
            className="mv-tool mv-close"
            type="button"
            ref={closeButton}
            aria-label="Close viewer"
            title="Close viewer (Escape)"
            onClick={close}
          >
            {icon(mdiArrowLeft)}
          </button>
          <div className="mv-title">
            <strong>{name}</strong>
            <span>
              {position}
              {media.isVideo ? " · Video" : ""}
            </span>
          </div>
          <div className="mv-actions" aria-label="Media actions">
            {onShare && viewerCanShare(asset) && (
              <Tool
                label="Share"
                path={mdiShareVariantOutline}
                onClick={() => action(onShare, asset.id)}
              />
            )}
            <Tool
              label="Photo information"
              path={mdiInformationOutline}
              active={showInfo}
              aria-pressed={showInfo}
              onClick={() => {
                play(false);
                setShowInfo((value) => !value);
              }}
            />
            {onFavorite && !readOnly && (
              <Tool
                label={
                  asset.favorite || asset.isFavorite
                    ? "Remove from favorites"
                    : "Add to favorites"
                }
                path={
                  asset.favorite || asset.isFavorite
                    ? mdiHeart
                    : mdiHeartOutline
                }
                active={asset.favorite || asset.isFavorite}
                aria-pressed={Boolean(asset.favorite || asset.isFavorite)}
                onClick={() => action(onFavorite, asset.id)}
              />
            )}
            {onEdit && !readOnly && (
              <Tool
                label="Edit"
                path={mdiPencilOutline}
                onClick={() =>
                  action(onEdit, asset.id, {
                    currentTime: video.current?.currentTime || 0,
                  })
                }
              />
            )}
            {onTrash && !readOnly && (
              <Tool
                label="Move to trash"
                path={mdiDeleteOutline}
                onClick={() => action(onTrash, asset.id)}
              />
            )}
            <div className="mv-menu-wrap">
              <button
                ref={menuButton}
                className="mv-tool"
                type="button"
                aria-label="More actions"
                aria-expanded={menuOpen}
                aria-haspopup="menu"
                onClick={() => setMenuOpen((value) => !value)}
              >
                {icon(mdiDotsHorizontal)}
              </button>
              {menuOpen && (
                <div className="mv-menu" role="menu" ref={menu}>
                  {options.map(([id, label]) => (
                    <button
                      type="button"
                      key={id}
                      role="menuitem"
                      onClick={() => moreAction(id)}
                    >
                      {label}
                    </button>
                  ))}
                  <button
                    type="button"
                    role="menuitem"
                    disabled={!onNavigateAsset || collection.length < 2}
                    onClick={() => {
                      setMenuOpen(false);
                      play(!playing);
                    }}
                  >
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
                    Slideshow settings
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>
        <main
          className="mv-canvas"
          ref={stage}
          tabIndex={0}
          aria-label={
            media.isVideo ? "Video viewing area" : "Image viewing area"
          }
          onPointerDown={startPan}
          onPointerMove={movePan}
          onPointerUp={() => (drag.current = null)}
          onPointerCancel={() => (drag.current = null)}
          onDoubleClick={(event) => {
            if (!media.isVideo && !event.target.closest?.("button"))
              setScale(zoom === 1 ? 2 : 1);
          }}
          style={{
            cursor: zoom > 1 ? "grab" : undefined,
            touchAction: zoom > 1 ? "none" : "pan-y",
          }}
        >
          {playable ? (
            <video
              key={`${asset.id}:${media.video}`}
              ref={video}
              src={media.video}
              poster={media.image || undefined}
              controls
              playsInline
              preload="metadata"
              aria-label={name}
              onLoadedMetadata={(event) => {
                if (latest.current.asset?.id !== asset.id) return;
                const time = Number(latest.current.initialTime);
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
                setVideoError(media.video);
                setError(
                  "This video could not be played. Its preview is still available.",
                );
              }}
            />
          ) : media.image && imageError !== media.image ? (
            <img
              key={`${asset.id}:${media.image}`}
              className={`mv-image ${look === "fill" && playing ? "fill" : ""}`}
              src={media.image}
              alt={name}
              draggable="false"
              style={{
                transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              }}
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
          ) : (
            <div className="mv-unavailable">
              <strong>Image unavailable</strong>
              <span>The source could not be displayed. Try another item.</span>
            </div>
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
                path={mdiChevronLeft}
                className="mv-tool mv-side previous"
                onClick={() => step(-1)}
              />
              <Tool
                label="Next item"
                path={mdiChevronRight}
                className="mv-tool mv-side next"
                onClick={() => step(1)}
              />
            </>
          )}
          {playing &&
            overlay !== "off" &&
            (asset.description || overlay === "details") && (
              <div className="mv-caption">
                <strong>{asset.description || name}</strong>
                {overlay === "details" && (
                  <span>
                    {[asset.date, asset.city, asset.make, asset.model]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                )}
              </div>
            )}
        </main>
        {showInfo && (
          <aside className="mv-info" aria-label="Media information">
            <header>
              <h2>Information</h2>
              <Tool
                label="Close information"
                path={mdiClose}
                onClick={() => setShowInfo(false)}
              />
            </header>
            {asset.description && (
              <p className="mv-description">{asset.description}</p>
            )}
            <dl>
              {metadata.map((item) => (
                <div key={item.label}>
                  <dt>{item.label}</dt>
                  <dd>{item.value}</dd>
                </div>
              ))}
            </dl>
            {(onTagPeople || asset.people?.length > 0) && (
              <section>
                <div className="mv-people-heading">
                  <h3>People</h3>
                  {onTagPeople && !readOnly && (
                    <button
                      type="button"
                      aria-label="Add person"
                      onClick={() => action(onTagPeople, asset.id)}
                    >
                      Add
                    </button>
                  )}
                </div>
                <div className="mv-people-list">
                  {(asset.personIds || asset.people || []).map((id, i) => {
                    const person = personProfiles.find(
                      (person) => person.id === id || person.name === id,
                    ) || { name: typeof id === "string" ? id : id.name };
                    return (
                      <div className="mv-person" key={person.id || i}>
                        <PersonAvatar person={person} size={38} />
                        <span>{person.name}</span>
                      </div>
                    );
                  })}
                  {!asset.people?.length && (
                    <p className="mv-no-people">No people tagged yet.</p>
                  )}
                </div>
              </section>
            )}
            {asset.tags?.length > 0 && (
              <section>
                <h3>Tags</h3>
                <div className="mv-chips">
                  {asset.tags.map((tag, i) => (
                    <span key={tag.id || i}>
                      {typeof tag === "string" ? tag : tag.name}
                    </span>
                  ))}
                </div>
              </section>
            )}
            {asset.ocr && (
              <section>
                <h3>Text in this photo</h3>
                <p className="mv-ocr">{asset.ocr}</p>
              </section>
            )}
          </aside>
        )}
        <footer className="mv-footer">
          <div className="mv-playback">
            <Tool
              label={playing ? "Pause slideshow" : "Play slideshow"}
              path={playing ? mdiPause : mdiPlay}
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
              path={mdiCogOutline}
              active={settingsOpen}
              aria-expanded={settingsOpen}
              onClick={() => setSettingsOpen((value) => !value)}
            />
          </div>
          <span className="mv-key-hint">
            ← → Browse <span>·</span> Esc Close
          </span>
          <div className="mv-zoom">
            {!media.isVideo && (
              <>
                <Tool
                  label="Zoom out"
                  path={mdiMagnifyMinusOutline}
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
                  path={mdiMagnifyPlusOutline}
                  disabled={zoom >= 32}
                  onClick={() => setScale(zoom * 1.25)}
                />
              </>
            )}
            <Tool
              label={fullscreen ? "Exit full screen" : "Enter full screen"}
              path={fullscreen ? mdiFullscreenExit : mdiFullscreen}
              disabled={
                !dialog.current?.requestFullscreen &&
                !(typeof document !== "undefined" && document.fullscreenEnabled)
              }
              onClick={toggleFullscreen}
            />
          </div>
        </footer>
        {settingsOpen && (
          <section
            className="mv-slideshow-settings"
            aria-label="Slideshow settings"
          >
            <header>
              <h2>Slideshow</h2>
              <Tool
                label="Close slideshow settings"
                path={mdiClose}
                onClick={() => setSettingsOpen(false)}
              />
            </header>
            <label>
              Photo duration
              <select
                aria-label="Photo duration"
                value={interval}
                onChange={(event) =>
                  setIntervalSeconds(Number(event.target.value))
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
                value={look}
                onChange={(event) => setLook(event.target.value)}
              >
                <option value="fit">Fit entire photo</option>
                <option value="fill">Fill screen</option>
              </select>
            </label>
            <label>
              Caption
              <select
                aria-label="Slideshow caption"
                value={overlay}
                onChange={(event) => setOverlay(event.target.value)}
              >
                <option value="off">Off</option>
                <option value="description">Description</option>
                <option value="details">Description & details</option>
              </select>
            </label>
            <label className="mv-check">
              <input
                type="checkbox"
                checked={shuffle}
                onChange={(event) => setShuffle(event.target.checked)}
              />
              Shuffle
            </label>
            <label className="mv-check">
              <input
                type="checkbox"
                checked={repeat}
                onChange={(event) => setRepeat(event.target.checked)}
              />
              Repeat collection
            </label>
            <p>Videos play to their end. Photos follow the interval above.</p>
          </section>
        )}
        {error && (
          <div className="mv-error" role="alert">
            <span>{error}</span>
            <Tool
              label="Dismiss viewer message"
              path={mdiClose}
              onClick={() => setError("")}
            />
          </div>
        )}
      </div>
    </dialog>
  );
}
