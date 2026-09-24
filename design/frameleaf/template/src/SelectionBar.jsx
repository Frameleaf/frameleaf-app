import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { Icon } from "./Icon";
import { Button, Dialog } from "./App";
import { bulkActionGroups, bulkActions } from "./selection.mjs";
import { isTypingTarget } from "./shortcuts.mjs";
import "./selection-bar.css";

const PRIMARY = [
  "favorite",
  "add-to-album",
  "create-shared-link",
  "download",
  "delete",
];
const TRASH_PRIMARY = ["restore", "download", "delete-permanently"];
const MENU_GROUPS = ["organize", "visibility", "album", "jobs"];
const TIMEZONES = [
  ["keep", "Keep each item's time zone"],
  ["UTC", "UTC"],
  ["America/Vancouver", "Vancouver (Pacific)"],
  ["America/Edmonton", "Edmonton (Mountain)"],
  ["America/Toronto", "Toronto (Eastern)"],
  ["Europe/London", "London"],
  ["Europe/Berlin", "Berlin"],
  ["Asia/Tokyo", "Tokyo"],
  ["Australia/Sydney", "Sydney"],
];
const plural = (count, noun = "item") =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;
const slug = (text) =>
  String(text)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/**
 * Floating bulk-action bar. Props: count, total, context {albumId?, trash?,
 * sharedLink?}, assets (selected assets), tagOptions, onAction(actionId, payload),
 * onClear(), onSelectAll(), leading ([{id, label, icon, onClick, disabled, primary}],
 * shown before the bulk actions).
 */
export function SelectionBar({
  count = 0,
  total = 0,
  context = {},
  assets = [],
  tagOptions = [],
  onAction,
  onClear,
  onSelectAll,
  leading = [],
}) {
  const open = count > 0;
  const trash = Boolean(context.trash);
  const actions = useMemo(
    () => bulkActions({ ...context, assets, count }),
    [context, assets, count],
  );
  const byId = useMemo(
    () => Object.fromEntries(actions.map((action) => [action.id, action])),
    [actions],
  );
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialog, setDialog] = useState(null);
  const menuRef = useRef(null);
  const moreRef = useRef(null);
  const menuId = useId();
  const latest = useRef({});
  latest.current = { onClear, onSelectAll, onAction, byId, menuOpen, trash };

  const perform = (id, payload) => {
    const action = latest.current.byId[id];
    if (!action?.available) return;
    setMenuOpen(false);
    if (action.confirm || action.dialog) {
      setDialog(id);
      return;
    }
    latest.current.onAction?.(id, payload);
  };
  const submit = (id, payload) => {
    setDialog(null);
    latest.current.onAction?.(id, payload);
  };

  useEffect(() => {
    if (!open) {
      setMenuOpen(false);
      setDialog(null);
    }
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const handler = (event) => {
      if (event.defaultPrevented || isTypingTarget(event.target)) return;
      if (document.querySelector("dialog[open]")) return;
      const mod = event.metaKey || event.ctrlKey;
      const key = String(event.key).toLowerCase();
      if (event.key === "Escape") {
        event.preventDefault();
        if (latest.current.menuOpen) {
          setMenuOpen(false);
          moreRef.current?.focus();
        } else latest.current.onClear?.();
      } else if (mod && !event.shiftKey && !event.altKey && key === "a") {
        event.preventDefault();
        latest.current.onSelectAll?.();
      } else if (mod && !event.shiftKey && !event.altKey && key === "d") {
        event.preventDefault();
        latest.current.onClear?.();
      } else if (
        !mod &&
        !event.altKey &&
        (event.key === "Delete" || event.key === "Backspace")
      ) {
        event.preventDefault();
        perform(latest.current.trash ? "delete-permanently" : "delete");
      }
    };
    addEventListener("keydown", handler);
    return () => removeEventListener("keydown", handler);
  }, [open]);
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (event) => {
      if (
        !menuRef.current?.contains(event.target) &&
        !moreRef.current?.contains(event.target)
      )
        setMenuOpen(false);
    };
    document.addEventListener("pointerdown", handler);
    menuRef.current?.querySelector('[role="menuitem"]')?.focus();
    return () => document.removeEventListener("pointerdown", handler);
  }, [menuOpen]);

  const menuKey = (event) => {
    const items = [
      ...(menuRef.current?.querySelectorAll('[role="menuitem"]') || []),
    ];
    const index = items.indexOf(document.activeElement);
    const focusAt = (i) =>
      items[((i % items.length) + items.length) % items.length]?.focus();
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusAt(index + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusAt(index - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusAt(0);
    } else if (event.key === "End") {
      event.preventDefault();
      focusAt(items.length - 1);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setMenuOpen(false);
      moreRef.current?.focus();
    } else if (event.key === "Tab") setMenuOpen(false);
  };

  const primary = (trash ? TRASH_PRIMARY : PRIMARY)
    .map((id) =>
      id === "favorite" &&
      !byId.favorite?.available &&
      byId.unfavorite?.available
        ? byId.unfavorite
        : byId[id],
    )
    .filter((action) => action?.available);
  const menuGroups = bulkActionGroups
    .filter((group) => MENU_GROUPS.includes(group.id))
    .map((group) => ({
      ...group,
      items: actions.filter(
        (action) =>
          action.group === group.id &&
          action.available &&
          !(action.id === "unfavorite" && primary.includes(action)),
      ),
    }))
    .filter((group) => group.items.length);

  return (
    <div
      className={`selection-bar${open ? " is-open" : ""}`}
      role="region"
      aria-label="Selected items"
      aria-hidden={!open}
      inert={!open || undefined}
    >
      <div className="sb-pill">
        <div className="sb-count">
          <span aria-live="polite">{count} selected</span>
          {total > count && onSelectAll && (
            <button type="button" className="sb-text" onClick={onSelectAll}>
              Select all {total}
            </button>
          )}
          <button
            type="button"
            className="sb-clear"
            onClick={onClear}
            aria-label="Deselect all"
            title="Deselect (Esc)"
          >
            <Icon name="mdiClose" size={16} />
            <span>Deselect</span>
          </button>
        </div>
        <div
          className="sb-actions"
          role="group"
          aria-label="Actions for selected items"
        >
          {leading.map((action) => (
            <button
              key={action.id}
              type="button"
              className={`sb-action${action.primary ? " is-primary" : ""}`}
              aria-label={action.label}
              title={action.label}
              disabled={action.disabled}
              onClick={action.onClick}
            >
              <Icon name={action.icon} size={18} />
              <span>{action.label}</span>
            </button>
          ))}
          {leading.length > 0 && (
            <span className="sb-divider" aria-hidden="true" />
          )}
          {primary.map((action) => (
            <button
              key={action.id}
              type="button"
              className={`sb-action${action.danger ? " is-danger" : ""}`}
              aria-label={action.label}
              title={action.label}
              onClick={() => perform(action.id)}
            >
              <Icon name={action.icon} size={18} />
              <span>{action.label}</span>
            </button>
          ))}
          {menuGroups.length > 0 && (
            <div className="sb-more">
              <button
                ref={moreRef}
                type="button"
                className="sb-action"
                aria-label="More actions"
                title="More"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                aria-controls={menuOpen ? menuId : undefined}
                onClick={() => setMenuOpen((value) => !value)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault();
                    setMenuOpen(true);
                  }
                }}
              >
                <Icon name="mdiDotsHorizontal" size={18} />
                <span>More</span>
              </button>
              {menuOpen && (
                <div
                  ref={menuRef}
                  id={menuId}
                  className="sb-menu"
                  role="menu"
                  aria-label="More actions"
                  onKeyDown={menuKey}
                >
                  {menuGroups.map((group) => (
                    <div
                      key={group.id}
                      role="group"
                      aria-labelledby={`${menuId}-${group.id}`}
                    >
                      <div
                        className="sb-menu-title"
                        id={`${menuId}-${group.id}`}
                      >
                        {group.title}
                      </div>
                      {group.items.map((action) => (
                        <button
                          key={action.id}
                          type="button"
                          role="menuitem"
                          tabIndex={-1}
                          className={action.danger ? "is-danger" : ""}
                          onClick={() => perform(action.id)}
                        >
                          <Icon name={action.icon} size={16} />
                          {action.label}
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      {dialog === "change-date" && (
        <ChangeDateDialog
          assets={assets}
          count={count}
          close={() => setDialog(null)}
          submit={(payload) => submit("change-date", payload)}
        />
      )}
      {dialog === "change-description" && (
        <ChangeDescriptionDialog
          assets={assets}
          count={count}
          close={() => setDialog(null)}
          submit={(payload) => submit("change-description", payload)}
        />
      )}
      {dialog === "change-location" && (
        <ChangeLocationDialog
          assets={assets}
          count={count}
          close={() => setDialog(null)}
          submit={(payload) => submit("change-location", payload)}
        />
      )}
      {dialog === "tag" && (
        <TagDialog
          count={count}
          options={tagOptions}
          close={() => setDialog(null)}
          submit={(payload) => submit("tag", payload)}
        />
      )}
      {dialog === "delete-permanently" && (
        <DeletePermanentlyDialog
          count={count}
          close={() => setDialog(null)}
          submit={() => submit("delete-permanently")}
        />
      )}
    </div>
  );
}

function ChangeDateDialog({ assets, count, close, submit }) {
  const first = assets[0];
  const initial = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(
    first?.takenAt || "",
  );
  const [mode, setMode] = useState("set");
  const [date, setDate] = useState(initial?.[1] || first?.date || "");
  const [time, setTime] = useState(initial?.[2] || "12:00");
  const [timezone, setTimezone] = useState("keep");
  const [amount, setAmount] = useState("1");
  const [unit, setUnit] = useState("hours");
  const [direction, setDirection] = useState("later");
  const formId = useId();
  const valid =
    mode === "set"
      ? /^\d{4}-\d{2}-\d{2}$/.test(date) && /^\d{2}:\d{2}$/.test(time)
      : Number(amount) > 0;
  const minutes =
    { minutes: 1, hours: 60, days: 1440 }[unit] *
    Number(amount) *
    (direction === "earlier" ? -1 : 1);
  const preview =
    mode === "set"
      ? valid
        ? `${plural(count)} will be set to ${date} at ${time}.`
        : "Choose a date and time."
      : valid
        ? `${plural(count)} will move ${amount} ${unit} ${direction}, keeping their spacing.`
        : "Enter how far to shift.";
  return (
    <Dialog
      title="Change date"
      close={close}
      actions={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button primary type="submit" form={formId} disabled={!valid}>
            Apply to {plural(count)}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="sb-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid) return;
          submit(
            mode === "set"
              ? {
                  mode,
                  date,
                  time,
                  timezone: timezone === "keep" ? null : timezone,
                }
              : { mode, minutes, amount: Number(amount), unit, direction },
          );
        }}
      >
        <fieldset className="sb-segmented">
          <legend className="sb-sr">How to change the date</legend>
          <label className="sb-choice">
            <input
              type="radio"
              name="date-mode"
              value="set"
              checked={mode === "set"}
              onChange={() => setMode("set")}
              data-initial-focus
            />
            Set the same date
          </label>
          <label className="sb-choice">
            <input
              type="radio"
              name="date-mode"
              value="shift"
              checked={mode === "shift"}
              onChange={() => setMode("shift")}
            />
            Shift all by
          </label>
        </fieldset>
        {mode === "set" ? (
          <div className="sb-grid">
            <label>
              Date
              <input
                type="date"
                value={date}
                required
                onChange={(event) => setDate(event.target.value)}
              />
            </label>
            <label>
              Time
              <input
                type="time"
                value={time}
                required
                onChange={(event) => setTime(event.target.value)}
              />
            </label>
            <label>
              Time zone
              <select
                value={timezone}
                onChange={(event) => setTimezone(event.target.value)}
              >
                {TIMEZONES.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        ) : (
          <div className="sb-grid">
            <label>
              Amount
              <input
                type="number"
                min="1"
                step="1"
                inputMode="numeric"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
              />
            </label>
            <label>
              Unit
              <select
                value={unit}
                onChange={(event) => setUnit(event.target.value)}
              >
                <option value="minutes">Minutes</option>
                <option value="hours">Hours</option>
                <option value="days">Days</option>
              </select>
            </label>
            <label>
              Direction
              <select
                value={direction}
                onChange={(event) => setDirection(event.target.value)}
              >
                <option value="later">Later</option>
                <option value="earlier">Earlier</option>
              </select>
            </label>
          </div>
        )}
        <p className="sb-preview" aria-live="polite">
          {preview}
        </p>
      </form>
    </Dialog>
  );
}

function ChangeDescriptionDialog({ assets, count, close, submit }) {
  const [description, setDescription] = useState(
    count === 1 ? assets[0]?.description || "" : "",
  );
  const formId = useId();
  return (
    <Dialog
      title="Change description"
      close={close}
      actions={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button primary type="submit" form={formId}>
            Apply to {plural(count)}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="sb-form"
        onSubmit={(event) => {
          event.preventDefault();
          submit({ description: description.trim() });
        }}
      >
        <label>
          Description
          <textarea
            rows={4}
            value={description}
            maxLength={1000}
            data-initial-focus
            onChange={(event) => setDescription(event.target.value)}
            placeholder="What is happening in these photos?"
          />
        </label>
        <p className="sb-preview">
          {count > 1
            ? `Replaces the description on all ${plural(count)}.`
            : "Leave empty to clear the description."}
        </p>
      </form>
    </Dialog>
  );
}

const numberOrNull = (value) => {
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : Number.NaN;
};
function ChangeLocationDialog({ assets, count, close, submit }) {
  const first = count === 1 ? assets[0] || {} : {};
  const [city, setCity] = useState(first.city || "");
  const [state, setState] = useState(first.state || "");
  const [country, setCountry] = useState(first.country || "");
  const [latitude, setLatitude] = useState(
    Number.isFinite(first.latitude) ? String(first.latitude) : "",
  );
  const [longitude, setLongitude] = useState(
    Number.isFinite(first.longitude) ? String(first.longitude) : "",
  );
  const formId = useId();
  const lat = numberOrNull(latitude);
  const lng = numberOrNull(longitude);
  const coordinateError =
    Number.isNaN(lat) || (lat !== null && Math.abs(lat) > 90)
      ? "Latitude must be between -90 and 90."
      : Number.isNaN(lng) || (lng !== null && Math.abs(lng) > 180)
        ? "Longitude must be between -180 and 180."
        : (lat === null) !== (lng === null)
          ? "Enter both latitude and longitude, or neither."
          : "";
  const valid =
    !coordinateError &&
    (city.trim() || state.trim() || country.trim() || lat !== null);
  return (
    <Dialog
      title="Change location"
      close={close}
      actions={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button primary type="submit" form={formId} disabled={!valid}>
            Apply to {plural(count)}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="sb-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid) return;
          submit({
            city: city.trim(),
            state: state.trim(),
            country: country.trim(),
            latitude: lat,
            longitude: lng,
          });
        }}
      >
        <div className="sb-grid">
          <label>
            City
            <input
              value={city}
              data-initial-focus
              onChange={(event) => setCity(event.target.value)}
            />
          </label>
          <label>
            State or region
            <input
              value={state}
              onChange={(event) => setState(event.target.value)}
            />
          </label>
          <label>
            Country
            <input
              value={country}
              onChange={(event) => setCountry(event.target.value)}
            />
          </label>
        </div>
        <div className="sb-grid">
          <label>
            Latitude
            <input
              inputMode="decimal"
              placeholder="51.4254"
              value={latitude}
              aria-invalid={coordinateError ? true : undefined}
              onChange={(event) => setLatitude(event.target.value)}
            />
          </label>
          <label>
            Longitude
            <input
              inputMode="decimal"
              placeholder="-116.1773"
              value={longitude}
              aria-invalid={coordinateError ? true : undefined}
              onChange={(event) => setLongitude(event.target.value)}
            />
          </label>
        </div>
        <p
          className={`sb-preview${coordinateError ? " sb-error" : ""}`}
          aria-live="polite"
        >
          {coordinateError ||
            (count > 1
              ? `Applies the same place to all ${plural(count)}.`
              : "Coordinates are optional.")}
        </p>
      </form>
    </Dialog>
  );
}

function TagDialog({ count, options, close, submit }) {
  const [chosen, setChosen] = useState([]);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const formId = useId();
  const normalized = (Array.isArray(options) ? options : [])
    .map((option) =>
      typeof option === "string"
        ? { id: option, label: option }
        : option && typeof option.id === "string"
          ? { id: option.id, label: option.label || option.id }
          : null,
    )
    .filter(Boolean);
  const chosenIds = new Set(chosen.map((tag) => tag.id));
  const needle = query.trim().toLowerCase();
  const matches = normalized
    .filter(
      (option) =>
        !chosenIds.has(option.id) &&
        (!needle || option.label.toLowerCase().includes(needle)),
    )
    .slice(0, 8);
  const canCreate =
    needle &&
    slug(query) &&
    !normalized.some((option) => option.label.toLowerCase() === needle) &&
    !chosenIds.has(slug(query));
  const suggestions = [
    ...matches,
    ...(canCreate
      ? [{ id: slug(query), label: query.trim(), isNew: true }]
      : []),
  ];
  const highlighted = Math.min(active, Math.max(0, suggestions.length - 1));
  const add = (tag) => {
    if (!tag || chosenIds.has(tag.id)) return;
    setChosen([...chosen, tag]);
    setQuery("");
    setActive(0);
  };
  const remove = (id) => setChosen(chosen.filter((tag) => tag.id !== id));
  const onKeyDown = (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive(Math.min(suggestions.length - 1, highlighted + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive(Math.max(0, highlighted - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (suggestions.length) add(suggestions[highlighted]);
    } else if (event.key === "Backspace" && !query && chosen.length) {
      remove(chosen.at(-1).id);
    }
  };
  return (
    <Dialog
      title="Tag"
      close={close}
      actions={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button primary type="submit" form={formId} disabled={!chosen.length}>
            Tag {plural(count)}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="sb-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!chosen.length) return;
          submit({
            tagIds: chosen.map((tag) => tag.id),
            newTags: chosen
              .filter((tag) => tag.isNew)
              .map(({ id, label }) => ({ id, label })),
          });
        }}
      >
        <div className="sb-chips" aria-label="Chosen tags">
          {chosen.map((tag) => (
            <span
              key={tag.id}
              className={`sb-chip${tag.isNew ? " is-new" : ""}`}
            >
              {tag.label}
              <button
                type="button"
                aria-label={`Remove ${tag.label}`}
                onClick={() => remove(tag.id)}
              >
                <Icon name="mdiClose" size={14} />
              </button>
            </span>
          ))}
          {!chosen.length && (
            <span className="sb-preview">No tags chosen yet.</span>
          )}
        </div>
        <label className="sb-combobox">
          Add tags
          <input
            role="combobox"
            aria-expanded={suggestions.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={
              suggestions.length ? `${listId}-${highlighted}` : undefined
            }
            autoComplete="off"
            placeholder="Type to search tags"
            value={query}
            data-initial-focus
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
          />
          <ul
            id={listId}
            role="listbox"
            className="sb-listbox"
            aria-label="Tag suggestions"
          >
            {suggestions.map((tag, index) => (
              <li
                key={tag.id}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === highlighted}
                onMouseDown={(event) => {
                  event.preventDefault();
                  add(tag);
                }}
                onMouseEnter={() => setActive(index)}
              >
                <span>{tag.label}</span>
                {tag.isNew && <small>Create tag</small>}
              </li>
            ))}
            {!suggestions.length && (
              <li className="sb-listbox-empty" aria-disabled="true">
                No matching tags
              </li>
            )}
          </ul>
        </label>
      </form>
    </Dialog>
  );
}

function DeletePermanentlyDialog({ count, close, submit }) {
  return (
    <Dialog
      title="Delete permanently"
      close={close}
      actions={
        <>
          <Button onClick={close} data-initial-focus>
            Cancel
          </Button>
          <Button
            className="danger"
            icon="mdiDeleteForeverOutline"
            onClick={submit}
          >
            Delete permanently
          </Button>
        </>
      }
    >
      <p className="sb-confirm">
        Permanently delete {plural(count)}? They will be removed from every
        album and shared link, and this cannot be undone.
      </p>
    </Dialog>
  );
}
