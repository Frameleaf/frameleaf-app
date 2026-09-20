import React, { useEffect, useRef, useState } from "react";
import { Button } from "./App";
import { PersonAvatar } from "./People";
import { SearchableSelect } from "./SearchableSelect";
import {
  captureDateControlValue,
  captureDateHasCustomCondition,
  customConditionValue,
  equalityControlValue,
  moveSetGroup,
  ratingConditionForValue,
  ratingControlValue,
  setGroupLabels,
  updateCaptureDate,
  updateSetGroup,
} from "./filter-state.mjs";

function MultiFilter({ field, label, items, condition, setCondition, people }) {
  const [term, setTerm] = useState("");
  const [preferred, setPreferred] = useState(null);
  const mode =
    preferred ||
    Object.keys(setGroupLabels).find((key) => condition?.[key]?.length) ||
    "any";
  const selected = condition?.[mode] || [];
  const update = (values) =>
    setCondition(field, updateSetGroup(condition, mode, values));
  const retainedGroups = Object.keys(setGroupLabels).filter(
    (key) => key !== mode && condition?.[key]?.length,
  );
  const activeGroupCount = Object.keys(setGroupLabels).filter(
    (group) => condition?.[group]?.length,
  ).length;
  return (
    <section className="filter-section">
      <div className="filter-section-heading">
        <h3>{label}</h3>
        <select
          aria-label={`${label} matching`}
          value={mode}
          onChange={(e) => {
            setCondition(field, moveSetGroup(condition, mode, e.target.value));
            setPreferred(e.target.value);
          }}
        >
          <option value="any">Any of</option>
          <option value="all">All of</option>
          <option value="none">Exclude</option>
        </select>
      </div>
      {activeGroupCount > 1 && (
        <p className="muted filter-group-help">
          Other selections remain active.
        </p>
      )}
      {retainedGroups.map((group) => (
        <p className="muted filter-group-summary" key={group}>
          {setGroupLabels[group]}:{" "}
          {condition[group]
            .map(
              (value) =>
                items.find((item) => item.value === value)?.label || value,
            )
            .join(", ")}{" "}
          <button
            className="text-button"
            onClick={() => setPreferred(group)}
            aria-label={`Edit ${label.toLowerCase()} ${setGroupLabels[group].toLowerCase()} group`}
          >
            Edit
          </button>
        </p>
      ))}
      {activeGroupCount > 0 && (
        <div className="filter-group-actions">
          {Object.keys(setGroupLabels)
            .filter((group) => group !== mode && !condition?.[group]?.length)
            .map((group) => (
              <button
                className="text-button"
                key={group}
                onClick={() => setPreferred(group)}
              >
                Add {setGroupLabels[group].toLowerCase()} group
              </button>
            ))}
        </div>
      )}
      <input
        className="filter-find"
        aria-label={`Find ${label.toLowerCase()}`}
        placeholder={`Find ${label.toLowerCase()}…`}
        value={term}
        onChange={(e) => setTerm(e.target.value)}
      />
      <div className={`filter-options ${people ? "face-options" : ""}`}>
        {items
          .filter((item) =>
            item.label.toLowerCase().includes(term.toLowerCase()),
          )
          .map((item) => (
            <label
              key={item.value}
              className={`filter-option ${selected.includes(item.value) ? "is-selected" : ""}`}
            >
              <input
                type="checkbox"
                checked={selected.includes(item.value)}
                onChange={() =>
                  update(
                    selected.includes(item.value)
                      ? selected.filter((value) => value !== item.value)
                      : [...selected, item.value],
                  )
                }
              />
              {people && (
                <PersonAvatar
                  person={people.find((person) => person.id === item.value)}
                  size={34}
                />
              )}
              <span>{item.label}</span>
              <small>{item.count}</small>
            </label>
          ))}
        {!items.some((item) =>
          item.label.toLowerCase().includes(term.toLowerCase()),
        ) && <p className="muted">No matching {label.toLowerCase()}.</p>}
      </div>
    </section>
  );
}
export function FilterPanel({
  query,
  facets,
  people,
  count,
  collection,
  setCondition,
  clear,
  close,
  save,
  focusSection = "people",
}) {
  const panel = useRef(null);
  const closeRef = useRef(close);
  closeRef.current = close;
  const filter = query.filter;
  useEffect(() => {
    const previousFocus = document.activeElement;
    const onKeyDown = (event) => {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        closeRef.current();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (previousFocus?.isConnected)
        previousFocus.focus?.({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    panel.current
      ?.querySelector(`[data-section="${focusSection}"]`)
      ?.scrollIntoView({ block: "nearest" });
    panel.current?.querySelector("h2")?.focus({ preventScroll: true });
  }, [focusSection]);
  const typeValue = equalityControlValue(filter.type, (value) =>
    ["IMAGE", "VIDEO"].includes(value),
  );
  const ratingValue = ratingControlValue(filter.rating);
  const selectFacet = (field, label) => {
    const value = equalityControlValue(filter[field]);
    const options = [
      { value: "", label: `Any ${label.toLowerCase()}` },
      ...(value === customConditionValue
        ? [
            {
              value: customConditionValue,
              label: "Custom condition (see chip)",
              disabled: true,
            },
          ]
        : []),
      ...(facets[field] || []),
    ];
    if (
      value &&
      value !== customConditionValue &&
      !options.some((item) => item.value === value)
    )
      options.push({ value, label: value, count: 0 });
    return (
      <SearchableSelect
        key={field}
        label={label}
        value={value}
        options={options}
        onChange={(next) => setCondition(field, next ? { eq: next } : null)}
        placeholder={`Search ${label.toLowerCase()}…`}
      />
    );
  };
  const flag = (field, label) => {
    const value = equalityControlValue(
      filter[field],
      (value) => typeof value === "boolean",
    );
    return (
      <label className="filter-select" key={field}>
        {label}
        <select
          aria-label={label}
          value={value}
          onChange={(e) =>
            setCondition(
              field,
              e.target.value === "" ? null : { eq: e.target.value === "true" },
            )
          }
        >
          <option value="">Any</option>
          {value === customConditionValue && (
            <option value={customConditionValue} disabled>
              Custom condition (see chip)
            </option>
          )}
          <option value="true">Yes</option>
          <option value="false">No</option>
        </select>
      </label>
    );
  };
  return (
    <aside className="filter-panel" aria-label="Library filters" ref={panel}>
      <div className="filter-panel-header">
        <div>
          <h2 tabIndex={-1}>Filters</h2>
          <span className="muted" aria-live="polite">
            {count} matching · {collection}
          </span>
        </div>
        <Button icon="mdiClose" aria-label="Close filters" onClick={close} />
      </div>
      <div className="filter-panel-scroll">
        <div data-section="people">
          <MultiFilter
            field="personIds"
            label="People"
            items={facets.personIds || []}
            condition={filter.personIds}
            setCondition={setCondition}
            people={people}
          />
        </div>
        <section className="filter-section" data-section="media">
          <h3>Media</h3>
          {typeValue === customConditionValue && (
            <p className="muted">Custom condition (see chip)</p>
          )}
          <div className="filter-segments">
            {[
              ["", "All"],
              ["IMAGE", "Photos"],
              ["VIDEO", "Videos"],
            ].map(([value, label]) => (
              <button
                key={value}
                aria-pressed={typeValue === value}
                onClick={() =>
                  setCondition("type", value ? { eq: value } : null)
                }
              >
                {label}
                {value && (
                  <small>
                    {facets.type?.find((item) => item.value === value)?.count ||
                      0}
                  </small>
                )}
              </button>
            ))}
          </div>
        </section>
        <section className="filter-section" data-section="date">
          <h3>Capture date</h3>
          {captureDateHasCustomCondition(filter.takenAt) && (
            <p className="muted">
              Custom condition (see chip). Date controls edit one boundary at a
              time.
            </p>
          )}
          <div className="date-range">
            {[
              ["gte", "From"],
              ["lte", "Through"],
            ].map(([operator, label]) => (
              <label key={operator}>
                {label}
                <input
                  type="date"
                  aria-label={`Captured ${label.toLowerCase()}`}
                  value={captureDateControlValue(filter.takenAt, operator)}
                  onInput={(e) => {
                    setCondition(
                      "takenAt",
                      updateCaptureDate(
                        filter.takenAt,
                        operator,
                        e.target.value,
                      ),
                    );
                  }}
                />
              </label>
            ))}
          </div>
          <button
            className="text-button"
            onClick={() =>
              setCondition("takenAt", { gte: "2026-08-01", lte: "2026-08-31" })
            }
          >
            August 2026
          </button>
        </section>
        <section className="filter-section" data-section="places">
          <h3>Places</h3>
          {[
            ["country", "Country"],
            ["state", "State / province"],
            ["city", "City"],
          ].map(([field, label]) => selectFacet(field, label))}
        </section>
        <section className="filter-section" data-section="rating">
          <h3>Rating & favorites</h3>
          <SearchableSelect
            label="Rating"
            value={ratingValue}
            placeholder="Search ratings…"
            onChange={(value) => {
              const next = ratingConditionForValue(value);
              if (next !== undefined) setCondition("rating", next);
            }}
            options={[
              { value: "", label: "Any rating" },
              ...(ratingValue === customConditionValue
                ? [
                    {
                      value: customConditionValue,
                      label: "Custom condition (see chip)",
                      disabled: true,
                    },
                  ]
                : []),
              { value: "null", label: "No rating metadata" },
              { value: "0", label: "Unrated (0)" },
              { value: "-1", label: "Rejected" },
              ...[1, 2, 3, 4, 5].map((value) => ({
                value: String(value),
                label: `Exactly ${value} ${value === 1 ? "star" : "stars"}`,
              })),
              ...[0, 1, 2, 3, 4, 5].map((value) => ({
                value: `min${value}`,
                label: `${value} stars or more`,
              })),
            ]}
          />
          {flag("isFavorite", "Favorites")}
        </section>
        <div data-section="tags">
          <MultiFilter
            field="tagIds"
            label="Tags"
            items={facets.tagIds || []}
            condition={filter.tagIds}
            setCondition={setCondition}
          />
        </div>
        <section className="filter-section" data-section="camera">
          <h3>Camera & lens</h3>
          {[
            ["make", "Camera make"],
            ["model", "Camera model"],
            ["lensModel", "Lens"],
          ].map(([field, label]) => selectFacet(field, label))}
        </section>
        <section className="filter-section">
          <h3>Library status</h3>
          {selectFacet("visibility", "Visibility")}
          {[
            ["hasPeople", "Has people"],
            ["hasAlbums", "In an album"],
            ["hasTags", "Has tags"],
          ].map(([field, label]) => flag(field, label))}
        </section>
      </div>
      <div className="filter-panel-footer">
        <Button onClick={clear}>Reset filters</Button>
        <Button icon="mdiFolderSearchOutline" onClick={save}>
          Save preset
        </Button>
      </div>
    </aside>
  );
}
