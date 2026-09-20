import React, { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "./App";
import { Icon } from "./Icon";
import {
  deriveDuplicateGroups,
  applyDuplicateDecision,
  createDuplicateUndo,
  applyDuplicateUndo,
  nextDuplicateGroup,
} from "./duplicate-review.mjs";
import { formatBytes, ownerName } from "./utilities-data.mjs";
import "./duplicate-review.css";
const title = (group) =>
  group.rows[0]?.groupLabel ||
  group.rows[0]?.name.replace(/\.[^.]+$/, "") ||
  group.id;
const actionable = (group) => group.editable && group.openCount > 0;
const isBurst = (group) => group?.rows.some((row) => row.groupKind === "burst");
const pageSize = 48;
const imageStyle = (row) => ({
  objectPosition: row.previewPosition || "center",
  transform: row.previewScale ? `scale(${row.previewScale})` : undefined,
});
export function DuplicateReview({
  state,
  actorId = "taylor",
  owner = "all",
  query = "",
  status = "open",
  onCommit,
  readLatest,
  onOpenTrash = () => {},
}) {
  const groups = useMemo(
    () =>
      deriveDuplicateGroups(state.rows, {
        owner,
        query,
        status,
        actorId,
      }).sort((a, b) => Number(b.editable) - Number(a.editable)),
    [state.rows, owner, query, status, actorId],
  );
  const allGroups = useMemo(
    () =>
      deriveDuplicateGroups(state.rows, {
        owner,
        status: "all",
        actorId,
      }),
    [state.rows, owner, actorId],
  );
  const [activeId, setActiveId] = useState(""),
    [selected, setSelected] = useState([]),
    [undoStack, setUndoStack] = useState([]),
    [notice, setNotice] = useState(""),
    [error, setError] = useState(""),
    [shortcuts, setShortcuts] = useState(false),
    [scrollTop, setScrollTop] = useState(0);
  const [keeperIds, setKeeperIds] = useState([]),
    [focusedId, setFocusedId] = useState(""),
    [framePage, setFramePage] = useState(0);
  const [queueOpen, setQueueOpen] = useState(false);
  const list = useRef(null),
    heading = useRef(null),
    focusAfter = useRef(false),
    lastChoice = useRef(null);
  const active = groups.find((group) => group.id === activeId) || groups[0];
  const burst = isBurst(active),
    contactSheet = active && (burst || active.rows.length > 2);
  const focused =
    active?.rows.find((row) => row.id === focusedId) || active?.rows[0];
  const selectedGroups = groups.filter(
    (group) => selected.includes(group.id) && actionable(group),
  );
  const eligible = groups.filter(actionable),
    recommended = selectedGroups.filter(
      (group) => group.canSuggest && !isBurst(group),
    );
  const complete = allGroups.filter((group) => !group.openCount).length;
  const currentIndex = active
    ? groups.findIndex((group) => group.id === active.id)
    : -1;
  const visibleStart = Math.max(0, Math.floor(scrollTop / 68) - 3),
    visibleEnd = Math.min(groups.length, visibleStart + 19);
  useEffect(() => {
    setSelected([]);
    setScrollTop(0);
    if (list.current) list.current.scrollTop = 0;
  }, [owner, query, status]);
  useEffect(() => {
    if (!groups.some((group) => group.id === activeId))
      setActiveId(groups[0]?.id || "");
  }, [groups, activeId]);
  useEffect(() => {
    setKeeperIds([]);
    setFocusedId("");
    setFramePage(0);
    lastChoice.current = null;
    if (focusAfter.current) {
      heading.current?.focus({ preventScroll: true });
      focusAfter.current = false;
    }
  }, [active?.id]);
  useEffect(() => {
    const viewport = list.current;
    if (!viewport || currentIndex < 0 || !viewport.clientHeight) return;
    const top = currentIndex * 68;
    if (top < viewport.scrollTop) viewport.scrollTop = top;
    else if (top + 68 > viewport.scrollTop + viewport.clientHeight)
      viewport.scrollTop = top + 68 - viewport.clientHeight;
    setScrollTop(viewport.scrollTop);
  }, [active?.id, currentIndex]);
  function move(direction) {
    if (!active) return;
    setActiveId(
      nextDuplicateGroup(groups, active.id, { direction, wrap: true }) ||
        active.id,
    );
  }
  function toggleKeeper(row, shiftKey = false) {
    if (!actionable(active)) return;
    const index = active.rows.findIndex((item) => item.id === row.id),
      adding = !keeperIds.includes(row.id);
    const ids =
      shiftKey && lastChoice.current !== null
        ? active.rows
            .slice(
              Math.min(index, lastChoice.current),
              Math.max(index, lastChoice.current) + 1,
            )
            .map((item) => item.id)
        : [row.id];
    setKeeperIds((previous) =>
      adding
        ? [...new Set([...previous, ...ids])]
        : previous.filter((id) => !ids.includes(id)),
    );
    lastChoice.current = index;
  }
  function undo() {
    if (!undoStack.length) return;
    try {
      const entry = undoStack.at(-1),
        latest = readLatest(),
        next = applyDuplicateUndo(latest, entry.patch, { actorId });
      if (onCommit(next, "Duplicate decision undone.")) {
        setUndoStack((previous) => previous.slice(0, -1));
        setActiveId(entry.activeId);
        setSelected([]);
        setNotice("Decision undone. The previous group is ready to review.");
        setError("");
        focusAfter.current = true;
      }
    } catch (error) {
      setError(error.message);
    }
  }
  function decide(decision, targets, keeperId) {
    if (!targets?.length) return;
    try {
      const before = readLatest(),
        groupIds = targets.map((group) => group.id);
      const next = applyDuplicateDecision(before, {
        groupIds,
        decision,
        keeperId,
        keeperIds: decision === "keepers" ? keeperIds : undefined,
        actorId,
        expectedGroups: targets.map((group) => group.expected),
      });
      const patch = createDuplicateUndo(before, next, groupIds);
      const keepers = ["keeper", "keepers", "suggested"].includes(decision);
      const retained =
        decision === "keepers" ? keeperIds.length : targets.length;
      const copies =
        targets.reduce((n, group) => n + group.rows.length, 0) - retained;
      const message = keepers
        ? `Kept ${retained} photo${retained === 1 ? "" : "s"}; ${copies} ${copies === 1 ? "photo" : "photos"} moved to trash.`
        : decision === "stack"
          ? `Stacked ${targets.length} group${targets.length === 1 ? "" : "s"}. Every photo is preserved.`
          : `Kept every photo in ${targets.length} group${targets.length === 1 ? "" : "s"}.`;
      if (!onCommit(next, message)) return;
      setUndoStack((previous) =>
        [...previous, { patch, activeId: active?.id }].slice(-20),
      );
      setNotice(message);
      setError("");
      setSelected((previous) =>
        previous.filter((id) => !groupIds.includes(id)),
      );
      setKeeperIds([]);
      const remaining = groups.filter((group) => !groupIds.includes(group.id));
      const ready = remaining.filter(actionable);
      setActiveId(
        nextDuplicateGroup(
          ready.length
            ? groups.filter(
                (group) => actionable(group) || group.id === active?.id,
              )
            : groups,
          active?.id,
          { direction: 1, excludeIds: groupIds, wrap: true },
        ) ||
          ready[0]?.id ||
          remaining[0]?.id ||
          "",
      );
      focusAfter.current = true;
    } catch (error) {
      setError(error.message);
    }
  }
  const keyHandler = useRef();
  keyHandler.current = (event) => {
    if (
      event.defaultPrevented ||
      event.repeat ||
      event.altKey ||
      event.target.closest?.(
        'input,textarea,select,[contenteditable="true"]',
      ) ||
      document.querySelector('dialog[open],[role="dialog"]')
    )
      return;
    if (
      (event.metaKey || event.ctrlKey) &&
      event.key.toLowerCase() === "z" &&
      !event.shiftKey
    ) {
      event.preventDefault();
      undo();
      return;
    }
    if (event.metaKey || event.ctrlKey) return;
    const key = event.key.toLowerCase();
    if (key === "?") {
      event.preventDefault();
      setShortcuts((value) => !value);
      return;
    }
    if (key === "arrowright" || key === "arrowleft") {
      event.preventDefault();
      move(key === "arrowright" ? 1 : -1);
      return;
    }
    if (!active || !actionable(active)) return;
    if (key === "k" && active.canSuggest && !burst) {
      event.preventDefault();
      decide("suggested", [active]);
    }
    if (key === "a") {
      event.preventDefault();
      decide("keep-all", [active]);
    }
    if (key === "s") {
      event.preventDefault();
      decide("stack", [active]);
    }
    if (key === "e" && contactSheet && keeperIds.length) {
      event.preventDefault();
      decide("keepers", [active]);
    }
    if (/^[1-9]$/.test(key)) {
      const row =
        active.rows[
          (contactSheet ? framePage * pageSize : 0) + Number(key) - 1
        ];
      if (row) {
        event.preventDefault();
        contactSheet ? toggleKeeper(row) : decide("keeper", [active], row.id);
      }
    }
  };
  useEffect(() => {
    const listener = (event) => keyHandler.current?.(event);
    addEventListener("keydown", listener);
    return () => removeEventListener("keydown", listener);
  }, []);
  return (
    <section className="duplicate-review" aria-label="Fast duplicate review">
      <div className="dr-session-bar">
        <div>
          <strong>{groups.length.toLocaleString()} groups</strong>
          <span>
            {complete.toLocaleString()} reviewed ·{" "}
            {eligible.length.toLocaleString()} ready for your decision
          </span>
        </div>
        <Button icon="mdiUndo" disabled={!undoStack.length} onClick={undo}>
          Undo{undoStack.length > 0 ? ` (${undoStack.length})` : ""}
        </Button>
        <Button
          onClick={() => setShortcuts(!shortcuts)}
          aria-expanded={shortcuts}
        >
          Shortcuts <kbd>?</kbd>
        </Button>
      </div>
      {(notice || error) && (
        <div
          className={`dr-live ${error ? "error" : ""}`}
          role={error ? "alert" : "status"}
        >
          <Icon
            name={error ? "mdiAlertCircleOutline" : "mdiCheckCircleOutline"}
          />
          <span>{error || notice}</span>
          {!error && notice.includes("moved to trash") && (
            <Button onClick={onOpenTrash}>View trash</Button>
          )}
          <Button
            aria-label="Dismiss review message"
            icon="mdiClose"
            onClick={() => {
              setNotice("");
              setError("");
            }}
          />
        </div>
      )}
      {shortcuts && (
        <div className="dr-shortcuts">
          <span>
            <kbd>1–9</kbd>{" "}
            {contactSheet ? "Select keepers on this page" : "Keep that copy"}
          </span>
          <span>
            <kbd>K</kbd> Keep suggested
          </span>
          <span>
            <kbd>A</kbd> Keep all
          </span>
          <span>
            <kbd>S</kbd> Stack
          </span>
          {contactSheet && (
            <span>
              <kbd>E</kbd> Keep selected
            </span>
          )}
          <span>
            <kbd>← →</kbd> Previous / next group
          </span>
          <span>
            <kbd>⌘ / Ctrl Z</kbd> Undo
          </span>
        </div>
      )}
      <div className="dr-bulk">
        <label>
          <input
            type="checkbox"
            aria-label="Select all matching editable groups"
            checked={
              eligible.length > 0 &&
              eligible.every((group) => selected.includes(group.id))
            }
            disabled={!eligible.length}
            onChange={() =>
              setSelected(
                eligible.every((group) => selected.includes(group.id))
                  ? []
                  : eligible.map((group) => group.id),
              )
            }
          />
          {selectedGroups.length
            ? `${selectedGroups.length.toLocaleString()} selected`
            : "Select matching groups"}
        </label>
        {selectedGroups.length > 0 && (
          <>
            <Button
              primary
              disabled={recommended.length !== selectedGroups.length}
              onClick={() => decide("suggested", selectedGroups)}
            >
              Keep suggested in {selectedGroups.length} groups
            </Button>
            <Button onClick={() => decide("keep-all", selectedGroups)}>
              Keep all copies
            </Button>
            <Button onClick={() => decide("stack", selectedGroups)}>
              Stack groups
            </Button>
            <Button onClick={() => setSelected([])}>Clear selection</Button>
          </>
        )}
        <span>
          {selectedGroups.length
            ? recommended.length !== selectedGroups.length
              ? `${selectedGroups.length - recommended.length} ${selectedGroups.length - recommended.length === 1 ? "group needs" : "groups need"} you to choose keepers. Stacking preserves every photo.`
              : `${selectedGroups.reduce((n, group) => n + group.rows.length - 1, 0).toLocaleString()} other copies would move to trash when keeping suggestions.`
            : "Decide once. Continue immediately. Undo any recent decision."}
        </span>
      </div>
      <div className="dr-workspace">
        <aside
          className={`dr-queue ${queueOpen ? "open" : ""}`}
          aria-label="Duplicate group queue"
        >
          <Button
            className="dr-queue-toggle"
            aria-expanded={queueOpen}
            onClick={() => setQueueOpen((value) => !value)}
          >
            Review queue · {groups.length.toLocaleString()} groups{" "}
            <Icon name="mdiChevronDown" />
          </Button>
          <header>
            <strong>Review queue</strong>
            <span>{groups.length.toLocaleString()}</span>
          </header>
          <div
            className="dr-queue-scroll"
            ref={list}
            onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
          >
            <div style={{ height: groups.length * 68, position: "relative" }}>
              {groups.slice(visibleStart, visibleEnd).map((group, index) => (
                <div
                  className={`dr-queue-row ${active?.id === group.id ? "active" : ""}`}
                  key={group.id}
                  style={{ top: (visibleStart + index) * 68 }}
                >
                  <input
                    type="checkbox"
                    aria-label={`Select group ${title(group)}`}
                    disabled={!actionable(group)}
                    checked={selected.includes(group.id)}
                    onChange={() =>
                      setSelected((previous) =>
                        previous.includes(group.id)
                          ? previous.filter((id) => id !== group.id)
                          : [...previous, group.id],
                      )
                    }
                  />
                  <button
                    aria-current={active?.id === group.id ? "true" : undefined}
                    onClick={() => setActiveId(group.id)}
                  >
                    <img src={`/media/${group.rows[0].image}.png`} alt="" />
                    <span>
                      <strong>{title(group)}</strong>
                      <small>
                        {group.rows.length}{" "}
                        {isBurst(group) ? "burst frames" : "copies"} ·{" "}
                        {group.editable
                          ? group.openCount
                            ? "Ready"
                            : "Reviewed"
                          : ownerName(group.ownerIds[0])}
                      </small>
                    </span>
                  </button>
                </div>
              ))}
            </div>
            {!groups.length && <p>No matching groups.</p>}
          </div>
        </aside>
        <div className="dr-comparison">
          {active ? (
            <>
              <div className="dr-group-heading">
                <div>
                  <h2 ref={heading} tabIndex={-1}>
                    {title(active)}
                  </h2>
                  <p>
                    Group {currentIndex + 1} of {groups.length} ·{" "}
                    {active.rows.length} {burst ? "frames" : "copies"} ·{" "}
                    {formatBytes(active.totalBytes)} in originals
                  </p>
                </div>
                <div>
                  <Button
                    aria-label="Previous duplicate group"
                    onClick={() => move(-1)}
                    disabled={groups.length < 2}
                    icon="mdiChevronDoubleLeft"
                  />
                  <Button
                    aria-label="Next duplicate group"
                    onClick={() => move(1)}
                    disabled={groups.length < 2}
                    icon="mdiChevronRight"
                  />
                </div>
              </div>
              {!active.editable && (
                <p className="dr-access">
                  Only {active.ownerIds.map(ownerName).join(" and ")} can decide
                  what to keep in this group.
                </p>
              )}
              {contactSheet ? (
                <>
                  <div className="dr-burst-intro">
                    <Icon name="mdiImageMultipleOutline" />
                    <div>
                      <strong>
                        {burst
                          ? "A burst can contain several keepers"
                          : "Review the whole group"}
                      </strong>
                      <p>
                        {burst
                          ? "Stack the sequence to organize it, or choose the moments you want to keep. Similar frames are not necessarily duplicates."
                          : "Choose one or more keepers from the contact sheet. Inspect any photo before making a decision."}
                      </p>
                    </div>
                    <Button
                      primary={burst}
                      disabled={!actionable(active)}
                      onClick={() => decide("stack", [active])}
                    >
                      {burst ? "Stack entire burst" : "Stack entire group"}
                    </Button>
                  </div>
                  <div className="dr-frame-preview">
                    <div>
                      <img
                        src={`/media/${focused.image}.png`}
                        style={imageStyle(focused)}
                        alt={`Preview of ${focused.name}`}
                      />
                    </div>
                    <aside>
                      <span>
                        FRAME{" "}
                        {active.rows.findIndex((row) => row.id === focused.id) +
                          1}{" "}
                        OF {active.rows.length}
                      </span>
                      <strong>{focused.name}</strong>
                      <p>{focused.quality}</p>
                      <small>
                        {focused.width?.toLocaleString()} ×{" "}
                        {focused.height?.toLocaleString()} ·{" "}
                        {formatBytes(focused.bytes)}
                      </small>
                      {focused.offsetMs !== undefined && (
                        <small>
                          +{(focused.offsetMs / 1000).toFixed(2)} seconds
                        </small>
                      )}
                      <Button
                        disabled={!actionable(active)}
                        aria-pressed={keeperIds.includes(focused.id)}
                        onClick={() => toggleKeeper(focused)}
                      >
                        {keeperIds.includes(focused.id)
                          ? "Remove from keepers"
                          : "Mark as keeper"}
                      </Button>
                      {focused.sampleEvidence && (
                        <small className="dr-sample">
                          Illustrative sequence · sample images
                        </small>
                      )}
                    </aside>
                  </div>
                  <div className="dr-contact-toolbar">
                    <strong aria-label="Selected keepers">
                      {keeperIds.length} of {active.rows.length} selected as
                      keepers
                    </strong>
                    <Button
                      disabled={!actionable(active)}
                      onClick={() => setKeeperIds(active.ids)}
                    >
                      Select all
                    </Button>
                    <Button
                      disabled={!keeperIds.length}
                      onClick={() => setKeeperIds([])}
                    >
                      Clear
                    </Button>
                    <span>
                      Click a photo to inspect · Shift-click to select a range
                    </span>
                  </div>
                  <div
                    className="dr-contact-sheet"
                    aria-label="Group contact sheet"
                  >
                    {active.rows
                      .slice(framePage * pageSize, (framePage + 1) * pageSize)
                      .map((row, index) => (
                        <article
                          key={row.id}
                          className={`${focused.id === row.id ? "focused" : ""} ${keeperIds.includes(row.id) ? "keeper" : ""}`}
                        >
                          <button
                            className="dr-frame-open"
                            aria-label={`Inspect frame ${framePage * pageSize + index + 1}`}
                            aria-pressed={focused.id === row.id}
                            onClick={() => setFocusedId(row.id)}
                          >
                            <img
                              src={`/media/${row.image}.png`}
                              style={imageStyle(row)}
                              alt={row.name}
                              loading="lazy"
                            />
                          </button>
                          <label>
                            <input
                              type="checkbox"
                              aria-label={`Keep frame ${framePage * pageSize + index + 1}`}
                              checked={keeperIds.includes(row.id)}
                              disabled={!actionable(active)}
                              onChange={() => {}}
                              onClick={(event) =>
                                toggleKeeper(row, event.shiftKey)
                              }
                            />
                            <span>
                              {String(
                                framePage * pageSize + index + 1,
                              ).padStart(2, "0")}
                            </span>
                            {row.id === active.suggestedKeeperId && !burst ? (
                              <small>Suggested</small>
                            ) : keeperIds.includes(row.id) ? (
                              <small>Keeper</small>
                            ) : null}
                          </label>
                        </article>
                      ))}
                  </div>
                  {active.rows.length > pageSize && (
                    <div className="dr-contact-pages">
                      <Button
                        disabled={!framePage}
                        onClick={() => setFramePage((value) => value - 1)}
                      >
                        Previous frames
                      </Button>
                      <span>
                        {framePage * pageSize + 1}–
                        {Math.min(
                          active.rows.length,
                          (framePage + 1) * pageSize,
                        )}{" "}
                        of {active.rows.length}
                      </span>
                      <Button
                        disabled={
                          (framePage + 1) * pageSize >= active.rows.length
                        }
                        onClick={() => setFramePage((value) => value + 1)}
                      >
                        Next frames
                      </Button>
                    </div>
                  )}
                </>
              ) : (
                <div className="dr-compare-grid">
                  {active.rows.map((row, index) => (
                    <article
                      key={row.id}
                      className={
                        row.id === active.suggestedKeeperId ? "suggested" : ""
                      }
                    >
                      <div className="dr-image">
                        <img src={`/media/${row.image}.png`} alt={row.name} />
                        <span>{index + 1}</span>
                        {row.id === active.suggestedKeeperId && (
                          <strong>Suggested keeper</strong>
                        )}
                      </div>
                      <div className="dr-copy">
                        <strong>{row.name}</strong>
                        <small>{row.quality}</small>
                        <div>
                          <span>
                            {row.width?.toLocaleString()} ×{" "}
                            {row.height?.toLocaleString()}
                          </span>
                          <span>{formatBytes(row.bytes)}</span>
                        </div>
                        <Button
                          primary={row.id === active.suggestedKeeperId}
                          disabled={!actionable(active)}
                          onClick={() => decide("keeper", [active], row.id)}
                        >
                          Keep this copy <kbd>{index < 9 ? index + 1 : ""}</kbd>
                        </Button>
                      </div>
                    </article>
                  ))}
                </div>
              )}
              <div
                className={`dr-decisions ${contactSheet ? "dr-sticky-decisions" : ""}`}
              >
                {contactSheet ? (
                  <>
                    <div>
                      <strong>
                        {keeperIds.length
                          ? `Keep ${keeperIds.length} selected · trash ${active.rows.length - keeperIds.length}`
                          : "Choose keepers, or keep every frame"}
                      </strong>
                      <small>
                        {keeperIds.length
                          ? "Unselected photos move to trash. You can undo this decision."
                          : "Nothing will be removed until you choose an action."}
                      </small>
                    </div>
                    <Button
                      primary
                      disabled={!actionable(active) || !keeperIds.length}
                      onClick={() => decide("keepers", [active])}
                    >
                      Keep {keeperIds.length} selected <kbd>E</kbd>
                    </Button>
                  </>
                ) : (
                  <Button
                    primary
                    disabled={!actionable(active) || !active.canSuggest}
                    onClick={() => decide("suggested", [active])}
                  >
                    Keep suggested <kbd>K</kbd>
                  </Button>
                )}
                <Button
                  disabled={!actionable(active)}
                  onClick={() => decide("keep-all", [active])}
                >
                  Keep all <kbd>A</kbd>
                </Button>
                <Button
                  disabled={!actionable(active)}
                  onClick={() => decide("stack", [active])}
                >
                  Stack together <kbd>S</kbd>
                </Button>
                <Button onClick={() => move(1)} disabled={groups.length < 2}>
                  Skip for now
                </Button>
              </div>
              <p className="dr-footnote">
                {burst
                  ? "Burst frames stay independent originals when stacked. Choose the stack cover later in your library."
                  : "Keeper suggestions use resolution, format and original provenance."}{" "}
                Storage is released only when trash is emptied. Stacking retains
                every photo.
              </p>
            </>
          ) : (
            <div className="dr-done">
              <Icon name="mdiCheckCircleOutline" size={36} />
              <h2 ref={heading} tabIndex={-1}>
                Review complete
              </h2>
              <p>
                No groups match the current filters. Change filters to see more
                or undo your last decision.
              </p>
              <Button
                disabled={!undoStack.length}
                icon="mdiUndo"
                onClick={undo}
              >
                Undo last decision
              </Button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
