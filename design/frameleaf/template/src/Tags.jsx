import React, { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./Icon";
import { Button, Dialog } from "./App";
import { Menu } from "./Memories";
import {
  applyTagChange,
  readTagOverrides,
  tagColors,
  tagTree,
  writeTagOverrides,
} from "./discovery-data.mjs";
import "./discovery.css";

const countLabel = (count, word = "item") =>
  `${count} ${count === 1 ? word : `${word}s`}`;

function flatten(nodes, expanded, depth = 0, out = []) {
  for (const node of nodes) {
    out.push(node);
    if (node.children.length && expanded.has(node.id)) flatten(node.children, expanded, depth + 1, out);
  }
  return out;
}

function TagRow({ node, expanded, selected, focused, onToggle, onSelect, onFocus, query }) {
  const open = expanded.has(node.id);
  const match = query && node.name.toLowerCase().includes(query);
  return (
    <li
      role="treeitem"
      aria-expanded={node.children.length ? open : undefined}
      aria-selected={selected === node.id}
      aria-level={node.depth + 1}
      data-tag={node.id}
      tabIndex={focused === node.id ? 0 : -1}
      className={`dv-tree-item${selected === node.id ? " selected" : ""}${match ? " match" : ""}`}
      style={{ "--depth": node.depth }}
      onClick={(event) => {
        event.stopPropagation();
        onSelect(node.id);
      }}
      onFocus={(event) => {
        event.stopPropagation();
        onFocus(node.id);
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
              onToggle(node.id);
            }}
          >
            <Icon name={open ? "mdiChevronDown" : "mdiChevronRight"} size={16} />
          </button>
        ) : (
          <span className="dv-tree-toggle" aria-hidden="true" />
        )}
        <span className={`dv-tag-dot color-${node.color}`} aria-hidden="true" />
        <span className="dv-tree-name">{node.name}</span>
        <small>{node.total}</small>
      </span>
      {node.children.length > 0 && open && (
        <ul role="group">
          {node.children.map((child) => (
            <TagRow
              key={child.id}
              node={child}
              expanded={expanded}
              selected={selected}
              focused={focused}
              onToggle={onToggle}
              onSelect={onSelect}
              onFocus={onFocus}
              query={query}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function TagDialog({ dialog, tree, onClose, onCommit }) {
  const [name, setName] = useState(dialog.type === "rename" ? dialog.node.name : "");
  const [parent, setParent] = useState(dialog.parent || "");
  const [color, setColor] = useState(dialog.type === "create" ? "grey" : dialog.node?.color);
  const [error, setError] = useState("");
  const all = Object.values(tree.byId).sort((a, b) => a.path.join("/").localeCompare(b.path.join("/")));
  const submit = (event) => {
    event.preventDefault();
    try {
      if (dialog.type === "create") onCommit({ type: "create", name, parent: parent || null, color });
      else if (dialog.type === "rename") onCommit({ type: "rename", id: dialog.node.id, name });
      else if (dialog.type === "delete") onCommit({ type: "delete", id: dialog.node.id });
      onClose();
    } catch (failure) {
      setError(failure.message);
    }
  };
  const titles = { create: dialog.parent ? "New subtag" : "New tag", rename: "Rename tag", delete: "Delete tag" };
  return (
    <Dialog
      title={titles[dialog.type]}
      close={onClose}
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            primary={dialog.type !== "delete"}
            className={dialog.type === "delete" ? "dv-danger" : ""}
            type="submit"
            form="dv-tag-form"
          >
            {dialog.type === "create" ? "Create" : dialog.type === "rename" ? "Save" : "Delete"}
          </Button>
        </>
      }
    >
      <form id="dv-tag-form" onSubmit={submit} className="dv-form">
        {dialog.type === "delete" ? (
          <p>
            Delete <strong>{dialog.node.path.join(" / ")}</strong>
            {dialog.node.children.length ? ` and its ${countLabel(dialog.node.children.length, "subtag")}` : ""}?{" "}
            {dialog.node.total
              ? `${countLabel(dialog.node.total)} will lose this tag but stay in your library.`
              : "No items use this tag."}
          </p>
        ) : (
          <label>
            Name
            <input
              data-initial-focus
              autoFocus
              value={name}
              maxLength={60}
              onChange={(event) => setName(event.target.value)}
              aria-invalid={!!error || undefined}
            />
          </label>
        )}
        {dialog.type === "create" && (
          <>
            <label>
              Parent tag
              <select value={parent} onChange={(event) => setParent(event.target.value)}>
                <option value="">None (top level)</option>
                {all.map((node) => (
                  <option key={node.id} value={node.id}>
                    {node.path.join(" / ")}
                  </option>
                ))}
              </select>
            </label>
            <fieldset className="dv-swatches">
              <legend>Colour</legend>
              {tagColors.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={color === option.id}
                  aria-label={option.label}
                  title={option.label}
                  className={`dv-swatch color-${option.id}${color === option.id ? " on" : ""}`}
                  onClick={() => setColor(option.id)}
                />
              ))}
            </fieldset>
          </>
        )}
        {error && (
          <p className="dv-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}

export function Tags({ tags = [], assets = [], overrides, onChange, onQuery }) {
  const [local, setLocal] = useState(() => overrides || readTagOverrides());
  const current = overrides ?? local;
  const tree = useMemo(() => tagTree(tags, assets, current), [tags, assets, current]);
  const [selected, setSelected] = useState(null);
  const [focused, setFocused] = useState(null);
  const [expanded, setExpanded] = useState(() => new Set(["trips", "family", "trips/rockies-2026"]));
  const [search, setSearch] = useState("");
  const [dialog, setDialog] = useState(null);
  const [status, setStatus] = useState("");
  const treeRef = useRef(null);
  const query = search.trim().toLowerCase();
  const node = selected ? tree.byId[selected] : null;
  const visible = useMemo(() => flatten(tree.roots, expanded), [tree, expanded]);
  const focusId = focused && tree.byId[focused] ? focused : visible[0]?.id || null;

  useEffect(() => {
    if (selected && !tree.byId[selected]) setSelected(null);
  }, [tree, selected]);
  // Searching expands every ancestor of a match so it can be seen.
  useEffect(() => {
    if (!query) return;
    setExpanded((value) => {
      const next = new Set(value);
      for (const item of Object.values(tree.byId))
        if (item.name.toLowerCase().includes(query))
          for (const crumb of item.breadcrumbs.slice(0, -1)) next.add(crumb.id);
      return next;
    });
  }, [query, tree]);

  const commit = (change) => {
    const result = applyTagChange(current, change, tree);
    writeTagOverrides(result.overrides);
    setLocal(result.overrides);
    onChange?.(result.overrides, change);
    if (change.type === "create") {
      if (change.parent) setExpanded((value) => new Set([...value, change.parent]));
      setSelected(result.id);
      setFocused(result.id);
      setStatus(`Tag ${change.name} created.`);
    } else if (change.type === "delete") {
      setSelected(null);
      setStatus("Tag deleted.");
    } else if (change.type === "rename") setStatus(`Renamed to ${change.name}.`);
    else if (change.type === "color") setStatus(`Colour changed to ${change.color}.`);
    else if (change.type === "move") setStatus("Tag moved.");
    return result.id;
  };
  const toggle = (id) =>
    setExpanded((value) => {
      const next = new Set(value);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const focusItem = (id) => {
    setFocused(id);
    [...(treeRef.current?.querySelectorAll("[data-tag]") || [])]
      .find((element) => element.dataset.tag === id)
      ?.focus();
  };
  const keyboard = (event) => {
    const item = tree.byId[focusId];
    if (!item) return;
    const index = visible.findIndex((entry) => entry.id === focusId);
    const actions = {
      ArrowDown: () => visible[index + 1] && focusItem(visible[index + 1].id),
      ArrowUp: () => visible[index - 1] && focusItem(visible[index - 1].id),
      Home: () => visible[0] && focusItem(visible[0].id),
      End: () => visible.at(-1) && focusItem(visible.at(-1).id),
      ArrowRight: () => {
        if (!item.children.length) return;
        if (!expanded.has(item.id)) toggle(item.id);
        else focusItem(item.children[0].id);
      },
      ArrowLeft: () => {
        if (item.children.length && expanded.has(item.id)) toggle(item.id);
        else if (item.parent) focusItem(item.parent);
      },
      Enter: () => setSelected(item.id),
      " ": () => setSelected(item.id),
    };
    if (actions[event.key]) {
      event.preventDefault();
      actions[event.key]();
    }
  };
  const covers = node
    ? node.allAssetIds
        .map((id) => assets.find((asset) => asset.id === id))
        .filter((asset) => asset?.image)
        .slice(0, 6)
    : [];
  const topTags = useMemo(
    () => Object.values(tree.byId).filter((item) => item.count > 0).sort((a, b) => b.total - a.total).slice(0, 12),
    [tree],
  );
  const allExpanded = Object.values(tree.byId).filter((item) => item.children.length).every((item) => expanded.has(item.id));

  return (
    <main className="discovery dv-tags" aria-label="Tags">
      <header className="dv-header">
        <div>
          <h1>Tags</h1>
          <p>{countLabel(tree.total, "tag")} · organise with nested tags such as trips / rockies-2026</p>
        </div>
        <div className="dv-header-actions">
          <label className="dv-search">
            <Icon name="mdiMagnify" size={16} />
            <input
              type="search"
              placeholder="Find a tag"
              aria-label="Find a tag"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <Button
            icon={allExpanded ? "mdiArrowCollapseAll" : "mdiArrowExpandAll"}
            onClick={() =>
              setExpanded(
                allExpanded
                  ? new Set()
                  : new Set(Object.values(tree.byId).filter((item) => item.children.length).map((item) => item.id)),
              )
            }
          >
            {allExpanded ? "Collapse all" : "Expand all"}
          </Button>
          <Button primary icon="mdiTagPlusOutline" onClick={() => setDialog({ type: "create", parent: null })}>
            New tag
          </Button>
        </div>
      </header>
      <output className="dv-sr-only" aria-live="polite">
        {status}
      </output>
      <div className="dv-split">
        <nav className="dv-pane dv-tree-pane" aria-label="Tag tree">
          {tree.roots.length ? (
            <ul role="tree" aria-label="Tags" ref={treeRef} className="dv-tree" onKeyDown={keyboard}>
              {tree.roots.map((root) => (
                <TagRow
                  key={root.id}
                  node={root}
                  expanded={expanded}
                  selected={selected}
                  focused={focusId}
                  onToggle={toggle}
                  onSelect={(id) => {
                    setSelected(id);
                    setFocused(id);
                  }}
                  onFocus={setFocused}
                  query={query}
                />
              ))}
            </ul>
          ) : (
            <div className="dv-empty" role="status">
              <Icon name="mdiTagOutline" size={30} />
              <strong>No tags yet</strong>
              <p>Create a tag to start grouping photos and videos.</p>
            </div>
          )}
        </nav>
        <section className="dv-pane dv-detail" aria-live="polite" aria-label={node ? `Tag ${node.name}` : "Tag overview"}>
          {node ? (
            <>
              <nav className="dv-breadcrumb" aria-label="Tag path">
                <button type="button" onClick={() => setSelected(null)}>
                  Tags
                </button>
                {node.breadcrumbs.map((crumb, index) => (
                  <React.Fragment key={crumb.id}>
                    <Icon name="mdiChevronRight" size={14} />
                    {index === node.breadcrumbs.length - 1 ? (
                      <span aria-current="page">{crumb.name}</span>
                    ) : (
                      <button type="button" onClick={() => setSelected(crumb.id)}>
                        {crumb.name}
                      </button>
                    )}
                  </React.Fragment>
                ))}
              </nav>
              <div className="dv-detail-title">
                <span className={`dv-tag-dot large color-${node.color}`} aria-hidden="true" />
                <div>
                  <h2>{node.name}</h2>
                  <p>
                    {countLabel(node.count)}
                    {node.total !== node.count && ` · ${node.total} including subtags`}
                    {node.derived && " · suggested from existing tags"}
                  </p>
                </div>
                <div className="dv-detail-actions">
                  <Button icon="mdiPencilOutline" onClick={() => setDialog({ type: "rename", node })}>
                    Rename
                  </Button>
                  <Menu
                    label="Change colour"
                    icon="mdiPaletteOutline"
                    className="dv-color-menu"
                    items={tagColors.map((option) => ({
                      id: option.id,
                      label: option.label,
                      checked: node.color === option.id,
                      onSelect: () => commit({ type: "color", id: node.id, color: option.id }),
                    }))}
                  >
                    <span className={`dv-tag-dot color-${node.color}`} aria-hidden="true" />
                    <span className="dv-menu-trigger-label">Colour</span>
                    <Icon name="mdiChevronDown" size={16} />
                  </Menu>
                  <Menu
                    label="More tag actions"
                    items={[
                      {
                        id: "sub",
                        label: "New subtag",
                        icon: "mdiTagPlusOutline",
                        onSelect: () => setDialog({ type: "create", parent: node.id }),
                      },
                      {
                        id: "top",
                        label: "Move to top level",
                        icon: "mdiArrowUp",
                        disabled: !node.parent,
                        onSelect: () => commit({ type: "move", id: node.id, parent: null }),
                      },
                      { id: "sep", separator: true },
                      {
                        id: "delete",
                        label: "Delete tag",
                        icon: "mdiDeleteOutline",
                        danger: true,
                        onSelect: () => setDialog({ type: "delete", node }),
                      },
                    ]}
                  />
                </div>
              </div>
              {covers.length ? (
                <div className="dv-strip" aria-label={`Preview of ${node.name}`}>
                  {covers.map((asset) => (
                    <img key={asset.id} src={asset.image} alt="" loading="lazy" />
                  ))}
                </div>
              ) : (
                <div className="dv-strip-empty">
                  <Icon name="mdiImageOutline" size={22} />
                  <span>No items carry this tag yet. Add it from the viewer or a selection.</span>
                </div>
              )}
              <div className="dv-detail-cta">
                <Button
                  primary
                  icon="mdiImageMultipleOutline"
                  disabled={!node.total}
                  onClick={() => onQuery?.(node.query, node.path.join(" / "))}
                >
                  Show all {countLabel(node.total)}
                </Button>
              </div>
              {node.children.length > 0 && (
                <div className="dv-subtags">
                  <h3>Subtags</h3>
                  <div className="dv-chip-row">
                    {node.children.map((child) => (
                      <button type="button" key={child.id} className="dv-chip" onClick={() => setSelected(child.id)}>
                        <span className={`dv-tag-dot color-${child.color}`} aria-hidden="true" />
                        {child.name}
                        <small>{child.total}</small>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="dv-overview">
              <h2>Choose a tag</h2>
              <p>Select a tag on the left to see a preview, rename it, change its colour or nest it under another tag.</p>
              {topTags.length > 0 && (
                <>
                  <h3>Most used</h3>
                  <div className="dv-chip-row">
                    {topTags.map((item) => (
                      <button type="button" key={item.id} className="dv-chip" onClick={() => setSelected(item.id)}>
                        <span className={`dv-tag-dot color-${item.color}`} aria-hidden="true" />
                        {item.path.join(" / ")}
                        <small>{item.total}</small>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </section>
      </div>
      {dialog && <TagDialog dialog={dialog} tree={tree} onClose={() => setDialog(null)} onCommit={commit} />}
      <p className="dv-note">Preview · sample data</p>
    </main>
  );
}
