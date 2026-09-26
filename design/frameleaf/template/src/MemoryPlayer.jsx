import React, {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { Icon } from "./Icon";
import { PersonAvatar } from "./People";
import { captureDate, videoAsset } from "./explore-timeline.mjs";
import {
  longDay,
  memoriesFor,
  memoryOverrides,
  readMemoryOverrides,
  writeMemoryOverrides,
} from "./discovery-data.mjs";
import {
  MEMORY_PHOTO_MS as PHOTO_MS,
  MEMORY_TITLE_MS as TITLE_MS,
  memoryCountLabel as countLabel,
  memoryLowerThird,
  memoryMotion,
  memorySlideClass,
  memoryTitleCard,
} from "./memory-engine.mjs";
import { prefersReducedMotion } from "./interactions.js";
import "./discovery.css";
import "./memories.css";

const isoToday = () => new Date().toISOString().slice(0, 10);

function Tool({
  label,
  icon,
  onClick,
  active,
  disabled,
  pressed,
  primary,
  className = "",
}) {
  return (
    <button
      type="button"
      className={`mp-tool${active ? " active" : ""}${primary ? " primary" : ""} ${className}`}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon name={icon} size={primary ? 26 : 20} />
    </button>
  );
}

export function MemoryPlayer({
  memory,
  assets = [],
  people = [],
  memories = null,
  overrides,
  onClose,
  onChange,
  onShare,
  onViewInTimeline,
  onStudio,
  onOpenAsset,
  onSelectMemory,
  onFavoriteAsset,
  today = isoToday(),
}) {
  const dialog = useRef(null);
  const video = useRef(null);
  const frame = useRef(null);
  const titleId = useId();
  const [local, setLocal] = useState(() => overrides || readMemoryOverrides());
  const current = overrides ?? local;
  const removed = useMemo(
    () => new Set(current.removed[memory?.id] || []),
    [current, memory],
  );
  const items = useMemo(
    () =>
      (memory?.assetIds || [])
        .filter((id) => !removed.has(id))
        .map((id) => assets.find((asset) => asset.id === id))
        .filter(Boolean),
    [memory, assets, removed],
  );
  const list = useMemo(
    () => memories || memoriesFor(assets, { today, overrides: current }).all,
    [memories, assets, today, current],
  );
  const position = list.findIndex((entry) => entry.id === memory?.id);
  const previousMemory = position > 0 ? list[position - 1] : null;
  const nextMemory =
    position >= 0 && position < list.length - 1 ? list[position + 1] : null;

  const [index, setIndex] = useState(-1);
  const [playing, setPlaying] = useState(true);
  const [soundtrack, setSoundtrack] = useState(false);
  const [gallery, setGallery] = useState(false);
  const [progress, setProgress] = useState(0);
  const [toast, setToast] = useState(null);
  const [status, setStatus] = useState("");
  const item = index >= 0 && index < items.length ? items[index] : null;
  const ended = index >= items.length;
  const isVideo = item ? videoAsset(item) : false;

  // Native dialog lifecycle with focus restore.
  useEffect(() => {
    const element = dialog.current;
    const previous = document.activeElement;
    element?.showModal?.();
    element?.querySelector("[data-initial-focus]")?.focus();
    return () => {
      if (element?.open) element.close();
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  // Reset when the memory changes.
  useEffect(() => {
    setIndex(-1);
    setProgress(0);
    setPlaying(true);
    setGallery(false);
  }, [memory?.id]);

  const go = useCallback(
    (next) => {
      setIndex(Math.max(-1, Math.min(items.length, next)));
      setProgress(0);
    },
    [items.length],
  );
  const advance = useCallback(() => go(index + 1), [go, index]);

  // Photo and title-card timers use a frame loop so pausing keeps progress.
  useEffect(() => {
    if (!playing || ended || gallery || (item && isVideo)) return undefined;
    const duration = index === -1 ? TITLE_MS : PHOTO_MS;
    const start = performance.now() - progress * duration;
    let last = 0;
    const tick = (now) => {
      const fraction = Math.min(1, (now - start) / duration);
      if (fraction >= 1) {
        advance();
        return;
      }
      if (now - last > 80) {
        last = now;
        setProgress(fraction);
      }
      frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame.current);
    // progress is intentionally read once at (re)start.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, index, ended, gallery, isVideo, advance]);
  useEffect(() => {
    const element = video.current;
    if (!element || !isVideo) return;
    if (playing && !gallery) element.play?.().catch?.(() => {});
    else element.pause?.();
  }, [playing, gallery, isVideo, index]);
  useEffect(() => {
    if (ended) setPlaying(false);
  }, [ended]);
  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(timer);
  }, [toast]);

  const commit = (next, change, message) => {
    writeMemoryOverrides(next);
    setLocal(next);
    onChange?.(next, change);
    if (message) setStatus(message);
  };
  const removeCurrent = () => {
    if (!item) return;
    const next = memoryOverrides.removeAsset(current, memory.id, item.id);
    commit(
      next,
      { type: "remove-asset", memoryId: memory.id, assetId: item.id },
      `${item.name || item.originalFileName} removed from this memory.`,
    );
    setToast({ assetId: item.id, name: item.name || item.originalFileName });
    if (index >= items.length - 1) go(Math.max(-1, items.length - 2));
    setProgress(0);
  };
  const undoRemove = () => {
    if (!toast) return;
    commit(
      memoryOverrides.restoreAsset(current, memory.id, toast.assetId),
      { type: "restore-asset", memoryId: memory.id, assetId: toast.assetId },
      `${toast.name} restored.`,
    );
    setToast(null);
  };
  const togglePlay = () => {
    if (ended) {
      go(0);
      setPlaying(true);
      return;
    }
    setPlaying((value) => !value);
  };
  const keyboard = (event) => {
    const tag = event.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    const key = event.key.toLowerCase();
    if (event.key === " " && tag !== "BUTTON") {
      event.preventDefault();
      togglePlay();
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      go(index + 1);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      go(index - 1);
    } else if (key === "m") {
      event.preventDefault();
      setSoundtrack((value) => !value);
    } else if (key === "g") {
      event.preventDefault();
      setGallery((value) => !value);
    } else if (event.key === "Home") {
      event.preventDefault();
      go(-1);
    } else if (event.key === "End") {
      event.preventDefault();
      go(items.length - 1);
    }
  };
  const itemPeople = item
    ? people.filter((person) =>
        (item.personIds || item.people || []).includes(person.id),
      )
    : [];
  // Same pan-and-zoom and Reduce Motion rule as the viewer's Memories slideshow.
  const reducedMotion = prefersReducedMotion();
  const motion =
    item && !isVideo
      ? memoryMotion(item.id, { reducedMotion, durationMs: PHOTO_MS + 1000 })
      : undefined;
  if (!memory) return null;
  const date = item ? captureDate(item)?.day : null;
  const card = memoryTitleCard(memory, items.length);
  const lowerThird = memoryLowerThird(item, {
    fallbackTitle: memory.title,
    day: date ? longDay(date) : "",
    video: isVideo,
  });

  return (
    <dialog
      ref={dialog}
      className={`memory-player${gallery ? " gallery-open" : ""}`}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose?.();
      }}
      // The close event is async: ignore one from a StrictMode effect re-run that
      // has already reopened the dialog.
      onClose={() => {
        if (!dialog.current?.open) onClose?.();
      }}
      onKeyDown={keyboard}
    >
      <div className="mp-progress" role="group" aria-label="Memory progress">
        {items.map((entry, position) => (
          <button
            key={entry.id}
            type="button"
            className={`mp-segment${position < index ? " done" : ""}${position === index ? " current" : ""}`}
            aria-label={`Go to item ${position + 1} of ${items.length}`}
            aria-current={position === index ? "true" : undefined}
            onClick={() => {
              go(position);
              setGallery(false);
              setPlaying(true);
            }}
          >
            <span
              style={{
                transform: `scaleX(${position < index ? 1 : position === index ? progress : 0})`,
              }}
            />
          </button>
        ))}
      </div>
      <header className="mp-header">
        <div className="mp-heading">
          <strong id={titleId}>{memory.title}</strong>
          <small>
            {memory.subtitle} · {countLabel(items.length)}
          </small>
        </div>
        <div className="mp-header-tools">
          <Tool
            label={soundtrack ? "Mute soundtrack" : "Play soundtrack"}
            icon={soundtrack ? "mdiMusicNote" : "mdiMusicNoteOutline"}
            pressed={soundtrack}
            active={soundtrack}
            onClick={() => setSoundtrack((value) => !value)}
          />
          <Tool
            label={gallery ? "Close gallery" : "Show all items"}
            icon="mdiViewGridOutline"
            pressed={gallery}
            active={gallery}
            onClick={() => setGallery((value) => !value)}
          />
          <Tool
            label="Close memory"
            icon="mdiClose"
            onClick={() => onClose?.()}
          />
        </div>
      </header>

      <main
        className="mp-stage"
        onClick={(event) => {
          if (event.target === event.currentTarget) togglePlay();
        }}
      >
        {index === -1 && (
          <section className="mp-title-card mv-title-card">
            {memory.cover?.image && (
              <img className="mp-title-bg" src={memory.cover.image} alt="" />
            )}
            <div className="mp-title-copy">
              <span className="mp-overline">{card.overline}</span>
              <h1>{card.title}</h1>
              <p>{card.subtitle}</p>
              <p className="mp-title-count">{card.count}</p>
              <button
                type="button"
                className="mp-play-large"
                data-initial-focus
                onClick={() => {
                  go(0);
                  setPlaying(true);
                }}
              >
                <Icon name="mdiPlay" size={22} />
                Play
              </button>
            </div>
          </section>
        )}
        {item && !isVideo && item.image && (
          <div
            key={`backdrop:${item.id}`}
            className="mp-backdrop"
            style={{ backgroundImage: `url("${item.image}")` }}
            aria-hidden="true"
          />
        )}
        {item && !isVideo && (
          <img
            key={`${item.id}:${index}`}
            className={`mp-photo ${memorySlideClass({ reducedMotion, paused: !playing })}`}
            style={motion}
            src={item.image}
            alt={item.description || item.name || ""}
          />
        )}
        {item && isVideo && (
          <video
            key={item.id}
            ref={video}
            className="mp-video"
            src={item.mediaSrc}
            poster={item.image}
            muted
            playsInline
            autoPlay
            preload="metadata"
            aria-label={item.name}
            onTimeUpdate={(event) => {
              const element = event.currentTarget;
              if (element.duration)
                setProgress(element.currentTime / element.duration);
            }}
            onEnded={advance}
          />
        )}
        {ended && (
          <section className="mp-end-card mv-title-card">
            {memory.cover?.image && (
              <img className="mp-title-bg" src={memory.cover.image} alt="" />
            )}
            <div className="mp-title-copy">
              <span className="mp-overline">
                {items.length ? "That was" : "Nothing left in"}
              </span>
              <h1>{memory.title}</h1>
              <p>{memory.subtitle}</p>
              <div className="mp-end-actions">
                <button
                  type="button"
                  className="mp-play-large"
                  data-initial-focus
                  onClick={() => {
                    go(items.length ? 0 : -1);
                    setPlaying(true);
                  }}
                  disabled={!items.length}
                >
                  <Icon name="mdiRepeat" size={20} />
                  Play again
                </button>
                {nextMemory && onSelectMemory && (
                  <button
                    type="button"
                    className="mp-secondary"
                    onClick={() => onSelectMemory(nextMemory.id, nextMemory)}
                  >
                    <Icon name="mdiSkipNext" size={20} />
                    Next memory: {nextMemory.title}
                  </button>
                )}
                <button
                  type="button"
                  className="mp-secondary"
                  onClick={() => onClose?.()}
                >
                  Back to memories
                </button>
              </div>
            </div>
          </section>
        )}
        {item && (
          <div
            className="mp-info mv-lower-third"
            key={`caption:${item.id}:${index}`}
            aria-live="off"
          >
            <strong>{lowerThird.place}</strong>
            {lowerThird.detail && <span>{lowerThird.detail}</span>}
            <span className="dv-sr-only">
              {item.name || item.originalFileName}
            </span>
            {itemPeople.length > 0 && (
              <span
                className="mp-people"
                aria-label={`People: ${itemPeople.map((p) => p.name).join(", ")}`}
              >
                {itemPeople.map((person) => (
                  <PersonAvatar key={person.id} person={person} size={24} />
                ))}
                <small>{itemPeople.map((p) => p.name).join(", ")}</small>
              </span>
            )}
          </div>
        )}
        {gallery && (
          <section className="mp-gallery" aria-label="All items in this memory">
            <header>
              <strong>{countLabel(items.length)}</strong>
              <small>Choose an item to jump to it</small>
            </header>
            {items.length ? (
              <div className="mp-gallery-grid">
                {items.map((entry, position) => (
                  <button
                    type="button"
                    key={entry.id}
                    className={`mp-gallery-item${position === index ? " current" : ""}`}
                    aria-label={`Item ${position + 1}: ${entry.name || entry.originalFileName}`}
                    aria-current={position === index ? "true" : undefined}
                    autoFocus={position === Math.max(0, index)}
                    onClick={() => {
                      go(position);
                      setGallery(false);
                      setPlaying(true);
                    }}
                  >
                    {entry.image ? (
                      <img src={entry.image} alt="" loading="lazy" />
                    ) : (
                      <span className="dv-cover-empty" />
                    )}
                    <span className="mp-gallery-index">{position + 1}</span>
                    {videoAsset(entry) && (
                      <span className="mp-gallery-video">
                        <Icon name="mdiPlay" size={12} />
                      </span>
                    )}
                  </button>
                ))}
              </div>
            ) : (
              <p className="mp-gallery-empty">
                Every item has been removed from this memory.
              </p>
            )}
          </section>
        )}
      </main>

      <footer className="mp-controls">
        <div className="mp-transport">
          <Tool
            label={
              previousMemory
                ? `Previous memory: ${previousMemory.title}`
                : "Previous memory"
            }
            icon="mdiSkipPrevious"
            disabled={!previousMemory || !onSelectMemory}
            onClick={() => onSelectMemory?.(previousMemory.id, previousMemory)}
          />
          <Tool
            label="Previous item"
            icon="mdiChevronLeft"
            disabled={index <= -1}
            onClick={() => go(index - 1)}
          />
          <Tool
            label={ended ? "Play again" : playing ? "Pause" : "Play"}
            icon={ended ? "mdiRepeat" : playing ? "mdiPause" : "mdiPlay"}
            primary
            onClick={togglePlay}
          />
          <Tool
            label="Next item"
            icon="mdiChevronRight"
            disabled={ended}
            onClick={() => go(index + 1)}
          />
          <Tool
            label={
              nextMemory ? `Next memory: ${nextMemory.title}` : "Next memory"
            }
            icon="mdiSkipNext"
            disabled={!nextMemory || !onSelectMemory}
            onClick={() => onSelectMemory?.(nextMemory.id, nextMemory)}
          />
        </div>
        <div className="mp-actions">
          {onFavoriteAsset && (
            <Tool
              label={
                item?.favorite ? "Remove item from favorites" : "Favorite item"
              }
              icon={item?.favorite ? "mdiHeart" : "mdiHeartOutline"}
              pressed={!!item?.favorite}
              active={!!item?.favorite}
              disabled={!item}
              onClick={() => onFavoriteAsset(item.id, !item.favorite)}
            />
          )}
          <Tool
            label="Remove from memory"
            icon="mdiPlaylistRemove"
            disabled={!item}
            onClick={removeCurrent}
          />
          {onShare && (
            <Tool
              label="Share memory"
              icon="mdiShareVariantOutline"
              disabled={!items.length}
              onClick={() =>
                onShare(
                  items.map((entry) => entry.id),
                  memory,
                )
              }
            />
          )}
          {onViewInTimeline && (
            <Tool
              label="View in timeline"
              icon="mdiTimelineClockOutline"
              disabled={!item}
              onClick={() => onViewInTimeline(item.id, memory)}
            />
          )}
          {onOpenAsset && (
            <Tool
              label="Open item"
              icon="mdiOpenInApp"
              disabled={!item}
              onClick={() => onOpenAsset(item.id)}
            />
          )}
          {onStudio && (
            <button
              type="button"
              className="mp-studio"
              onClick={() =>
                onStudio(
                  memory,
                  items.map((entry) => entry.id),
                )
              }
            >
              <Icon name="mdiMovieEditOutline" size={18} />
              <span>Make a movie in Studio</span>
            </button>
          )}
        </div>
      </footer>
      {toast && (
        <div className="mp-toast" role="status">
          <span>{toast.name} removed from this memory.</span>
          <button type="button" onClick={undoRemove}>
            Undo
          </button>
        </div>
      )}
      <output className="dv-sr-only" aria-live="polite">
        {status}
        {item &&
          ` Item ${index + 1} of ${items.length}: ${item.name || item.originalFileName}.`}
      </output>
    </dialog>
  );
}
