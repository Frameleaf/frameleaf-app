import React, { useEffect, useMemo, useRef, useState } from "react";
import { Icon, allIconNames } from "./Icon";
import { collectionIconGroups, collectionIcons } from "./collections-data.mjs";
import "./icon-chooser.css";

const PAGE = 240;
const curated = new Map(collectionIcons.map((icon) => [icon.name, icon.label]));
const derivedLabel = (name) =>
  (name || "")
    .replace(/^mdi/, "")
    .replace(/([A-Z])/g, " $1")
    .replace(/([0-9]+)/g, " $1")
    .trim()
    .toLowerCase();
/** Human label for any Material icon name: the curated label when we have one. */
export const iconLabel = (name) => curated.get(name) || derivedLabel(name);

/** The whole Material Design Icons catalogue, searchable by curated or derived words. */
const catalogue = allIconNames.map((name) => {
  const derived = derivedLabel(name);
  const label = curated.get(name);
  return { name, label: label || derived, text: label ? `${label.toLowerCase()} ${derived}` : derived };
});

/** Options per row for the grid that holds `active`, measured so arrow keys move by row. */
function columnsOf(active) {
  const siblings = [...(active?.parentElement?.querySelectorAll('[role="option"]') || [])];
  if (siblings.length < 2) return 1;
  const top = siblings[0].offsetTop;
  const inRow = siblings.filter((element) => element.offsetTop === top).length;
  return inRow === siblings.length && siblings.length > 8 ? 8 : Math.max(1, inRow);
}

/**
 * Searchable icon picker over the whole Material catalogue. By default it is a
 * popover under its anchor; `inline` renders it as a static panel inside a form.
 * props: value (icon name), onChange(name), onClose(), label, inline
 */
export function IconChooser({ value, onChange, onClose, label = "Choose an icon", inline = false }) {
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const root = useRef(null);
  const search = useRef(null);
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const results = useMemo(
    () =>
      terms.length
        ? catalogue.filter((icon) => terms.every((term) => icon.text.includes(term)))
        : catalogue,
    [query],
  );
  useEffect(() => {
    setLimit(PAGE);
  }, [query]);
  useEffect(() => {
    if (!inline) search.current?.focus();
  }, [inline]);
  useEffect(() => {
    if (inline) return undefined;
    const outside = (event) => {
      if (!root.current?.contains(event.target)) onClose?.();
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [onClose, inline]);
  const choose = (name) => {
    onChange?.(name);
    if (!inline) onClose?.();
  };
  const keys = (event) => {
    if (event.key === "Enter" && event.target === search.current) {
      // Never submit an enclosing form from the icon search.
      event.preventDefault();
      return;
    }
    if (event.key === "Escape") {
      if (inline) return;
      event.preventDefault();
      event.stopPropagation();
      onClose?.();
      return;
    }
    const options = [...(root.current?.querySelectorAll('[role="option"]') || [])];
    const index = options.indexOf(document.activeElement);
    const columns = index >= 0 ? columnsOf(options[index]) : 1;
    const step = {
      ArrowRight: 1,
      ArrowLeft: -1,
      ArrowDown: columns,
      ArrowUp: -columns,
    }[event.key];
    if (step === undefined) return;
    if (index < 0) {
      if (event.key === "ArrowDown" && options[0]) {
        event.preventDefault();
        options[0].focus();
      }
      return;
    }
    event.preventDefault();
    const next = index + step;
    if (next < 0) search.current?.focus();
    else options[Math.min(options.length - 1, next)]?.focus();
  };
  const option = ({ name, label: text }) => (
    <button
      key={name}
      type="button"
      role="option"
      aria-selected={value === name}
      aria-label={text}
      title={text}
      className={value === name ? "chosen" : ""}
      onClick={() => choose(name)}
    >
      <Icon name={name} size={20} />
    </button>
  );
  const shown = results.slice(0, limit);
  const remaining = results.length - shown.length;
  return (
    <div
      className={`icon-chooser${inline ? " inline" : ""}`}
      role={inline ? "group" : "dialog"}
      aria-label={label}
      ref={root}
      onKeyDown={keys}
    >
      <label className="icon-chooser-search">
        <Icon name="mdiMagnify" size={16} />
        <input
          ref={search}
          type="search"
          placeholder={`Search ${catalogue.length.toLocaleString()} icons`}
          aria-label="Search icons"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <div className="icon-chooser-scroll">
        {!terms.length &&
          collectionIconGroups.map((group) => (
            <section key={group.label} className="icon-chooser-section">
              <h3>{group.label}</h3>
              <div className="icon-chooser-grid" role="listbox" aria-label={group.label}>
                {group.icons.map(option)}
              </div>
            </section>
          ))}
        <section className="icon-chooser-section">
          <h3>
            {terms.length
              ? `${results.length.toLocaleString()} matching ${results.length === 1 ? "icon" : "icons"}`
              : `All icons · ${catalogue.length.toLocaleString()}`}
          </h3>
          {results.length ? (
            <>
              <div className="icon-chooser-grid" role="listbox" aria-label="All icons">
                {shown.map(option)}
              </div>
              {remaining > 0 && (
                <button
                  type="button"
                  className="icon-chooser-more"
                  onClick={() => setLimit((current) => current + PAGE * 2)}
                >
                  Show {Math.min(PAGE * 2, remaining).toLocaleString()} more of{" "}
                  {results.length.toLocaleString()}
                </button>
              )}
            </>
          ) : (
            <p className="icon-chooser-empty">No icons match. Try a shorter word.</p>
          )}
        </section>
      </div>
    </div>
  );
}
