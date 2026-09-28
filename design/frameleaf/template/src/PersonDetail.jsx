import React, { useEffect, useRef, useState } from "react";
import { Button } from "./Controls";
import { Icon } from "./Icon";
import {
  BirthdayDialog,
  FaceCrop,
  FeaturedPhotoDialog,
  MergePeopleDialog,
  PersonAvatar,
  PersonMenu,
  PersonNameEditor,
  usePhoneLayout,
} from "./People";
import {
  ageAt,
  applyPeopleOverrides,
  displayName,
  featuredAsset,
  formatBirthday,
  isUnnamed,
  mergePeople,
  personAssets,
  personFaces,
  remapAssetPeople,
  setBirthday,
  setFeaturedAsset,
  setPersonName,
  togglePersonFlag,
} from "./people-data.mjs";
import "./people.css";

const plural = (count, one, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;
const shortDate = (asset) => {
  const stamp = String(asset?.takenAt || asset?.date || "");
  if (!/^\d{4}-\d{2}-\d{2}/.test(stamp)) return "";
  return new Date(`${stamp.slice(0, 10)}T00:00:00Z`).toLocaleDateString(
    undefined,
    { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" },
  );
};

function FixMatchPanel({
  person,
  faces,
  assets,
  people,
  onFaceAction,
  onOpenAsset,
  close,
}) {
  const [resolved, setResolved] = useState({});
  const [naming, setNaming] = useState(null);
  const [message, setMessage] = useState("");
  const panel = useRef(null),
    heading = useRef(null),
    closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const previous = document.activeElement;
    heading.current?.focus();
    const onKey = (event) => {
      if (
        event.key === "Escape" &&
        !event.defaultPrevented &&
        !document.querySelector("dialog[open]")
      ) {
        event.preventDefault();
        closeRef.current?.();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  const assetFor = (id) => assets.find((asset) => asset.id === id);
  const others = people
    .filter((candidate) => candidate.id !== person.id && !isUnnamed(candidate))
    .map((candidate) => ({
      candidate,
      count: personAssets(candidate, assets).length,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 6)
    .map(({ candidate }) => candidate);
  const act = (face, action, note) => {
    onFaceAction?.(face.assetId, { faceId: face.faceId, ...action });
    setResolved((map) => ({ ...map, [`${face.assetId}:${face.faceId}`]: note }));
    setNaming(null);
    setMessage(note);
  };
  const open = faces.filter((face) => !resolved[`${face.assetId}:${face.faceId}`]);
  return (
    <aside
      className="pd-fix"
      ref={panel}
      role="dialog"
      aria-labelledby="pd-fix-title"
      aria-modal="false"
    >
      <header className="pd-fix-header">
        <div>
          <h2 id="pd-fix-title" ref={heading} tabIndex={-1}>
            Fix incorrect match
          </h2>
          <p>
            Faces grouped as {displayName(person)}. Move any that belong to
            someone else.
          </p>
        </div>
        <Button aria-label="Close fix incorrect match" icon="mdiClose" onClick={close} />
      </header>
      <ul className="pd-fix-list">
        {faces.map((face) => {
          const asset = assetFor(face.assetId);
          const key = `${face.assetId}:${face.faceId}`;
          if (!asset) return null;
          const done = resolved[key];
          const isNaming = naming === key;
          return (
            <li className={`pd-fix-row ${done ? "is-done" : ""}`} key={key}>
              <button
                type="button"
                className="pd-fix-thumb"
                aria-label={`Open ${asset.name}`}
                onClick={() => onOpenAsset?.(asset.id)}
              >
                {face.box ? (
                  <FaceCrop src={asset.image} box={face.box} size={56} />
                ) : (
                  <img src={asset.image} alt="" loading="lazy" />
                )}
              </button>
              <div className="pd-fix-copy">
                <strong>{asset.name}</strong>
                <span>
                  {shortDate(asset)}
                  {face.box ? " · Tagged face" : " · Recognized"}
                </span>
                {done && <em>{done}</em>}
              </div>
              {!done && !isNaming && (
                <PersonMenu
                  className="pd-fix-menu"
                  buttonClassName="pd-fix-menu-button"
                  label={`Not this person in ${asset.name}`}
                  items={[
                    ...others.map((candidate) => ({
                      id: `assign-${candidate.id}`,
                      label: `This is ${displayName(candidate)}`,
                      icon: "mdiAccountOutline",
                      onSelect: () =>
                        act(
                          face,
                          { type: "reassign", personId: candidate.id },
                          `Moved to ${displayName(candidate)}`,
                        ),
                    })),
                    ...(others.length ? ["separator"] : []),
                    {
                      id: "new",
                      label: "Someone new…",
                      icon: "mdiAccountPlusOutline",
                      onSelect: () => setNaming(key),
                    },
                    {
                      id: "remove",
                      label: "Not a face of anyone",
                      icon: "mdiAccountOffOutline",
                      danger: true,
                      onSelect: () =>
                        act(face, { type: "remove" }, "Removed from this person"),
                    },
                  ]}
                >
                  <Icon name="mdiAccountEditOutline" size={16} />
                  <span>Not this person</span>
                </PersonMenu>
              )}
              {isNaming && (
                <PersonNameEditor
                  className="pd-fix-naming"
                  person={{ id: `new-${face.faceId || face.assetId}`, name: "" }}
                  people={people}
                  placeholder="New person's name"
                  label="Name for the new person"
                  onCommit={(name) =>
                    act(face, { type: "new-person", name }, `Moved to ${name}`)
                  }
                  onCancel={() => setNaming(null)}
                />
              )}
            </li>
          );
        })}
      </ul>
      {faces.length === 0 && (
        <p className="people-empty">No faces are grouped under this person.</p>
      )}
      <footer className="pd-fix-footer">
        <span role="status" aria-live="polite">
          {message || (open.length ? `${plural(open.length, "face")} to review` : "All reviewed")}
        </span>
        <Button primary onClick={close}>
          Done
        </Button>
      </footer>
    </aside>
  );
}

export function PersonHeader({
  person,
  assets = [],
  overrides,
  onChange,
  allPeople = [],
  onOpenSettings,
  onOpenAsset,
  onSelectFeatured,
  faces = [],
  onFaceAction,
  onBack,
}) {
  const [editing, setEditing] = useState(false);
  const [dialog, setDialog] = useState(null);
  const [fixOpen, setFixOpen] = useState(false);
  const [status, setStatus] = useState("");
  const [local, setLocal] = useState(() => overrides || {});
  const phone = usePhoneLayout();
  const current = onChange ? overrides || {} : local;
  const change = (next, message) => {
    if (onChange) onChange(next);
    else setLocal(next);
    if (message) setStatus(message);
  };
  if (!person?.id) return null;
  const people = applyPeopleOverrides(
    [person, ...allPeople.filter((candidate) => candidate.id !== person?.id)],
    current,
  );
  const applied =
    people.find((candidate) => candidate.id === person?.id) ||
    applyPeopleOverrides([person], current, { samples: false })[0] ||
    person;
  const library = remapAssetPeople(assets, current);
  const owned = personAssets(applied, library);
  const featured = featuredAsset(applied, owned);
  const faceList = personFaces(applied, owned, faces);
  const featuredFace =
    featured && faceList.find((face) => face.assetId === featured.id && face.box);
  const name = displayName(applied);
  const unnamed = isUnnamed(applied);
  const age = applied.birthday ? ageAt(applied.birthday) : null;
  const photos = owned.filter((asset) => asset.type !== "video").length,
    videos = owned.length - photos;
  const countLabel = [
    photos ? plural(photos, "photo") : "",
    videos ? plural(videos, "video") : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const avatar =
    applied.featuredAssetId && featured?.id === applied.featuredAssetId ? (
      featuredFace ? (
        <FaceCrop src={featured.image} box={featuredFace.box} size={phone ? 96 : 128} />
      ) : (
        <PersonAvatar
          person={{ ...applied, image: featured.image, faceBox: null }}
          size={phone ? 96 : 128}
        />
      )
    ) : (
      <PersonAvatar person={applied} size={phone ? 96 : 128} />
    );
  const actions = [
    {
      id: "featured",
      label: "Featured photo",
      icon: "mdiImageOutline",
      onClick: () => setDialog("featured"),
      disabled: owned.length === 0,
    },
    {
      id: "merge",
      label: "Merge people",
      icon: "mdiCallMerge",
      onClick: () => setDialog("merge"),
      disabled: people.length < 2,
    },
    {
      id: "birthday",
      label: applied.birthday ? "Date of birth" : "Set date of birth",
      icon: "mdiCakeVariantOutline",
      onClick: () => setDialog("birthday"),
    },
    {
      id: "hide",
      label: applied.hidden ? "Unhide" : "Hide",
      icon: applied.hidden ? "mdiEyeOutline" : "mdiEyeOffOutline",
      onClick: () =>
        change(
          togglePersonFlag(current, applied.id, "hidden", !applied.hidden),
          applied.hidden
            ? `${name} is shown on the People page again.`
            : `${name} is hidden from the People page. Their photos stay in the library.`,
        ),
    },
    {
      id: "favorite",
      label: applied.favorite ? "Unfavorite" : "Favorite",
      icon: applied.favorite ? "mdiHeart" : "mdiHeartOutline",
      onClick: () =>
        change(
          togglePersonFlag(current, applied.id, "favorite", !applied.favorite),
          applied.favorite
            ? `${name} removed from favorites.`
            : `${name} added to favorites.`,
        ),
    },
    {
      id: "fix",
      label: "Fix incorrect match",
      icon: "mdiFaceRecognition",
      onClick: () => setFixOpen(true),
      disabled: owned.length === 0,
    },
    {
      id: "groups",
      label: "Recognition groups",
      icon: "mdiAccountGroupOutline",
      onClick: () => onOpenSettings?.("recognition-groups"),
      disabled: !onOpenSettings,
    },
  ];

  return (
    <section className={`pd-hero ${phone ? "is-phone" : ""}`} aria-label={`${name} details`}>
      {featured && !phone && (
        <div
          className="pd-backdrop"
          style={{ backgroundImage: `url(${featured.image})` }}
          aria-hidden="true"
        />
      )}
      <div className="pd-hero-content">
        {onBack && (
          <Button
            className="pd-back"
            icon="mdiArrowLeft"
            aria-label="Back to people"
            onClick={onBack}
          />
        )}
        <button
          type="button"
          className="pd-avatar"
          aria-label={`Select featured photo for ${name}`}
          disabled={owned.length === 0}
          onClick={() => setDialog("featured")}
        >
          {avatar}
          <span className="pd-avatar-edit" aria-hidden="true">
            <Icon name="mdiCameraOutline" size={16} />
          </span>
          {applied.favorite && (
            <span className="pl-badge pl-badge-favorite" title="Favorite">
              <Icon name="mdiHeart" size={14} />
            </span>
          )}
        </button>
        <div className="pd-identity">
          {editing ? (
            <PersonNameEditor
              className="pd-name-editor"
              person={applied}
              people={people}
              placeholder={unnamed ? "Add a name" : "Name"}
              onCommit={(next) => {
                change(
                  setPersonName(current, applied.id, next),
                  unnamed ? `Named this person ${next}.` : `Renamed to ${next}.`,
                );
                setEditing(false);
              }}
              onCancel={() => setEditing(false)}
            />
          ) : (
            <button
              type="button"
              className={`pd-name ${unnamed ? "is-unnamed" : ""}`}
              aria-label={unnamed ? "Add a name" : `Rename ${name}`}
              onClick={() => setEditing(true)}
            >
              <h1>{unnamed ? "Add a name" : name}</h1>
              <Icon name="mdiPencilOutline" size={16} />
            </button>
          )}
          <div className="pd-facts">
            <span className="pd-fact">
              <Icon name="mdiImageMultipleOutline" size={15} />
              {countLabel || "No photos yet"}
            </span>
            <button
              type="button"
              className="pd-fact pd-fact-link"
              onClick={() => setDialog("birthday")}
            >
              <Icon name="mdiCakeVariantOutline" size={15} />
              {applied.birthday
                ? `Born ${formatBirthday(applied.birthday)}${age !== null ? ` · ${plural(age, "year")} old` : ""}`
                : "Add date of birth"}
            </button>
            {applied.hidden && (
              <span className="pd-fact pd-fact-flag">
                <Icon name="mdiEyeOffOutline" size={15} />
                Hidden from People
              </span>
            )}
          </div>
        </div>
        <div className="pd-actions" role="toolbar" aria-label={`Actions for ${name}`}>
          {actions.map((action) => (
            <Button
              key={action.id}
              icon={action.icon}
              disabled={action.disabled}
              active={action.id === "fix" && fixOpen}
              onClick={action.onClick}
            >
              {action.label}
            </Button>
          ))}
        </div>
      </div>
      <p className="pd-status" role="status" aria-live="polite">
        {status}
      </p>
      {dialog === "featured" && (
        <FeaturedPhotoDialog
          person={applied}
          assets={owned}
          faces={faceList}
          close={() => setDialog(null)}
          onSelect={(assetId) => {
            change(
              setFeaturedAsset(current, applied.id, assetId),
              "Featured photo updated.",
            );
            onSelectFeatured?.(assetId);
            setDialog(null);
          }}
        />
      )}
      {dialog === "merge" && (
        <MergePeopleDialog
          person={applied}
          people={people}
          assets={library}
          close={() => setDialog(null)}
          onMerge={(intoId) => {
            const target = people.find((candidate) => candidate.id === intoId);
            change(
              mergePeople(current, applied.id, intoId, people),
              `Merged ${name} into ${displayName(target)}.`,
            );
            setDialog(null);
          }}
        />
      )}
      {dialog === "birthday" && (
        <BirthdayDialog
          person={applied}
          close={() => setDialog(null)}
          onSave={(birthday) => {
            change(
              setBirthday(current, applied.id, birthday),
              birthday ? "Date of birth saved." : "Date of birth removed.",
            );
            setDialog(null);
          }}
        />
      )}
      {fixOpen && (
        <FixMatchPanel
          person={applied}
          faces={faceList}
          assets={owned}
          people={people}
          onFaceAction={onFaceAction}
          onOpenAsset={onOpenAsset}
          close={() => setFixOpen(false)}
        />
      )}
    </section>
  );
}
