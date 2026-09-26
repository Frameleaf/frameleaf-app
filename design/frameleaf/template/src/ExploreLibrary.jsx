import React, { useMemo } from "react";
import { Icon } from "./Icon";
import { PersonAvatar } from "./People";
import {
  exploreSections,
  captureDate,
  videoAsset,
} from "./explore-timeline.mjs";
import "./explore-library.css";

const countLabel = (count) => `${count} ${count === 1 ? "item" : "items"}`;
const collectionName = (id) =>
  ({
    "summer-rockies": "Summer in the Rockies",
    family: "Family",
    everyday: "Everyday",
  })[id] || id.replaceAll("-", " ");
function Heading({ children, action, onClick }) {
  return (
    <div className="el-section-heading">
      <h2>{children}</h2>
      {onClick && (
        <button type="button" onClick={onClick}>
          {action || "View all"}
          <Icon name="mdiChevronRight" size={16} />
        </button>
      )}
    </div>
  );
}
function Cover({ asset, className = "" }) {
  return asset?.image ? (
    <img className={className} src={asset.image} alt="" loading="lazy" />
  ) : (
    <div className={`el-cover-empty ${className}`}>
      <Icon name="mdiImageMultipleOutline" size={28} />
    </div>
  );
}
export function ExploreLibrary({
  assets = [],
  people = [],
  onQuery,
  onOpenCollection,
  onOpenAsset,
  onNavigate,
}) {
  const sections = useMemo(
    () => exploreSections(assets, people),
    [assets, people],
  );
  const query = (patch, title) => onQuery?.(patch, title);
  const navigate = (destination) => onNavigate?.(destination);
  return (
    <main className="explore-library" aria-label="Explore your library">
      <header className="el-header">
        <h1>Explore</h1>
        <p>Familiar faces, favorite places, and more to rediscover.</p>
      </header>
      {!sections.assets.length ? (
        <div className="el-empty" role="status">
          <Icon name="mdiImageSearchOutline" size={32} />
          <h2>Nothing to explore in this view</h2>
          <p>Choose another album or adjust your filters to see more.</p>
        </div>
      ) : (
        <>
          {sections.people.length > 0 && (
            <section
              className="el-section"
              aria-label="People"
              id="explore-people"
            >
              <Heading onClick={onNavigate && (() => navigate("People"))}>
                People
              </Heading>
              <div className="el-people">
                {sections.people.slice(0, 12).map((item) => (
                  <button
                    type="button"
                    className="el-person"
                    key={item.id}
                    onClick={() => query(item.query, item.label)}
                  >
                    <PersonAvatar person={item.person} size={88} />
                    <strong>{item.label}</strong>
                    <small>{countLabel(item.count)}</small>
                  </button>
                ))}
              </div>
            </section>
          )}
          <section className="el-section" aria-label="Library highlights">
            <div className="el-highlights">
              <button
                type="button"
                className="el-best"
                onClick={() =>
                  onNavigate
                    ? navigate("Best Photos")
                    : query({ filter: { rating: { gte: 4 } } }, "Highly rated")
                }
              >
                <Cover asset={sections.best[0] || sections.assets[0]} />
                <span className="el-cover-shade" />
                <span className="el-best-copy">
                  <span className="el-overline">
                    <Icon name="mdiStarOutline" size={16} /> Best Photos
                  </span>
                  <strong>A few worth another look</strong>
                  <small>
                    {sections.best.length
                      ? `${sections.best.length} ${sections.hasQualityScores ? "quality suggestions" : "highly rated items"} in this view`
                      : "Find your strongest photos and videos"}
                  </small>
                </span>
                <span className="el-cover-arrow">
                  <Icon name="mdiChevronRight" />
                </span>
              </button>
              <div className="el-shortcuts">
                {sections.shortcuts.map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    onClick={() => query(item.query, item.label)}
                  >
                    <span className="el-shortcut-icon">
                      <Icon name={item.icon} size={20} />
                    </span>
                    <span>
                      <strong>{item.label}</strong>
                      <small>{countLabel(item.count)}</small>
                    </span>
                    <Icon name="mdiChevronRight" size={16} />
                  </button>
                ))}
              </div>
            </div>
          </section>
          {sections.places.length > 0 && (
            <section
              className="el-section"
              aria-label="Places"
              id="explore-places"
            >
              <Heading onClick={onNavigate && (() => navigate("Places"))}>
                Places
              </Heading>
              <div className="el-places">
                {sections.places.slice(0, 8).map((item) => (
                  <button
                    type="button"
                    className="el-place"
                    key={item.id}
                    onClick={() => query(item.query, item.label)}
                  >
                    <Cover asset={item.cover} />
                    <span className="el-cover-shade" />
                    <span>
                      <strong>{item.label}</strong>
                      <small>{countLabel(item.count)}</small>
                    </span>
                  </button>
                ))}
              </div>
            </section>
          )}
          {sections.memories.length > 0 && (
            <section
              className="el-section"
              aria-label="Memories"
              id="explore-memories"
            >
              <Heading onClick={onNavigate && (() => navigate("Memories"))}>
                Days to revisit
              </Heading>
              <div className="el-memory-row">
                {sections.memories.map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    onClick={() => query(item.query, item.title)}
                  >
                    <Cover asset={item.cover} />
                    <span className="el-cover-shade" />
                    <span className="el-memory-copy">
                      <strong>{item.title}</strong>
                      <small>{countLabel(item.assets.length)}</small>
                    </span>
                  </button>
                ))}
              </div>
            </section>
          )}
          {sections.things.length > 0 && (
            <section
              className="el-section"
              aria-label="Things"
              id="explore-things"
            >
              <Heading>Things in your photos</Heading>
              <div className="el-things">
                {sections.things.slice(0, 10).map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    onClick={() => query(item.query, item.label)}
                  >
                    <Cover asset={item.cover} />
                    <span>
                      <strong>{item.label}</strong>
                      <small>{countLabel(item.count)}</small>
                    </span>
                    <Icon name="mdiChevronRight" size={16} />
                  </button>
                ))}
              </div>
            </section>
          )}
          {onOpenCollection && sections.collections.length > 0 && (
            <section
              className="el-section"
              aria-label="Collections"
              id="explore-collections"
            >
              <Heading>From your albums</Heading>
              <div className="el-collections">
                {sections.collections.slice(0, 6).map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    onClick={() => onOpenCollection(item.id)}
                  >
                    <Cover asset={item.cover} />
                    <span>
                      <strong>{collectionName(item.id)}</strong>
                      <small>{countLabel(item.count)}</small>
                    </span>
                    <Icon name="mdiChevronRight" size={16} />
                  </button>
                ))}
              </div>
            </section>
          )}
          {onOpenAsset && (
            <section
              className="el-section"
              aria-label="Recent captures"
              id="explore-recent"
            >
              <Heading>Recent captures</Heading>
              <div className="el-recent">
                {sections.assets.slice(0, 8).map((asset) => (
                  <button
                    type="button"
                    key={asset.id}
                    onClick={() => onOpenAsset(asset.id)}
                    aria-label={`Open ${asset.name || asset.originalFileName}`}
                  >
                    <Cover asset={asset} />
                    <span>{asset.name || asset.originalFileName}</span>
                    {videoAsset(asset) && (
                      <span className="el-media-label">
                        <Icon name="mdiMovieOpenOutline" size={14} />
                        Video
                      </span>
                    )}
                    <small>{captureDate(asset)?.day || "Date unknown"}</small>
                  </button>
                ))}
              </div>
            </section>
          )}
          {onNavigate && (
            <div className="el-more">
              <button type="button" onClick={() => navigate("Memories")}>
                <Icon name="mdiHistory" />
                <span>Memories</span>
                <Icon name="mdiChevronRight" size={16} />
              </button>
              <button type="button" onClick={() => navigate("Recently added")}>
                <Icon name="mdiClockOutline" />
                <span>Recently added</span>
                <Icon name="mdiChevronRight" size={16} />
              </button>
            </div>
          )}
        </>
      )}
    </main>
  );
}
