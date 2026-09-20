import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { PersonAvatar } from "./People";
import { Icon } from "./Icon";
import {
  canTagAsset,
  faceSourceKey,
  normalizeFaces,
  imageContentRect,
  imagePoint,
  boxFromPoints,
  adjustFaceBox,
  moveFaceBox,
  faceId,
  personId,
} from "./face-tags.mjs";
import "./face-tagger.css";

const copy = (value) => structuredClone(value);
const percent = (value) => Math.round(value * 1000) / 10;
const labelFor = (face, people) =>
  people.find((person) => person.id === face.personId)?.name ||
  "Choose a person";
export function FaceTagger(props) {
  const available = canTagAsset(props.asset, {
    actorId: props.actorId,
    unlocked: props.unlocked,
  });
  const close = useRef(props.onClose);
  close.current = props.onClose;
  useEffect(() => {
    if (!available) close.current?.();
  }, [available]);
  return available ? (
    <FaceTagEditor key={faceSourceKey(props.asset)} {...props} />
  ) : null;
}
function FaceTagEditor({
  asset,
  people = [],
  faces = [],
  revision = 0,
  onSave,
  onClose,
}) {
  const [loaded] = useState(() => {
    try {
      return { faces: normalizeFaces(faces), error: "" };
    } catch (error) {
      return { faces: [], error: error.message };
    }
  });
  const [draft, setDraft] = useState(loaded.faces),
    [addedPeople, setAddedPeople] = useState([]),
    [selectedId, setSelectedId] = useState(loaded.faces[0]?.id || null);
  const [capturedRevision, setCapturedRevision] = useState(revision),
    [drawing, setDrawing] = useState(loaded.faces.length === 0),
    [preview, setPreview] = useState(null),
    [history, setHistory] = useState([]);
  const [query, setQuery] = useState(""),
    [newName, setNewName] = useState(""),
    [showNew, setShowNew] = useState(false),
    [error, setError] = useState(loaded.error),
    [saving, setSaving] = useState(false);
  const [natural, setNatural] = useState(null),
    [viewport, setViewport] = useState({ width: 0, height: 0 }),
    [imageFailed, setImageFailed] = useState(false);
  const dialog = useRef(null),
    stage = useRef(null),
    image = useRef(null),
    first = useRef(null),
    search = useRef(null),
    gesture = useRef(null),
    alive = useRef(false),
    latest = useRef(null);
  latest.current = { draft, addedPeople, onClose, onSave, revision };
  const source = asset.fullSrc || asset.image || asset.src,
    sourceKey = faceSourceKey(asset),
    content = imageContentRect(viewport, natural);
  const candidates = [
    ...people,
    ...addedPeople.filter(
      (person) => !people.some((existing) => existing.id === person.id),
    ),
  ];
  const selected = draft.find((face) => face.id === selectedId),
    matched = candidates.filter((person) =>
      person.name
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase()),
    );
  const changed =
    JSON.stringify(draft) !== JSON.stringify(loaded.faces) ||
    addedPeople.length > 0;
  const stale = revision !== capturedRevision;
  const valid =
    !!natural &&
    !imageFailed &&
    !loaded.error &&
    draft.every(
      (face) =>
        face.personId &&
        candidates.some((person) => person.id === face.personId),
    );
  useLayoutEffect(() => {
    const previous = document.activeElement,
      overflow = document.body.style.overflow,
      element = dialog.current;
    alive.current = true;
    document.body.style.overflow = "hidden";
    if (typeof element.showModal === "function") element.showModal();
    else element.setAttribute("open", "");
    first.current?.focus();
    return () => {
      alive.current = false;
      gesture.current = null;
      document.body.style.overflow = overflow;
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  useLayoutEffect(() => {
    const measure = () => {
      const rect = stage.current?.getBoundingClientRect();
      if (rect)
        setViewport((current) =>
          current.width === rect.width && current.height === rect.height
            ? current
            : { width: rect.width, height: rect.height },
        );
    };
    measure();
    const observer =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(measure)
        : null;
    observer?.observe(stage.current);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);
  const checkpoint = (before = draft) =>
    setHistory((rows) => [...rows, copy(before)].slice(-30));
  function change(next) {
    checkpoint();
    setDraft(next);
    setError("");
  }
  function setBox(id, box) {
    change(draft.map((face) => (face.id === id ? { ...face, box } : face)));
  }
  function addBox(box = { x: 0.35, y: 0.3, width: 0.2, height: 0.25 }) {
    if (!natural || saving || draft.length >= 100) return;
    const next = { id: faceId(), personId: "", box };
    change([...draft, next]);
    setSelectedId(next.id);
    setDrawing(false);
    setQuery("");
    search.current?.focus();
  }
  function point(event, clampToImage = false) {
    return imagePoint(
      event.clientX,
      event.clientY,
      stage.current.getBoundingClientRect(),
      content,
      { clampToImage },
    );
  }
  function start(event, mode = "draw", face) {
    if (event.button > 0 || !content || saving || (!drawing && mode === "draw"))
      return;
    const origin = point(event);
    if (!origin) return;
    if (mode === "draw" && draft.length >= 100) {
      setError("Use no more than 100 face regions per image.");
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    stage.current.setPointerCapture?.(event.pointerId);
    gesture.current = {
      mode,
      origin,
      before: copy(draft),
      face: face && copy(face),
      pointerId: event.pointerId,
    };
    if (face) setSelectedId(face.id);
    setPreview(null);
    setError("");
  }
  function move(event) {
    const active = gesture.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const end = point(event, true);
    if (!end) return;
    if (active.mode === "draw") {
      const box = boxFromPoints(active.origin, end);
      active.box = box;
      setPreview(box);
      return;
    }
    const box =
      active.mode === "move"
        ? moveFaceBox(
            active.face.box,
            end.x - active.origin.x,
            end.y - active.origin.y,
          )
        : adjustFaceBox(
            adjustFaceBox(active.face.box, "width", end.x - active.face.box.x),
            "height",
            end.y - active.face.box.y,
          );
    active.box = box;
    setDraft(
      active.before.map((face) =>
        face.id === active.face.id ? { ...face, box } : face,
      ),
    );
  }
  function finish(event) {
    const active = gesture.current;
    if (!active || active.pointerId !== event.pointerId) return;
    move(event);
    gesture.current = null;
    stage.current.releasePointerCapture?.(event.pointerId);
    setPreview(null);
    if (active.mode === "draw") {
      if (active.box) addBox(active.box);
      else
        setError(
          "Draw a larger region around the face, or use Add face with the position controls.",
        );
    } else if (
      active.box &&
      JSON.stringify(active.box) !== JSON.stringify(active.face.box)
    )
      checkpoint(active.before);
  }
  function cancelGesture() {
    const active = gesture.current;
    if (!active) return false;
    setDraft(active.before);
    gesture.current = null;
    setPreview(null);
    return true;
  }
  function choose(person) {
    if (!selected || saving) return;
    change(
      draft.map((face) =>
        face.id === selected.id ? { ...face, personId: person.id } : face,
      ),
    );
    setShowNew(false);
  }
  function createPerson(event) {
    event.preventDefault();
    if (!selected || saving) return;
    const name = newName.trim();
    if (!name || name.length > 120 || /[\u0000-\u001f]/.test(name)) {
      setError("Enter a name of up to 120 characters.");
      return;
    }
    if (
      candidates.some(
        (person) =>
          person.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase(),
      )
    ) {
      setError(
        "This name is already in your people list. Choose the existing person.",
      );
      return;
    }
    const person = { id: personId(), name };
    setAddedPeople((rows) => [...rows, person]);
    choose(person);
    setNewName("");
    setQuery("");
  }
  async function save() {
    if (!valid || saving || stale || typeof onSave !== "function") return;
    try {
      const next = normalizeFaces(draft),
        used = new Set(next.map((face) => face.personId));
      setSaving(true);
      setError("");
      const result = await latest.current.onSave(next, {
        newPeople: addedPeople.filter((person) => used.has(person.id)),
        expectedRevision: capturedRevision,
        imageWidth: natural.width,
        imageHeight: natural.height,
        sourceKey,
      });
      if (!alive.current) return;
      if (result === false) {
        setError("Face tags could not be saved. Your changes are still here.");
        setSaving(false);
        return;
      }
      latest.current.onClose?.();
    } catch (error) {
      if (alive.current) {
        setSaving(false);
        setError(
          error.message ||
            "Face tags could not be saved. Your changes are still here.",
        );
      }
    }
  }
  function keyboard(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      if (!cancelGesture() && !saving) onClose?.();
      return;
    }
    if (event.key === "Tab") {
      const items = [
        ...dialog.current.querySelectorAll(
          'button:not(:disabled),input:not(:disabled),[tabindex="0"]',
        ),
      ];
      if (event.shiftKey && document.activeElement === items[0]) {
        event.preventDefault();
        items.at(-1)?.focus();
      } else if (!event.shiftKey && document.activeElement === items.at(-1)) {
        event.preventDefault();
        items[0]?.focus();
      }
      return;
    }
    if (event.target.closest("input,textarea") || saving || !selected) return;
    if (
      !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(
        event.key,
      ) ||
      event.ctrlKey ||
      event.metaKey
    )
      return;
    event.preventDefault();
    const amount = event.shiftKey ? 0.02 : 0.005,
      dx =
        event.key === "ArrowLeft"
          ? -amount
          : event.key === "ArrowRight"
            ? amount
            : 0,
      dy =
        event.key === "ArrowUp"
          ? -amount
          : event.key === "ArrowDown"
            ? amount
            : 0;
    const box = event.altKey
      ? adjustFaceBox(
          adjustFaceBox(selected.box, "width", selected.box.width + dx),
          "height",
          selected.box.height + dy,
        )
      : moveFaceBox(selected.box, dx, dy);
    setBox(selected.id, box);
  }
  function loadLatest() {
    try {
      const next = normalizeFaces(faces);
      setDraft(next);
      setAddedPeople([]);
      setSelectedId(next[0]?.id || null);
      setHistory([]);
      setCapturedRevision(revision);
      setError("");
    } catch (error) {
      setError(error.message);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="face-tagger"
      aria-label="Tag people"
      onKeyDown={keyboard}
      onCancel={(event) => {
        event.preventDefault();
        if (!saving) onClose?.();
      }}
    >
      <header className="ft-header">
        <div>
          <h2>Tag people</h2>
          <p>
            {asset.name || asset.originalFileName || "Photo"}
            {asset.type === "video" ? " · Video preview" : ""}
          </p>
        </div>
        <button
          type="button"
          ref={first}
          className="ft-icon"
          aria-label="Close face tagging"
          disabled={saving}
          onClick={onClose}
        >
          <Icon name="mdiClose" />
        </button>
      </header>
      <div className="ft-layout">
        <section className="ft-photo-panel" aria-label="Face regions">
          <div className="ft-toolbar">
            <button
              type="button"
              className={drawing ? "active" : ""}
              aria-pressed={drawing}
              disabled={!natural || saving}
              onClick={() => {
                setDrawing((value) => !value);
                setError("");
              }}
            >
              Draw face
            </button>
            <button
              type="button"
              disabled={!natural || saving || draft.length >= 100}
              onClick={() => addBox()}
            >
              Add face
            </button>
            <button
              type="button"
              disabled={!history.length || saving}
              onClick={() => {
                const previous = history.at(-1);
                setDraft(previous);
                setHistory((rows) => rows.slice(0, -1));
                setSelectedId(previous[0]?.id || null);
                setError("");
              }}
            >
              Undo
            </button>
            <span>
              {draft.length} {draft.length === 1 ? "face" : "faces"}
            </span>
          </div>
          <div
            ref={stage}
            className={`ft-stage ${drawing ? "drawing" : ""}`}
            tabIndex={0}
            aria-label="Photo face regions"
            aria-describedby="ft-coordinate-help"
            onPointerDown={(event) => start(event)}
            onPointerMove={move}
            onPointerUp={finish}
            onPointerCancel={cancelGesture}
          >
            {!imageFailed ? (
              <img
                ref={image}
                src={source}
                alt={asset.name || "Photo for face tagging"}
                draggable="false"
                onLoad={(event) => {
                  const element = event.currentTarget;
                  if (element.naturalWidth > 0 && element.naturalHeight > 0) {
                    setNatural({
                      width: element.naturalWidth,
                      height: element.naturalHeight,
                    });
                    const rect = stage.current.getBoundingClientRect();
                    setViewport({ width: rect.width, height: rect.height });
                  }
                }}
                onError={() => {
                  setImageFailed(true);
                  setNatural(null);
                  setError(
                    "The image could not be loaded. Reopen it before tagging faces.",
                  );
                }}
              />
            ) : (
              <p className="ft-image-error">Image unavailable</p>
            )}
            {content && (
              <div
                className="ft-image-plane"
                style={{
                  left: content.left,
                  top: content.top,
                  width: content.width,
                  height: content.height,
                }}
              >
                {draft.map((face, index) => (
                  <div
                    key={face.id}
                    className={`ft-face-box ${face.id === selectedId ? "selected" : ""}`}
                    style={{
                      left: `${face.box.x * 100}%`,
                      top: `${face.box.y * 100}%`,
                      width: `${face.box.width * 100}%`,
                      height: `${face.box.height * 100}%`,
                    }}
                  >
                    <button
                      type="button"
                      className="ft-face-move"
                      aria-label={`Face ${index + 1}: ${labelFor(face, candidates)}`}
                      aria-pressed={face.id === selectedId}
                      disabled={saving}
                      onClick={() => {
                        setSelectedId(face.id);
                        setDrawing(false);
                      }}
                      onPointerDown={(event) => start(event, "move", face)}
                    >
                      <span>
                        {index + 1} · {labelFor(face, candidates)}
                      </span>
                    </button>
                    {face.id === selectedId && (
                      <button
                        type="button"
                        className="ft-resize"
                        aria-label={`Resize face ${index + 1}`}
                        disabled={saving}
                        onPointerDown={(event) => start(event, "resize", face)}
                        title="Drag to resize; Alt + arrow keys also resize"
                      />
                    )}
                  </div>
                ))}
                {preview && (
                  <div
                    className="ft-drawing-box"
                    style={{
                      left: `${preview.x * 100}%`,
                      top: `${preview.y * 100}%`,
                      width: `${preview.width * 100}%`,
                      height: `${preview.height * 100}%`,
                    }}
                  />
                )}
              </div>
            )}
          </div>
          <p id="ft-coordinate-help" className="ft-help">
            {drawing
              ? "Drag around a face in the photo, or choose Add face and enter its position."
              : "Select a region to move or resize it. Arrow keys move; Alt + arrows resize; Shift makes larger steps."}
          </p>
        </section>
        <aside className="ft-sidebar" aria-label="Face details">
          <div className="ft-face-list" aria-label="Faces in this image">
            {draft.map((face, index) => (
              <button
                type="button"
                key={face.id}
                className={face.id === selectedId ? "active" : ""}
                aria-pressed={face.id === selectedId}
                onClick={() => {
                  setSelectedId(face.id);
                  setDrawing(false);
                }}
              >
                <span>{index + 1}</span>
                {labelFor(face, candidates)}
              </button>
            ))}
          </div>
          {selected ? (
            <>
              <section className="ft-position">
                <div className="ft-section-title">
                  <h3>Face position</h3>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => {
                      change(draft.filter((face) => face.id !== selected.id));
                      setSelectedId(
                        draft.find((face) => face.id !== selected.id)?.id ||
                          null,
                      );
                    }}
                  >
                    Remove face
                  </button>
                </div>
                <div className="ft-coordinates">
                  {[
                    ["x", "Left (%)"],
                    ["y", "Top (%)"],
                    ["width", "Width (%)"],
                    ["height", "Height (%)"],
                  ].map(([key, label]) => (
                    <label key={key}>
                      {label}
                      <input
                        type="number"
                        aria-label={label}
                        step="0.1"
                        min={key === "width" || key === "height" ? "0.5" : "0"}
                        max="100"
                        value={percent(selected.box[key])}
                        disabled={saving}
                        onChange={(event) => {
                          if (event.target.value !== "")
                            setBox(
                              selected.id,
                              adjustFaceBox(
                                selected.box,
                                key,
                                Number(event.target.value) / 100,
                              ),
                            );
                        }}
                      />
                    </label>
                  ))}
                </div>
                <p>
                  Position is measured within the full image, excluding empty
                  margins.
                </p>
              </section>
              <section className="ft-assign">
                <h3>Who is this?</h3>
                <input
                  ref={search}
                  type="search"
                  aria-label="Find a person"
                  placeholder="Find a person"
                  value={query}
                  disabled={saving}
                  onChange={(event) => setQuery(event.target.value)}
                />
                <div className="ft-person-list">
                  {matched.slice(0, 100).map((person) => (
                    <button
                      type="button"
                      key={person.id}
                      disabled={saving}
                      aria-pressed={selected.personId === person.id}
                      className={
                        selected.personId === person.id ? "active" : ""
                      }
                      onClick={() => choose(person)}
                    >
                      <PersonAvatar person={person} size={36} />
                      <span>{person.name}</span>
                      {selected.personId === person.id && (
                        <Icon name="mdiCheck" size={17} />
                      )}
                    </button>
                  ))}
                  {!matched.length && <p>No matching people.</p>}
                  {matched.length > 100 && (
                    <p>Keep typing to narrow the list.</p>
                  )}
                </div>
                <button
                  type="button"
                  className="ft-new-person"
                  disabled={saving}
                  aria-expanded={showNew}
                  onClick={() => {
                    setShowNew((value) => !value);
                    setNewName(query);
                  }}
                >
                  Create person
                </button>
                {showNew && (
                  <form className="ft-create-person" onSubmit={createPerson}>
                    <label>
                      Person name
                      <input
                        type="text"
                        aria-label="New person name"
                        maxLength={120}
                        value={newName}
                        onChange={(event) => setNewName(event.target.value)}
                        disabled={saving}
                      />
                    </label>
                    <button type="submit" disabled={!newName.trim() || saving}>
                      Create and assign
                    </button>
                  </form>
                )}
              </section>
            </>
          ) : (
            <div className="ft-empty">
              <h3>Add a missing face</h3>
              <p>
                Draw around their face, then choose an existing person or create
                someone new.
              </p>
            </div>
          )}
        </aside>
      </div>
      {stale && (
        <div className="ft-message" role="alert">
          Face tags changed in another view.{" "}
          <button type="button" onClick={loadLatest} disabled={saving}>
            Discard changes and load latest
          </button>
        </div>
      )}
      {error && (
        <div className="ft-message error" role="alert">
          {error}
        </div>
      )}
      <footer className="ft-footer">
        <span>
          {draft.some((face) => !face.personId)
            ? "Choose a person for every face."
            : changed
              ? "Changes are ready to save."
              : "Manual face regions"}
        </span>
        <button type="button" disabled={saving} onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="ft-save"
          disabled={!valid || saving || stale || typeof onSave !== "function"}
          onClick={save}
        >
          {saving ? "Saving…" : "Save face tags"}
        </button>
      </footer>
    </dialog>
  );
}
