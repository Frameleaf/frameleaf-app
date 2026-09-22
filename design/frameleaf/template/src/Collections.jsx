import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { Button } from "./App";
import { Icon } from "./Icon";
import { AlbumCard, AvatarStack, spanLabel } from "./AlbumCard";
import {
  CollectionFormDialog,
  DeleteDialog,
  LeaveDialog,
  Menu,
  MoveDialog,
  ReevaluateDialog,
  ShareDialog,
} from "./CollectionHeader";
import {
  canEdit,
  collectionAssets,
  collectionSorts,
  coverAsset,
  createCollection,
  createLink,
  deleteCollection,
  findCollection,
  isMember,
  kindLabel,
  leaveCollection,
  listCollections,
  moveCollection,
  plural,
  roleOf,
  timeAgo,
  updateCollection,
} from "./collections-data.mjs";
import "./collections.css";

const viewKey = "frameleaf:albums-view:v1";
const viewModes = ["grid", "list"];
const filterOptions = [
  ["all", "All"],
  ["owned", "My albums"],
  ["shared", "Shared"],
  ["smart", "Smart"],
];
const filterIds = filterOptions.map(([id]) => id);
const sortOptions = [
  ["modified", "Last modified"],
  ["created", "Date created"],
  ["title", "Title"],
  ["items", "Item count"],
  ["recent-photo", "Newest photos"],
  ["oldest-photo", "Oldest photos"],
];

function readView() {
  try {
    const raw = JSON.parse(localStorage.getItem(viewKey) || "null");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return {
      tab: filterIds.includes(raw.tab) ? raw.tab : undefined,
      sort: collectionSorts.includes(raw.sort) ? raw.sort : undefined,
      view: viewModes.includes(raw.view) ? raw.view : undefined,
      collapsed: Array.isArray(raw.collapsed)
        ? raw.collapsed.filter((id) => typeof id === "string").slice(0, 200)
        : undefined,
    };
  } catch {
    return {};
  }
}

/** 2×2 of album covers that stands in for a collection, like a folder of prints. */
function Mosaic({ covers, icon }) {
  if (!covers.length)
    return (
      <span className="al-mosaic" aria-hidden="true">
        <span className="al-mosaic-icon">
          <Icon name={icon} size={22} />
        </span>
      </span>
    );
  if (covers.length === 1)
    return (
      <span className="al-mosaic single" aria-hidden="true">
        <img src={covers[0]} alt="" draggable={false} />
      </span>
    );
  return (
    <span className="al-mosaic" aria-hidden="true">
      {[0, 1, 2, 3].map((index) =>
        covers[index] ? (
          <img key={index} src={covers[index]} alt="" draggable={false} />
        ) : (
          <span key={index} className="tile" />
        ),
      )}
    </span>
  );
}

/**
 * Albums page. Collections are shelves with their albums laid out beneath;
 * albums that live on their own and shared spaces follow. Albums can be
 * dragged onto a collection (mouse or pen) or moved through the dialog.
 */
export function Collections({
  assets = [],
  people = [],
  users = [],
  currentUserId = "taylor",
  state,
  onChange,
  onOpen,
  onCreateLink,
  onUpload,
  onDownload,
  onDeleted,
  onShare,
  createRequest = null,
}) {
  const saved = useMemo(readView, []);
  const [tab, setTab] = useState(saved.tab || "all");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState(saved.sort || "modified");
  const [view, setView] = useState(saved.view || "grid");
  const [collapsed, setCollapsed] = useState(() => new Set(saved.collapsed || []));
  const [dialog, setDialog] = useState(null);
  const [status, setStatus] = useState("");
  const [drag, setDrag] = useState(null);
  const dragRef = useRef(null);
  const dragView = useRef(null);
  const suppressClick = useRef(false);
  const timers = useRef([]);
  const headingId = useId();

  useEffect(() => {
    try {
      localStorage.setItem(
        viewKey,
        JSON.stringify({ tab, sort, view, collapsed: [...collapsed] }),
      );
    } catch {
      /* per-device convenience only */
    }
  }, [tab, sort, view, collapsed]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  useEffect(() => {
    if (!createRequest?.key) return;
    setDialog({
      type: "create",
      kind: createRequest.kind || "album",
      parentId: createRequest.parentId ?? null,
    });
  }, [createRequest?.key]);
  useEffect(() => {
    if (!drag) return undefined;
    const onKey = (event) => {
      if (event.key !== "Escape") return;
      dragRef.current = null;
      dragView.current = null;
      setDrag(null);
      setStatus("Move cancelled");
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [drag]);

  const tags = useMemo(
    () => [...new Set(assets.flatMap((asset) => asset.tagIds || asset.tags || []))].sort(),
    [assets],
  );
  const searching = search.trim().length > 0;
  const baseTab = tab === "smart" ? "all" : tab;
  const smartOnly = (entry) => tab !== "smart" || Boolean(entry.collection.smart);
  const listedAll = useMemo(
    () =>
      listCollections(state, { tab: baseTab, sort, userId: currentUserId }, assets, users)[0]
        .entries.filter(smartOnly),
    [state, baseTab, sort, currentUserId, assets, users, tab],
  );
  const listed = useMemo(
    () =>
      searching
        ? listCollections(
            state,
            { tab: baseTab, search, sort, userId: currentUserId },
            assets,
            users,
          )[0].entries.filter(smartOnly)
        : listedAll,
    [state, baseTab, search, sort, currentUserId, assets, users, tab, searching, listedAll],
  );
  const entries = useMemo(
    () => new Map(listedAll.map((entry) => [entry.collection.id, entry])),
    [listedAll],
  );
  const matches = useMemo(() => new Set(listed.map((entry) => entry.collection.id)), [listed]);
  const accessible = useMemo(
    () => state.collections.filter((item) => isMember(item, currentUserId)),
    [state, currentUserId],
  );
  const order = useMemo(
    () => new Map(listedAll.map((entry, index) => [entry.collection.id, index])),
    [listedAll],
  );
  const byOrder = (a, b) =>
    (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.id) ?? Number.MAX_SAFE_INTEGER) ||
    a.name.localeCompare(b.name);
  const childrenOf = (id) =>
    accessible.filter((item) => item.parentId === id && item.kind === "album");
  const shelves = accessible
    .filter((item) => item.kind === "collection")
    .sort(byOrder)
    .map((collection) => {
      const all = childrenOf(collection.id);
      const listedChildren = all.filter((item) => entries.has(item.id)).sort(byOrder);
      const hits = listedChildren.filter((item) => matches.has(item.id));
      const selfMatch = matches.has(collection.id);
      const albums = !searching ? listedChildren : hits.length ? hits : selfMatch ? listedChildren : [];
      const visible = searching
        ? hits.length > 0 || selfMatch
        : albums.length > 0 || entries.has(collection.id);
      return visible ? { collection, albums, all } : null;
    })
    .filter(Boolean);
  const isCollectionId = (id) => accessible.some((item) => item.id === id && item.kind === "collection");
  const loose = listed
    .filter(
      (entry) =>
        entry.collection.kind === "album" &&
        !(entry.collection.parentId && isCollectionId(entry.collection.parentId)),
    )
    .map((entry) => entry.collection);
  const spaces = listed
    .filter((entry) => entry.collection.kind === "space")
    .map((entry) => entry.collection);
  const nothing = shelves.length === 0 && loose.length === 0 && spaces.length === 0;

  const albumTotal = accessible.filter((item) => item.kind === "album").length;
  const collectionTotal = accessible.filter((item) => item.kind === "collection").length;
  const sharedTotal = accessible.filter((item) => item.members.length > 1).length;
  const summary = [
    plural(albumTotal, "album"),
    collectionTotal ? plural(collectionTotal, "collection") : null,
    sharedTotal ? `${sharedTotal} shared` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const shelfItemCount = (collection) => {
    const ids = new Set();
    for (const item of [collection, ...childrenOf(collection.id)])
      for (const asset of collectionAssets(item, assets)) ids.add(asset.id);
    return ids.size;
  };
  const itemCountOf = (collection) =>
    collection.kind === "collection"
      ? shelfItemCount(collection)
      : (entries.get(collection.id)?.itemCount ?? collectionAssets(collection, assets).length);
  const target = dialog?.id ? findCollection(state, dialog.id) : null;
  const userFor = (id) => users.find((user) => user.id === id) || { id, name: id };
  const sortLabel = sortOptions.find(([value]) => value === sort)?.[1] || "Last modified";

  const commit = (change, message) => {
    try {
      const next = change(state);
      if (next !== state) onChange(next);
      if (message) setStatus(message);
      return true;
    } catch (failure) {
      setStatus(failure.message);
      return false;
    }
  };
  const closeDialog = () => setDialog(null);
  const toggleCollapsed = (id) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const open = (id) => onOpen?.(id);
  const download = (collection) => {
    if (onDownload) return onDownload(collection.id);
    const count = itemCountOf(collection);
    setStatus(`Preparing “${collection.name}” · ${plural(count, "item")}`);
    timers.current.push(
      setTimeout(() => setStatus(`“${collection.name}” is ready to download`), 1400),
    );
    return undefined;
  };
  const link = (collection) => {
    if (onCreateLink) return onCreateLink(collection.id);
    commit(
      (current) => createLink(current, collection.id).state,
      `Link created. Anyone with the link can view this ${kindLabel(collection)}.`,
    );
    return undefined;
  };
  const menuFor = (collection) => {
    const role = roleOf(collection, currentUserId);
    const owner = role === "owner";
    const editor = owner || role === "editor";
    const isAlbum = collection.kind === "album";
    const isCollection = collection.kind === "collection";
    const count = itemCountOf(collection);
    return [
      { id: "open", icon: "mdiFolderOpenOutline", label: "Open", onSelect: () => open(collection.id) },
      editor && {
        id: "edit",
        icon: "mdiPencilOutline",
        label: "Edit",
        onSelect: () => setDialog({ type: "edit", id: collection.id }),
      },
      editor &&
        isCollection && {
          id: "new-album",
          icon: "mdiPlus",
          label: "New album",
          onSelect: () => setDialog({ type: "create", kind: "album", parentId: collection.id }),
        },
      editor &&
        isAlbum && {
          id: "move",
          icon: "mdiFolderMoveOutline",
          label: "Move to…",
          onSelect: () => setDialog({ type: "move", id: collection.id }),
        },
      editor &&
        isAlbum &&
        !collection.smart &&
        onUpload && {
          id: "upload",
          icon: "mdiUpload",
          label: "Upload photos",
          onSelect: () => onUpload(collection.id),
        },
      collection.smart && {
        id: "reevaluate",
        icon: "mdiRefresh",
        label: "Re-evaluate",
        onSelect: () => setDialog({ type: "reevaluate", id: collection.id }),
      },
      { separator: true },
      {
        id: "share",
        icon: owner ? "mdiAccountPlusOutline" : "mdiAccountMultipleOutline",
        label: owner ? "Share" : "Members",
        onSelect: () => setDialog({ type: "share", id: collection.id }),
      },
      owner && { id: "link", icon: "mdiLinkVariant", label: "Create link", onSelect: () => link(collection) },
      {
        id: "download",
        icon: "mdiDownloadOutline",
        label: "Download",
        disabled: !count,
        onSelect: () => download(collection),
      },
      { separator: true },
      owner
        ? {
            id: "delete",
            icon: "mdiDeleteOutline",
            label: "Delete",
            danger: true,
            onSelect: () => setDialog({ type: "delete", id: collection.id }),
          }
        : {
            id: "leave",
            icon: "mdiLogoutVariant",
            label: "Leave",
            danger: true,
            onSelect: () => setDialog({ type: "leave", id: collection.id }),
          },
    ];
  };

  /* ---- drag an album onto a collection shelf (mouse and pen; touch uses Move to…) ---- */
  const validTarget = (sourceId, targetId) => {
    if (!targetId || targetId === sourceId) return false;
    const source = findCollection(state, sourceId);
    const destination = findCollection(state, targetId);
    return Boolean(
      source &&
        destination &&
        source.kind === "album" &&
        destination.kind === "collection" &&
        canEdit(destination, currentUserId) &&
        source.parentId !== targetId,
    );
  };
  const setDragState = (value) => {
    dragView.current = value;
    setDrag(value);
  };
  const onPointerDown = (event, collection) => {
    if (event.button !== 0 || event.pointerType === "touch") return;
    if (collection.kind !== "album" || !canEdit(collection, currentUserId)) return;
    if (event.target.closest("button, a, input, select, [role='menu']")) return;
    dragRef.current = {
      id: collection.id,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
      pointerId: event.pointerId,
      element: event.currentTarget,
    };
  };
  const onPointerMove = (event) => {
    const current = dragRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    if (!current.active) {
      if (Math.hypot(event.clientX - current.startX, event.clientY - current.startY) < 6) return;
      current.active = true;
      try {
        current.element.setPointerCapture(event.pointerId);
      } catch {
        /* capture is best effort */
      }
    }
    const under = document.elementFromPoint(event.clientX, event.clientY);
    const zone = under?.closest("[data-drop-id]");
    const overId = zone?.getAttribute("data-drop-id") ?? null;
    const overRoot = overId === "root";
    setDragState({
      id: current.id,
      x: event.clientX,
      y: event.clientY,
      overId: !overRoot && validTarget(current.id, overId) ? overId : null,
      overRoot,
    });
  };
  const onPointerUp = (event) => {
    const current = dragRef.current;
    if (!current) return;
    dragRef.current = null;
    if (!current.active) return;
    try {
      current.element.releasePointerCapture(event.pointerId);
    } catch {
      /* already released */
    }
    suppressClick.current = true;
    setTimeout(() => {
      suppressClick.current = false;
    }, 0);
    const result = dragView.current;
    setDragState(null);
    if (!result) return;
    const source = findCollection(state, current.id);
    if (!source) return;
    if (result.overRoot) {
      const parent = findCollection(state, source.parentId);
      if (source.parentId !== null)
        commit(
          (value) => moveCollection(value, source.id, null),
          parent ? `Moved “${source.name}” out of “${parent.name}”` : `Moved “${source.name}”`,
        );
    } else if (result.overId) {
      const destination = findCollection(state, result.overId);
      commit(
        (value) => moveCollection(value, source.id, result.overId),
        `Moved “${source.name}” into “${destination?.name}”`,
      );
    }
  };
  const onPointerCancel = () => {
    dragRef.current = null;
    setDragState(null);
  };
  const suppress = (event) => {
    if (suppressClick.current) {
      event.preventDefault();
      event.stopPropagation();
    }
  };
  const dragProps = (collection) => ({
    onPointerDown: (event) => onPointerDown(event, collection),
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onClickCapture: suppress,
  });

  /* ---- renderers ---- */
  const coverOf = (collection) => {
    const entry = entries.get(collection.id);
    if (entry?.coverAssetId) return assets.find((asset) => asset.id === entry.coverAssetId) || null;
    return coverAsset(collection, assets);
  };
  const othersOf = (collection) =>
    collection.members
      .filter((member) => member.userId !== currentUserId)
      .map((member) => member.userId);
  const albumCard = (collection) => {
    const entry = entries.get(collection.id);
    return (
      <AlbumCard
        key={collection.id}
        collection={collection}
        cover={coverOf(collection)}
        count={entry?.itemCount ?? collectionAssets(collection, assets).length}
        earliestAt={entry?.earliestAt ?? null}
        latestAt={entry?.latestAt ?? null}
        users={users}
        currentUserId={currentUserId}
        onOpen={open}
        className={drag?.id === collection.id ? "dragging" : ""}
        dragProps={dragProps(collection)}
        actions={
          <Menu
            className="al-card-menu"
            icon="mdiDotsHorizontal"
            aria-label={`Actions for ${collection.name}`}
            items={menuFor(collection)}
          />
        }
      />
    );
  };
  const albumRow = (collection) => {
    const entry = entries.get(collection.id);
    const cover = coverOf(collection);
    return (
      <li
        key={collection.id}
        className={`al-row${drag?.id === collection.id ? " dragging" : ""}`}
        aria-label={collection.name}
        {...dragProps(collection)}
      >
        <button type="button" className="al-row-open" onClick={() => open(collection.id)}>
          <span className="al-row-thumb" aria-hidden="true">
            {cover ? (
              <img src={cover.image} alt="" loading="lazy" draggable={false} />
            ) : (
              <Icon name={collection.icon} size={20} />
            )}
          </span>
          <span className="al-row-text">
            <strong>
              {collection.name}
              {collection.smart && (
                <span className="al-row-badge">
                  <Icon name="mdiAutoFix" size={13} />
                  Smart
                </span>
              )}
            </strong>
            <small>
              {spanLabel(entry || { itemCount: collectionAssets(collection, assets).length })}
            </small>
          </span>
        </button>
        <AvatarStack users={users} ids={othersOf(collection)} size={20} />
        <span className="al-row-updated">{timeAgo(collection.updatedAt)}</span>
        <Menu
          className="al-row-menu"
          icon="mdiDotsHorizontal"
          aria-label={`Actions for ${collection.name}`}
          items={menuFor(collection)}
        />
      </li>
    );
  };
  const albumsBlock = (list, emptyText = "") =>
    view === "grid" ? (
      <div className="al-grid">
        {list.map(albumCard)}
        {list.length === 0 && emptyText && <p className="al-shelf-empty">{emptyText}</p>}
      </div>
    ) : (
      <ul className="al-list">
        {list.map(albumRow)}
        {list.length === 0 && emptyText && <li className="al-row-empty">{emptyText}</li>}
      </ul>
    );
  const renderShelf = ({ collection, albums, all }) => {
    const isCollapsed = collapsed.has(collection.id);
    const editor = canEdit(collection, currentUserId);
    const covers = all.map((item) => coverOf(item)?.image).filter(Boolean).slice(0, 4);
    const titleId = `${headingId}-${collection.id}`;
    return (
      <section
        key={collection.id}
        className={`al-shelf${drag?.overId === collection.id ? " drop-target" : ""}`}
        data-drop-id={collection.id}
        aria-labelledby={titleId}
      >
        <div className="al-shelf-head">
          <button
            type="button"
            className="al-shelf-toggle"
            aria-expanded={!isCollapsed}
            aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${collection.name}`}
            onClick={() => toggleCollapsed(collection.id)}
          >
            <Icon name={isCollapsed ? "mdiChevronRight" : "mdiChevronDown"} size={20} />
          </button>
          <button
            type="button"
            className="al-shelf-open"
            aria-label={`Open ${collection.name}`}
            onClick={() => open(collection.id)}
          >
            <Mosaic covers={covers} icon={collection.icon} />
            <span className="al-shelf-text">
              <h2 id={titleId}>{collection.name}</h2>
              <small>
                {plural(all.length, "album")} · {plural(shelfItemCount(collection), "item")}
                {collection.description ? ` · ${collection.description}` : ""}
              </small>
            </span>
          </button>
          <div className="al-shelf-side">
            <AvatarStack users={users} ids={othersOf(collection)} size={22} />
            {editor && (
              <Button
                icon="mdiPlus"
                aria-label={`New album in ${collection.name}`}
                onClick={() => setDialog({ type: "create", kind: "album", parentId: collection.id })}
              >
                Album
              </Button>
            )}
            <Menu
              icon="mdiDotsHorizontal"
              aria-label={`Actions for ${collection.name}`}
              items={menuFor(collection)}
            />
          </div>
        </div>
        {!isCollapsed &&
          albumsBlock(
            albums,
            editor ? "No albums yet. Add one, or drag an album onto this collection." : "No albums yet.",
          )}
      </section>
    );
  };
  const renderPlain = (key, title, list, noun) => (
    <section key={key} className={`al-shelf plain ${key}`} aria-label={title || "Albums"}>
      {title && (
        <div className="al-shelf-head">
          <h2 className="al-plain-title">
            {title}
            <small>{plural(list.length, noun)}</small>
          </h2>
        </div>
      )}
      {albumsBlock(list)}
    </section>
  );

  const dragged = drag ? findCollection(state, drag.id) : null;
  const draggedParent = dragged ? findCollection(state, dragged.parentId) : null;

  return (
    <section className="albums" aria-labelledby={headingId}>
      <header className="al-header">
        <div className="al-heading">
          <h1 id={headingId}>Albums</h1>
          <p>{summary}</p>
        </div>
        <div className="al-tools">
          <label className="al-search">
            <Icon name="mdiMagnify" size={17} />
            <input
              type="search"
              value={search}
              placeholder="Search albums"
              aria-label="Search albums"
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <Menu
            icon="mdiSortVariant"
            label={sortLabel}
            aria-label="Sort albums"
            items={sortOptions.map(([value, label]) => ({
              id: value,
              label,
              checked: sort === value,
              onSelect: () => setSort(value),
            }))}
          />
          <div className="al-view" role="group" aria-label="View">
            <button
              type="button"
              aria-pressed={view === "grid"}
              aria-label="Grid view"
              title="Grid view"
              onClick={() => setView("grid")}
            >
              <Icon name="mdiViewGridOutline" size={18} />
            </button>
            <button
              type="button"
              aria-pressed={view === "list"}
              aria-label="List view"
              title="List view"
              onClick={() => setView("list")}
            >
              <Icon name="mdiViewListOutline" size={18} />
            </button>
          </div>
          <Menu
            primary
            icon="mdiPlus"
            label="New"
            align="end"
            items={[
              {
                id: "album",
                icon: "mdiImageAlbum",
                label: "Album",
                onSelect: () => setDialog({ type: "create", kind: "album" }),
              },
              {
                id: "smart",
                icon: "mdiAutoFix",
                label: "Smart album",
                onSelect: () => setDialog({ type: "create", kind: "album", smart: true }),
              },
              { separator: true },
              {
                id: "collection",
                icon: "mdiFolderMultipleOutline",
                label: "Collection",
                onSelect: () => setDialog({ type: "create", kind: "collection" }),
              },
              {
                id: "space",
                icon: "mdiAccountMultipleOutline",
                label: "Shared space",
                onSelect: () => setDialog({ type: "create", kind: "space" }),
              },
            ]}
          />
        </div>
      </header>
      <div className="al-filters" role="tablist" aria-label="Show">
        {filterOptions.map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            tabIndex={tab === value ? 0 : -1}
            onClick={() => setTab(value)}
            onKeyDown={(event) => {
              const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
              if (!step) return;
              event.preventDefault();
              const index = filterIds.indexOf(tab);
              const nextIndex = (index + step + filterIds.length) % filterIds.length;
              setTab(filterIds[nextIndex]);
              event.currentTarget.parentElement?.querySelectorAll("[role=tab]")[nextIndex]?.focus();
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="cl-status" role="status" aria-live="polite">
        {status}
      </p>
      {shelves.map(renderShelf)}
      {loose.length > 0 &&
        renderPlain("loose", shelves.length || spaces.length ? "Other albums" : "", loose, "album")}
      {spaces.length > 0 && renderPlain("spaces", "Shared spaces", spaces, "space")}
      {nothing && (
        <div className="al-empty">
          <Icon name="mdiImageAlbum" size={36} />
          <h2>
            {searching
              ? "No albums match"
              : tab === "shared"
                ? "Nothing shared yet"
                : tab === "smart"
                  ? "No smart albums yet"
                  : "No albums yet"}
          </h2>
          <p>
            {searching
              ? "Try a different search or clear it."
              : tab === "shared"
                ? "Share an album with someone to see it here."
                : tab === "smart"
                  ? "A smart album fills itself from rules such as people, tags or dates."
                  : "Create an album to start organising."}
          </p>
        </div>
      )}
      <div
        className={`al-root-drop${draggedParent ? " visible" : ""}${drag?.overRoot ? " over" : ""}`}
        data-drop-id="root"
        aria-hidden="true"
      >
        Drop here to take “{dragged?.name}” out of “{draggedParent?.name}”
      </div>
      <p className="al-preview-note">Preview · sample data</p>
      {drag && (
        <div
          className={`al-drop-hint${drag.overId || drag.overRoot ? " ready" : ""}`}
          style={{ left: drag.x + 14, top: drag.y + 14 }}
          aria-hidden="true"
        >
          {drag.overRoot
            ? "Take out of its collection"
            : drag.overId
              ? `Move into ${findCollection(state, drag.overId)?.name}`
              : `Moving ${dragged?.name}`}
        </div>
      )}

      {dialog?.type === "create" && (
        <CollectionFormDialog
          state={state}
          people={people}
          tags={tags}
          assets={assets}
          kind={dialog.kind}
          smart={Boolean(dialog.smart)}
          defaultParentId={dialog.parentId ?? null}
          close={closeDialog}
          onSubmit={(input) => {
            const { state: next, collection } = createCollection(state, {
              ...input,
              kind: dialog.kind,
              ownerId: currentUserId,
            });
            onChange(next);
            setStatus(`Created “${collection.name}”`);
          }}
        />
      )}
      {dialog?.type === "edit" && target && (
        <CollectionFormDialog
          state={state}
          collection={target}
          people={people}
          tags={tags}
          assets={assets}
          close={closeDialog}
          onSubmit={(input) => {
            onChange(updateCollection(state, target.id, input));
            setStatus(`Saved “${input.name.trim()}”`);
          }}
        />
      )}
      {dialog?.type === "move" && target && (
        <MoveDialog
          state={state}
          collection={target}
          close={closeDialog}
          onMove={(parentId) => {
            onChange(moveCollection(state, target.id, parentId));
            const destination = findCollection(state, parentId);
            setStatus(
              destination
                ? `Moved “${target.name}” into “${destination.name}”`
                : `“${target.name}” is now on its own`,
            );
          }}
        />
      )}
      {dialog?.type === "share" && target && (
        <ShareDialog
          state={state}
          onState={onChange}
          collectionId={target.id}
          users={users}
          currentUserId={currentUserId}
          close={closeDialog}
          onLeave={() => setDialog({ type: "leave", id: target.id })}
          onShared={(userId, role) => {
            setStatus(`Invited ${userFor(userId).name} as ${role}`);
            onShare?.(target.id, userId, role);
          }}
        />
      )}
      {dialog?.type === "delete" && target && (
        <DeleteDialog
          collection={target}
          count={itemCountOf(target)}
          close={closeDialog}
          onConfirm={() => {
            const { state: next, assetIds } = deleteCollection(state, target.id, { assets });
            onChange(next);
            onDeleted?.(target.id, assetIds);
            setStatus(
              target.kind === "collection"
                ? `Deleted “${target.name}”. Its albums are now on their own.`
                : `Deleted “${target.name}”. Its items stay in your library.`,
            );
          }}
        />
      )}
      {dialog?.type === "leave" && target && (
        <LeaveDialog
          collection={target}
          close={closeDialog}
          onConfirm={() =>
            commit(
              (current) => leaveCollection(current, target.id, currentUserId),
              `You left “${target.name}”`,
            )
          }
        />
      )}
      {dialog?.type === "reevaluate" && target?.smart && (
        <ReevaluateDialog
          collection={target}
          allAssets={assets}
          currentIds={collectionAssets(target, assets).map((asset) => asset.id)}
          people={people}
          close={closeDialog}
          onApply={(ids) =>
            commit(
              (current) => updateCollection(current, target.id, { smart: target.smart }),
              `“${target.name}” re-evaluated · ${plural(ids.length, "item")}`,
            )
          }
        />
      )}
    </section>
  );
}
