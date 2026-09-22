import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { Icon } from "./Icon";
import {
  commandGroups,
  groupCommands,
  loadRecentCommands,
  navigationCommands,
  recentCommands,
  rememberCommand,
  saveRecentCommands,
  searchCommands,
  shortcutKeys,
  stripCommandPrefix,
} from "./command-palette.mjs";
import "./command-palette.css";

export const commandPaletteShortcut = "mod+shift+p";
const isApple = () =>
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || "");

function Keys({ shortcut, apple }) {
  const keys = shortcutKeys(shortcut, apple);
  if (!keys.length) return null;
  return (
    <span className="cp-keys" aria-hidden="true">
      {keys.map((key, index) => (
        <kbd key={`${key}-${index}`}>{key}</kbd>
      ))}
    </span>
  );
}

/**
 * Top-anchored command palette. Props:
 * index: commands from buildCommandIndex()
 * onRun(command): run the chosen command (payload describes it)
 * onClose(): dismiss
 * initialQuery: text typed before the palette opened (">" prefix is stripped)
 */
export function CommandPalette({
  index = [],
  onRun,
  onClose,
  initialQuery = "",
}) {
  const dialog = useRef(null);
  const input = useRef(null);
  const listRef = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [query, setQuery] = useState(() => stripCommandPrefix(initialQuery));
  const [active, setActive] = useState(0);
  const [recent, setRecent] = useState(() =>
    loadRecentCommands(typeof localStorage === "undefined" ? null : localStorage),
  );
  const apple = useMemo(isApple, []);
  const listId = useId();
  const commands = Array.isArray(index) ? index : [];
  const searching = query.trim().length > 0;
  const results = useMemo(() => {
    if (searching) return searchCommands(commands, query, 30);
    const recents = recentCommands(commands, recent);
    if (recents.length) return recents;
    return navigationCommands(commands).slice(0, 10);
  }, [commands, query, recent, searching]);
  const groups = useMemo(
    () =>
      searching
        ? groupCommands(results)
        : [
            {
              id: recent.length ? "recent" : "suggested",
              title: recentCommands(commands, recent).length
                ? "Recent"
                : "Suggested",
              commands: results,
            },
          ],
    [results, searching, recent, commands],
  );
  const flat = groups.flatMap((group) => group.commands);
  const current = flat[Math.min(active, Math.max(0, flat.length - 1))];

  useEffect(() => {
    const element = dialog.current;
    const previous = document.activeElement;
    element?.showModal?.();
    input.current?.focus();
    return () => {
      if (element?.open) element.close();
      if (previous?.isConnected) previous.focus?.({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    setActive(0);
  }, [query]);
  useEffect(() => {
    const option = listRef.current?.querySelector('[aria-selected="true"]');
    option?.scrollIntoView?.({ block: "nearest" });
  }, [active, results]);

  function run(command) {
    if (!command) return;
    const next = rememberCommand(recent, command.id);
    setRecent(next);
    saveRecentCommands(
      typeof localStorage === "undefined" ? null : localStorage,
      next,
    );
    onRun?.(command);
    closeRef.current?.();
  }
  function onKeyDown(event) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (flat.length) setActive((value) => (value + 1) % flat.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (flat.length)
        setActive((value) => (value - 1 + flat.length) % flat.length);
    } else if (event.key === "Home" && flat.length) {
      event.preventDefault();
      setActive(0);
    } else if (event.key === "End" && flat.length) {
      event.preventDefault();
      setActive(flat.length - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      run(current);
    }
  }
  let position = -1;
  return (
    <dialog
      ref={dialog}
      className="command-palette"
      aria-label="Command palette"
      onCancel={(event) => {
        event.preventDefault();
        closeRef.current?.();
      }}
      onClose={() => {
        if (!dialog.current?.open) closeRef.current?.();
      }}
    >
      <div className="cp-input-row">
        <Icon name="mdiChevronRight" size={20} />
        <input
          ref={input}
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={current ? `${listId}-${current.id}` : undefined}
          aria-label="Type a command or search for a page"
          placeholder="Type a command or search for a page…"
          value={query}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) =>
            setQuery(event.target.value.replace(/^\s*>\s*/, ""))
          }
          onKeyDown={onKeyDown}
        />
        <kbd aria-hidden="true">Esc</kbd>
      </div>
      <div
        className="cp-list"
        role="listbox"
        id={listId}
        ref={listRef}
        aria-label="Commands"
      >
        {flat.length === 0 && (
          <div className="cp-empty">
            <strong>No matching commands</strong>
            Try a page name, a setting, a person or a place.
          </div>
        )}
        {groups.map((group) => (
          <div key={group.id} role="group" aria-label={group.title}>
            <p className="cp-group-title">{group.title}</p>
            {group.commands.map((command) => {
              position += 1;
              const selected = position === Math.min(active, flat.length - 1);
              return (
                <button
                  type="button"
                  key={command.id}
                  id={`${listId}-${command.id}`}
                  role="option"
                  aria-selected={selected}
                  className="cp-item"
                  tabIndex={-1}
                  onMouseMove={() => {
                    const index = flat.indexOf(command);
                    if (index >= 0 && index !== active) setActive(index);
                  }}
                  onClick={() => run(command)}
                >
                  <Icon name={command.icon} size={18} />
                  <span>
                    <strong>{command.title}</strong>
                    {command.subtitle && <small>{command.subtitle}</small>}
                  </span>
                  <Keys shortcut={command.shortcut} apple={apple} />
                </button>
              );
            })}
          </div>
        ))}
      </div>
      <div className="cp-foot">
        <span>
          <kbd>↑</kbd>
          <kbd>↓</kbd> Navigate
        </span>
        <span>
          <kbd>↩</kbd> Run
        </span>
        <span>
          <kbd>Esc</kbd> Close
        </span>
        <span className="cp-count" aria-live="polite">
          {searching
            ? `${flat.length} ${flat.length === 1 ? "match" : "matches"}`
            : `${commandGroups.length} groups`}
        </span>
      </div>
    </dialog>
  );
}
