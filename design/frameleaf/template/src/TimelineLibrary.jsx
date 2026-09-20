import React, { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./Icon";
import {
  localCaptureTime,
  timelineGroups,
  timelineMonths,
  videoAsset,
} from "./explore-timeline.mjs";
import "./timeline-library.css";

const groupingMode = (value) =>
  ({ day: "days", month: "months", year: "years" })[value] || value;
const durationLabel = (value) => {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return "Video";
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
};
export function TimelineLibrary({
  assets = [],
  selected = new Set(),
  onSelect,
  onOpen,
  grouping = "day",
  onGroupingChange,
  order = "desc",
}) {
  const [localGrouping, setLocalGrouping] = useState(null);
  const mode = localGrouping ?? groupingMode(grouping);
  useEffect(() => setLocalGrouping(null), [grouping]);
  const groups = useMemo(
    () => timelineGroups(assets, mode === "days" ? "day" : mode, order),
    [assets, mode, order],
  );
  const itemCount = groups.reduce((sum, group) => sum + group.assets.length, 0);
  const months = useMemo(() => timelineMonths(assets, order), [assets, order]);
  const assetElements = useRef(new Map());
  const selectedIds = selected instanceof Set ? selected : new Set(selected);
  const changeGrouping = (value) => {
    if (onGroupingChange) onGroupingChange(value);
    else setLocalGrouping(value);
  };
  const jump = (month) => {
    const target = assetElements.current.get(month.firstAssetId);
    target?.scrollIntoView?.({ block: "start", behavior: "auto" });
    target?.querySelector(".tl-open")?.focus({ preventScroll: true });
  };
  return (
    <section className="timeline-library" aria-label="Photo timeline">
      <div className="tl-toolbar">
        <span>
          {itemCount} {itemCount === 1 ? "item" : "items"}
        </span>
        <div role="group" aria-label="Timeline grouping">
          {[
            ["years", "Years"],
            ["months", "Months"],
            ["days", "Days"],
            ["all", "All"],
          ].map(([value, label]) => (
            <button
              type="button"
              key={value}
              aria-pressed={mode === value}
              onClick={() => changeGrouping(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {!groups.length ? (
        <div className="tl-empty" role="status">
          <Icon name="mdiCalendarRange" size={30} />
          <p>No photos or videos in this view.</p>
        </div>
      ) : (
        <div className="tl-layout">
          <div className="tl-groups">
            {groups.map((group) => (
              <section
                className="tl-group"
                key={group.id}
                aria-label={group.title}
              >
                <header>
                  <h2>{group.title}</h2>
                  <span>
                    {group.assets.length}{" "}
                    {group.assets.length === 1 ? "item" : "items"}
                  </span>
                </header>
                <div className="tl-grid">
                  {group.assets.map((asset) => (
                    <article
                      className={`tl-asset${selectedIds.has(asset.id) ? " is-selected" : ""}`}
                      key={asset.id}
                      data-asset-id={asset.id}
                      ref={(element) => {
                        if (element)
                          assetElements.current.set(asset.id, element);
                        else assetElements.current.delete(asset.id);
                      }}
                    >
                      <button
                        className="tl-open"
                        type="button"
                        aria-label={`Open ${asset.name || asset.originalFileName || "photo"}`}
                        onClick={(event) => {
                          if (event.metaKey || event.ctrlKey || event.shiftKey)
                            onSelect?.(asset.id, event);
                          else onOpen?.(asset.id);
                        }}
                      >
                        <img
                          src={asset.image}
                          alt={asset.name || asset.originalFileName || "Photo"}
                          loading="lazy"
                        />
                        {videoAsset(asset) && (
                          <span className="tl-duration">
                            <Icon name="mdiMovieOpenOutline" size={14} />
                            {durationLabel(asset.duration)}
                          </span>
                        )}
                        {(asset.isFavorite ?? asset.favorite) && (
                          <span className="tl-favorite" aria-label="Favorite">
                            <Icon name="mdiHeartOutline" size={15} />
                          </span>
                        )}
                      </button>
                      <label className="tl-select">
                        <input
                          type="checkbox"
                          aria-label={`Select ${asset.name || asset.originalFileName || "photo"}`}
                          checked={selectedIds.has(asset.id)}
                          onChange={(event) => onSelect?.(asset.id, event)}
                        />
                        <span aria-hidden="true">
                          <Icon
                            name={
                              selectedIds.has(asset.id)
                                ? "mdiCheckCircle"
                                : "mdiCircleOutline"
                            }
                            size={21}
                          />
                        </span>
                      </label>
                      <div className="tl-caption">
                        <span title={asset.name || asset.originalFileName}>
                          {asset.name || asset.originalFileName}
                        </span>
                        {localCaptureTime(asset) && (
                          <time>{localCaptureTime(asset)}</time>
                        )}
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            ))}
          </div>
          {months.length > 0 && (
            <nav className="tl-months" aria-label="Jump to a capture month">
              {months.map((month, index) => (
                <React.Fragment key={month.id}>
                  {(index === 0 || months[index - 1].year !== month.year) && (
                    <span className="tl-year">{month.year}</span>
                  )}
                  <button
                    type="button"
                    aria-label={`Jump to ${month.label}, ${month.count} ${month.count === 1 ? "item" : "items"}`}
                    onClick={() => jump(month)}
                  >
                    {month.shortLabel}
                    <small>{month.count}</small>
                  </button>
                </React.Fragment>
              ))}
            </nav>
          )}
        </div>
      )}
    </section>
  );
}
