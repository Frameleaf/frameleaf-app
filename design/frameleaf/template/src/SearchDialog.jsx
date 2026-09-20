import React, { useMemo, useState } from "react";
import { Button, Dialog } from "./App";
import { Icon } from "./Icon";
import { PersonAvatar } from "./People";
import {
  resolveSamplePhrase,
  searchSampleAssets,
  searchChips,
  normalizeSearchQuery,
  sampleFacets,
} from "./search.mjs";
export const searchModes = [
  ["semantic", "Smart search", "mdiImageSearchOutline"],
  ["text", "All text", "mdiMagnify"],
  ["filename", "Filename", "mdiImageMultipleOutline"],
  ["description", "Description", "mdiTextBoxSearchOutline"],
  ["ocr", "Text in photos", "mdiTextBoxSearchOutline"],
  ["fullPath", "Full path", "mdiFolderOutline"],
];
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
}) {
  const [text, setText] = useState(query.text);
  const [mode, setMode] = useState(searchBy);
  const [scope, setScope] = useState("current");
  const [extra, setExtra] = useState(query.filter);
  const places = useMemo(
    () => [...new Set(allAssets.map((asset) => asset.city))],
    [allAssets],
  );
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
  const results = searchSampleAssets(
    scope === "current" ? scopedAssets : allAssets,
    next,
    { people, tags, ratings, textMode: mode },
  );
  const chips = searchChips(next, { people, tags });
  const placeChoices = sampleFacets(
    scope === "current" ? scopedAssets : allAssets,
    next,
    { people, tags, ratings, textMode: mode },
  ).city;
  const apply = () => submit(next, mode, scope, text);
  return (
    <Dialog
      title="Search your library"
      close={close}
      wide
      actions={
        <>
          <span className="search-result-count" aria-live="polite">
            {results.length} matching {results.length === 1 ? "item" : "items"}
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
          apply();
        }}
      >
        <div className="search-input-row">
          <Icon name="mdiMagnify" size={24} />
          <input
            data-initial-focus
            autoFocus
            aria-label="Search query"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={
              mode === "semantic"
                ? "Try “Jamie hiking in August 2026”"
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
        </div>
        <div className="search-mode-grid" aria-label="Search mode">
          {searchModes.map(([value, label, icon]) => (
            <button
              type="button"
              key={value}
              aria-pressed={mode === value}
              onClick={() => setMode(value)}
            >
              <Icon name={icon} />
              {label}
            </button>
          ))}
        </div>
        <div className="search-scope">
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
          <span className="muted">
            {mode === "semantic"
              ? "People, places and dates become editable filters."
              : mode === "ocr"
                ? "Search the text recorded for a photo."
                : "Use quotes for a phrase, or −word to exclude it."}
          </span>
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
                    onClick={() => {
                      const filter = { ...next.filter };
                      delete filter[chip.field];
                      setExtra(filter);
                      setText(next.text);
                    }}
                  >
                    <Icon name="mdiClose" size={14} />
                  </button>
                </span>
              ))}
            </div>
          </div>
        )}
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
                <PersonAvatar person={person} size={44} />
                <span>{person.name}</span>
              </button>
            ))}
          </div>
        </section>
        <div className="search-discovery">
          <section>
            <h3>{recent.length ? "Recent searches" : "Try a search"}</h3>
            {(recent.length
              ? recent
              : [
                  { text: "Jamie hiking in August 2026", mode: "semantic" },
                  { text: "videos at Lake Louise", mode: "semantic" },
                  { text: "LAKE AGNES", mode: "ocr" },
                ]
            )
              .slice(0, 4)
              .map((item) => (
                <button
                  type="button"
                  key={`${item.mode}:${item.text}`}
                  onClick={() => {
                    setText(item.query?.text ?? item.text);
                    setMode(item.mode);
                    if (item.query) setExtra(item.query.filter);
                  }}
                >
                  <Icon name="mdiHistory" size={16} />
                  <span>
                    {item.text}
                    <small className="recent-mode">
                      {searchModes.find(([value]) => value === item.mode)?.[1]}
                    </small>
                  </span>
                  <Icon name="mdiChevronRight" size={16} />
                </button>
              ))}
          </section>
          <section>
            <h3>Places</h3>
            {placeChoices.map((item) => (
              <button
                type="button"
                key={item.value}
                onClick={() => {
                  setExtra({ ...next.filter, city: { eq: item.value } });
                  setText(next.text);
                }}
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
        </div>
        <p className="sample-search-note">
          Sample library · Smart search uses supplied descriptions and labels.
          Text in photos uses supplied sample text. No AI processing runs in
          this prototype.
        </p>
        <button type="submit" className="sr-only" tabIndex={-1}>
          Search
        </button>
      </form>
    </Dialog>
  );
}
