import React, { useState } from "react";
import { Button, Dialog } from "./Controls";
import { Icon } from "./Icon";
import { PersonAvatar, usePhoneLayout } from "./People";
import {
  applyPeopleOverrides,
  displayName,
  getOverride,
  hideAll,
  hideUnnamed,
  isUnnamed,
  pendingVisibilityChanges,
  resetVisibility,
  showAll,
  togglePersonFlag,
  visiblePeople,
} from "./people-data.mjs";
import "./people.css";

const plural = (count, one, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

export function ManagePeople({ people = [], overrides = {}, onSave, onBack }) {
  const [draft, setDraft] = useState(() => overrides || {});
  const [search, setSearch] = useState("");
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [status, setStatus] = useState("");
  const phone = usePhoneLayout();
  const saved = overrides || {};
  const list = visiblePeople(applyPeopleOverrides(people, saved), {
    showHidden: true,
  });
  const query = search.trim().toLocaleLowerCase();
  const rows = list
    .filter(
      (person) =>
        !query || displayName(person).toLocaleLowerCase().includes(query),
    )
    .sort(
      (a, b) =>
        isUnnamed(a) - isUnnamed(b) ||
        displayName(a).localeCompare(displayName(b)),
    );
  const pending = pendingVisibilityChanges(list, saved, draft);
  const hiddenCount = list.filter(
    (person) => getOverride(draft, person.id).hidden,
  ).length;
  const apply = (next, message) => {
    setDraft(next);
    setStatus(message);
  };
  const leave = () => {
    if (pending > 0) setConfirmLeave(true);
    else onBack?.();
  };
  const batches = [
    {
      id: "hide-all",
      label: "Hide all",
      icon: "mdiEyeOffOutline",
      run: () => apply(hideAll(draft, list), "All people hidden. Save to keep this."),
    },
    {
      id: "hide-unnamed",
      label: "Hide unnamed",
      icon: "mdiAccountOffOutline",
      run: () =>
        apply(hideUnnamed(draft, list), "Unnamed people hidden. Save to keep this."),
    },
    {
      id: "show-all",
      label: "Show all",
      icon: "mdiEyeOutline",
      run: () => apply(showAll(draft, list), "All people shown. Save to keep this."),
    },
    {
      id: "reset",
      label: "Reset",
      icon: "mdiRestore",
      run: () =>
        apply(resetVisibility(draft, saved, list), "Changes reverted."),
      disabled: pending === 0,
    },
  ];

  return (
    <section className="people-library pm-page" aria-label="Show and hide people">
      <header className="people-header pm-header">
        <div className="pm-title">
          <Button
            className="pm-back"
            icon="mdiArrowLeft"
            aria-label="Back to people"
            onClick={leave}
          />
          <div>
            <h1>Show and hide people</h1>
            <p className="people-summary">
              Hidden people stay off the People page and out of suggestions.
              Their photos remain in your library.
            </p>
          </div>
        </div>
        <div className="people-toolbar pm-toolbar">
          <input
            type="search"
            aria-label="Find a person"
            placeholder="Find a person"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <div className="pm-batches" role="group" aria-label="Visibility shortcuts">
            {batches.map((batch) => (
              <Button
                key={batch.id}
                icon={batch.icon}
                disabled={batch.disabled}
                onClick={batch.run}
              >
                {batch.label}
              </Button>
            ))}
          </div>
        </div>
      </header>
      <p className="pm-summary">
        {plural(list.length - hiddenCount, "person", "people")} shown ·{" "}
        {plural(hiddenCount, "person", "people")} hidden
      </p>
      <div className="pm-grid">
        {rows.map((person) => {
          const hidden = getOverride(draft, person.id).hidden;
          const changed =
            hidden !== getOverride(saved, person.id).hidden;
          const name = displayName(person);
          return (
            <button
              type="button"
              key={person.id}
              className={`pm-card ${hidden ? "is-hidden" : ""} ${changed ? "is-changed" : ""}`}
              aria-pressed={!hidden}
              aria-label={`${name}, ${hidden ? "hidden" : "shown"}${changed ? ", unsaved change" : ""}`}
              onClick={() =>
                apply(
                  togglePersonFlag(draft, person.id, "hidden", !hidden),
                  `${name} will be ${hidden ? "shown" : "hidden"} after saving.`,
                )
              }
            >
              <PersonAvatar person={person} size={phone ? 96 : 120} />
              <span className={`pm-card-name ${isUnnamed(person) ? "is-unnamed" : ""}`}>
                {name}
              </span>
              <span className="pm-eye" aria-hidden="true">
                <Icon name={hidden ? "mdiEyeOffOutline" : "mdiEyeOutline"} size={18} />
              </span>
              {changed && <span className="pm-dot" aria-hidden="true" />}
            </button>
          );
        })}
      </div>
      {rows.length === 0 && (
        <p className="people-empty" role="status">
          {query ? "No people match your search." : "No people to manage yet."}
        </p>
      )}
      <footer className="pm-footer">
        <span className="pm-pending" role="status" aria-live="polite">
          {status ||
            (pending
              ? `${plural(pending, "pending change")}`
              : "No pending changes")}
        </span>
        <div className="pm-footer-actions">
          <Button onClick={leave}>Cancel</Button>
          <Button
            primary
            icon="mdiCheck"
            disabled={pending === 0}
            onClick={() => {
              onSave?.(draft);
              setStatus("Changes saved.");
            }}
          >
            Save changes{pending ? ` (${pending})` : ""}
          </Button>
        </div>
      </footer>
      {confirmLeave && (
        <Dialog
          title="Discard changes?"
          close={() => setConfirmLeave(false)}
          actions={
            <>
              <Button onClick={() => setConfirmLeave(false)} data-initial-focus>
                Keep editing
              </Button>
              <Button
                primary
                onClick={() => {
                  setConfirmLeave(false);
                  onBack?.();
                }}
              >
                Discard
              </Button>
            </>
          }
        >
          <p className="pp-dialog-hint">
            {plural(pending, "visibility change")} will be lost.
          </p>
        </Dialog>
      )}
    </section>
  );
}
