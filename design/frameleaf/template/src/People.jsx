import React, { useEffect, useId, useRef, useState } from "react";
import { Button, Dialog } from "./Controls";
import { Icon } from "./Icon";
import {
  ageAt,
  applyPeopleOverrides,
  dismissSuggestion,
  displayName,
  isBirthday,
  isUnnamed,
  mergePeople,
  mergeSuggestions,
  nameSuggestions,
  personAssets,
  remapAssetPeople,
  setBirthday,
  setPersonName,
  togglePersonFlag,
  visiblePeople,
} from "./people-data.mjs";
import "./people.css";

export function PersonAvatar({ person, size = 32, decorative = true }) {
  const [failedImage, setFailedImage] = useState(null);
  const name = person?.name?.trim() || "Unnamed person";
  const image = person?.image;
  const style = { width: size, height: size };
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => Array.from(part)[0])
    .join("")
    .toLocaleUpperCase();

  if (!image || failedImage === image) {
    const colors = {
      primary: "#176447",
      pink: "#913c68",
      red: "#a33232",
      yellow: "#785d08",
      blue: "#27579b",
      green: "#28662f",
      purple: "#69419c",
      orange: "#944716",
      gray: "#535a65",
      amber: "#80591b",
    };
    return (
      <span
        className="person-avatar person-avatar-fallback"
        style={
          colors[person?.avatarColor]
            ? {
                ...style,
                backgroundColor: colors[person.avatarColor],
                color: "#ffffff",
              }
            : style
        }
        role={decorative ? undefined : "img"}
        aria-hidden={decorative || undefined}
        aria-label={decorative ? undefined : name}
      >
        {initials}
      </span>
    );
  }

  if (
    person.faceBox &&
    ["x", "y", "width", "height"].every((key) =>
      Number.isFinite(person.faceBox[key]),
    ) &&
    person.faceBox.width > 0 &&
    person.faceBox.height > 0
  ) {
    const box = person.faceBox;
    const sourceWidth = person.imageWidth || 1,
      sourceHeight = person.imageHeight || 1;
    const scale = Math.max(
      size / (sourceWidth * box.width),
      size / (sourceHeight * box.height),
    );
    return (
      <span
        className="person-avatar person-face-crop"
        style={{
          ...style,
          position: "relative",
          display: "inline-block",
          overflow: "hidden",
          flexShrink: 0,
        }}
        role={decorative ? undefined : "img"}
        aria-label={decorative ? undefined : name}
        aria-hidden={decorative || undefined}
      >
        <img
          src={image}
          alt=""
          loading="lazy"
          style={{
            position: "absolute",
            maxWidth: "none",
            width: sourceWidth * scale,
            height: sourceHeight * scale,
            left: size / 2 - (box.x + box.width / 2) * sourceWidth * scale,
            top: size / 2 - (box.y + box.height / 2) * sourceHeight * scale,
          }}
          onError={() => setFailedImage(image)}
        />
      </span>
    );
  }
  return (
    <img
      className="person-avatar"
      style={style}
      src={image}
      alt={decorative ? "" : name}
      width={size}
      height={size}
      loading="lazy"
      onError={() => setFailedImage(image)}
    />
  );
}

/** Circular crop of a normalized face box that keeps the source aspect ratio. */
export function FaceCrop({ src, box, size = 64, alt = "", className = "" }) {
  const valid =
    box &&
    ["x", "y", "width", "height"].every((key) => Number.isFinite(box[key])) &&
    box.width > 0 &&
    box.height > 0;
  if (!src || !valid)
    return (
      <span
        className={`pp-face-crop pp-face-crop-plain ${className}`}
        style={{ width: size, height: size }}
        role={alt ? "img" : undefined}
        aria-label={alt || undefined}
        aria-hidden={alt ? undefined : true}
      >
        {src && <img src={src} alt="" loading="lazy" />}
      </span>
    );
  const cx = (box.x + box.width / 2) * 100,
    cy = (box.y + box.height / 2) * 100;
  return (
    <span
      className={`pp-face-crop ${className}`}
      style={{ width: size, height: size }}
      role={alt ? "img" : undefined}
      aria-label={alt || undefined}
      aria-hidden={alt ? undefined : true}
    >
      <img
        src={src}
        alt=""
        loading="lazy"
        style={{
          width: `${Math.min(100 / box.width, 2500)}%`,
          transform: `translate(-${cx}%, -${cy}%)`,
        }}
      />
    </span>
  );
}

export function usePhoneLayout() {
  const [phone, setPhone] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(max-width: 700px)").matches,
  );
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function")
      return undefined;
    const query = window.matchMedia("(max-width: 700px)");
    const sync = () => setPhone(query.matches);
    sync();
    query.addEventListener?.("change", sync);
    return () => query.removeEventListener?.("change", sync);
  }, []);
  return phone;
}

const plural = (count, one, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

/** Popover menu with roving arrow-key focus. items: [{id,label,icon,onSelect,disabled,danger}] or "separator". */
export function PersonMenu({
  items,
  label = "More actions",
  icon = "mdiDotsVertical",
  className = "",
  buttonClassName = "",
  align = "right",
  children,
}) {
  const [open, setOpen] = useState(false);
  const button = useRef(null),
    menu = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    menu.current?.querySelector('[role="menuitem"]:not(:disabled)')?.focus();
    const onPointer = (event) => {
      if (
        !menu.current?.contains(event.target) &&
        !button.current?.contains(event.target)
      )
        setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);
  const close = (restore = true) => {
    setOpen(false);
    if (restore) button.current?.focus();
  };
  const onKeyDown = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === "Tab") {
      close(false);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const list = [
      ...menu.current.querySelectorAll('[role="menuitem"]:not(:disabled)'),
    ];
    const index = list.indexOf(document.activeElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? list.length - 1
          : (index + (event.key === "ArrowDown" ? 1 : -1) + list.length) %
            list.length;
    list[next]?.focus();
  };
  return (
    <div className={`pp-menu-wrap ${className}`}>
      <button
        ref={button}
        type="button"
        className={`pp-menu-button ${buttonClassName}`}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {children || <Icon name={icon} />}
      </button>
      {open && (
        <div
          className={`pp-menu pp-menu-${align}`}
          role="menu"
          aria-label={label}
          ref={menu}
          onKeyDown={onKeyDown}
        >
          {items.map((item, index) =>
            item === "separator" ? (
              <hr key={`separator-${index}`} />
            ) : (
              <button
                type="button"
                role="menuitem"
                key={item.id}
                disabled={item.disabled}
                className={item.danger ? "danger" : ""}
                onClick={() => {
                  close();
                  item.onSelect?.();
                }}
              >
                {item.icon && <Icon name={item.icon} size={16} />}
                <span>{item.label}</span>
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

/** Inline rename with a suggestion list of existing names. Enter saves, Escape or leaving cancels. */
export function PersonNameEditor({
  person,
  people = [],
  onCommit,
  onCancel,
  placeholder = "Name",
  label,
  className = "",
  allowEmpty = false,
}) {
  const [value, setValue] = useState(person?.name || "");
  const [active, setActive] = useState(-1);
  const [dismissed, setDismissed] = useState(false);
  const wrap = useRef(null),
    input = useRef(null);
  const listId = useId();
  const trimmed = value.trim();
  const suggestions = nameSuggestions(value, people, {
    exclude: person?.id,
  }).filter((entry) => entry.name !== trimmed);
  const showList = !dismissed && suggestions.length > 0;
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const commit = (name) => {
    const next = name.trim();
    if (!next && !allowEmpty) {
      onCancel?.();
      return;
    }
    onCommit?.(next);
  };
  return (
    <form
      ref={wrap}
      className={`pp-name-editor ${className}`}
      onSubmit={(event) => {
        event.preventDefault();
        commit(active >= 0 && showList ? suggestions[active].name : value);
      }}
      onBlur={(event) => {
        if (!wrap.current?.contains(event.relatedTarget)) onCancel?.();
      }}
    >
      <input
        ref={input}
        type="text"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={showList}
        aria-controls={listId}
        aria-activedescendant={
          showList && active >= 0 ? `${listId}-${active}` : undefined
        }
        aria-label={label || `Name for ${displayName(person)}`}
        placeholder={placeholder}
        maxLength={120}
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          setActive(-1);
          setDismissed(false);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit(active >= 0 && showList ? suggestions[active].name : value);
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            if (showList) setDismissed(true);
            else onCancel?.();
          } else if (event.key === "ArrowDown" && suggestions.length) {
            event.preventDefault();
            setDismissed(false);
            setActive((index) => (index + 1) % suggestions.length);
          } else if (event.key === "ArrowUp" && suggestions.length) {
            event.preventDefault();
            setDismissed(false);
            setActive(
              (index) => (index - 1 + suggestions.length) % suggestions.length,
            );
          }
        }}
      />
      <button
        type="button"
        className="pp-icon-button"
        aria-label="Save name"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() =>
          commit(active >= 0 && showList ? suggestions[active].name : value)
        }
      >
        <Icon name="mdiCheck" size={16} />
      </button>
      <button
        type="button"
        className="pp-icon-button"
        aria-label="Cancel renaming"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onCancel?.()}
      >
        <Icon name="mdiClose" size={16} />
      </button>
      {showList && (
        <ul
          className="pp-suggestions"
          role="listbox"
          id={listId}
          aria-label="Suggested names"
        >
          {suggestions.map((entry, index) => (
            <li
              key={entry.id}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === active}
              className={index === active ? "active" : ""}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => commit(entry.name)}
            >
              <PersonAvatar
                person={people.find((candidate) => candidate.id === entry.id)}
                size={24}
              />
              <span>{entry.name}</span>
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}

export function MergePeopleDialog({ person, people = [], assets = [], onMerge, close }) {
  const [query, setQuery] = useState("");
  const [choice, setChoice] = useState(null);
  const text = query.trim().toLocaleLowerCase();
  const candidates = visiblePeople(people, { showHidden: true })
    .filter((candidate) => candidate.id !== person.id)
    .map((candidate) => ({
      person: candidate,
      count: personAssets(candidate, assets).length,
    }))
    .filter(
      ({ person: candidate }) =>
        !text || displayName(candidate).toLocaleLowerCase().includes(text),
    )
    .sort(
      (a, b) =>
        isUnnamed(a.person) - isUnnamed(b.person) ||
        b.count - a.count ||
        displayName(a.person).localeCompare(displayName(b.person)),
    );
  const target = people.find((candidate) => candidate.id === choice) || null;
  return (
    <Dialog
      title="Merge people"
      close={close}
      actions={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button
            primary
            icon="mdiCallMerge"
            disabled={!target}
            onClick={() => onMerge(target.id)}
          >
            Merge
          </Button>
        </>
      }
    >
      <div className="pp-merge-preview" aria-live="polite">
        <div className="pp-merge-side">
          <PersonAvatar person={person} size={72} />
          <strong>{displayName(person)}</strong>
          <span>{plural(personAssets(person, assets).length, "item")}</span>
        </div>
        <Icon name="mdiArrowRight" size={22} className="pp-merge-arrow" />
        <div className={`pp-merge-side ${target ? "" : "pp-merge-empty"}`}>
          {target ? (
            <>
              <PersonAvatar person={target} size={72} />
              <strong>{displayName(target)}</strong>
              <span>{plural(personAssets(target, assets).length, "item")}</span>
            </>
          ) : (
            <>
              <span className="pp-merge-placeholder" aria-hidden="true">
                <Icon name="mdiAccountOutline" size={28} />
              </span>
              <strong>Choose a person</strong>
              <span>Photos move to them</span>
            </>
          )}
        </div>
      </div>
      <p className="pp-dialog-hint">
        Everything tagged as {displayName(person)} will appear under the person
        you choose. Their name, birthday and favorite status are kept.
      </p>
      <input
        type="search"
        className="pp-search"
        aria-label="Find a person to merge into"
        placeholder="Find a person"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        data-initial-focus
      />
      <ul className="pp-person-list" aria-label="People">
        {candidates.map(({ person: candidate, count }) => (
          <li key={candidate.id}>
            <button
              type="button"
              aria-pressed={candidate.id === choice}
              onClick={() => setChoice(candidate.id)}
            >
              <PersonAvatar person={candidate} size={40} />
              <span
                className={`pp-person-list-name ${isUnnamed(candidate) ? "is-unnamed" : ""}`}
              >
                {displayName(candidate)}
              </span>
              <span className="pp-person-list-count">{plural(count, "item")}</span>
              {candidate.id === choice && <Icon name="mdiCheck" size={18} />}
            </button>
          </li>
        ))}
        {candidates.length === 0 && (
          <li className="pp-person-list-empty">No other people match.</li>
        )}
      </ul>
    </Dialog>
  );
}

export function BirthdayDialog({ person, onSave, close }) {
  const [value, setValue] = useState(person.birthday || "");
  const today = new Date().toISOString().slice(0, 10);
  const valid = value === "" || (isBirthday(value) && value <= today);
  const age = valid && value ? ageAt(value) : null;
  const unchanged = (value || null) === (person.birthday || null);
  return (
    <Dialog
      title="Date of birth"
      close={close}
      actions={
        <>
          <Button onClick={close}>Cancel</Button>
          {person.birthday && (
            <Button icon="mdiDeleteOutline" onClick={() => onSave(null)}>
              Remove
            </Button>
          )}
          <Button
            primary
            disabled={!valid || unchanged}
            onClick={() => onSave(value || null)}
          >
            Save
          </Button>
        </>
      }
    >
      <label className="pp-field">
        <span>Date of birth for {displayName(person)}</span>
        <input
          type="date"
          max={today}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          data-initial-focus
        />
      </label>
      <p className="pp-dialog-hint" aria-live="polite">
        {!valid
          ? "Choose a date that is not in the future."
          : value && age !== null
            ? `${displayName(person)} is ${plural(age, "year")} old. The viewer shows their age at the time of each photo.`
            : "The viewer shows their age at the time of each photo."}
      </p>
    </Dialog>
  );
}

export function FeaturedPhotoDialog({ person, assets = [], faces = [], onSelect, close }) {
  const owned = personAssets(person, assets);
  const faceFor = (assetId) =>
    faces.find((face) => face.assetId === assetId && face.box) || null;
  return (
    <Dialog
      title="Select featured photo"
      close={close}
      wide
      actions={<Button onClick={close}>Done</Button>}
    >
      <p className="pp-dialog-hint">
        The featured photo represents {displayName(person)} across the app.
      </p>
      <div className="pp-featured-grid" role="radiogroup" aria-label="Photos">
        {owned.map((asset, index) => {
          const face = faceFor(asset.id);
          const current = asset.id === person.featuredAssetId;
          return (
            <button
              type="button"
              key={asset.id}
              role="radio"
              aria-checked={current}
              aria-label={`${asset.name}${current ? ", current featured photo" : ""}`}
              className={`pp-featured-tile ${current ? "current" : ""}`}
              data-initial-focus={index === 0 ? "" : undefined}
              onClick={() => onSelect(asset.id)}
            >
              {face ? (
                <FaceCrop src={asset.image} box={face.box} size={96} />
              ) : (
                <img src={asset.image} alt="" loading="lazy" />
              )}
              {asset.type === "video" && (
                <span className="pp-featured-video" aria-hidden="true">
                  <Icon name="mdiPlay" size={14} />
                </span>
              )}
              {current && (
                <span className="pp-featured-check" aria-hidden="true">
                  <Icon name="mdiCheck" size={16} />
                </span>
              )}
            </button>
          );
        })}
      </div>
      {owned.length === 0 && (
        <p className="people-empty">No photos are available for this person.</p>
      )}
    </Dialog>
  );
}

function latestDate(assets) {
  let latest = "";
  for (const asset of assets) {
    const stamp = String(asset.takenAt || asset.date || "");
    if (stamp > latest) latest = stamp;
  }
  return latest;
}

export function PeopleLibrary({
  people = [],
  assets = [],
  onPerson,
  onOpenPerson,
  overrides,
  onChange,
  onManage,
  onMergeSuggestion,
  suggestions,
}) {
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("name");
  const [showHidden, setShowHidden] = useState(false);
  const [editing, setEditing] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [skipped, setSkipped] = useState([]);
  const [status, setStatus] = useState("");
  const [local, setLocal] = useState(() => overrides || {});
  const phone = usePhoneLayout();
  const current = onChange ? overrides || {} : local;
  const change = (next, message) => {
    if (onChange) onChange(next);
    else setLocal(next);
    if (message) setStatus(message);
  };
  const applied = applyPeopleOverrides(people, current);
  const library = remapAssetPeople(assets, current);
  const open = (id) => (onOpenPerson || onPerson)?.(id);
  const query = search.trim().toLocaleLowerCase();
  const cards = visiblePeople(applied, { showHidden })
    .map((person) => {
      const owned = personAssets(person, library);
      return { person, count: owned.length, latest: latestDate(owned) };
    })
    .filter(
      ({ person }) =>
        !query || displayName(person).toLocaleLowerCase().includes(query),
    )
    .sort((a, b) => {
      const unnamed = isUnnamed(a.person) - isUnnamed(b.person);
      if (sort === "count")
        return (
          b.count - a.count ||
          unnamed ||
          displayName(a.person).localeCompare(displayName(b.person))
        );
      if (sort === "recent")
        return (
          b.latest.localeCompare(a.latest) ||
          unnamed ||
          displayName(a.person).localeCompare(displayName(b.person))
        );
      return (
        unnamed || displayName(a.person).localeCompare(displayName(b.person))
      );
    });
  const hiddenCount = applied.filter((person) => person.hidden).length;
  const visibleCount = visiblePeople(applied, { showHidden }).length;
  const pending = (suggestions || mergeSuggestions(applied, library)).filter(
    (entry) =>
      !skipped.includes(entry.id) &&
      applied.some((person) => person.id === entry.from) &&
      applied.some((person) => person.id === entry.into),
  );
  const suggestion = pending[0] || null;
  const personById = (id) => applied.find((person) => person.id === id);
  const dialogPerson = dialog ? personById(dialog.id) : null;
  const avatarSize = phone ? 128 : 160;
  const menuFor = (person) => [
    {
      id: "rename",
      label: isUnnamed(person) ? "Add a name" : "Rename",
      icon: "mdiPencilOutline",
      onSelect: () => setEditing(person.id),
    },
    {
      id: "favorite",
      label: person.favorite ? "Remove from favorites" : "Favorite",
      icon: person.favorite ? "mdiHeartOffOutline" : "mdiHeartOutline",
      onSelect: () =>
        change(
          togglePersonFlag(current, person.id, "favorite", !person.favorite),
          person.favorite
            ? `${displayName(person)} removed from favorites.`
            : `${displayName(person)} added to favorites.`,
        ),
    },
    {
      id: "hide",
      label: person.hidden ? "Show on People page" : "Hide",
      icon: person.hidden ? "mdiEyeOutline" : "mdiEyeOffOutline",
      onSelect: () =>
        change(
          togglePersonFlag(current, person.id, "hidden", !person.hidden),
          person.hidden
            ? `${displayName(person)} is shown again.`
            : `${displayName(person)} is hidden. Use Show and hide people to bring them back.`,
        ),
    },
    "separator",
    {
      id: "merge",
      label: "Merge into…",
      icon: "mdiCallMerge",
      onSelect: () => setDialog({ type: "merge", id: person.id }),
    },
    {
      id: "birthday",
      label: person.birthday ? "Change date of birth" : "Set date of birth",
      icon: "mdiCakeVariantOutline",
      onSelect: () => setDialog({ type: "birthday", id: person.id }),
    },
  ];

  return (
    <section className="people-library pl-page" aria-label="People library">
      <header className="people-header pl-header">
        <div>
          <h1>People</h1>
          <p className="people-summary">
            {plural(visibleCount, "person", "people")} ·{" "}
            {plural(assets.length, "photo and video", "photos and videos")}
            {hiddenCount > 0 && !showHidden && ` · ${plural(hiddenCount, "hidden person", "hidden people")}`}
          </p>
        </div>
        <div className="people-toolbar pl-toolbar">
          <input
            type="search"
            aria-label="Find a person"
            placeholder="Find a person"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <select
            aria-label="Sort people"
            value={sort}
            onChange={(event) => setSort(event.target.value)}
          >
            <option value="name">Name</option>
            <option value="count">Photo count</option>
            <option value="recent">Recently seen</option>
          </select>
          <Button
            icon={showHidden ? "mdiEyeOutline" : "mdiEyeOffOutline"}
            active={showHidden}
            aria-pressed={showHidden}
            onClick={() => setShowHidden((value) => !value)}
          >
            {showHidden ? "Hide hidden" : "Show hidden"}
          </Button>
          {onManage && (
            <Button icon="mdiAccountMultipleOutline" onClick={onManage}>
              Show and hide people
            </Button>
          )}
        </div>
      </header>
      {suggestion && (
        <section
          className="pl-suggestion"
          aria-label="Merge suggestion"
          key={suggestion.id}
        >
          <div className="pl-suggestion-faces" aria-hidden="true">
            <PersonAvatar person={personById(suggestion.from)} size={64} />
            <PersonAvatar person={personById(suggestion.into)} size={64} />
          </div>
          <div className="pl-suggestion-copy">
            <strong>Are these the same person?</strong>
            <span>
              {displayName(personById(suggestion.from))} and{" "}
              {displayName(personById(suggestion.into))} · {suggestion.reason}.
            </span>
            {pending.length > 1 && (
              <small>{pending.length - 1} more to review</small>
            )}
          </div>
          <div className="pl-suggestion-actions">
            <Button
              primary
              icon="mdiCallMerge"
              onClick={() => {
                if (onMergeSuggestion)
                  onMergeSuggestion(suggestion.from, suggestion.into);
                else
                  change(
                    mergePeople(current, suggestion.from, suggestion.into, applied),
                  );
                setStatus(
                  `Merged ${displayName(personById(suggestion.from))} into ${displayName(personById(suggestion.into))}.`,
                );
              }}
            >
              Yes, merge
            </Button>
            <Button
              onClick={() => {
                setSkipped((list) => [...list, suggestion.id]);
                change(dismissSuggestion(current, suggestion.from, suggestion.into));
                setStatus("Kept as two people.");
              }}
            >
              No
            </Button>
          </div>
          <small className="pl-preview-note">Preview · sample data</small>
        </section>
      )}
      <div className="pl-grid">
        {cards.map(({ person, count }) => {
          const name = displayName(person);
          const unnamed = isUnnamed(person);
          return (
            <article
              className={`pl-card ${person.hidden ? "is-hidden" : ""} ${editing === person.id ? "is-editing" : ""}`}
              key={person.id}
            >
              <button
                className="pl-face"
                type="button"
                aria-label={`Open ${name}`}
                onClick={() => open(person.id)}
              >
                <PersonAvatar person={person} size={avatarSize} />
                {person.favorite && (
                  <span className="pl-badge pl-badge-favorite" title="Favorite">
                    <Icon name="mdiHeart" size={14} />
                  </span>
                )}
                {person.hidden && (
                  <span className="pl-badge pl-badge-hidden" title="Hidden">
                    <Icon name="mdiEyeOffOutline" size={14} />
                  </span>
                )}
              </button>
              <div className="pl-meta">
                {editing === person.id ? (
                  <PersonNameEditor
                    person={person}
                    people={applied}
                    placeholder={unnamed ? "Add a name" : "Name"}
                    onCommit={(next) => {
                      change(
                        setPersonName(current, person.id, next),
                        unnamed
                          ? `Named this person ${next}.`
                          : `Renamed ${name} to ${next}.`,
                      );
                      setEditing(null);
                    }}
                    onCancel={() => setEditing(null)}
                  />
                ) : unnamed ? (
                  <button
                    className="pl-add-name"
                    type="button"
                    onClick={() => setEditing(person.id)}
                  >
                    <Icon name="mdiPlus" size={14} />
                    Add a name
                  </button>
                ) : (
                  <button
                    className="pl-name"
                    type="button"
                    title="Rename"
                    aria-label={`Rename ${name}`}
                    onClick={() => setEditing(person.id)}
                  >
                    {name}
                  </button>
                )}
                <span className="pl-count">{plural(count, "item")}</span>
              </div>
              <PersonMenu
                className="pl-menu"
                label={`More actions for ${name}`}
                items={menuFor(person)}
              />
            </article>
          );
        })}
      </div>
      {cards.length === 0 && (
        <p className="people-empty" role="status">
          {query
            ? "No people match your search."
            : hiddenCount > 0
              ? "Everyone is hidden. Turn on Show hidden or use Show and hide people."
              : "No people are assigned in this library."}
        </p>
      )}
      <p className="pl-status" role="status" aria-live="polite">
        {status}
      </p>
      {dialog?.type === "merge" && dialogPerson && (
        <MergePeopleDialog
          person={dialogPerson}
          people={applied}
          assets={library}
          close={() => setDialog(null)}
          onMerge={(intoId) => {
            change(
              mergePeople(current, dialogPerson.id, intoId, applied),
              `Merged ${displayName(dialogPerson)} into ${displayName(personById(intoId))}.`,
            );
            setDialog(null);
          }}
        />
      )}
      {dialog?.type === "birthday" && dialogPerson && (
        <BirthdayDialog
          person={dialogPerson}
          close={() => setDialog(null)}
          onSave={(birthday) => {
            change(
              setBirthday(current, dialogPerson.id, birthday),
              birthday
                ? `Date of birth saved for ${displayName(dialogPerson)}.`
                : `Date of birth removed for ${displayName(dialogPerson)}.`,
            );
            setDialog(null);
          }}
        />
      )}
    </section>
  );
}

export function PeoplePanel({ people = [], personIds = [], onPerson }) {
  const selected = new Set(personIds);
  const assigned = people.filter((person) => selected.has(person.id));

  return (
    <div className="inspector-people">
      {assigned.length ? (
        assigned.map((person) => (
          <button
            className="inspector-person"
            type="button"
            key={person.id}
            onClick={() => onPerson(person.id)}
          >
            <PersonAvatar person={person} size={64} />
            <span>{displayName(person)}</span>
          </button>
        ))
      ) : (
        <p className="people-empty">No people are assigned yet.</p>
      )}
    </div>
  );
}
