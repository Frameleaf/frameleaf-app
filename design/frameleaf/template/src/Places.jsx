import React, { useMemo, useState } from "react";
import { Icon } from "./Icon";
import { Button } from "./App";
import { MapView } from "./MapView";
import { placesTree } from "./discovery-data.mjs";
import "./discovery.css";

const countLabel = (count, word = "item") =>
  `${count} ${count === 1 ? word : `${word}s`}`;

function PlaceCard({ place, onQuery, onOpenMap }) {
  return (
    <div className="dv-place">
      <button
        type="button"
        className="dv-place-main"
        onClick={() => onQuery?.(place.query, place.name)}
        aria-label={`${place.name}, ${countLabel(place.count)}`}
      >
        {place.cover?.image ? (
          <img src={place.cover.image} alt="" loading="lazy" />
        ) : (
          <span className="dv-cover-empty">
            <Icon name="mdiMapMarkerOutline" size={26} />
          </span>
        )}
        <span className="dv-shade" aria-hidden="true" />
        <span className="dv-place-copy">
          <strong>{place.name}</strong>
          <small>{countLabel(place.count)}</small>
        </span>
      </button>
      {onOpenMap && place.latitude != null && (
        <button
          type="button"
          className="dv-place-map"
          aria-label={`Show ${place.name} on the map`}
          title="Show on map"
          onClick={() => onOpenMap(place.name, place)}
        >
          <Icon name="mdiMapOutline" size={16} />
        </button>
      )}
    </div>
  );
}

export function Places({ assets = [], onQuery, onOpenMap }) {
  const [search, setSearch] = useState("");
  const [grouped, setGrouped] = useState(true);
  const [collapsed, setCollapsed] = useState(() => new Set());
  const tree = useMemo(() => placesTree(assets), [assets]);
  const query = search.trim().toLowerCase();
  const matches = (name) => !query || name.toLowerCase().includes(query);
  const countries = tree.countries
    .map((country) => ({
      ...country,
      children: country.children
        .map((state) => ({
          ...state,
          children: state.children.filter(
            (city) => matches(city.name) || matches(state.name) || matches(country.name),
          ),
        }))
        .filter((state) => state.children.length),
    }))
    .filter((country) => country.children.length);
  const flat = tree.cities.filter((city) => matches(city.name));
  const groupIds = countries.map((country) => country.id);
  const allCollapsed = groupIds.length > 0 && groupIds.every((id) => collapsed.has(id));
  const toggle = (id) =>
    setCollapsed((value) => {
      const next = new Set(value);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const assetsIn = (ids) => {
    const wanted = new Set(ids);
    return assets.filter((asset) => wanted.has(asset.id));
  };
  const visibleCount = grouped
    ? countries.reduce((sum, c) => sum + c.children.reduce((inner, s) => inner + s.children.length, 0), 0)
    : flat.length;

  return (
    <main className="discovery dv-places" aria-label="Places">
      <header className="dv-header">
        <div>
          <h1>Places</h1>
          <p>
            {tree.cities.length ? `${countLabel(tree.cities.length, "place")} · ${countLabel(tree.total)} with a location` : "Where your photos and videos were taken"}
            {tree.unplaced > 0 && ` · ${tree.unplaced} without a location`}
          </p>
        </div>
        <div className="dv-header-actions">
          <label className="dv-search">
            <Icon name="mdiMagnify" size={16} />
            <input
              type="search"
              placeholder="Find a place"
              aria-label="Find a place"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <Button
            icon="mdiEarth"
            aria-pressed={grouped}
            active={grouped}
            onClick={() => setGrouped((value) => !value)}
          >
            Group by country
          </Button>
          {grouped && groupIds.length > 0 && (
            <Button
              icon={allCollapsed ? "mdiArrowExpandAll" : "mdiArrowCollapseAll"}
              onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(groupIds))}
            >
              {allCollapsed ? "Expand all" : "Collapse all"}
            </Button>
          )}
        </div>
      </header>

      {!tree.cities.length ? (
        <div className="dv-empty" role="status">
          <Icon name="mdiMapMarkerOutline" size={30} />
          <strong>No places yet</strong>
          <p>Photos and videos with a location appear here, grouped by country and region.</p>
        </div>
      ) : !visibleCount ? (
        <div className="dv-empty" role="status">
          <Icon name="mdiMapSearchOutline" size={30} />
          <strong>No places match “{search.trim()}”</strong>
          <p>Try a shorter name or clear the search.</p>
        </div>
      ) : grouped ? (
        countries.map((country) => {
          const open = !collapsed.has(country.id);
          return (
            <section key={country.id} className="dv-section dv-country" aria-label={country.name}>
              <div className="dv-section-heading">
                <button
                  type="button"
                  className="dv-group-toggle"
                  aria-expanded={open}
                  onClick={() => toggle(country.id)}
                >
                  <Icon name={open ? "mdiChevronDown" : "mdiChevronRight"} size={18} />
                  <h2>{country.name}</h2>
                  <small>{countLabel(country.count)}</small>
                </button>
                <button type="button" className="dv-link" onClick={() => onQuery?.(country.query, country.name)}>
                  View all
                  <Icon name="mdiChevronRight" size={16} />
                </button>
              </div>
              {open &&
                country.children.map((state) => (
                  <div key={state.id} className="dv-state">
                    <div className="dv-state-map">
                      <MapView static assets={assetsIn(state.assetIds)} />
                      <button
                        type="button"
                        className="dv-state-label"
                        onClick={() => onQuery?.(state.query, state.name)}
                        aria-label={`${state.name}, ${countLabel(state.count)}. View all`}
                      >
                        <strong>{state.name}</strong>
                        <small>{countLabel(state.count)} · {countLabel(state.children.length, "place")}</small>
                      </button>
                    </div>
                    <div className="dv-place-grid">
                      {state.children.map((city) => (
                        <PlaceCard key={city.id} place={city} onQuery={onQuery} onOpenMap={onOpenMap} />
                      ))}
                    </div>
                  </div>
                ))}
            </section>
          );
        })
      ) : (
        <section className="dv-section" aria-label="All places">
          <div className="dv-place-grid wide">
            {flat.map((city) => (
              <PlaceCard key={city.id} place={city} onQuery={onQuery} onOpenMap={onOpenMap} />
            ))}
          </div>
        </section>
      )}
      <p className="dv-note">Preview · sample data</p>
    </main>
  );
}
