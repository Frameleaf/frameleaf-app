import React, {
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Icon } from "./Icon";
import { PersonAvatar } from "./People";
import { FilterPanel } from "./FilterPanel";
import {
  normalizeSearchQuery,
  resolveSamplePhrase,
  sampleFacets,
  searchChips,
  searchSampleAssets,
} from "./search.mjs";
import {
  dateHistogram,
  parseSearchInput,
  searchOperators,
  suggestSearchTokens,
} from "./search-palette.mjs";
import {
  isCommandQuery,
  navigationCommands,
  searchCommands,
} from "./command-palette.mjs";
import "./search-palette.css";

export const searchModes = [
  ["semantic", "Smart search", "mdiImageSearchOutline", "Smart"],
  ["text", "All text", "mdiMagnify", "All text"],
  ["filename", "Filename", "mdiImageMultipleOutline", "Filename"],
  ["description", "Description", "mdiTextBoxOutline", "Description"],
  ["ocr", "Text in photos", "mdiTextRecognition", "Text in photos"],
  ["fullPath", "Full path", "mdiFolderOutline", "Full path"],
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
const TOP_HITS = 12;
const EXAMPLES = [
  { text: "Jamie hiking in August 2026", mode: "semantic" },
  { text: "videos at Lake Louise", mode: "semantic" },
  { text: "LAKE AGNES", mode: "ocr" },
];
// Completed operator tokens become chips; a trailing, still-typed one stays editable.
const COMPLETE_TOKEN = /(^|\s)(-?[a-z]+:(?:"[^"]*"|\S+))\s/i;

/**
 * Spotlight-style search: one glass panel with typed operators, typeahead, live results,
 * a date histogram and facet refinement. Everything still resolves through search.mjs.
 */
export function SearchPalette({
  query,
  searchBy,
  collection,
  scopedAssets,
  allAssets,
  people,
  tags,
  ratings,
  recent,
  commandIndex = [],
  onCommand,
  onOpenPalette,
  close,
  submit,
  save,
  openAsset,
}) {
  const dialog = useRef(null);
  const input = useRef(null);
  const [tokens, setTokens] = useState([]);
  const [text, setText] = useState(query.text || "");
  const [mode, setMode] = useState(searchBy);
  const [scope, setScope] = useState("current");
  const [extra, setExtra] = useState(query.filter || {});
  const [active, setActive] = useState(-1);
  const [modeMenu, setModeMenu] = useState(false);
  const [help, setHelp] = useState(false);
  // Graphical filters for people who would rather pick than type; remembered per device.
  const [advanced, setAdvanced] = useState(() => {
    try {
      return localStorage.getItem("frameleaf.search.advanced") === "1";
    } catch {
      return false;
    }
  });
  const toggleAdvanced = () =>
    setAdvanced((value) => {
      try {
        localStorage.setItem("frameleaf.search.advanced", value ? "0" : "1");
      } catch {
        /* per-device convenience only */
      }
      return !value;
    });

  useLayoutEffect(() => {
    const element = dialog.current;
    const previous = document.activeElement;
    element?.showModal();
    input.current?.focus();
    return () => {
      if (element?.open) element.close();
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  // Large libraries: keep typing responsive and let the result work trail behind.
  const deferred = useDeferredValue(`${tokens.join(" ")} ${text}`);
  const pending = deferred !== `${tokens.join(" ")} ${text}`;
  const base = scope === "current" ? scopedAssets : allAssets;

  const catalog = useMemo(() => {
    const count = (field, value) =>
      allAssets.filter((asset) =>
        Array.isArray(asset[field])
          ? asset[field].includes(value)
          : asset[field] === value,
      ).length;
    const values = (field) => [
      ...new Set(allAssets.map((asset) => asset[field]).filter(Boolean)),
    ];
    return {
      people: people.map((person) => ({
        ...person,
        count: count("personIds", person.id) || count("people", person.name),
      })),
      tags: tags.map((tag) => ({ ...tag, count: count("tagIds", tag.id) })),
      places: values("city"),
      makes: values("make"),
      models: values("model"),
      years: [
        ...new Set(
          allAssets
            .map((asset) =>
              String(asset.takenAt || asset.date || "").slice(0, 4),
            )
            .filter(Boolean),
        ),
      ],
      typeCounts: {
        IMAGE: allAssets.filter((asset) => asset.type !== "video").length,
        VIDEO: allAssets.filter((asset) => asset.type === "video").length,
      },
      favoriteCount: allAssets.filter(
        (asset) => asset.favorite || asset.isFavorite,
      ).length,
    };
  }, [allAssets, people, tags]);

  const parsed = useMemo(
    () => parseSearchInput(deferred, catalog),
    [deferred, catalog],
  );
  const resolved =
    mode === "semantic"
      ? resolveSamplePhrase(parsed.text, {
          people,
          places: catalog.places,
          now: new Date(),
        })
      : { query: { text: parsed.text, filter: {} }, recognized: [] };
  const next = normalizeSearchQuery(
    {
      ...query,
      text: resolved.query.text,
      mode: mode === "semantic" ? "smart" : "text",
      filter: { ...extra, ...resolved.query.filter, ...parsed.filter },
    },
    { people, tags },
  );
  const options = { people, tags, ratings, textMode: mode };
  const results = searchSampleAssets(base, next, options);
  const otherCount = searchSampleAssets(
    scope === "current" ? allAssets : scopedAssets,
    next,
    options,
  ).length;
  const facets = sampleFacets(base, next, options);
  const histogram = dateHistogram(results);
  const interpreted = searchChips(
    { filter: { ...extra, ...resolved.query.filter } },
    { people, tags },
  );
  const typing = text.trim().length > 0 || tokens.length > 0;
  const suggestions = text.trim() ? suggestSearchTokens(text, catalog, 6) : [];
  // "Go to" reuses the shared command index; ">" hands off to the command palette.
  // A filter being typed ("person:…") is not a destination query.
  const matchingDestinations =
    text.trim().length >= 2 && !isCommandQuery(text) && !/\S:/.test(text)
      ? searchCommands(navigationCommands(commandIndex), text, 4)
      : [];

  // One flat list drives arrow-key navigation across every section.
  const items = [
    ...suggestions.map((item) => ({ kind: "suggestion", item })),
    ...(typing
      ? results.slice(0, TOP_HITS).map((item) => ({ kind: "asset", item }))
      : []),
    ...matchingDestinations.map((item) => ({ kind: "destination", item })),
    ...(!typing
      ? (recent.length ? recent : EXAMPLES)
          .slice(0, 5)
          .map((item) => ({ kind: "recent", item }))
      : []),
  ];
  useEffect(() => setActive(-1), [deferred, scope, mode]);
  const activeItem = items[active];
  const previewAsset =
    activeItem?.kind === "asset" ? activeItem.item : typing ? results[0] : null;

  const commitTokens = (value) => {
    if (isCommandQuery(value) && onOpenPalette) {
      onOpenPalette(value);
      return;
    }
    let rest = value;
    const found = [];
    for (
      let match = rest.match(COMPLETE_TOKEN);
      match;
      match = rest.match(COMPLETE_TOKEN)
    ) {
      const raw = match[2];
      if (!parseSearchInput(raw, catalog).tokens.length) break;
      found.push(raw);
      rest = `${rest.slice(0, match.index)}${match[1]}${rest.slice(match.index + match[0].length)}`;
    }
    if (found.length) setTokens((current) => [...current, ...found]);
    setText(rest.replace(/^\s+/, ""));
  };
  const addToken = (raw) => {
    setTokens((current) =>
      current.includes(raw) ? current : [...current, raw],
    );
    input.current?.focus();
  };
  // A graphical choice replaces any typed chip for the same field, so the two
  // never disagree about what is being searched.
  const setAdvancedCondition = (field, condition) => {
    setTokens((current) =>
      current.filter(
        (token) => !(field in (parseSearchInput(token, catalog).filter || {})),
      ),
    );
    setExtra((current) => {
      const filter = { ...current };
      if (condition == null) delete filter[field];
      else filter[field] = condition;
      return filter;
    });
  };
  const run = (overrides = {}) =>
    submit(
      next,
      mode,
      overrides.scope || scope,
      [...tokens, text].join(" ").trim(),
    );
  const activate = (entry) => {
    if (!entry) return run();
    if (entry.kind === "suggestion") {
      const inserted = entry.item.insert;
      if (inserted.endsWith(":")) setText(inserted);
      else commitTokens(inserted);
      input.current?.focus();
    } else if (entry.kind === "asset")
      openAsset(
        entry.item.id,
        next,
        mode,
        scope,
        [...tokens, text].join(" ").trim(),
      );
    else if (entry.kind === "destination") {
      onCommand?.(entry.item);
      close();
    } else if (entry.kind === "recent") {
      setTokens([]);
      setText(entry.item.query?.text ?? entry.item.text);
      setMode(entry.item.mode);
      if (entry.item.query) setExtra(entry.item.query.filter || {});
    }
  };
  const keyDown = (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((index) =>
        Math.max(-1, Math.min(items.length - 1, index + step)),
      );
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (event.metaKey || event.ctrlKey) run();
      else activate(activeItem);
    } else if (
      event.key === "Tab" &&
      suggestions.length &&
      event.target === input.current &&
      !event.shiftKey
    ) {
      event.preventDefault();
      activate({
        kind: "suggestion",
        item: suggestions[Math.max(0, active)] || suggestions[0],
      });
    } else if (
      event.key === "Backspace" &&
      !text &&
      tokens.length &&
      event.target === input.current
    ) {
      event.preventDefault();
      setTokens((current) => current.slice(0, -1));
    }
  };
  const label = (entry, index) => ({
    id: `sp-item-${index}`,
    role: "option",
    "aria-selected": index === active,
    onMouseEnter: () => setActive(index),
    onClick: () => activate(entry),
  });
  let index = -1;
  const nextIndex = () => (index += 1);
  const chipsFromTokens = parseSearchInput(tokens.join(" "), catalog).tokens;
  const modeInfo = searchModes.find(([value]) => value === mode);
  const quickActive = (item) =>
    next.filter[item.field]?.eq === item.value &&
    Object.keys(next.filter[item.field]).length === 1;
  const quickCount = (item) =>
    facets[item.field]?.find((entry) => entry.value === item.value)?.count;
  const peopleFacet = (facets.personIds || [])
    .filter((item) => item.count > 0)
    .slice(0, 6);
  const refine = [
    [
      "type",
      facets.type,
      (item) => (item.value === "IMAGE" ? "type:photo" : "type:video"),
    ],
    [
      "place",
      facets.city,
      (item) =>
        `place:${/\s/.test(item.value) ? `"${item.value}"` : item.value}`,
    ],
    ["camera", facets.make, (item) => `camera:${item.value}`],
    [
      "rating",
      (facets.rating || []).filter((item) => Number(item.value) >= 3),
      (item) => `rating:${item.value}`,
    ],
  ];

  return (
    <dialog
      ref={dialog}
      className="search-palette"
      aria-label="Search your library"
      onCancel={(event) => {
        event.preventDefault();
        if (modeMenu || help) {
          setModeMenu(false);
          setHelp(false);
        } else close();
      }}
      onClick={(event) => event.target === event.currentTarget && close()}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          run();
        }}
        onKeyDown={keyDown}
      >
        <div className="sp-field">
          <Icon name="mdiMagnify" size={22} />
          <div className="sp-tokens">
            {chipsFromTokens.map((token, position) => (
              <span
                className={`sp-token ${token.exclude ? "exclude" : ""}`}
                key={tokens[position]}
              >
                {token.key === "person" && (
                  <PersonAvatar
                    person={people.find(
                      (person) =>
                        person.name.toLowerCase() === token.value.toLowerCase(),
                    )}
                    size={18}
                  />
                )}
                {token.label}
                <button
                  type="button"
                  aria-label={`Remove ${token.label}`}
                  onClick={() =>
                    setTokens((current) =>
                      current.filter((_, at) => at !== position),
                    )
                  }
                >
                  <Icon name="mdiClose" size={12} />
                </button>
              </span>
            ))}
            <input
              ref={input}
              aria-label="Search query"
              role="combobox"
              aria-expanded="true"
              aria-controls="sp-results"
              aria-activedescendant={
                active >= 0 ? `sp-item-${active}` : undefined
              }
              autoComplete="off"
              spellCheck={false}
              value={text}
              onChange={(event) => commitTokens(event.target.value)}
              placeholder={
                tokens.length
                  ? "Add words or filters…"
                  : mode === "semantic"
                    ? "Search photos, people, places… or > for commands"
                    : mode === "ocr"
                      ? "Find words visible in a photo…"
                      : `Search by ${modeInfo?.[1].toLowerCase()}…`
              }
            />
          </div>
          {(text || tokens.length > 0) && (
            <button
              type="button"
              className="sp-icon-button"
              aria-label="Clear search"
              onClick={() => {
                setText("");
                setTokens([]);
                setExtra({});
                input.current?.focus();
              }}
            >
              <Icon name="mdiClose" size={16} />
            </button>
          )}
          <div className="sp-mode">
            <button
              type="button"
              aria-label={`Search mode: ${modeInfo?.[1]}`}
              aria-haspopup="menu"
              aria-expanded={modeMenu}
              onClick={() => setModeMenu(!modeMenu)}
            >
              <Icon name={modeInfo?.[2]} size={16} />
              <span className="sp-button-label">{modeInfo?.[1]}</span>
              <Icon name="mdiChevronDown" size={14} />
            </button>
            {modeMenu && (
              <div role="menu" className="sp-menu">
                {searchModes.map(([value, name, icon]) => (
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={mode === value}
                    key={value}
                    onClick={() => {
                      setMode(value);
                      setModeMenu(false);
                      input.current?.focus();
                    }}
                  >
                    <Icon name={icon} size={16} />
                    {name}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            type="button"
            className="sp-advanced-toggle"
            aria-label="Advanced filters"
            aria-pressed={advanced}
            onClick={toggleAdvanced}
          >
            <Icon name="mdiTuneVariant" size={16} />
            <span className="sp-button-label">Advanced</span>
          </button>
          <button
            type="button"
            className="sp-icon-button"
            aria-label="Search syntax"
            aria-expanded={help}
            onClick={() => setHelp(!help)}
          >
            <Icon name="mdiHelpCircleOutline" size={18} />
          </button>
        </div>

        <div className="sp-bar">
          <div className="sp-scope" role="radiogroup" aria-label="Search scope">
            {[
              [
                "current",
                collection,
                scope === "current" ? results.length : otherCount,
              ],
              [
                "library",
                "Entire library",
                scope === "library" ? results.length : otherCount,
              ],
            ].map(([value, name, count]) => (
              <button
                type="button"
                role="radio"
                aria-checked={scope === value}
                key={value}
                onClick={() => setScope(value)}
              >
                {name}
                <small>{count.toLocaleString()}</small>
              </button>
            ))}
          </div>
          {interpreted.length > 0 && (
            <div className="sp-understood" aria-label="Understood as">
              <span>Understood</span>
              {interpreted.map((chip) => (
                <button
                  type="button"
                  key={chip.field}
                  aria-label={`Remove ${chip.label}`}
                  onClick={() => {
                    const filter = { ...extra, ...resolved.query.filter };
                    delete filter[chip.field];
                    setExtra(filter);
                    setText(resolved.query.text);
                  }}
                >
                  {chip.label}
                  <Icon name="mdiClose" size={12} />
                </button>
              ))}
            </div>
          )}
          <span className="sp-status" aria-live="polite">
            {pending
              ? "Searching…"
              : `${results.length.toLocaleString()} ${results.length === 1 ? "match" : "matches"}`}
          </span>
        </div>

        {help && (
          <section className="sp-help" aria-label="Search syntax">
            <p>
              Type naturally, or combine filters. Put − in front of any filter
              to exclude it.
            </p>
            <div>
              {searchOperators.map((operator) => (
                <button
                  type="button"
                  key={operator.key}
                  onClick={() =>
                    setText(`${text ? `${text} ` : ""}${operator.key}:`)
                  }
                >
                  <code>{operator.hint}</code>
                  <span>{operator.label}</span>
                </button>
              ))}
              <button
                type="button"
                onClick={() =>
                  setText(`${text ? `${text} ` : ""}"exact phrase"`)
                }
              >
                <code>"exact phrase"</code>
                <span>Phrase</span>
              </button>
              <button
                type="button"
                onClick={() => setText(`${text ? `${text} ` : ""}-snow`)}
              >
                <code>-word</code>
                <span>Exclude a word</span>
              </button>
            </div>
          </section>
        )}

        {advanced && (
          <div className="sp-advanced">
            <FilterPanel
              embedded
              query={next}
              facets={facets}
              people={people}
              count={results.length}
              collection={scope === "current" ? collection : "Entire library"}
              setCondition={setAdvancedCondition}
              clear={() => {
                setExtra({});
                setTokens([]);
              }}
              close={close}
            />
          </div>
        )}
        <div className="sp-body" hidden={advanced}>
          <div
            className="sp-results"
            id="sp-results"
            role="listbox"
            aria-label="Search results"
          >
            {suggestions.length > 0 && (
              <section>
                <h3>Suggestions</h3>
                {suggestions.map((item) => {
                  const at = nextIndex();
                  return (
                    <div
                      key={item.detail}
                      {...label({ kind: "suggestion", item }, at)}
                      className={`sp-row ${at === active ? "active" : ""}`}
                    >
                      {item.kind === "person" ? (
                        <PersonAvatar
                          person={catalog.people.find(
                            (person) => person.name === item.label,
                          )}
                          size={20}
                        />
                      ) : (
                      <Icon
                        name={
                          {
                            person: "mdiAccountOutline",
                            place: "mdiMapMarker",
                            tag: "mdiTagOutline",
                            camera: "mdiCameraOutline",
                            year: "mdiCalendarRange",
                            type: "mdiImageMultipleOutline",
                            is: "mdiHeartOutline",
                            operator: "mdiPoundBox",
                          }[item.kind]
                        }
                        size={16}
                      />
                      )}
                      <span>{item.label}</span>
                      <code>{item.detail}</code>
                      {item.count != null && (
                        <small>{item.count.toLocaleString()}</small>
                      )}
                      {at === active && <kbd>⇥</kbd>}
                    </div>
                  );
                })}
              </section>
            )}

            {typing && (
              <section>
                <h3>
                  Photos and videos
                  {results.length > TOP_HITS && (
                    <button
                      type="button"
                      className="sp-link"
                      onClick={() => run()}
                    >
                      Show all {results.length.toLocaleString()} <kbd>⌘⏎</kbd>
                    </button>
                  )}
                </h3>
                {results.length ? (
                  <div className="sp-hits">
                    {results.slice(0, TOP_HITS).map((asset) => {
                      const at = nextIndex();
                      return (
                        <div
                          key={asset.id}
                          {...label({ kind: "asset", item: asset }, at)}
                          className={`sp-hit ${at === active ? "active" : ""}`}
                          title={asset.name}
                        >
                          <img src={asset.image} alt="" loading="lazy" />
                          {asset.type === "video" && (
                            <Icon name="mdiPlayCircleOutline" size={16} />
                          )}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="sp-empty">
                    No matches{" "}
                    {scope === "current"
                      ? `in ${collection}`
                      : "in your library"}
                    .
                    {scope === "current" && otherCount > 0 && (
                      <button
                        type="button"
                        className="sp-link"
                        onClick={() => setScope("library")}
                      >
                        {otherCount.toLocaleString()} in your entire library
                      </button>
                    )}
                  </p>
                )}
              </section>
            )}

            {matchingDestinations.length > 0 && (
              <section>
                <h3>Go to</h3>
                {matchingDestinations.map((item) => {
                  const at = nextIndex();
                  return (
                    <div
                      key={item.id}
                      {...label({ kind: "destination", item }, at)}
                      className={`sp-row ${at === active ? "active" : ""}`}
                    >
                      <Icon name={item.icon || "mdiArrowRight"} size={16} />
                      <span>{item.title}</span>
                      <small>{item.subtitle}</small>
                      <Icon name="mdiArrowRight" size={14} />
                    </div>
                  );
                })}
              </section>
            )}

            {!typing && (
              <>
                <section>
                  <h3>{recent.length ? "Recent searches" : "Try a search"}</h3>
                  {(recent.length ? recent : EXAMPLES)
                    .slice(0, 5)
                    .map((item) => {
                      const at = nextIndex();
                      return (
                        <div
                          key={`${item.mode}:${item.text}`}
                          {...label({ kind: "recent", item }, at)}
                          className={`sp-row ${at === active ? "active" : ""}`}
                        >
                          <Icon name="mdiHistory" size={16} />
                          <span>{item.text}</span>
                          <small>
                            {
                              searchModes.find(
                                ([value]) => value === item.mode,
                              )?.[1]
                            }
                          </small>
                        </div>
                      );
                    })}
                </section>
                <section>
                  <h3>People</h3>
                  <div className="sp-people">
                    {people.map((person) => (
                      <button
                        type="button"
                        key={person.id}
                        onClick={() =>
                          addToken(
                            `person:${/\s/.test(person.name) ? `"${person.name}"` : person.name}`,
                          )
                        }
                      >
                        <PersonAvatar person={person} size={48} />
                        <span>{person.name}</span>
                      </button>
                    ))}
                  </div>
                </section>
              </>
            )}
          </div>

          <aside className="sp-side" aria-label="Refine">
            {previewAsset && (
              <figure className="sp-preview">
                <img src={previewAsset.image} alt={previewAsset.name} />
                <figcaption>
                  <strong>{previewAsset.name}</strong>
                  <span>
                    {[previewAsset.date, previewAsset.city]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </figcaption>
              </figure>
            )}
            {histogram.buckets.length > 1 && (
              <section>
                <h3>When</h3>
                <div
                  className="sp-histogram"
                  role="group"
                  aria-label={`Matches by ${histogram.unit}`}
                >
                  {histogram.buckets.map((bucket) => {
                    const max = Math.max(
                      ...histogram.buckets.map((item) => item.count),
                    );
                    return (
                      <button
                        type="button"
                        key={bucket.start}
                        disabled={!bucket.count}
                        title={`${bucket.label}: ${bucket.count}`}
                        aria-label={`${bucket.label}, ${bucket.count} ${bucket.count === 1 ? "match" : "matches"}`}
                        style={{
                          "--h": `${Math.max(4, (bucket.count / max) * 100)}%`,
                        }}
                        onClick={() => {
                          // after: is exclusive of its day and before: is exclusive, so bracket the bucket.
                          const day = (time) =>
                            new Date(time).toISOString().slice(0, 10);
                          setTokens((current) => [
                            ...current.filter(
                              (raw) => !/^(after|before|year|month):/.test(raw),
                            ),
                            `after:${day(Date.parse(bucket.start) - 86_400_000)}`,
                            `before:${day(Date.parse(bucket.end))}`,
                          ]);
                        }}
                      />
                    );
                  })}
                </div>
                <div className="sp-histogram-axis">
                  <span>{histogram.buckets[0].label}</span>
                  <span>{histogram.buckets.at(-1).label}</span>
                </div>
              </section>
            )}
            {peopleFacet.length > 0 && typing && (
              <section>
                <h3>People</h3>
                <div className="sp-facet-people">
                  {peopleFacet.map((item) => (
                    <button
                      type="button"
                      key={item.value}
                      aria-pressed={item.selected}
                      onClick={() =>
                        addToken(
                          `person:${/\s/.test(item.label) ? `"${item.label}"` : item.label}`,
                        )
                      }
                    >
                      <PersonAvatar
                        person={people.find(
                          (person) => person.id === item.value,
                        )}
                        size={28}
                      />
                      <small>{item.count}</small>
                    </button>
                  ))}
                </div>
              </section>
            )}
            {typing &&
              refine.map(([key, values, token]) =>
                values?.some((item) => item.count > 0) ? (
                  <section key={key}>
                    <h3>
                      {
                        {
                          type: "Media",
                          place: "Places",
                          camera: "Cameras",
                          rating: "Rating",
                        }[key]
                      }
                    </h3>
                    <div className="sp-facets">
                      {values
                        .filter((item) => item.count > 0)
                        .slice(0, 5)
                        .map((item) => (
                          <button
                            type="button"
                            key={item.value}
                            aria-pressed={item.selected}
                            onClick={() => addToken(token(item))}
                          >
                            {key === "rating" ? `${item.value}★+` : item.label}
                            <small>{item.count}</small>
                          </button>
                        ))}
                    </div>
                  </section>
                ) : null,
              )}
            {enrichmentQuickFilters.some(
              (item) => Number.isInteger(quickCount(item)) || quickActive(item),
            ) && (
              <section>
                <h3>Enrichment</h3>
                <div className="sp-facets">
                  {enrichmentQuickFilters.map((item) => {
                    const count = quickCount(item);
                    const activeFilter = quickActive(item);
                    if (!activeFilter && !Number.isInteger(count)) return null;
                    return (
                      <button
                        type="button"
                        key={item.id}
                        aria-pressed={activeFilter}
                        onClick={() => {
                          const filter = { ...extra };
                          if (activeFilter) delete filter[item.field];
                          else filter[item.field] = { eq: item.value };
                          setExtra(filter);
                        }}
                      >
                        <Icon name={item.icon} size={14} />
                        {item.label}
                        {Number.isInteger(count) && <small>{count}</small>}
                      </button>
                    );
                  })}
                </div>
              </section>
            )}
            {!typing && (
              <section>
                <h3>Places</h3>
                <div className="sp-facets">
                  {(facets.city || []).map((item) => (
                    <button
                      type="button"
                      key={item.value}
                      onClick={() =>
                        addToken(
                          `place:${/\s/.test(item.value) ? `"${item.value}"` : item.value}`,
                        )
                      }
                    >
                      {item.label}
                      <small>{item.count}</small>
                    </button>
                  ))}
                </div>
              </section>
            )}
          </aside>
        </div>

        <footer className="sp-footer">
          <span className="sp-keys" aria-hidden="true">
            <kbd>↑</kbd>
            <kbd>↓</kbd> move <kbd>⏎</kbd> open <kbd>⇥</kbd> complete{" "}
            <kbd>⌘⏎</kbd> all results <kbd>esc</kbd> close
          </span>
          <span className="sp-note">
            Sample library. Smart search matches supplied descriptions; no AI
            runs here.
          </span>
          <button
            type="button"
            className="sp-secondary"
            onClick={() =>
              save(next, mode, scope, [...tokens, text].join(" ").trim())
            }
          >
            <Icon name="mdiContentSaveOutline" size={16} />
            Save search
          </button>
          <button type="submit" className="sp-primary">
            Show {results.length.toLocaleString()}{" "}
            {results.length === 1 ? "result" : "results"}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
