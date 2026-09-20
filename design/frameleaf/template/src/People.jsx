import React, { useState } from "react";

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
          borderRadius: "50%",
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

export function PeopleLibrary({ people = [], assets = [], onPerson }) {
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("name");
  const query = search.trim().toLocaleLowerCase();
  const matches = people
    .filter((person) => person.name.toLocaleLowerCase().includes(query))
    .map((person) => ({
      person,
      count: assets.filter((asset) => asset.personIds?.includes(person.id))
        .length,
    }))
    .sort((a, b) =>
      sort === "count"
        ? b.count - a.count || a.person.name.localeCompare(b.person.name)
        : a.person.name.localeCompare(b.person.name),
    );

  return (
    <section className="people-library" aria-label="People library">
      <header className="people-header">
        <div>
          <h1>People</h1>
          <p className="people-summary">
            {people.length} people · {assets.length} photos and videos in this
            sample library
          </p>
        </div>
        <div className="people-toolbar">
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
          </select>
        </div>
      </header>
      <div className="people-grid">
        {matches.map(({ person, count }) => (
          <button
            className="person-card"
            type="button"
            key={person.id}
            onClick={() => onPerson(person.id)}
          >
            <PersonAvatar person={person} size={144} />
            <strong className="person-name">{person.name}</strong>
            <span className="person-count">
              {count} {count === 1 ? "item" : "items"}
            </span>
          </button>
        ))}
      </div>
      {matches.length === 0 && (
        <p className="people-empty" role="status">
          {query
            ? "No people match your search."
            : "No people are assigned in this sample library."}
        </p>
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
            <span>{person.name}</span>
          </button>
        ))
      ) : (
        <p className="people-empty">No people assigned to this sample.</p>
      )}
    </div>
  );
}
