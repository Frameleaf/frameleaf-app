import React, { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./Icon";
import { Button } from "./App";
import { captureDate, videoAsset } from "./explore-timeline.mjs";
import { folderAt, folderTree, formatBytes } from "./discovery-data.mjs";
import { timecode } from "./media";
import "./discovery.css";

const countLabel = (count, word = "item") =>
  `${count} ${count === 1 ? word : `${word}s`}`;

/** Skip pass-through folders that only contain a single subfolder. */
function firstUseful(tree) {
  let node = tree.root;
  while (node.children.length === 1 && !node.directCount) node = node.children[0];
  return node.path;
}
function flatten(nodes, expanded, out = []) {
  for (const node of nodes) {
    out.push(node);
    if (node.children.length && expanded.has(node.path)) flatten(node.children, expanded, out);
  }
  return out;
}

function FolderRow({ node, expanded, current, focused, onToggle, onOpen, onFocus, depth = 0 }) {
  const open = expanded.has(node.path);
  return (
    <li
      role="treeitem"
      aria-expanded={node.children.length ? open : undefined}
      aria-selected={current === node.path}
      aria-level={depth + 1}
      data-folder={node.path}
      tabIndex={focused === node.path ? 0 : -1}
      className={`dv-tree-item${current === node.path ? " selected" : ""}`}
      style={{ "--depth": depth }}
      onClick={(event) => {
        event.stopPropagation();
        onOpen(node.path);
      }}
      onFocus={(event) => {
        event.stopPropagation();
        onFocus(node.path);
      }}
    >
      <span className="dv-tree-row">
        {node.children.length ? (
          <button
            type="button"
            className="dv-tree-toggle"
            tabIndex={-1}
            aria-label={`${open ? "Collapse" : "Expand"} ${node.name}`}
            onClick={(event) => {
              event.stopPropagation();
              onToggle(node.path);
            }}
          >
            <Icon name={open ? "mdiChevronDown" : "mdiChevronRight"} size={16} />
          </button>
        ) : (
          <span className="dv-tree-toggle" aria-hidden="true" />
        )}
        <Icon name={current === node.path ? "mdiFolderOpenOutline" : "mdiFolderOutline"} size={16} />
        <span className="dv-tree-name">{node.name}</span>
        <small>{node.count}</small>
      </span>
      {node.children.length > 0 && open && (
        <ul role="group">
          {node.children.map((child) => (
            <FolderRow
              key={child.path}
              node={child}
              expanded={expanded}
              current={current}
              focused={focused}
              onToggle={onToggle}
              onOpen={onOpen}
              onFocus={onFocus}
              depth={depth + 1}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

export function Folders({ assets = [], onOpenAsset, onQuery }) {
  const tree = useMemo(() => folderTree(assets), [assets]);
  const [path, setPath] = useState(() => firstUseful(tree));
  const [expanded, setExpanded] = useState(
    () => new Set((folderAt(tree, firstUseful(tree)) || tree.root).breadcrumbs.map((crumb) => crumb.path)),
  );
  const [focused, setFocused] = useState(null);
  const [sort, setSort] = useState("name");
  const [status, setStatus] = useState("");
  const treeRef = useRef(null);
  const folder = folderAt(tree, path) || tree.root;
  useEffect(() => {
    if (!folderAt(tree, path)) setPath(firstUseful(tree));
  }, [tree, path]);
  const open = (next) => {
    setPath(next);
    setFocused(next);
    setExpanded((value) => {
      const set = new Set(value);
      for (const crumb of (folderAt(tree, next) || tree.root).breadcrumbs) set.add(crumb.path);
      return set;
    });
  };
  const toggle = (id) =>
    setExpanded((value) => {
      const next = new Set(value);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const visible = useMemo(() => flatten([tree.root], expanded), [tree, expanded]);
  const focusId = focused && folderAt(tree, focused) ? focused : path;
  const focusItem = (id) => {
    setFocused(id);
    [...(treeRef.current?.querySelectorAll("[data-folder]") || [])]
      .find((element) => element.dataset.folder === id)
      ?.focus();
  };
  const keyboard = (event) => {
    const item = folderAt(tree, focusId);
    if (!item) return;
    const index = visible.findIndex((entry) => entry.path === focusId);
    const parentPath = item.breadcrumbs.at(-2)?.path;
    const actions = {
      ArrowDown: () => visible[index + 1] && focusItem(visible[index + 1].path),
      ArrowUp: () => visible[index - 1] && focusItem(visible[index - 1].path),
      Home: () => focusItem(visible[0].path),
      End: () => focusItem(visible.at(-1).path),
      ArrowRight: () => {
        if (!item.children.length) return;
        if (!expanded.has(item.path)) toggle(item.path);
        else focusItem(item.children[0].path);
      },
      ArrowLeft: () => {
        if (item.children.length && expanded.has(item.path)) toggle(item.path);
        else if (parentPath) focusItem(parentPath);
      },
      Enter: () => open(item.path),
      " ": () => open(item.path),
    };
    if (actions[event.key]) {
      event.preventDefault();
      actions[event.key]();
    }
  };
  const files = useMemo(() => {
    const list = [...folder.assets];
    if (sort === "name")
      list.sort((a, b) => (a.originalFileName || a.name || "").localeCompare(b.originalFileName || b.name || "", undefined, { numeric: true }));
    else if (sort === "size") list.sort((a, b) => (b.fileSizeInBytes || 0) - (a.fileSizeInBytes || 0));
    return list;
  }, [folder, sort]);
  const showInTimeline = () => {
    onQuery?.({ text: folder.path, mode: "fullPath" }, folder.name);
    setStatus(`Showing ${folder.name} in the timeline.`);
  };

  return (
    <main className="discovery dv-folders" aria-label="Folders">
      <header className="dv-header">
        <div>
          <h1>Folders</h1>
          <p>Browse originals the way they are stored on disk.</p>
        </div>
        <div className="dv-header-actions">
          <label className="dv-select">
            Sort
            <select value={sort} onChange={(event) => setSort(event.target.value)} aria-label="Sort files">
              <option value="name">Name</option>
              <option value="date">Date taken</option>
              <option value="size">Size</option>
            </select>
          </label>
          <Button icon="mdiTimelineClockOutline" onClick={showInTimeline} disabled={!folder.count}>
            Show in timeline
          </Button>
        </div>
      </header>
      <output className="dv-sr-only" aria-live="polite">
        {status}
      </output>
      <nav className="dv-breadcrumb dv-breadcrumb-bar" aria-label="Folder path">
        {folder.breadcrumbs.map((crumb, index) => (
          <React.Fragment key={crumb.path}>
            {index > 0 && <Icon name="mdiChevronRight" size={14} />}
            {index === folder.breadcrumbs.length - 1 ? (
              <span aria-current="page">
                {index === 0 && <Icon name="mdiHarddisk" size={15} />}
                {crumb.name}
              </span>
            ) : (
              <button type="button" onClick={() => open(crumb.path)}>
                {index === 0 && <Icon name="mdiHarddisk" size={15} />}
                {crumb.name}
              </button>
            )}
          </React.Fragment>
        ))}
      </nav>
      {!assets.length ? (
        <div className="dv-empty" role="status">
          <Icon name="mdiFolderOutline" size={30} />
          <strong>No folders yet</strong>
          <p>Imported originals appear here in the same structure as your storage.</p>
        </div>
      ) : (
        <div className="dv-split">
          <nav className="dv-pane dv-tree-pane" aria-label="Folder tree">
            <ul role="tree" aria-label="Folders" ref={treeRef} className="dv-tree" onKeyDown={keyboard}>
              <FolderRow
                node={tree.root}
                expanded={expanded}
                current={folder.path}
                focused={focusId}
                onToggle={toggle}
                onOpen={open}
                onFocus={setFocused}
              />
            </ul>
          </nav>
          <section className="dv-pane dv-detail dv-folder-detail" aria-label={`Contents of ${folder.name}`}>
            {folder.children.length > 0 && (
              <ul className="dv-folder-rows" aria-label="Subfolders">
                {folder.children.map((child) => (
                  <li key={child.path}>
                    <button type="button" onClick={() => open(child.path)}>
                      <Icon name="mdiFolderOutline" size={20} />
                      <span>
                        <strong>{child.name}</strong>
                        <small>
                          {countLabel(child.count, "file")}
                          {child.children.length ? ` · ${countLabel(child.children.length, "folder")}` : ""}
                        </small>
                      </span>
                      <small className="dv-folder-size">{formatBytes(child.size)}</small>
                      <Icon name="mdiChevronRight" size={16} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {files.length ? (
              <div className="dv-file-grid" role="list" aria-label={`Files in ${folder.name}`}>
                {files.map((asset) => (
                  <button
                    type="button"
                    role="listitem"
                    key={asset.id}
                    className="dv-file"
                    onClick={() => onOpenAsset?.(asset.id)}
                    aria-label={`Open ${asset.originalFileName || asset.name}`}
                  >
                    {asset.image ? (
                      <img src={asset.image} alt="" loading="lazy" />
                    ) : (
                      <span className="dv-cover-empty">
                        <Icon name="mdiFileDocumentOutline" size={22} />
                      </span>
                    )}
                    {videoAsset(asset) && (
                      <span className="dv-file-badge">
                        <Icon name="mdiPlay" size={12} />
                        {asset.duration ? timecode(asset.duration) : "Video"}
                      </span>
                    )}
                    <span className="dv-file-name">{asset.originalFileName || asset.name}</span>
                    <small>
                      {formatBytes(asset.fileSizeInBytes)}
                      {captureDate(asset)?.day ? ` · ${captureDate(asset).day}` : ""}
                    </small>
                  </button>
                ))}
              </div>
            ) : (
              <div className="dv-empty compact" role="status">
                <Icon name="mdiFolderOpenOutline" size={26} />
                <strong>No files directly in this folder</strong>
                <p>Open a subfolder to see its originals.</p>
              </div>
            )}
            <footer className="dv-details-bar">
              <span>
                <Icon name="mdiFileDocumentOutline" size={15} />
                {countLabel(folder.count, "file")}
                {folder.directCount !== folder.count && ` · ${folder.directCount} here`}
              </span>
              <span>
                <Icon name="mdiHarddisk" size={15} />
                {formatBytes(folder.size)}
              </span>
              {folder.children.length > 0 && (
                <span>
                  <Icon name="mdiFolderMultipleOutline" size={15} />
                  {countLabel(folder.children.length, "folder")}
                </span>
              )}
              <span className="dv-details-path" title={folder.path}>
                {folder.path}
              </span>
            </footer>
          </section>
        </div>
      )}
      <p className="dv-note">Preview · sample data</p>
    </main>
  );
}
