import React from "react";
import { Icon } from "./Icon";
import { PersonAvatar } from "./People";
import { plural } from "./collections-data.mjs";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Aug 2026", "Jun – Aug 2026" or "2025 – 2026" for a run of capture dates. */
export function monthSpan(earliest, latest) {
  if (!latest) return "";
  const last = new Date(latest);
  if (Number.isNaN(last.getTime())) return "";
  const first = new Date(earliest || latest);
  const month = (date) => `${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
  if (Number.isNaN(first.getTime()) || month(first) === month(last)) return month(last);
  if (first.getFullYear() === last.getFullYear())
    return `${MONTHS[first.getMonth()]} – ${MONTHS[last.getMonth()]} ${last.getFullYear()}`;
  return `${first.getFullYear()} – ${last.getFullYear()}`;
}

/** "19 items · Aug 2026" for a listing entry. */
export function spanLabel(entry) {
  const count = entry?.itemCount ?? 0;
  const when = monthSpan(entry?.earliestAt, entry?.latestAt);
  return [count ? plural(count, "item") : "Empty", when].filter(Boolean).join(" · ");
}

/** Overlapping avatars for the people who can see an album. */
export function AvatarStack({ users = [], ids = [], size = 18, max = 3 }) {
  if (!ids.length) return null;
  const userFor = (id) => users.find((user) => user.id === id) || { id, name: id };
  const shown = ids.slice(0, max);
  const more = ids.length - shown.length;
  const names = ids.map((id) => userFor(id).name).join(", ");
  return (
    <span className="al-avatars" title={names} aria-label={`Shared with ${names}`}>
      {shown.map((id) => (
        <PersonAvatar key={id} person={userFor(id)} size={size} />
      ))}
      {more > 0 && <span className="al-avatar-more">+{more}</span>}
    </span>
  );
}

/**
 * Square album tile: cover, name, count and who else can see it. The menu
 * (or any other control) is passed in as `actions` so this stays free of
 * page-specific behaviour and can sit on the Albums page, a collection page
 * or a picker.
 */
export function AlbumCard({
  collection,
  cover = null,
  count = 0,
  earliestAt = null,
  latestAt = null,
  users = [],
  currentUserId = "taylor",
  onOpen,
  actions = null,
  className = "",
  dragProps = {},
}) {
  const others = collection.members
    .filter((member) => member.userId !== currentUserId)
    .map((member) => member.userId);
  const meta = spanLabel({ itemCount: count, earliestAt, latestAt });
  const open = () => onOpen?.(collection.id);
  return (
    <article
      className={`al-card${className ? ` ${className}` : ""}`}
      aria-label={collection.name}
      {...dragProps}
    >
      <button
        type="button"
        className="al-cover"
        aria-label={`Open ${collection.name}`}
        onClick={open}
      >
        {cover ? (
          <img src={cover.image} alt="" loading="lazy" draggable={false} />
        ) : (
          <span className="al-cover-empty" aria-hidden="true">
            <Icon name={collection.icon} size={30} />
          </span>
        )}
        {collection.smart && (
          <span className="al-smart" title="Smart album" aria-hidden="true">
            <Icon name="mdiAutoFix" size={13} />
          </span>
        )}
        {collection.kind === "space" && (
          <span className="al-smart al-space-mark" title="Shared space" aria-hidden="true">
            <Icon name="mdiAccountMultipleOutline" size={13} />
          </span>
        )}
      </button>
      <div className="al-card-text">
        <button type="button" className="al-card-name" onClick={open}>
          {collection.name}
        </button>
        <div className="al-card-meta">
          <small>{meta}</small>
          <AvatarStack users={users} ids={others} size={18} />
        </div>
      </div>
      {actions && <div className="al-card-actions">{actions}</div>}
    </article>
  );
}
