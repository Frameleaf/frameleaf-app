import React, {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Icon } from "./Icon";
import { AssetTile } from "./AssetTile";
import { justifiedRows, rowHeightFor } from "./justified-layout.mjs";
import { groupSelectionState } from "./selection.mjs";
import { isMacPlatform } from "./shortcuts.mjs";
import {
  assetMonthId,
  scrubberMonthAt,
  timelineGroups,
  timelineScrubber,
} from "./explore-timeline.mjs";
import {
  drillTarget,
  firstGroupWithPrefix,
  timelineCards,
} from "./timeline-highlights.mjs";
import "./timeline-library.css";

// Coarse to fine. ⌘/Ctrl+wheel and pinch step through this list.
const MODES = ["all", "years", "months", "days"];
const MODE_LABELS = {
  years: "Years",
  months: "Months",
  days: "Days",
  all: "All",
};
const GAP = 4;
const HEADER_OFFSET = 48;
const WHEEL_STEP = 60;
const PINCH_STEP = 56;

const groupingMode = (value) =>
  ({ day: "days", month: "months", year: "years" })[value] ||
  (MODES.includes(value) ? value : "days");
const clamp01 = (value) => Math.min(1, Math.max(0, value));
const reducedMotion = () =>
  typeof matchMedia === "function" &&
  matchMedia("(prefers-reduced-motion: reduce)").matches;
function scrollParent(element) {
  let node = element?.parentElement;
  while (node) {
    const { overflowY } = getComputedStyle(node);
    if (/(auto|scroll)/.test(overflowY)) return node;
    node = node.parentElement;
  }
  return null;
}
function useContainerWidth(ref, fallback = 960) {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const measure = () =>
      setWidth(Math.round(element.getBoundingClientRect().width));
    measure();
    if (typeof ResizeObserver === "undefined") {
      addEventListener("resize", measure);
      return () => removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width || fallback;
}

/**
 * Justified, date-grouped library with sticky headers and a draggable scrubber.
 * Callbacks: onSelect(id, event), onSelectGroup(ids, checked), onOpen(id),
 * onFavorite(id), onEdit(id), onShare(id), onMore(id, event),
 * onGroupingChange("years"|"months"|"days"|"all").
 */
export function TimelineLibrary({
  assets = [],
  selected = new Set(),
  onSelect,
  onSelectGroup,
  onOpen,
  onFavorite,
  onEdit,
  onShare,
  onMore,
  ratings,
  grouping = "day",
  onGroupingChange,
  order = "desc",
  showCaptions = false,
  rowHeight,
  // The library's Thumbnail size slider scales the responsive default height.
  rowScale = 1,
}) {
  const rootRef = useRef(null);
  const groupsRef = useRef(null);
  const [localGrouping, setLocalGrouping] = useState(null);
  const [currentMonthId, setCurrentMonthId] = useState(null);
  const [announcement, setAnnouncement] = useState("");
  const [trackHeight, setTrackHeight] = useState(480);
  const mode = localGrouping ?? groupingMode(grouping);
  useEffect(() => setLocalGrouping(null), [grouping]);

  const selectedIds = useMemo(
    () => (selected instanceof Set ? selected : new Set(selected || [])),
    [selected],
  );
  const selecting = selectedIds.size > 0;
  const groups = useMemo(
    () => timelineGroups(assets, mode === "days" ? "day" : mode, order),
    [assets, mode, order],
  );
  // Years and Months are curated card views; Days and All show every item.
  const curated = mode === "years" || mode === "months";
  const cards = useMemo(
    () => (curated ? timelineCards(assets, mode, { order }) : []),
    [assets, mode, order, curated],
  );
  const scrubber = useMemo(
    () => timelineScrubber(assets, order),
    [assets, order],
  );
  const assetById = useMemo(
    () => new Map(assets.map((asset) => [asset.id, asset])),
    [assets],
  );
  const stackCounts = useMemo(() => {
    const counts = new Map();
    for (const asset of assets)
      if (asset.stackId)
        counts.set(asset.stackId, (counts.get(asset.stackId) || 0) + 1);
    return counts;
  }, [assets]);
  const width = useContainerWidth(groupsRef);
  const targetRowHeight = Number.isFinite(rowHeight)
    ? rowHeight
    : Math.round(rowHeightFor(width) * rowScale);
  const layouts = useMemo(
    () =>
      (curated ? [] : groups).map((group) =>
        justifiedRows(group.assets, {
          containerWidth: width,
          targetRowHeight,
          gap: GAP,
          maxRowHeight: Math.round(targetRowHeight * 1.25),
        }),
      ),
    [groups, width, targetRowHeight, curated],
  );
  const ratingFor = (asset) =>
    typeof ratings === "function"
      ? ratings(asset)
      : ratings && typeof ratings === "object"
        ? (ratings[asset.id] ?? asset.rating)
        : asset.rating;

  const changeGrouping = (value) => {
    if (!MODES.includes(value) || value === mode) return;
    setAnnouncement(`Grouped by ${MODE_LABELS[value].toLowerCase()}`);
    if (onGroupingChange) onGroupingChange(value);
    else setLocalGrouping(value);
  };
  const stepGrouping = (delta) => {
    const index = MODES.indexOf(mode);
    changeGrouping(
      MODES[Math.min(MODES.length - 1, Math.max(0, index + delta))],
    );
  };
  // Opening a year or month card steps one level finer and scrolls there.
  const pendingDrill = useRef(null);
  const openCard = (card) => {
    const target = drillTarget(card);
    if (!target) return;
    pendingDrill.current = target.groupPrefix;
    changeGrouping(target.grouping);
  };
  useLayoutEffect(() => {
    const prefix = pendingDrill.current;
    if (!prefix) return;
    pendingDrill.current = null;
    const container = groupsRef.current;
    const id = firstGroupWithPrefix(
      groups.map((group) => group.id),
      prefix,
    );
    const element = id && container?.querySelector(`[data-group-id="${id}"]`);
    if (!element) return;
    const scroller = scrollParent(container);
    if (scroller)
      scroller.scrollBy({
        top:
          element.getBoundingClientRect().top -
          scroller.getBoundingClientRect().top,
      });
    else element.scrollIntoView({ block: "start" });
  }, [mode, groups]);
  const latest = useRef({});
  latest.current = { mode, stepGrouping };

  // ⌘/Ctrl + wheel (also trackpad pinch) and two-finger pinch step the grouping.
  useEffect(() => {
    const element = rootRef.current;
    if (!element) return undefined;
    let wheelTotal = 0;
    let cooldown = 0;
    const onWheel = (event) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      const now = Date.now();
      if (now < cooldown) return;
      wheelTotal += event.deltaY;
      if (Math.abs(wheelTotal) < WHEEL_STEP) return;
      latest.current.stepGrouping(wheelTotal > 0 ? -1 : 1);
      wheelTotal = 0;
      cooldown = now + 300;
    };
    const touches = new Map();
    let pinchStart = 0;
    const distance = () => {
      const [a, b] = [...touches.values()];
      return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
    };
    const onPointerDown = (event) => {
      if (event.pointerType !== "touch") return;
      touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (touches.size === 2) pinchStart = distance();
    };
    const onPointerMove = (event) => {
      if (!touches.has(event.pointerId)) return;
      touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (touches.size !== 2 || !pinchStart) return;
      const delta = distance() - pinchStart;
      if (Math.abs(delta) < PINCH_STEP) return;
      latest.current.stepGrouping(delta > 0 ? 1 : -1);
      pinchStart = distance();
    };
    const onPointerEnd = (event) => {
      touches.delete(event.pointerId);
      if (touches.size < 2) pinchStart = 0;
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    element.addEventListener("pointerdown", onPointerDown);
    element.addEventListener("pointermove", onPointerMove);
    element.addEventListener("pointerup", onPointerEnd);
    element.addEventListener("pointercancel", onPointerEnd);
    return () => {
      element.removeEventListener("wheel", onWheel);
      element.removeEventListener("pointerdown", onPointerDown);
      element.removeEventListener("pointermove", onPointerMove);
      element.removeEventListener("pointerup", onPointerEnd);
      element.removeEventListener("pointercancel", onPointerEnd);
    };
  }, []);

  // Keep the scrubber marker in step with the scroll position.
  useEffect(() => {
    const root = rootRef.current;
    const scroller = scrollParent(root);
    const target = scroller || window;
    let frame = 0;
    const update = () => {
      frame = 0;
      const container = groupsRef.current;
      if (!container) return;
      const top = scroller ? scroller.getBoundingClientRect().top : 0;
      const rows = container.querySelectorAll(".tl-row, .tl-card");
      let id = null;
      for (const row of rows) {
        if (row.getBoundingClientRect().bottom > top + HEADER_OFFSET) {
          id =
            row.dataset.firstAsset ??
            row.querySelector("[data-asset-id]")?.dataset.assetId ??
            null;
          break;
        }
      }
      const asset = id ? assetById.get(id) : null;
      setCurrentMonthId(asset ? assetMonthId(asset) : null);
      if (scroller) setTrackHeight(Math.max(200, scroller.clientHeight - 72));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    target.addEventListener("scroll", schedule, { passive: true });
    addEventListener("resize", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      target.removeEventListener("scroll", schedule);
      removeEventListener("resize", schedule);
    };
  }, [assetById, layouts]);

  const jumpTo = (month, behavior = "smooth") => {
    if (!month) return;
    const container = groupsRef.current;
    const escaped =
      typeof CSS !== "undefined" && CSS.escape
        ? CSS.escape(month.firstAssetId)
        : String(month.firstAssetId).replace(/["\\]/g, "\\$&");
    // Card views have no tiles: fall back to the month's card, then the year's.
    const tile =
      container?.querySelector(`[data-asset-id="${escaped}"]`) ||
      container?.querySelector(`.tl-card[data-group-id="${month.id}"]`) ||
      container?.querySelector(`.tl-card[data-group-id="${month.year}"]`);
    if (!tile) return;
    const scroller = scrollParent(container);
    const smooth = behavior === "smooth" && !reducedMotion();
    if (scroller) {
      const offset =
        tile.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top -
        HEADER_OFFSET;
      scroller.scrollBy({ top: offset, behavior: smooth ? "smooth" : "auto" });
    } else
      tile.scrollIntoView({
        block: "start",
        behavior: smooth ? "smooth" : "auto",
      });
    setCurrentMonthId(month.id);
  };

  const hint = isMacPlatform()
    ? "Hold ⌘ and scroll, or pinch, to change grouping"
    : "Hold Ctrl and scroll, or pinch, to change grouping";

  return (
    <section
      className={`timeline-library${selecting ? " is-selecting" : ""}`}
      aria-label="Photo timeline"
      ref={rootRef}
    >
      <div className="tl-toolbar">
        <span className="tl-hint">{hint}</span>
        <div
          role="group"
          aria-label="Timeline grouping"
          className="tl-segmented"
        >
          {["years", "months", "days", "all"].map((value) => (
            <button
              type="button"
              key={value}
              aria-pressed={mode === value}
              onClick={() => changeGrouping(value)}
            >
              {MODE_LABELS[value]}
            </button>
          ))}
        </div>
      </div>
      <div className="tl-live" role="status" aria-live="polite">
        {announcement}
      </div>
      {!groups.length ? (
        <div className="tl-empty" role="status">
          <Icon name="mdiCalendarRange" size={30} />
          <p>No photos or videos in this view.</p>
        </div>
      ) : (
        <div className="tl-layout">
          <div
            className={`tl-groups${curated ? ` is-curated tl-cards-${mode}` : ""}`}
            ref={groupsRef}
            style={{ "--tl-gap": `${GAP}px` }}
            role={curated ? "list" : undefined}
            aria-label={curated ? MODE_LABELS[mode] : undefined}
          >
            {curated &&
              cards.map((card) => (
                <TimelineCard key={card.id} card={card} onOpen={openCard} />
              ))}
            {!curated &&
              groups.map((group, index) => {
                const ids = group.assets.map((asset) => asset.id);
                const state = groupSelectionState(ids, selectedIds);
                const headingId = `tl-group-${group.id}`;
                return (
                  <section
                    className="tl-group"
                    key={group.id}
                    data-group-id={group.id}
                    aria-labelledby={headingId}
                  >
                    <header className="tl-group-header">
                      <label
                        className={`tl-group-select${state !== "none" ? " is-active" : ""}`}
                      >
                        <input
                          type="checkbox"
                          checked={state === "all"}
                          ref={(element) => {
                            if (element)
                              element.indeterminate = state === "some";
                          }}
                          aria-label={`Select all in ${group.title}`}
                          onChange={(event) =>
                            onSelectGroup?.(ids, event.target.checked)
                          }
                        />
                        <span aria-hidden="true">
                          {state === "all" && (
                            <Icon name="mdiCheck" size={13} />
                          )}
                          {state === "some" && (
                            <Icon name="mdiMinus" size={13} />
                          )}
                        </span>
                      </label>
                      <h2 id={headingId}>{group.title}</h2>
                      <span className="tl-group-count">
                        {group.assets.length}{" "}
                        {group.assets.length === 1 ? "item" : "items"}
                      </span>
                    </header>
                    <div className="tl-rows">
                      {layouts[index].map((row, rowIndex) => (
                        <div className="tl-row" key={rowIndex}>
                          {row.items.map(
                            ({ item, width: tileWidth, height }) => (
                              <AssetTile
                                key={item.id}
                                asset={item}
                                layout="timeline"
                                selected={selectedIds.has(item.id)}
                                selecting={selecting}
                                rating={ratingFor(item)}
                                stackCount={
                                  item.stackId
                                    ? stackCounts.get(item.stackId)
                                    : undefined
                                }
                                showCaption={showCaptions}
                                style={{
                                  width: tileWidth,
                                  "--tl-h": `${height}px`,
                                }}
                                onOpen={onOpen}
                                onToggleSelect={(event) =>
                                  onSelect?.(item.id, event)
                                }
                                onFavorite={onFavorite}
                                onEdit={onEdit}
                                onShare={onShare}
                                onMore={onMore}
                              />
                            ),
                          )}
                        </div>
                      ))}
                    </div>
                  </section>
                );
              })}
          </div>
          {scrubber.total > 0 && (
            <TimelineScrubber
              model={scrubber}
              currentMonthId={currentMonthId}
              trackHeight={trackHeight}
              onJump={jumpTo}
            />
          )}
        </div>
      )}
    </section>
  );
}

const plural = (count) => `${count} ${count === 1 ? "item" : "items"}`;

/** One curated Years or Months card: key photo, title, count and places. */
function TimelineCard({ card, onOpen }) {
  const year = card.kind === "year";
  const title = year ? (card.year ?? card.title) : card.title;
  const meta = [plural(card.count), card.placeLabel]
    .filter(Boolean)
    .join(" · ");
  return (
    <article
      className={`tl-card tl-card-${card.kind}`}
      role="listitem"
      data-group-id={card.id}
      data-first-asset={card.firstAssetId ?? undefined}
    >
      <button
        type="button"
        className="tl-card-open"
        aria-label={`${title}, ${meta}. Show ${year ? "months" : "days"}`}
        onClick={() => onOpen(card)}
      >
        <span className="tl-card-media">
          {card.key?.image ? (
            <img src={card.key.image} alt="" loading="lazy" decoding="async" />
          ) : (
            <Icon name="mdiImageOutline" size={32} />
          )}
          <span className="tl-card-caption">
            <span className="tl-card-title">{title}</span>
            <span className="tl-card-meta">{meta}</span>
          </span>
        </span>
        {card.highlights.length > 0 && (
          <span className="tl-card-strip" aria-hidden="true">
            {card.highlights.map((asset) => (
              <img
                key={asset.id}
                src={asset.image}
                alt=""
                loading="lazy"
                decoding="async"
              />
            ))}
          </span>
        )}
      </button>
    </article>
  );
}

function TimelineScrubber({ model, currentMonthId, trackHeight, onJump }) {
  const trackRef = useRef(null);
  const [hover, setHover] = useState(null);
  const [dragging, setDragging] = useState(false);
  const lastJump = useRef(null);
  const months = model.months;
  const maxCount = Math.max(1, ...months.map((month) => month.count));
  const currentIndex = Math.max(
    0,
    months.findIndex((month) => month.id === currentMonthId),
  );
  const current = months[currentIndex];
  const fractionAt = (clientY) => {
    const rect = trackRef.current.getBoundingClientRect();
    return rect.height ? clamp01((clientY - rect.top) / rect.height) : 0;
  };
  const jumpDuringDrag = (month) => {
    if (!month || lastJump.current === month.id) return;
    lastJump.current = month.id;
    onJump(month, "auto");
  };
  const pointerDown = (event) => {
    if (event.button !== 0 && event.pointerType === "mouse") return;
    event.preventDefault();
    trackRef.current.setPointerCapture?.(event.pointerId);
    const fraction = fractionAt(event.clientY);
    const month = scrubberMonthAt(model, fraction);
    setDragging(true);
    setHover({ fraction, month });
    lastJump.current = null;
    jumpDuringDrag(month);
  };
  const pointerMove = (event) => {
    const fraction = fractionAt(event.clientY);
    const month = scrubberMonthAt(model, fraction);
    setHover({ fraction, month });
    if (dragging) jumpDuringDrag(month);
  };
  const pointerUp = (event) => {
    if (!dragging) return;
    setDragging(false);
    trackRef.current.releasePointerCapture?.(event.pointerId);
    if (event.pointerType === "touch") setHover(null);
  };
  const pointerLeave = () => {
    if (!dragging) setHover(null);
  };
  const keyDown = (event) => {
    const step = { ArrowUp: -1, ArrowDown: 1, PageUp: -3, PageDown: 3 }[
      event.key
    ];
    let next = null;
    if (step)
      next = Math.min(months.length - 1, Math.max(0, currentIndex + step));
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = months.length - 1;
    if (next === null) return;
    event.preventDefault();
    onJump(months[next], "smooth");
  };
  const labelHeight = 18;
  const bubble = hover?.month || (dragging ? current : null);
  const bubbleFraction = hover ? hover.fraction : (current?.center ?? 0);
  return (
    <div className="tl-scrubber" style={{ "--tl-track": `${trackHeight}px` }}>
      <div
        ref={trackRef}
        className={`tl-scrub-track${dragging ? " is-dragging" : ""}`}
        role="slider"
        tabIndex={0}
        aria-label="Jump to a month"
        aria-orientation="vertical"
        aria-valuemin={0}
        aria-valuemax={Math.max(0, months.length - 1)}
        aria-valuenow={currentIndex}
        aria-valuetext={
          current
            ? `${current.label}, ${current.count} ${current.count === 1 ? "item" : "items"}`
            : ""
        }
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={pointerUp}
        onPointerCancel={pointerUp}
        onPointerLeave={pointerLeave}
        onKeyDown={keyDown}
      >
        {model.years.map((year) => (
          <React.Fragment key={year.year}>
            <i
              className="tl-scrub-yeartick"
              style={{ top: `${year.start * 100}%` }}
              aria-hidden="true"
            />
            {(year.end - year.start) * trackHeight >= labelHeight && (
              <span
                className="tl-scrub-year"
                style={{ top: `${year.start * 100}%` }}
                aria-hidden="true"
              >
                {year.year}
              </span>
            )}
          </React.Fragment>
        ))}
        {months.map((month) => (
          <i
            key={month.id}
            className={`tl-scrub-tick${month.id === currentMonthId ? " is-current" : ""}`}
            style={{
              top: `${month.center * 100}%`,
              width: `${4 + Math.round((month.count / maxCount) * 8)}px`,
            }}
            aria-hidden="true"
          />
        ))}
        {current && (
          <span
            className="tl-scrub-marker"
            style={{ top: `${current.center * 100}%` }}
            aria-hidden="true"
          />
        )}
        {bubble && (
          <div
            className="tl-scrub-bubble"
            style={{ top: `${bubbleFraction * 100}%` }}
            aria-hidden="true"
          >
            {bubble.label}
            <small>
              {bubble.count} {bubble.count === 1 ? "item" : "items"}
            </small>
          </div>
        )}
      </div>
    </div>
  );
}
