import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { Icon } from "./Icon";
import { Button } from "./App";
import {
  longDay,
  memoriesFor,
  memoryOverrides,
  readMemoryOverrides,
  writeMemoryOverrides,
} from "./discovery-data.mjs";
import {
  memoryCountLabel as countLabel,
  memoryOverline,
  memoryPreviewMotion,
} from "./memory-engine.mjs";
import { prefersReducedMotion } from "./interactions.js";
import "./discovery.css";
import "./memories.css";

const isoToday = () => new Date().toISOString().slice(0, 10);
const kindIcon = {
  "on-this-day": "mdiCalendarTodayOutline",
  "years-ago": "mdiHistory",
  event: "mdiMapMarkerOutline",
  "best-of": "mdiStarOutline",
};

/**
 * Accessible dropdown menu: trigger + role="menu" with arrow-key movement,
 * Escape and outside clicks close it and focus returns to the trigger.
 */
export function Menu({
  label,
  icon = "mdiDotsVertical",
  items = [],
  className = "",
  align = "end",
  children,
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef(null);
  const menu = useRef(null);
  const id = useId();
  useEffect(() => {
    if (!open) return undefined;
    const first = menu.current?.querySelector(
      "[role=menuitem]:not([disabled])",
    );
    first?.focus();
    const onPointer = (event) => {
      if (
        !menu.current?.contains(event.target) &&
        !trigger.current?.contains(event.target)
      )
        setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);
  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };
  const keyboard = (event) => {
    const options = [
      ...(menu.current?.querySelectorAll("[role=menuitem]:not([disabled])") ||
        []),
    ];
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
      close();
    }
  };
  return (
    <div className={`dv-menu-wrap ${className}`}>
      <button
        ref={trigger}
        type="button"
        className="dv-icon-button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
      >
        {children || <Icon name={icon} size={18} />}
      </button>
      {open && (
        <div
          id={id}
          ref={menu}
          role="menu"
          aria-label={label}
          className={`dv-menu align-${align}`}
          onKeyDown={keyboard}
        >
          {items.map((item) =>
            item.separator ? (
              <hr key={item.id} />
            ) : (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                className={item.danger ? "danger" : ""}
                onClick={(event) => {
                  event.stopPropagation();
                  close(item.keepFocus !== true);
                  item.onSelect?.();
                }}
              >
                {item.icon && <Icon name={item.icon} size={16} />}
                <span>{item.label}</span>
                {item.checked && <Icon name="mdiCheck" size={16} />}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

function Cover({ asset, className = "", style }) {
  return asset?.image ? (
    <img
      className={className}
      style={style}
      src={asset.image}
      alt=""
      loading="lazy"
    />
  ) : (
    <div className={`dv-cover-empty ${className}`}>
      <Icon name="mdiImageMultipleOutline" size={28} />
    </div>
  );
}

function MemoryCard({
  memory,
  size = "regular",
  onPlay,
  onToggleFavorite,
  onHide,
  today,
}) {
  const badge = memory.upcomingOn
    ? memory.inDays === 1
      ? "Tomorrow"
      : `In ${memory.inDays} days`
    : memory.passedDays
      ? memory.passedDays === 1
        ? "Yesterday"
        : `${memory.passedDays} days ago`
      : null;
  return (
    <article
      className={`dv-memory ${size}${memory.favorite ? " favorite" : ""}`}
    >
      <button
        type="button"
        className="dv-memory-main"
        onClick={() => onPlay(memory)}
        aria-label={`Play ${memory.title}, ${memory.subtitle}, ${countLabel(memory.count)}`}
      >
        <Cover
          asset={memory.cover}
          style={memoryPreviewMotion(
            memory.cover?.id ?? memory.id,
            prefersReducedMotion(),
          )}
        />
        <span className="dv-shade" aria-hidden="true" />
        <span className="dv-memory-copy">
          <span className="dv-overline">
            <Icon
              name={kindIcon[memory.kind] || "mdiImageMultipleOutline"}
              size={14}
            />
            {badge || memoryOverline(memory)}
          </span>
          <strong>{memory.title}</strong>
          <small>{memory.subtitle}</small>
          <small className="dv-memory-count">
            {countLabel(memory.count)}
            {memory.favorite && (
              <>
                {" · "}
                <Icon name="mdiHeart" size={12} /> Favorite
              </>
            )}
          </small>
        </span>
        <span className="dv-memory-play" aria-hidden="true">
          <Icon name="mdiPlay" size={20} />
        </span>
      </button>
      <Menu
        label={`More actions for ${memory.title}`}
        className="dv-memory-menu"
        items={[
          {
            id: "play",
            label: "Play",
            icon: "mdiPlay",
            onSelect: () => onPlay(memory),
          },
          {
            id: "favorite",
            label: memory.favorite ? "Remove from favorites" : "Favorite",
            icon: memory.favorite ? "mdiHeart" : "mdiHeartOutline",
            onSelect: () => onToggleFavorite(memory),
          },
          { id: "sep", separator: true },
          {
            id: "hide",
            label: "Hide memory",
            icon: "mdiEyeOffOutline",
            onSelect: () => onHide(memory),
          },
        ]}
      />
    </article>
  );
}

export function Memories({
  assets = [],
  overrides,
  onChange,
  onPlay,
  today = isoToday(),
}) {
  const [local, setLocal] = useState(() => overrides || readMemoryOverrides());
  const current = overrides ?? local;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [status, setStatus] = useState("");
  const gear = useRef(null);
  const settingsId = useId();
  const index = useMemo(
    () =>
      memoriesFor(assets, {
        today,
        showUpcoming: current.settings.showUpcoming,
        onlyFavorites: current.settings.onlyFavorites,
        overrides: current,
      }),
    [assets, today, current],
  );
  const commit = (next, change, message) => {
    writeMemoryOverrides(next);
    setLocal(next);
    onChange?.(next, change);
    if (message) setStatus(message);
  };
  const play = (memory) => onPlay?.(memory.id, memory);
  const toggleFavorite = (memory) =>
    commit(
      memoryOverrides.toggleFavorite(current, memory.id),
      { type: "favorite", memoryId: memory.id },
      memory.favorite
        ? `${memory.title} removed from favorites.`
        : `${memory.title} added to favorites.`,
    );
  const hide = (memory) =>
    commit(
      memoryOverrides.hide(current, memory.id),
      { type: "hide", memoryId: memory.id },
      `${memory.title} hidden. Restore it from Hidden memories below.`,
    );
  const unhide = (memory) =>
    commit(
      memoryOverrides.unhide(current, memory.id),
      { type: "unhide", memoryId: memory.id },
      `${memory.title} restored.`,
    );
  const patchSettings = (patch) =>
    commit(memoryOverrides.settings(current, patch), {
      type: "settings",
      ...patch,
    });
  useEffect(() => {
    if (!settingsOpen) return undefined;
    const onKey = (event) => {
      if (event.key === "Escape") {
        setSettingsOpen(false);
        gear.current?.focus();
      }
    };
    const onPointer = (event) => {
      if (
        !document.getElementById(settingsId)?.contains(event.target) &&
        !gear.current?.contains(event.target)
      )
        setSettingsOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [settingsOpen, settingsId]);

  const nothing =
    !index.today.length && !index.upcoming.length && !index.earlier.length;
  const nextUp = index.upcoming[0];
  const cardProps = {
    onPlay: play,
    onToggleFavorite: toggleFavorite,
    onHide: hide,
    today,
  };
  return (
    <main className="discovery dv-memories" aria-label="Memories">
      <header className="dv-header">
        <div>
          <h1>Memories</h1>
          <p>{longDay(today)} · days worth revisiting from your library</p>
        </div>
        <div className="dv-header-actions">
          <div className="dv-popover-wrap">
            <Button
              ref={gear}
              icon="mdiCogOutline"
              aria-label="Memory settings"
              title="Memory settings"
              aria-expanded={settingsOpen}
              aria-haspopup="dialog"
              aria-controls={settingsOpen ? settingsId : undefined}
              active={settingsOpen}
              onClick={() => setSettingsOpen((value) => !value)}
            />
            {settingsOpen && (
              <div
                id={settingsId}
                className="dv-popover"
                role="dialog"
                aria-label="Memory settings"
              >
                <strong>Memory settings</strong>
                <button
                  type="button"
                  role="switch"
                  aria-checked={current.settings.showUpcoming}
                  className={`dv-switch${current.settings.showUpcoming ? " on" : ""}`}
                  onClick={() =>
                    patchSettings({
                      showUpcoming: !current.settings.showUpcoming,
                    })
                  }
                  autoFocus
                >
                  <span className="dv-switch-track" aria-hidden="true" />
                  <span>
                    Show upcoming
                    <small>Preview memories for the next two weeks</small>
                  </span>
                </button>
                <button
                  type="button"
                  role="switch"
                  aria-checked={current.settings.onlyFavorites}
                  className={`dv-switch${current.settings.onlyFavorites ? " on" : ""}`}
                  onClick={() =>
                    patchSettings({
                      onlyFavorites: !current.settings.onlyFavorites,
                    })
                  }
                >
                  <span className="dv-switch-track" aria-hidden="true" />
                  <span>
                    Only favorites
                    <small>Show memories you have marked with a heart</small>
                  </span>
                </button>
              </div>
            )}
          </div>
        </div>
      </header>
      <output className="dv-sr-only" aria-live="polite">
        {status}
      </output>

      <section className="dv-section" aria-label="Today">
        <div className="dv-section-heading">
          <h2>Today</h2>
          {index.today.length > 0 && (
            <small>
              {countLabel(index.today.length, "memory").replace(
                "memorys",
                "memories",
              )}
            </small>
          )}
        </div>
        {index.today.length ? (
          <div className="dv-memory-hero">
            {index.today.map((memory, position) => (
              <MemoryCard
                key={memory.id}
                memory={memory}
                size={position === 0 ? "hero" : "regular"}
                {...cardProps}
              />
            ))}
          </div>
        ) : (
          <div className="dv-memory-quiet">
            <Cover
              asset={index.earlier[0]?.cover || index.upcoming[0]?.cover}
            />
            <span className="dv-shade" aria-hidden="true" />
            <span className="dv-memory-copy">
              <span className="dv-overline">
                <Icon name="mdiCalendarTodayOutline" size={14} />
                {longDay(today)}
              </span>
              <strong>Nothing from this day yet</strong>
              <small>
                {nextUp
                  ? `Your next memory arrives ${nextUp.inDays === 1 ? "tomorrow" : `in ${nextUp.inDays} days`}: ${nextUp.subtitle}.`
                  : current.settings.onlyFavorites
                    ? "Only favorite memories are shown. Mark a memory with a heart or change the settings."
                    : "Memories appear here on the anniversary of your photos and videos."}
              </small>
            </span>
          </div>
        )}
      </section>

      {current.settings.showUpcoming && index.upcoming.length > 0 && (
        <section className="dv-section" aria-label="Upcoming">
          <div className="dv-section-heading">
            <h2>Upcoming</h2>
            <small>Next 14 days</small>
          </div>
          <div className="dv-memory-row">
            {index.upcoming.map((memory) => (
              <MemoryCard key={memory.id} memory={memory} {...cardProps} />
            ))}
          </div>
        </section>
      )}

      <section className="dv-section" aria-label="Earlier">
        <div className="dv-section-heading">
          <h2>Earlier</h2>
          {index.earlier.length > 0 && <small>Trips and highlights</small>}
        </div>
        {index.earlier.length ? (
          <div className="dv-memory-grid">
            {index.earlier.map((memory) => (
              <MemoryCard key={memory.id} memory={memory} {...cardProps} />
            ))}
          </div>
        ) : (
          <div className="dv-empty" role="status">
            <Icon name="mdiHistory" size={30} />
            <strong>{nothing ? "No memories yet" : "Nothing earlier"}</strong>
            <p>
              {current.settings.onlyFavorites
                ? "Turn off Only favorites in settings to see every memory."
                : "Trips, weekends and monthly highlights appear here as your library grows."}
            </p>
          </div>
        )}
      </section>

      {index.hidden.length > 0 && (
        <section className="dv-section dv-hidden" aria-label="Hidden memories">
          <div className="dv-section-heading">
            <h2>Hidden memories</h2>
            <button
              type="button"
              className="dv-link"
              aria-expanded={showHidden}
              onClick={() => setShowHidden((value) => !value)}
            >
              {showHidden ? "Hide" : `Show ${index.hidden.length}`}
              <Icon
                name={showHidden ? "mdiChevronUp" : "mdiChevronDown"}
                size={16}
              />
            </button>
          </div>
          {showHidden && (
            <ul className="dv-hidden-list">
              {index.hidden.map((memory) => (
                <li key={memory.id}>
                  <Cover asset={memory.cover} />
                  <span>
                    <strong>{memory.title}</strong>
                    <small>{memory.subtitle}</small>
                  </span>
                  <Button icon="mdiRestore" onClick={() => unhide(memory)}>
                    Restore
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      <p className="dv-note">Preview · sample data</p>
    </main>
  );
}
