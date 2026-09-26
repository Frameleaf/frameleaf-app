import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { IconChooser, iconLabel } from "./IconChooser";
import { Button, Dialog } from "./App";
import { Icon } from "./Icon";
import { PersonAvatar } from "./People";
import {
  ancestors,
  assetDates,
  changeRole,
  collectionAssets,
  coverAsset,
  createCollection,
  defaultIconFor,
  descendantIds,
  findCollection,
  formatDate,
  formatDateRange,
  inviteMember,
  isMember,
  isOwner,
  itemCount,
  kindLabel,
  normalizeRule,
  plural,
  reevaluateSmart,
  removeMember,
  roleOf,
  ruleIsEmpty,
  timeAgo,
} from "./collections-data.mjs";
import { AlbumCard } from "./AlbumCard";
import "./collections.css";

/** "Album", "Collection" or "Shared space" for titles. */
const Kind = (collection) => {
  const label = kindLabel(collection);
  return label[0].toUpperCase() + label.slice(1);
};

/* =====================================================================
   Shared building blocks (also used by the Collections index screen)
   ===================================================================== */

/** Accessible dropdown: role="menu", arrow keys, Escape, click-outside. */
export function Menu({
  label,
  icon,
  items = [],
  className = "",
  primary,
  active,
  align = "end",
  children,
  ...buttonProps
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef(null);
  const trigger = useRef(null);
  const list = useRef(null);
  const id = useId();
  const visible = items.filter(Boolean);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event) => {
      if (!wrap.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    list.current?.querySelector('[role^="menuitem"]:not([disabled])')?.focus();
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };
  const onKeyDown = (event) => {
    const options = [
      ...(list.current?.querySelectorAll(
        '[role^="menuitem"]:not([disabled])',
      ) || []),
    ];
    const index = options.indexOf(document.activeElement);
    const go = (next) =>
      options[(next + options.length) % options.length]?.focus();
    if (event.key === "ArrowDown") {
      event.preventDefault();
      go(index + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      go(index - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      go(0);
    } else if (event.key === "End") {
      event.preventDefault();
      go(options.length - 1);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "Tab") close(false);
  };

  return (
    <div className={`cl-menu-wrap ${className}`} ref={wrap}>
      <button
        type="button"
        ref={trigger}
        className={`button ${primary ? "primary" : ""} ${active || open ? "active" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
        {...buttonProps}
      >
        {icon && <Icon name={icon} />}
        {children ?? label}
      </button>
      {open && (
        <div
          className={`cl-menu ${align}`}
          role="menu"
          id={id}
          ref={list}
          aria-label={buttonProps["aria-label"] || label}
          onKeyDown={onKeyDown}
        >
          {visible.map((item, index) =>
            item.separator ? (
              <hr key={`sep-${index}`} role="separator" />
            ) : (
              <button
                key={item.id || item.label}
                type="button"
                role={
                  item.checked === undefined ? "menuitem" : "menuitemcheckbox"
                }
                aria-checked={item.checked}
                disabled={item.disabled}
                className={`cl-menu-item${item.danger ? " danger" : ""}`}
                onClick={() => {
                  close();
                  item.onSelect?.();
                }}
              >
                {item.icon && <Icon name={item.icon} />}
                <span>{item.label}</span>
                {item.checked && <Icon name="mdiCheck" />}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

/** Overlapping avatar row for members. */
export function UserAvatars({ users = [], ids = [], size = 22, max = 4 }) {
  const shown = ids
    .slice(0, max)
    .map((id) => users.find((user) => user.id === id) || { id, name: id });
  const extra = ids.length - shown.length;
  return (
    <span className="cl-avatars">
      {shown.map((user) => (
        <PersonAvatar key={user.id} person={user} size={size} />
      ))}
      {extra > 0 && (
        <span className="cl-avatar-more" style={{ width: size, height: size }}>
          +{extra}
        </span>
      )}
    </span>
  );
}

export function RuleChips({ rule, people = [] }) {
  const r = normalizeRule(rule);
  const chips = [];
  if (r.personIds.length)
    chips.push({
      icon: "mdiAccountOutline",
      label: r.personIds
        .map((id) => people.find((person) => person.id === id)?.name || id)
        .join(", "),
    });
  if (r.tagIds.length)
    chips.push({ icon: "mdiTagOutline", label: r.tagIds.join(", ") });
  if (r.from || r.to)
    chips.push({
      icon: "mdiCalendarRange",
      label:
        r.from && r.to
          ? `${formatDate(r.from)} – ${formatDate(r.to)}`
          : r.from
            ? `From ${formatDate(r.from)}`
            : `Until ${formatDate(r.to)}`,
    });
  if (r.type !== "any")
    chips.push({
      icon: r.type === "video" ? "mdiVideoOutline" : "mdiImageOutline",
      label: r.type === "video" ? "Videos only" : "Photos only",
    });
  if (!chips.length) return null;
  return (
    <ul className="cl-chips" aria-label="Smart album rules">
      {chips.map((chip) => (
        <li key={chip.icon} className="cl-chip">
          <Icon name={chip.icon} />
          {chip.label}
        </li>
      ))}
    </ul>
  );
}

export function IconPicker({ value, onChange, label = "Icon" }) {
  const id = useId();
  return (
    <div className="cl-field cl-icon-field">
      <span id={id}>{label}</span>
      <div className="cl-icon-current">
        <span className="cl-icon-current-mark" aria-hidden="true">
          <Icon name={value} size={22} />
        </span>
        <span className="cl-icon-current-name">{iconLabel(value)}</span>
      </div>
      <IconChooser inline value={value} onChange={onChange} label={label} />
    </div>
  );
}

export function RuleBuilder({
  rule,
  onChange,
  people = [],
  tags = [],
  assets = [],
}) {
  const r = normalizeRule(rule);
  const set = (patch) => onChange(normalizeRule({ ...r, ...patch }));
  const count = useMemo(() => reevaluateSmart(r, assets).length, [r, assets]);
  return (
    <div className="cl-rule">
      <fieldset>
        <legend>People (any of)</legend>
        <div className="cl-rule-people">
          {people.map((person) => (
            <label
              key={person.id}
              className={`cl-person-check${r.personIds.includes(person.id) ? " on" : ""}`}
            >
              <input
                type="checkbox"
                checked={r.personIds.includes(person.id)}
                onChange={() =>
                  set({ personIds: toggleIn(r.personIds, person.id) })
                }
              />
              <PersonAvatar person={person} size={24} />
              <span>{person.name}</span>
            </label>
          ))}
          {!people.length && (
            <span className="cl-muted">No named people yet.</span>
          )}
        </div>
      </fieldset>
      <fieldset>
        <legend>Tags (any of)</legend>
        <div className="cl-rule-tags">
          {tags.map((tag) => (
            <label
              key={tag}
              className={`cl-tag-check${r.tagIds.includes(tag) ? " on" : ""}`}
            >
              <input
                type="checkbox"
                checked={r.tagIds.includes(tag)}
                onChange={() => set({ tagIds: toggleIn(r.tagIds, tag) })}
              />
              {tag}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="cl-rule-row">
        <label className="cl-field">
          <span>From</span>
          <input
            type="date"
            value={r.from || ""}
            max={r.to || undefined}
            onChange={(event) => set({ from: event.target.value || null })}
          />
        </label>
        <label className="cl-field">
          <span>To</span>
          <input
            type="date"
            value={r.to || ""}
            min={r.from || undefined}
            onChange={(event) => set({ to: event.target.value || null })}
          />
        </label>
        <label className="cl-field">
          <span>Media</span>
          <select
            value={r.type}
            onChange={(event) => set({ type: event.target.value })}
          >
            <option value="any">Photos and videos</option>
            <option value="photo">Photos only</option>
            <option value="video">Videos only</option>
          </select>
        </label>
      </div>
      <p className="cl-rule-preview" role="status" aria-live="polite">
        {ruleIsEmpty(r)
          ? "Add at least one rule. The album fills itself from whatever matches."
          : `${plural(count, "item")} match right now.`}
      </p>
    </div>
  );
}

/** Albums that can hold `selfId` (excludes self, its descendants, smart albums and spaces). */
/** Collections an album can live in (never itself, never a smart album or a space). */
export function parentOptions(state, selfId = null) {
  return state.collections
    .filter(
      (collection) =>
        collection.kind === "collection" && collection.id !== selfId,
    )
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((collection) => ({
      id: collection.id,
      name: collection.name,
      depth: 0,
    }));
}

export function CollectionFormDialog({
  state,
  collection = null,
  people = [],
  tags = [],
  assets = [],
  defaultParentId = null,
  kind: kindProp = "album",
  smart: smartDefault = false,
  close,
  onSubmit,
}) {
  const editing = Boolean(collection);
  const kind = collection?.kind || kindProp;
  const isAlbum = kind === "album";
  const label = kindLabel({ kind });
  const formId = useId();
  const [name, setName] = useState(collection?.name || "");
  const [description, setDescription] = useState(collection?.description || "");
  const [icon, setIcon] = useState(collection?.icon || defaultIconFor(kind));
  const [parentId, setParentId] = useState(
    collection?.parentId ?? defaultParentId ?? null,
  );
  const [smart, setSmart] = useState(
    Boolean(collection?.smart) || (isAlbum && Boolean(smartDefault)),
  );
  const [rule, setRule] = useState(normalizeRule(collection?.smart?.rule));
  const [error, setError] = useState("");
  const parents = useMemo(
    () => parentOptions(state, collection?.id ?? null),
    [state, collection],
  );
  const hasChildren = collection
    ? descendantIds(state, collection.id).size > 0
    : false;
  const submit = (event) => {
    event.preventDefault();
    try {
      onSubmit({
        name,
        description,
        icon,
        parentId: isAlbum ? parentId : null,
        smart: isAlbum && smart ? { rule } : null,
      });
      close();
    } catch (failure) {
      setError(failure.message);
    }
  };
  return (
    <Dialog
      title={editing ? `Edit ${label}` : `New ${label}`}
      wide
      close={close}
      actions={
        <>
          <Button type="button" onClick={close}>
            Cancel
          </Button>
          <Button
            primary
            type="submit"
            form={formId}
            icon={editing ? "mdiCheck" : "mdiPlus"}
          >
            {editing ? "Save" : "Create"}
          </Button>
        </>
      }
    >
      <form id={formId} className="cl-form" onSubmit={submit}>
        <label className="cl-field">
          <span>Name</span>
          <input
            data-initial-focus
            required
            maxLength={120}
            value={name}
            placeholder="Give it a name"
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="cl-field">
          <span>Description</span>
          <textarea
            rows={2}
            maxLength={2000}
            value={description}
            placeholder="Optional"
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
        <IconPicker value={icon} onChange={setIcon} />
        {isAlbum && (
          <label className="cl-field">
            <span>Collection</span>
            <select
              value={parentId ?? ""}
              onChange={(event) => setParentId(event.target.value || null)}
            >
              <option value="">No collection</option>
              {parents.map((parent) => (
                <option key={parent.id} value={parent.id}>
                  {`${"— ".repeat(parent.depth)}${parent.name}`}
                </option>
              ))}
            </select>
          </label>
        )}
        {isAlbum && (
          <label className="cl-switch">
            <input
              type="checkbox"
              role="switch"
              checked={smart}
              disabled={hasChildren}
              aria-describedby={`${formId}-smart-help`}
              onChange={(event) => setSmart(event.target.checked)}
            />
            <span>Smart album</span>
            <small id={`${formId}-smart-help`}>
              {hasChildren
                ? "Move the nested albums out first."
                : "Fills itself from rules instead of photos you add."}
            </small>
          </label>
        )}
        {smart && isAlbum && (
          <RuleBuilder
            rule={rule}
            onChange={setRule}
            people={people}
            tags={tags}
            assets={assets}
          />
        )}
        {error && (
          <p className="cl-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}

export function MoveDialog({ state, collection, close, onMove }) {
  const [parentId, setParentId] = useState(collection.parentId);
  const [error, setError] = useState("");
  const parents = useMemo(
    () => parentOptions(state, collection.id),
    [state, collection.id],
  );
  const current = findCollection(state, collection.parentId);
  return (
    <Dialog
      title={`Move “${collection.name}”`}
      close={close}
      actions={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button
            primary
            icon="mdiFolderMoveOutline"
            onClick={() => {
              try {
                onMove(parentId);
                close();
              } catch (failure) {
                setError(failure.message);
              }
            }}
          >
            Move
          </Button>
        </>
      }
    >
      <p className="cl-muted" style={{ margin: "0 0 12px", fontSize: 13 }}>
        Currently {current ? `inside “${current.name}”` : "on its own"}.
      </p>
      <label className="cl-field">
        <span>Collection</span>
        <select
          data-initial-focus
          value={parentId ?? ""}
          onChange={(event) => setParentId(event.target.value || null)}
        >
          <option value="">No collection</option>
          {parents.map((parent) => (
            <option key={parent.id} value={parent.id}>
              {`${"— ".repeat(parent.depth)}${parent.name}`}
            </option>
          ))}
        </select>
      </label>
      {error && (
        <p className="cl-error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}

export function ShareDialog({
  state,
  onState,
  collectionId,
  users = [],
  currentUserId = "taylor",
  close,
  onLeave,
  onShared,
}) {
  const collection = findCollection(state, collectionId);
  const [query, setQuery] = useState("");
  const [role, setRole] = useState("editor");
  const [picked, setPicked] = useState(null);
  const [error, setError] = useState("");
  if (!collection) return null;
  const owner = isOwner(collection, currentUserId);
  const term = query.trim().toLowerCase();
  const candidates = users.filter(
    (user) =>
      !isMember(collection, user.id) &&
      (!term ||
        user.name.toLowerCase().includes(term) ||
        (user.email || "").toLowerCase().includes(term)),
  );
  const apply = (change) => {
    try {
      onState(change(state));
      setError("");
      return true;
    } catch (failure) {
      setError(failure.message);
      return false;
    }
  };
  const userFor = (id) =>
    users.find((user) => user.id === id) || { id, name: id };
  return (
    <Dialog
      title={owner ? `Share ${kindLabel(collection)}` : "Members"}
      close={close}
      actions={<Button onClick={close}>Done</Button>}
    >
      {owner && (
        <div className="cl-invite">
          <label className="cl-field">
            <span>Invite someone</span>
            <input
              data-initial-focus
              type="search"
              value={query}
              placeholder="Search by name or email"
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <ul
            className="cl-people"
            role="listbox"
            aria-label="People to invite"
          >
            {candidates.map((user) => (
              <li key={user.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={picked === user.id}
                  onClick={() => setPicked(picked === user.id ? null : user.id)}
                >
                  <PersonAvatar person={user} size={28} />
                  <span>
                    {user.name}
                    {user.email && <small>{user.email}</small>}
                  </span>
                </button>
              </li>
            ))}
            {!candidates.length && (
              <li className="cl-empty-row">
                {term
                  ? "No one matches that search."
                  : "Everyone already has access."}
              </li>
            )}
          </ul>
          <div className="cl-invite-row">
            <label>
              Role
              <select
                value={role}
                onChange={(event) => setRole(event.target.value)}
              >
                <option value="editor">Editor</option>
                <option value="viewer">Viewer</option>
              </select>
            </label>
            <Button
              primary
              icon="mdiAccountPlusOutline"
              disabled={!picked}
              onClick={() => {
                const invitee = picked;
                if (
                  apply((current) =>
                    inviteMember(current, collectionId, invitee, role),
                  )
                ) {
                  setPicked(null);
                  setQuery("");
                  onShared?.(invitee, role);
                }
              }}
            >
              Invite
            </Button>
          </div>
        </div>
      )}
      <h3 className="cl-subhead">Who has access</h3>
      <ul className="cl-members">
        {collection.members.map((member) => {
          const user = userFor(member.userId);
          return (
            <li key={member.userId}>
              <PersonAvatar person={user} size={30} />
              <span className="cl-member-name">
                {user.name}
                {member.userId === currentUserId && <small>You</small>}
              </span>
              {member.role === "owner" ? (
                <span className="cl-role">Owner</span>
              ) : owner ? (
                <>
                  <select
                    aria-label={`Role for ${user.name}`}
                    value={member.role}
                    onChange={(event) =>
                      apply((current) =>
                        changeRole(
                          current,
                          collectionId,
                          member.userId,
                          event.target.value,
                        ),
                      )
                    }
                  >
                    <option value="editor">Editor</option>
                    <option value="viewer">Viewer</option>
                  </select>
                  <Button
                    icon="mdiClose"
                    aria-label={`Remove ${user.name}`}
                    onClick={() =>
                      apply((current) =>
                        removeMember(current, collectionId, member.userId),
                      )
                    }
                  />
                </>
              ) : (
                <span className="cl-role">
                  {member.role === "editor" ? "Editor" : "Viewer"}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {!owner && onLeave && (
        <div className="cl-leave">
          <p>
            Leaving removes this collection from your library. The owner can
            invite you again later.
          </p>
          <Button icon="mdiLogoutVariant" onClick={onLeave}>
            Leave {kindLabel(collection)}
          </Button>
        </div>
      )}
      {error && (
        <p className="cl-error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}

export function ReevaluateDialog({
  collection,
  allAssets = [],
  currentIds = [],
  people = [],
  close,
  onApply,
}) {
  const next = useMemo(
    () => reevaluateSmart(collection.smart?.rule, allAssets),
    [collection, allAssets],
  );
  const current = new Set(currentIds);
  const nextSet = new Set(next);
  const added = next.filter((id) => !current.has(id));
  const removed = currentIds.filter((id) => !nextSet.has(id));
  const preview = added
    .slice(0, 8)
    .map((id) => allAssets.find((asset) => asset.id === id))
    .filter(Boolean);
  return (
    <Dialog
      title="Re-evaluate smart album"
      close={close}
      actions={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button
            primary
            icon="mdiRefresh"
            data-initial-focus
            onClick={() => {
              onApply?.(next);
              close();
            }}
          >
            Apply
          </Button>
        </>
      }
    >
      <RuleChips rule={collection.smart?.rule} people={people} />
      <p className="cl-lead">
        <strong>{plural(next.length, "item")}</strong> match right now.
      </p>
      <ul className="cl-diff">
        <li>
          <Icon name="mdiPlus" /> {plural(added.length, "item")} would be added
        </li>
        <li>
          <Icon name="mdiMinus" /> {plural(removed.length, "item")} no longer
          match
        </li>
      </ul>
      {preview.length > 0 && (
        <div className="cl-thumbs" aria-label="New matches">
          {preview.map((asset) => (
            <img
              key={asset.id}
              src={asset.image}
              alt={asset.name}
              loading="lazy"
            />
          ))}
        </div>
      )}
      {!added.length && !removed.length && (
        <p className="cl-muted" style={{ margin: 0, fontSize: 13 }}>
          Everything is already up to date. Applying records the check.
        </p>
      )}
    </Dialog>
  );
}

export function DeleteDialog({ collection, count = 0, close, onConfirm }) {
  return (
    <Dialog
      title={`Delete “${collection.name}”?`}
      close={close}
      actions={
        <>
          <Button onClick={close} data-initial-focus>
            Cancel
          </Button>
          <Button
            className="danger"
            icon="mdiDeleteOutline"
            onClick={() => {
              onConfirm();
              close();
            }}
          >
            Delete {kindLabel(collection)}
          </Button>
        </>
      }
    >
      <p style={{ margin: "0 0 12px" }}>
        {collection.kind === "collection"
          ? "The collection is removed. Its albums stay in your library, on their own."
          : `The ${kindLabel(collection)}, its sharing and any public links are removed.`}
        {collection.kind === "space"
          ? " Members lose access to the space."
          : ""}
      </p>
      <p className="cl-keep">
        <Icon name="mdiImageMultipleOutline" />
        {collection.smart
          ? "Smart albums only hold rules. Nothing in your library changes."
          : count === 0
            ? "It has no items, so nothing else changes."
            : `Its ${plural(count, "item")} stay${count === 1 ? "s" : ""} in your library.`}
      </p>
    </Dialog>
  );
}

export function LeaveDialog({ collection, close, onConfirm }) {
  return (
    <Dialog
      title={`Leave “${collection.name}”?`}
      close={close}
      actions={
        <>
          <Button onClick={close} data-initial-focus>
            Cancel
          </Button>
          <Button
            className="danger"
            icon="mdiLogoutVariant"
            onClick={() => {
              onConfirm();
              close();
            }}
          >
            Leave {kindLabel(collection)}
          </Button>
        </>
      }
    >
      <p style={{ margin: 0 }}>
        It disappears from your library. The owner keeps everything and can
        invite you again.
      </p>
    </Dialog>
  );
}

export function CoverDialog({ collection, assets = [], close, onSelect }) {
  const [choice, setChoice] = useState(collection.coverAssetId);
  return (
    <Dialog
      title="Select cover"
      wide
      close={close}
      actions={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button
            primary
            icon="mdiCheck"
            onClick={() => {
              onSelect(choice);
              close();
            }}
          >
            Use as cover
          </Button>
        </>
      }
    >
      <div className="cl-cover-grid" role="radiogroup" aria-label="Cover photo">
        {assets.map((asset) => (
          <button
            key={asset.id}
            type="button"
            role="radio"
            aria-checked={choice === asset.id}
            aria-label={asset.name}
            className={choice === asset.id ? "chosen" : ""}
            data-initial-focus={
              choice === asset.id ||
              (!choice && asset === assets[0]) ||
              undefined
            }
            onClick={() => setChoice(asset.id)}
          >
            <img src={asset.image} alt="" loading="lazy" />
            {choice === asset.id && <Icon name="mdiCheckCircle" />}
          </button>
        ))}
      </div>
      <label className="cl-check">
        <input
          type="checkbox"
          checked={choice === null}
          onChange={(event) =>
            setChoice(event.target.checked ? null : (assets[0]?.id ?? null))
          }
        />
        <span>Always use the newest item</span>
      </label>
    </Dialog>
  );
}

export function OptionsDialog({ collection, close, onChange }) {
  const [displayOrder, setDisplayOrder] = useState(collection.displayOrder);
  const [commentsEnabled, setCommentsEnabled] = useState(
    collection.commentsEnabled,
  );
  const id = useId();
  return (
    <Dialog
      title={`${Kind(collection)} options`}
      close={close}
      actions={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button
            primary
            icon="mdiCheck"
            onClick={() => {
              onChange({ displayOrder, commentsEnabled });
              close();
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="cl-options">
        <fieldset>
          <legend className="cl-subhead" style={{ margin: "0 0 4px" }}>
            Display order
          </legend>
          <label>
            <input
              type="radio"
              name={`${id}-order`}
              data-initial-focus
              checked={displayOrder === "newest"}
              onChange={() => setDisplayOrder("newest")}
            />
            Newest first
          </label>
          <label>
            <input
              type="radio"
              name={`${id}-order`}
              checked={displayOrder === "oldest"}
              onChange={() => setDisplayOrder("oldest")}
            />
            Oldest first
          </label>
        </fieldset>
        <label className="cl-switch">
          <input
            type="checkbox"
            role="switch"
            checked={commentsEnabled}
            onChange={(event) => setCommentsEnabled(event.target.checked)}
          />
          <span>Comments and likes</span>
          <small>Members can react to the collection and to items in it.</small>
        </label>
      </div>
    </Dialog>
  );
}

/* =====================================================================
   Inline text editing (title, description)
   ===================================================================== */
function InlineEdit({
  value,
  onSave,
  as: Tag = "h1",
  className = "",
  label,
  placeholder,
  multiline = false,
  editable = true,
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const input = useRef(null);
  const cancelled = useRef(false);
  useEffect(() => {
    if (editing) {
      cancelled.current = false;
      input.current?.focus();
      input.current?.select?.();
    }
  }, [editing]);
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);
  const commit = () => {
    if (cancelled.current) return;
    const next = draft.trim();
    if (!multiline && !next) {
      setDraft(value);
      setEditing(false);
      return;
    }
    if (next !== value) onSave(next);
    setEditing(false);
  };
  const cancel = () => {
    cancelled.current = true;
    setDraft(value);
    setEditing(false);
  };
  if (!editable)
    return (
      <Tag className={className}>
        {value || <span className="cl-muted">{placeholder}</span>}
      </Tag>
    );
  if (editing) {
    const Field = multiline ? "textarea" : "input";
    return (
      <Field
        ref={input}
        className={`${className} editing`}
        value={draft}
        aria-label={label}
        rows={multiline ? 2 : undefined}
        maxLength={multiline ? 2000 : 120}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !(multiline && event.shiftKey)) {
            event.preventDefault();
            commit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            cancel();
          }
        }}
      />
    );
  }
  return (
    <Tag className={className}>
      <button
        type="button"
        className="ch-edit-trigger"
        aria-label={`Edit ${label.toLowerCase()}`}
        title={`Edit ${label.toLowerCase()}`}
        onClick={() => setEditing(true)}
      >
        {value || <span className="cl-muted">{placeholder}</span>}
        <Icon name="mdiPencilOutline" />
      </button>
    </Tag>
  );
}

/* =====================================================================
   The detail header
   ===================================================================== */
export function CollectionHeader({
  collection,
  assets = [],
  allAssets,
  people = [],
  users = [],
  tags,
  currentUserId = "taylor",
  state,
  onState,
  onChange,
  onNavigate,
  onAddPhotos,
  onUpload,
  onShare,
  onCreateLink,
  onManageLinks,
  onSlideshow,
  onDownload,
  onOpenMap,
  onSelectCover,
  onDelete,
  onLeave,
  onOpenActivity,
  onReevaluate,
  activity = [],
  children,
}) {
  const [dialog, setDialog] = useState(null);
  const [iconOpen, setIconOpen] = useState(false);
  const [status, setStatus] = useState("");
  // #3 on phones the secondary actions move into the "…" menu instead of running off-screen.
  const [compact, setCompact] = useState(
    () =>
      typeof matchMedia === "function" &&
      matchMedia("(max-width: 700px)").matches,
  );
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const query = matchMedia("(max-width: 700px)");
    const change = () => setCompact(query.matches);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  const library = allAssets || assets;
  const tagList = useMemo(
    () =>
      tags ||
      [
        ...new Set(
          library.flatMap((asset) => asset.tagIds || asset.tags || []),
        ),
      ].sort(),
    [tags, library],
  );
  if (!collection) return null;
  const role = roleOf(collection, currentUserId);
  const owner = role === "owner";
  const editor = owner || role === "editor";
  const items = assets;
  const dates = assetDates(items);
  const crumbs = state ? ancestors(state, collection.id) : [];
  const childAlbums =
    state && collection.kind === "collection"
      ? state.collections.filter(
          (item) =>
            item.parentId === collection.id && isMember(item, currentUserId),
        )
      : [];
  const likes = activity.filter((entry) => entry.type === "like").length;
  const comments = activity.filter((entry) => entry.type === "comment").length;
  const mappable = items.filter((asset) =>
    Number.isFinite(asset.latitude),
  ).length;
  const others = collection.members.filter(
    (member) => member.userId !== currentUserId,
  );
  const ownerUser = users.find((user) => user.id === collection.ownerId) || {
    id: collection.ownerId,
    name: collection.ownerId,
  };
  const linkCount = collection.links?.length || 0;
  const patch = (change, message) => {
    try {
      onChange?.(change);
      if (message) setStatus(message);
    } catch (failure) {
      setStatus(failure.message);
    }
  };
  const openShare = () => {
    if (state && onState) setDialog("share");
    else onShare?.();
  };
  const closeDialog = () => setDialog(null);

  return (
    <header className="ch" aria-label={Kind(collection)}>
      <nav className="ch-crumbs" aria-label="Breadcrumb">
        <button type="button" onClick={() => onNavigate?.(null)}>
          {collection.kind === "space" ? "Shared spaces" : "Albums"}
        </button>
        {crumbs.map((crumb) => (
          <React.Fragment key={crumb.id}>
            <Icon name="mdiChevronRight" />
            <button type="button" onClick={() => onNavigate?.(crumb.id)}>
              {crumb.name}
            </button>
          </React.Fragment>
        ))}
        <Icon name="mdiChevronRight" />
        <span aria-current="page">{collection.name}</span>
      </nav>
      <div className="ch-main">
        <div className="ch-icon-wrap">
          {editor ? (
            <button
              type="button"
              className={`ch-icon ch-icon-button ${iconOpen ? "open" : ""}`}
              aria-label="Change icon"
              title="Change icon"
              aria-haspopup="dialog"
              aria-expanded={iconOpen}
              onClick={() => setIconOpen((value) => !value)}
            >
              <Icon name={collection.icon} />
              <span className="ch-icon-edit" aria-hidden="true">
                <Icon name="mdiPencilOutline" size={12} />
              </span>
            </button>
          ) : (
            <div className="ch-icon" aria-hidden="true">
              <Icon name={collection.icon} />
            </div>
          )}
          {iconOpen && (
            <IconChooser
              value={collection.icon}
              label={`Icon for ${collection.name}`}
              onChange={(icon) => patch({ icon }, "Icon updated")}
              onClose={() => setIconOpen(false)}
            />
          )}
        </div>
        <div className="ch-text">
          <div className="ch-title-row">
            <InlineEdit
              as="h1"
              className="ch-title"
              label="Title"
              value={collection.name}
              editable={editor}
              placeholder={`Untitled ${kindLabel(collection)}`}
              onSave={(name) => patch({ name }, "Title saved")}
            />
            {collection.smart && (
              <span className="ch-badge">
                <Icon name="mdiAutoFix" /> Smart
              </span>
            )}
            {collection.kind === "space" && (
              <span className="ch-badge">Shared space</span>
            )}
            {!owner && (
              <span className="ch-shared-by">
                <PersonAvatar person={ownerUser} size={18} />
                Shared by {ownerUser.name}
                {role === "viewer" ? " · View only" : ""}
              </span>
            )}
          </div>
          <InlineEdit
            as="p"
            className="ch-desc"
            label="Description"
            value={collection.description}
            editable={editor}
            multiline
            placeholder={editor ? "Add a description" : ""}
            onSave={(description) =>
              patch({ description }, "Description saved")
            }
          />
          <div className="ch-summary">
            <span>{plural(items.length, "item")}</span>
            {dates.latest && (
              <>
                <span className="dot" />
                <span>{formatDateRange(dates.earliest, dates.latest)}</span>
              </>
            )}
            <span className="dot" />
            {others.length ? (
              <button
                type="button"
                className="ch-members"
                onClick={openShare}
                aria-label={`Shared with ${plural(others.length, "person", "people")}. Manage members`}
              >
                <UserAvatars
                  users={users}
                  ids={others.map((member) => member.userId)}
                  size={20}
                />
                <span>
                  Shared with{" "}
                  {others
                    .slice(0, 2)
                    .map(
                      (member) =>
                        (
                          users.find((user) => user.id === member.userId) || {
                            name: member.userId,
                          }
                        ).name,
                    )
                    .join(", ")}
                  {others.length > 2 ? ` and ${others.length - 2} more` : ""}
                </span>
              </button>
            ) : owner ? (
              <button type="button" className="ch-members" onClick={openShare}>
                <Icon name="mdiAccountPlusOutline" />
                <span>Private · share it</span>
              </button>
            ) : (
              <span>Private</span>
            )}
            {(likes > 0 || comments > 0) && (
              <>
                <span className="dot" />
                <span>
                  {[
                    likes ? plural(likes, "like") : null,
                    comments ? plural(comments, "comment") : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </>
            )}
          </div>
          {collection.smart && (
            <div className="ch-rule">
              <RuleChips rule={collection.smart.rule} people={people} />
              <span className="cl-muted">
                Checked {timeAgo(collection.updatedAt)}
              </span>
            </div>
          )}
        </div>
      </div>
      <div
        className="ch-actions"
        role="toolbar"
        aria-label={`${Kind(collection)} actions`}
      >
        {editor && collection.kind === "collection" && (
          <Button primary icon="mdiPlus" onClick={() => setDialog("new-album")}>
            New album
          </Button>
        )}
        {editor && !collection.smart && collection.kind !== "collection" && (
          <Menu
            primary
            icon="mdiPlus"
            label="Add photos"
            align="start"
            items={[
              {
                id: "select",
                icon: "mdiImageMultipleOutline",
                label: "Select from library",
                onSelect: () => onAddPhotos?.(),
              },
              {
                id: "upload",
                icon: "mdiUpload",
                label: "Upload from computer",
                onSelect: () => onUpload?.(),
              },
            ]}
          />
        )}
        {collection.smart && (
          <Button
            primary
            icon="mdiRefresh"
            onClick={() => setDialog("reevaluate")}
          >
            Re-evaluate
          </Button>
        )}
        <Button
          icon={owner ? "mdiAccountPlusOutline" : "mdiAccountMultipleOutline"}
          onClick={openShare}
        >
          {owner ? "Share" : "Members"}
        </Button>
        {!compact && (
          <>
            {owner && (
              <Button
                icon="mdiLinkVariant"
                aria-label={linkCount ? `Links, ${linkCount}` : "Create link"}
                onClick={() =>
                  linkCount ? onManageLinks?.() : onCreateLink?.()
                }
              >
                Links
                {linkCount > 0 && <span className="ch-count">{linkCount}</span>}
              </Button>
            )}
            <Button
              icon="mdiMapOutline"
              disabled={!mappable}
              onClick={() => onOpenMap?.()}
            >
              Map
            </Button>
            <Button
              icon="mdiPlayCircleOutline"
              disabled={!items.length}
              onClick={() => onSlideshow?.()}
            >
              Slideshow
            </Button>
            <Button
              icon="mdiDownloadOutline"
              disabled={!items.length}
              onClick={() => onDownload?.()}
            >
              Download
            </Button>
            <Button
              icon="mdiCommentTextOutline"
              aria-label={`Activity, ${plural(likes + comments, "entry", "entries")}`}
              onClick={() => onOpenActivity?.()}
            >
              Activity
              {likes + comments > 0 && (
                <span className="ch-count">{likes + comments}</span>
              )}
            </Button>
          </>
        )}
        <span className="spacer" />
        <Menu
          icon="mdiDotsHorizontal"
          aria-label="More actions"
          items={[
            ...(compact
              ? [
                  owner && {
                    id: "links",
                    icon: "mdiLinkVariant",
                    label: linkCount ? `Links (${linkCount})` : "Create link",
                    onSelect: () =>
                      linkCount ? onManageLinks?.() : onCreateLink?.(),
                  },
                  {
                    id: "map",
                    icon: "mdiMapOutline",
                    label: "Map",
                    disabled: !mappable,
                    onSelect: () => onOpenMap?.(),
                  },
                  {
                    id: "slideshow",
                    icon: "mdiPlayCircleOutline",
                    label: "Slideshow",
                    disabled: !items.length,
                    onSelect: () => onSlideshow?.(),
                  },
                  {
                    id: "download",
                    icon: "mdiDownloadOutline",
                    label: "Download",
                    disabled: !items.length,
                    onSelect: () => onDownload?.(),
                  },
                  {
                    id: "activity",
                    icon: "mdiCommentTextOutline",
                    label:
                      likes + comments
                        ? `Activity (${likes + comments})`
                        : "Activity",
                    onSelect: () => onOpenActivity?.(),
                  },
                  { separator: true },
                ]
              : []),
            editor && {
              id: "edit",
              icon: "mdiPencilOutline",
              label: "Edit details",
              onSelect: () => setDialog("edit"),
            },
            {
              id: "badges",
              icon: "mdiAccountCircleOutline",
              label: "Owner badges",
              checked: collection.showOwnerBadges,
              onSelect: () =>
                patch(
                  { showOwnerBadges: !collection.showOwnerBadges },
                  collection.showOwnerBadges
                    ? "Owner badges hidden"
                    : "Owner badges shown",
                ),
            },
            editor &&
              !collection.smart && {
                id: "cover",
                icon: "mdiImageOutline",
                label: "Select cover",
                disabled: !items.length,
                onSelect: () => setDialog("cover"),
              },
            editor && {
              id: "options",
              icon: "mdiTuneVariant",
              label: "Options",
              onSelect: () => setDialog("options"),
            },
            { separator: true },
            owner
              ? {
                  id: "delete",
                  icon: "mdiDeleteOutline",
                  label: `Delete ${kindLabel(collection)}`,
                  danger: true,
                  onSelect: () => setDialog("delete"),
                }
              : {
                  id: "leave",
                  icon: "mdiLogoutVariant",
                  label: `Leave ${kindLabel(collection)}`,
                  danger: true,
                  onSelect: () => setDialog("leave"),
                },
          ]}
        />
      </div>
      <p className="ch-status" role="status" aria-live="polite">
        {status}
      </p>
      {collection.kind === "collection" && state && (
        <div className="ch-albums">
          <div className="ch-albums-head">
            <h2>Albums</h2>
            <small>{plural(childAlbums.length, "album")}</small>
          </div>
          <div className="al-grid compact">
            {childAlbums.map((child) => {
              const childItems = collectionAssets(child, library);
              const childDates = assetDates(childItems);
              return (
                <AlbumCard
                  key={child.id}
                  collection={child}
                  cover={coverAsset(child, library)}
                  count={childItems.length}
                  earliestAt={childDates.earliest}
                  latestAt={childDates.latest}
                  users={users}
                  currentUserId={currentUserId}
                  onOpen={(id) => onNavigate?.(id)}
                />
              );
            })}
            {editor && (
              <button
                type="button"
                className="al-new-tile"
                onClick={() => setDialog("new-album")}
              >
                <Icon name="mdiPlus" />
                New album
              </button>
            )}
          </div>
        </div>
      )}
      {children}

      {dialog === "new-album" && state && onState && (
        <CollectionFormDialog
          state={state}
          kind="album"
          defaultParentId={collection.id}
          people={people}
          tags={tagList}
          assets={library}
          close={closeDialog}
          onSubmit={(input) => {
            const created = createCollection(state, {
              ...input,
              kind: "album",
              ownerId: currentUserId,
            });
            onState(created.state);
            setStatus(`Created “${created.collection.name}”`);
          }}
        />
      )}
      {dialog === "share" && state && onState && (
        <ShareDialog
          state={state}
          onState={onState}
          collectionId={collection.id}
          users={users}
          currentUserId={currentUserId}
          close={closeDialog}
          onLeave={() => setDialog("leave")}
          onShared={(userId, memberRole) => {
            setStatus("Invitation sent");
            onShare?.(userId, memberRole);
          }}
        />
      )}
      {dialog === "cover" && (
        <CoverDialog
          collection={collection}
          assets={items}
          close={closeDialog}
          onSelect={(assetId) => {
            onSelectCover?.(assetId);
            patch(
              { coverAssetId: assetId },
              assetId ? "Cover updated" : "Cover follows the newest item",
            );
          }}
        />
      )}
      {dialog === "options" && (
        <OptionsDialog
          collection={collection}
          close={closeDialog}
          onChange={(change) => patch(change, "Options saved")}
        />
      )}
      {dialog === "edit" && state && (
        <CollectionFormDialog
          state={state}
          collection={collection}
          people={people}
          tags={tagList}
          assets={library}
          close={closeDialog}
          onSubmit={(input) => {
            onChange?.(input);
            setStatus("Details saved");
          }}
        />
      )}
      {dialog === "delete" && (
        <DeleteDialog
          collection={collection}
          count={items.length}
          close={closeDialog}
          onConfirm={() => onDelete?.()}
        />
      )}
      {dialog === "leave" && (
        <LeaveDialog
          collection={collection}
          close={closeDialog}
          onConfirm={() => onLeave?.()}
        />
      )}
      {dialog === "reevaluate" && collection.smart && (
        <ReevaluateDialog
          collection={collection}
          allAssets={library}
          currentIds={items.map((asset) => asset.id)}
          people={people}
          close={closeDialog}
          onApply={(ids) => {
            onReevaluate?.(ids);
            patch(
              { smart: collection.smart },
              `Smart album checked · ${plural(ids.length, "item")}`,
            );
          }}
        />
      )}
    </header>
  );
}
