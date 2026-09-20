import React, { useEffect, useMemo, useState } from "react";
import { Button, Dialog } from "./App";
import { Icon } from "./Icon";
import {
  loadResourceState,
  subscribeResourceState,
} from "./account-library-data.mjs";
import { applyLockedRules } from "./locked-rules.mjs";
import { lockedAccessSnapshot } from "./locked-content.mjs";
import {
  parseUtilities,
  utilityStorageKey,
  formatBytes,
} from "./utilities-data.mjs";
import {
  deriveTrashRows,
  reviewTrashAction,
  applyTrashAction,
} from "./trash-data.mjs";
import "./trash-manager.css";
const read = () => parseUtilities(localStorage.getItem(utilityStorageKey));
export function TrashManager({
  scope = "all",
  showLocked = false,
  settings = {},
  onNavigate = () => {},
}) {
  const [state, setState] = useState(() => {
    try {
      return read();
    } catch {
      return parseUtilities(null);
    }
  });
  const [resources, setResources] = useState(loadResourceState);
  useEffect(() => subscribeResourceState(setResources), []);
  const preferences = resources.users.find(
    (user) => user.id === "taylor",
  )?.preferences;
  const access = lockedAccessSnapshot(resources);
  const revealed = showLocked && access.available && access.pinEnabled;
  const currentUnlock = () => {
    const latest = lockedAccessSnapshot(loadResourceState());
    return (
      revealed &&
      latest.available &&
      latest.pinEnabled &&
      latest.token === access.token
    );
  };
  const permittedState = useMemo(
    () => ({ ...state, rows: applyLockedRules(state.rows, preferences) }),
    [state, preferences],
  );
  const readCurrent = () => {
    const current = read();
    const owner = loadResourceState().users.find(
      (user) => user.id === "taylor",
    );
    return {
      ...current,
      rows: applyLockedRules(current.rows, owner?.preferences),
    };
  };
  const [query, setQuery] = useState(""),
    [type, setType] = useState("all"),
    [sort, setSort] = useState("recent");
  const [selected, setSelected] = useState([]),
    [review, setReview] = useState(null),
    [confirmation, setConfirmation] = useState("");
  const [inspect, setInspect] = useState(null),
    [notice, setNotice] = useState(""),
    [error, setError] = useState("");
  const ownScope = scope === "all" || scope === "taylor";
  const all = useMemo(
    () =>
      deriveTrashRows(permittedState.rows, {
        owner: scope,
        actorId: "taylor",
        unlocked: revealed,
      }),
    [permittedState.rows, scope, revealed],
  );
  const rows = useMemo(
    () =>
      deriveTrashRows(permittedState.rows, {
        owner: scope,
        actorId: "taylor",
        query,
        type,
        unlocked: revealed,
      }).sort((a, b) =>
        sort === "size"
          ? b.bytes - a.bytes
          : sort === "name"
            ? a.name.localeCompare(b.name)
            : (Date.parse(b.trashedAt) || 0) - (Date.parse(a.trashedAt) || 0),
      ),
    [permittedState.rows, scope, query, type, sort, revealed],
  );
  const chosen = rows.filter((row) => selected.includes(row.id));
  useEffect(() => {
    setSelected([]);
    setReview(null);
    setInspect(null);
    setConfirmation("");
    setError("");
    setNotice("");
  }, [scope, query, type, revealed, preferences]);
  useEffect(() => {
    const sync = (event) => {
      if (event.key === utilityStorageKey || event.key === null) {
        try {
          setState(read());
        } catch {
          setError(
            "Trash could not be refreshed. Try again before making changes.",
          );
        }
      }
    };
    addEventListener("storage", sync);
    return () => removeEventListener("storage", sync);
  }, []);
  function persist(next, message) {
    localStorage.setItem(utilityStorageKey, JSON.stringify(next));
    window.dispatchEvent(new Event("frameleaf:utilities-changed"));
    setState(next);
    setSelected([]);
    setNotice(message);
    setError("");
    setReview(null);
    setConfirmation("");
    setInspect(null);
  }
  function restore(targets) {
    if (!targets.length || !ownScope) return;
    try {
      const snapshot = reviewTrashAction(permittedState, {
        action: "restore",
        ids: targets.map((row) => row.id),
        actorId: "taylor",
        unlocked: currentUnlock(),
      });
      persist(
        applyTrashAction(readCurrent(), {
          ...snapshot,
          unlocked: currentUnlock(),
        }),
        `Restored ${snapshot.count} item${snapshot.count === 1 ? "" : "s"} to your library.`,
      );
    } catch (error) {
      setError(error.message || "Changes could not be saved. Try again.");
    }
  }
  function prepare(action) {
    if (!ownScope) return;
    try {
      const snapshot = reviewTrashAction(permittedState, {
        action,
        ids: chosen.map((row) => row.id),
        actorId: "taylor",
        unlocked: currentUnlock(),
      });
      setReview({
        ...snapshot,
        names: state.rows
          .filter((row) => snapshot.ids.includes(row.id))
          .map((row) => row.name),
      });
      setConfirmation("");
      setError("");
    } catch (error) {
      setError(error.message);
    }
  }
  function remove() {
    if (!review || confirmation !== `DELETE ${review.count}` || !ownScope)
      return;
    try {
      persist(
        applyTrashAction(readCurrent(), {
          ...review,
          confirmed: true,
          unlocked: currentUnlock(),
        }),
        `Permanently deleted ${review.count} item${review.count === 1 ? "" : "s"} from your trash.`,
      );
    } catch (error) {
      setError(error.message || "Changes could not be saved. Try again.");
    }
  }
  function toggle(id) {
    setSelected((previous) =>
      previous.includes(id)
        ? previous.filter((value) => value !== id)
        : [...previous, id],
    );
  }
  const days = Number.isFinite(Number(settings.trashDays))
    ? Number(settings.trashDays)
    : 30;
  return (
    <section className="trash-manager" aria-label="Your trash">
      {!ownScope ? (
        <div className="tm-empty">
          <Icon name="mdiShieldLockOutline" size={36} />
          <h2>Trash is private to each account</h2>
          <p>
            Select your own account or all accounts to manage your trash. Other
            accounts’ items are not shown here.
          </p>
        </div>
      ) : (
        <>
          <div className="tm-summary">
            <div>
              <strong>{all.length.toLocaleString()}</strong>
              <span>items in your trash</span>
            </div>
            <div>
              <strong>
                {formatBytes(all.reduce((n, row) => n + row.bytes, 0))}
              </strong>
              <span>original file sizes</span>
            </div>
            <div>
              <strong>
                {settings.trashEnabled === false ? "Disabled" : `${days} days`}
              </strong>
              <span>
                {settings.trashEnabled === false
                  ? "trash recovery for new deletions"
                  : "automatic retention window"}
              </span>
            </div>
          </div>
          <p className="tm-retention">
            {settings.trashEnabled === false
              ? "Trash protection is off for new deletions. Existing items remain available here until the server removes them."
              : `Items are eligible for permanent deletion after ${days} days in trash.`}{" "}
            File sizes do not indicate how much disk space will be freed;
            originals still referenced elsewhere are retained.
          </p>
          <div className="tm-toolbar">
            <label>
              Find in trash
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search filenames"
              />
            </label>
            <label>
              Media
              <select
                value={type}
                onChange={(event) => setType(event.target.value)}
              >
                <option value="all">Photos & videos</option>
                <option value="image">Photos</option>
                <option value="video">Videos</option>
              </select>
            </label>
            <label>
              Sort
              <select
                value={sort}
                onChange={(event) => setSort(event.target.value)}
              >
                <option value="recent">Recently deleted</option>
                <option value="size">Largest first</option>
                <option value="name">Filename</option>
              </select>
            </label>
            <Button onClick={() => onNavigate("storage", "retention")}>
              Retention settings
            </Button>
          </div>
          {error && !review && (
            <p role="alert" className="tm-error">
              {error}
            </p>
          )}
          {notice && (
            <div className="tm-notice" role="status">
              <Icon name="mdiCheckCircleOutline" />
              <span>{notice}</span>
              <Button
                icon="mdiClose"
                aria-label="Dismiss trash message"
                onClick={() => setNotice("")}
              />
            </div>
          )}
          <div className="tm-actions">
            <label>
              <input
                type="checkbox"
                aria-label="Select all matching trash items"
                checked={
                  rows.length > 0 &&
                  rows.every((row) => selected.includes(row.id))
                }
                disabled={!rows.length}
                onChange={() =>
                  setSelected(
                    rows.every((row) => selected.includes(row.id))
                      ? []
                      : rows.map((row) => row.id),
                  )
                }
              />
              {chosen.length
                ? `${chosen.length} selected`
                : `${rows.length} matching item${rows.length === 1 ? "" : "s"}`}
            </label>
            <Button
              primary
              disabled={!chosen.length}
              onClick={() => restore(chosen)}
            >
              Restore selected ({chosen.length})
            </Button>
            <Button disabled={!chosen.length} onClick={() => prepare("delete")}>
              Delete selected ({chosen.length})
            </Button>
            {selected.length > 0 && (
              <Button onClick={() => setSelected([])}>Clear selection</Button>
            )}
          </div>
          <div className="tm-grid">
            {rows.map((row) => (
              <article
                key={row.id}
                className={selected.includes(row.id) ? "selected" : ""}
              >
                <div className="tm-photo">
                  <button
                    aria-label={`Preview ${row.name}`}
                    onClick={() => setInspect(row)}
                  >
                    <img
                      src={`/media/${row.image}.png`}
                      alt={row.name}
                      loading="lazy"
                    />
                  </button>
                  <label>
                    <input
                      type="checkbox"
                      aria-label={`Select ${row.name}`}
                      checked={selected.includes(row.id)}
                      onChange={() => toggle(row.id)}
                    />
                  </label>
                  {row.mediaType === "video" && (
                    <span>
                      <Icon name="mdiMovieOpenOutline" size={15} />
                      Video
                    </span>
                  )}
                </div>
                <div className="tm-detail">
                  <strong>{row.name}</strong>
                  <span>
                    {formatBytes(row.bytes)} ·{" "}
                    {row.mediaType === "video" ? "Video" : "Photo"}
                  </span>
                  <small>{row.deletedAgeLabel}</small>
                  <Button
                    icon="mdiBackupRestore"
                    onClick={() => restore([row])}
                  >
                    Restore
                  </Button>
                </div>
              </article>
            ))}
          </div>
          {!rows.length && (
            <div className="tm-empty">
              <Icon
                name={all.length ? "mdiMagnify" : "mdiDeleteOutline"}
                size={34}
              />
              <h2>
                {all.length ? "No matching items" : "Your trash is empty"}
              </h2>
              <p>
                {all.length
                  ? "Try another filename or media type. Your other trashed items are still available."
                  : "Deleted photos and videos will appear here during their recovery window."}
              </p>
              {all.length > 0 && (
                <Button
                  onClick={() => {
                    setQuery("");
                    setType("all");
                  }}
                >
                  Clear filters
                </Button>
              )}
            </div>
          )}
          <div className="tm-all">
            <div>
              <strong>Manage available trash</strong>
              <p>
                These actions include all {all.length} available items,
                including items hidden by the filters above. Unlock to include
                Locked content.
              </p>
            </div>
            <Button disabled={!all.length} onClick={() => restore(all)}>
              Restore all ({all.length})
            </Button>
            <Button
              className="tm-delete"
              disabled={!all.length}
              onClick={() => prepare("empty")}
            >
              Empty your trash ({all.length})
            </Button>
          </div>
        </>
      )}
      {inspect && all.some((row) => row.id === inspect.id) && (
        <Dialog
          title={inspect.name}
          close={() => setInspect(null)}
          wide
          actions={
            <>
              <Button onClick={() => setInspect(null)}>Close</Button>
              <Button primary onClick={() => restore([inspect])}>
                Restore to library
              </Button>
            </>
          }
        >
          <img
            className="tm-preview"
            src={`/media/${inspect.image}.png`}
            alt={inspect.name}
          />
          <p>
            {formatBytes(inspect.bytes)} · {inspect.deletedAgeLabel}
          </p>
        </Dialog>
      )}
      {review && review.ids.every((id) => all.some((row) => row.id === id)) && (
        <Dialog
          title={
            review.action === "empty"
              ? "Empty your trash?"
              : "Permanently delete selected items?"
          }
          close={() => {
            setReview(null);
            setError("");
          }}
          actions={
            <>
              <Button
                onClick={() => {
                  setReview(null);
                  setError("");
                }}
              >
                Cancel
              </Button>
              <Button
                className="tm-delete"
                disabled={confirmation !== `DELETE ${review.count}`}
                onClick={remove}
              >
                Permanently delete {review.count}{" "}
                {review.count === 1 ? "item" : "items"}
              </Button>
            </>
          }
        >
          <p>
            <strong>
              {review.count} item{review.count === 1 ? "" : "s"} ·{" "}
              {formatBytes(review.bytes)}
            </strong>
          </p>
          <p>
            These items cannot be restored after permanent deletion.
            {review.action === "empty"
              ? " This includes your entire trash, regardless of the current filters."
              : " Only the selected items will be deleted."}
          </p>
          <ul className="tm-delete-list">
            {review.names.slice(0, 8).map((name, index) => (
              <li key={index}>{name}</li>
            ))}
            {review.names.length > 8 && (
              <li>And {review.names.length - 8} more</li>
            )}
          </ul>
          <label className="tm-confirm">
            Type DELETE {review.count} to confirm
            <input
              aria-label="Confirm permanent deletion"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              autoComplete="off"
            />
          </label>
          {error && (
            <p role="alert" className="tm-error">
              {error}
            </p>
          )}
        </Dialog>
      )}
    </section>
  );
}
