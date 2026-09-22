import React, { useEffect, useMemo, useRef, useState } from "react";
import { Button, Dialog } from "./App";
import { Icon } from "./Icon";
import { PersonAvatar } from "./People";
import {
  resolveSamplePhrase,
  searchSampleAssets,
  searchChips,
  normalizeSearchQuery,
  sampleFacets,
  statusLabels,
} from "./search.mjs";
import {
  isCommandQuery,
  navigationCommands,
  searchCommands,
} from "./command-palette.mjs";
import "./search-dialog.css";

export const searchModes = [
  ["semantic", "Smart search", "mdiImageSearchOutline", "Smart"],
  ["text", "All text", "mdiMagnify", "All text"],
  ["filename", "Filename", "mdiImageMultipleOutline", "Filename"],
  ["description", "Description", "mdiTextBoxOutline", "Description"],
  ["ocr", "Text in photos", "mdiTextRecognition", "Text in photos"],
  ["fullPath", "Full path", "mdiFolderOutline", "Full path"],
];
const suggestedQueries = [
  { text: "Jamie hiking in August 2026", mode: "semantic" },
  { text: "videos at Lake Louise", mode: "semantic" },
  { text: "LAKE AGNES", mode: "ocr" },
];
export const enrichmentQuickFilters = [
  {
    id: "description-missing",
    label: "Description missing",
    icon: "mdiTextBoxOutline",
    field: "descriptionStatus",
    value: "missing",
  },
  {
    id: "description-failed",
    label: "Description failed",
    icon: "mdiAlertCircleOutline",
    field: "descriptionStatus",
    value: "failed",
  },
  {
    id: "sensitivity-review",
    label: "Needs sensitivity review",
    icon: "mdiEyeOffOutline",
    field: "sensitiveStatus",
    value: "needs-review",
  },
];
const modeHints = {
  semantic: "People, places and dates become editable filters.",
  ocr: "Search the text recorded for a photo.",
  filename: "Matches the original filename.",
  description: "Matches descriptions, generated or written.",
  fullPath: "Matches the original folder path.",
  text: "Use quotes for a phrase, or −word to exclude it.",
};

function ModeControl({ mode, setMode }) {
  const group = useRef(null);
  const move = (offset) => {
    const index = searchModes.findIndex(([value]) => value === mode);
    const next = searchModes[(index + offset + searchModes.length) % searchModes.length];
    setMode(next[0]);
    requestAnimationFrame(() =>
      group.current?.querySelector('[aria-checked="true"]')?.focus(),
    );
  };
  return (
    <>
      <div
        className="sd-modes"
        role="radiogroup"
        aria-label="Search mode"
        ref={group}
        onKeyDown={(event) => {
          if (["ArrowRight", "ArrowDown"].includes(event.key)) {
            event.preventDefault();
            move(1);
          } else if (["ArrowLeft", "ArrowUp"].includes(event.key)) {
            event.preventDefault();
            move(-1);
          }
        }}
      >
        {searchModes.map(([value, label, icon, short]) => (
          <button
            type="button"
            key={value}
            role="radio"
            aria-checked={mode === value}
            aria-label={label}
            title={label}
            tabIndex={mode === value ? 0 : -1}
            onClick={() => setMode(value)}
          >
            <Icon name={icon} />
            {short}
          </button>
        ))}
      </div>
      <label className="sd-mode-select">
        Mode
        <select
          aria-label="Search mode"
          value={mode}
          onChange={(event) => setMode(event.target.value)}
        >
          {searchModes.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}

/**
 * Library search. Keeps submit(next, mode, scope, text).
 * commandIndex: buildCommandIndex() result for the "Go to" section.
 * onCommand(command): a Go-to item was chosen.
 * onOpenPalette(text): the user typed a ">" prefix; open the command palette.
 */
export function SearchDialog({
  query,
  searchBy,
  collection,
  scopedAssets,
  allAssets,
  people,
  tags,
  ratings,
  recent,
  close,
  submit,
  commandIndex = [],
  onCommand,
  onOpenPalette,
}) {
  const [text, setText] = useState(query.text);
  const [mode, setMode] = useState(searchBy);
  const [scope, setScope] = useState("current");
  const [extra, setExtra] = useState(query.filter);
  const handedOff = useRef(false);
  const places = useMemo(
    () => [...new Set(allAssets.map((asset) => asset.city))],
    [allAssets],
  );
  const commandQuery = isCommandQuery(text);
  useEffect(() => {
    if (commandQuery && onOpenPalette && !handedOff.current) {
      handedOff.current = true;
      onOpenPalette(text);
    }
  }, [commandQuery, onOpenPalette, text]);
  const resolved =
    mode === "semantic"
      ? resolveSamplePhrase(text, { people, places, now: new Date() })
      : { query: { text, filter: {} }, recognized: [] };
  const next = normalizeSearchQuery(
    {
      ...query,
      text: resolved.query.text,
      mode: mode === "semantic" ? "smart" : "text",
      filter: { ...extra, ...resolved.query.filter },
    },
    { people, tags },
  );
  const pool = scope === "current" ? scopedAssets : allAssets;
  const results = searchSampleAssets(pool, next, {
    people,
    tags,
    ratings,
    textMode: mode,
  });
  const chips = searchChips(next, { people, tags });
  const facets = sampleFacets(pool, next, { people, tags, ratings, textMode: mode });
  const placeChoices = facets.city;
  const goTo = useMemo(
    () =>
      text.trim().length >= 2 && !commandQuery
        ? searchCommands(navigationCommands(commandIndex), text, 5)
        : [],
    [commandIndex, text, commandQuery],
  );
  const apply = () => submit(next, mode, scope, text);
  const setFilter = (field, condition) => {
    const filter = { ...next.filter };
    if (condition) filter[field] = condition;
    else delete filter[field];
    setExtra(filter);
    setText(next.text);
  };
  const quickActive = (item) =>
    next.filter[item.field]?.eq === item.value &&
    Object.keys(next.filter[item.field]).length === 1;
  const quickCount = (item) =>
    facets[item.field]?.find((entry) => entry.value === item.value)?.count;
  const recentItems = (recent.length ? recent : suggestedQueries).slice(0, 4);
  return (
    <Dialog
      title="Search your library"
      close={close}
      wide
      actions={
        <>
          <span className="search-result-count" aria-live="polite">
            {results.length.toLocaleString("en")} matching{" "}
            {results.length === 1 ? "item" : "items"}
          </span>
          <Button onClick={close}>Cancel</Button>
          <Button primary icon="mdiMagnify" onClick={apply}>
            Show results
          </Button>
        </>
      }
    >
      <form
        className="search-workspace"
        onSubmit={(e) => {
          e.preventDefault();
          if (commandQuery && onOpenPalette) onOpenPalette(text);
          else apply();
        }}
      >
        <div className="search-input-row sd-input-row">
          <Icon name="mdiMagnify" size={22} />
          <input
            data-initial-focus
            autoFocus
            aria-label="Search query"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={
              mode === "semantic"
                ? "Try “Jamie hiking in August 2026”, or > for commands"
                : mode === "ocr"
                  ? "Find words visible in a photo…"
                  : "Search filenames, descriptions and more…"
            }
          />
          {text && (
            <button
              type="button"
              aria-label="Clear search text"
              onClick={() => setText("")}
            >
              <Icon name="mdiClose" />
            </button>
          )}
          <ModeControl mode={mode} setMode={setMode} />
        </div>
        {commandQuery && (
          <div className="sd-palette-hint" role="status">
            <Icon name="mdiChevronRight" size={18} />
            Commands start with “&gt;”. Press Enter to open the command
            palette.
            {onOpenPalette && (
              <Button onClick={() => onOpenPalette(text)}>
                Open command palette
              </Button>
            )}
          </div>
        )}
        <div className="search-scope sd-scope">
          <label>
            Search in
            <select
              aria-label="Search scope"
              value={scope}
              onChange={(e) => setScope(e.target.value)}
            >
              <option value="current">{collection}</option>
              <option value="library">Entire library</option>
            </select>
          </label>
          <span>{modeHints[mode] || modeHints.text}</span>
        </div>
        {chips.length > 0 && (
          <div className="search-interpreted">
            <div className="filter-section-heading">
              <h3>Search with these filters</h3>
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  setExtra({});
                  setText(next.text);
                }}
              >
                Clear filters
              </button>
            </div>
            <div className="chips">
              {chips.map((chip) => (
                <span className="chip" key={chip.field}>
                  {chip.field === "personIds" &&
                    Object.values(next.filter.personIds)
                      .flat()
                      .slice(0, 3)
                      .map((id) => (
                        <PersonAvatar
                          key={id}
                          person={people.find((person) => person.id === id)}
                          size={22}
                        />
                      ))}
                  {chip.label}
                  <button
                    type="button"
                    aria-label={`Remove ${chip.label}`}
                    onClick={() => setFilter(chip.field, null)}
                  >
                    <Icon name="mdiClose" size={14} />
                  </button>
                </span>
              ))}
            </div>
          </div>
        )}
        {goTo.length > 0 && (
          <section className="sd-goto" aria-label="Go to">
            <h3>Go to</h3>
            <div className="sd-goto-list">
              {goTo.map((command) => (
                <button
                  type="button"
                  key={command.id}
                  onClick={() => {
                    onCommand?.(command);
                    close();
                  }}
                >
                  <Icon name={command.icon} size={18} />
                  <span>
                    {command.title}
                    {command.subtitle && (
                      <small>{command.subtitle.replace(/^Settings · /, "")}</small>
                    )}
                  </span>
                  <Icon name="mdiChevronRight" size={16} />
                </button>
              ))}
            </div>
          </section>
        )}
        <section className="sd-quick" aria-label={recent.length ? "Recent searches" : "Suggested searches"}>
          <h3>{recent.length ? "Recent searches" : "Try a search"}</h3>
          {recentItems.map((item) => (
            <button
              type="button"
              className="sd-chip"
              key={`${item.mode}:${item.text}`}
              onClick={() => {
                setText(item.query?.text ?? item.text);
                setMode(item.mode);
                if (item.query) setExtra(item.query.filter);
              }}
            >
              <Icon name={recent.length ? "mdiHistory" : "mdiLightbulbOnOutline"} />
              <span>{item.text}</span>
              <small>
                {searchModes.find(([value]) => value === item.mode)?.[3]}
              </small>
            </button>
          ))}
        </section>
        <section className="sd-quick" aria-label="Enrichment filters">
          <h3>Enrichment</h3>
          {enrichmentQuickFilters.map((item) => {
            const active = quickActive(item);
            const count = quickCount(item);
            return (
              <button
                type="button"
                className="sd-chip"
                key={item.id}
                aria-pressed={active}
                onClick={() =>
                  setFilter(item.field, active ? null : { eq: item.value })
                }
              >
                <Icon name={item.icon} />
                <span>{item.label}</span>
                {Number.isInteger(count) && <small>{count}</small>}
              </button>
            );
          })}
        </section>
        <section className="search-people">
          <h3>People</h3>
          <div>
            {people.map((person) => (
              <button
                type="button"
                key={person.id}
                onClick={() => {
                  setText(next.text);
                  setExtra({
                    ...next.filter,
                    personIds: {
                      ...next.filter.personIds,
                      [next.filter.personIds?.any ? "any" : "all"]: [
                        ...new Set([
                          ...(next.filter.personIds?.all ||
                            next.filter.personIds?.any ||
                            []),
                          person.id,
                        ]),
                      ],
                    },
                  });
                }}
              >
                <PersonAvatar person={person} size={30} />
                <span>{person.name}</span>
              </button>
            ))}
          </div>
        </section>
        <div className="search-discovery">
          <section>
            <h3>Places</h3>
            {placeChoices.slice(0, 6).map((item) => (
              <button
                type="button"
                key={item.value}
                onClick={() => setFilter("city", { eq: item.value })}
              >
                <Icon name="mdiMapMarker" size={16} />
                {item.label}
                <small>{item.count}</small>
              </button>
            ))}
            {!placeChoices.length && (
              <p className="muted">No places match these filters.</p>
            )}
          </section>
          <section>
            <h3>Status</h3>
            {[
              ["descriptionStatus", "generated"],
              ["descriptionStatus", "manual"],
              ["sensitiveStatus", "reviewed"],
            ].map(([field, value]) => {
              const count = facets[field]?.find((entry) => entry.value === value)?.count ?? 0;
              return (
                <button
                  type="button"
                  key={`${field}:${value}`}
                  onClick={() => setFilter(field, { eq: value })}
                >
                  <Icon
                    name={field === "descriptionStatus" ? "mdiTextBoxOutline" : "mdiShieldCheckOutline"}
                    size={16}
                  />
                  {field === "descriptionStatus" ? "Description: " : "Sensitivity: "}
                  {statusLabels[field][value].toLowerCase()}
                  <small>{count}</small>
                </button>
              );
            })}
          </section>
        </div>
        <p className="sample-search-note">
          Preview · sample data. Smart search uses supplied descriptions and
          labels; text in photos uses supplied sample text.
        </p>
        <button type="submit" className="sr-only" tabIndex={-1}>
          Search
        </button>
      </form>
    </Dialog>
  );
}
