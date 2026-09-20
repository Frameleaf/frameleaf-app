import React, { useState } from "react";
import { Button, Dialog } from "./App";
import {
  recoveryRoots,
  recoveryCandidates,
  applyUtilityRecovery,
  ownerName,
  formatBytes,
} from "./utilities-data.mjs";
export function UtilityRecovery({ state, rows, mode, close, onCommit }) {
  const [roots, setRoots] = useState(["recovered", "backup"]),
    [candidates, setCandidates] = useState({}),
    [consent, setConsent] = useState(false),
    [error, setError] = useState("");
  const valid = rows.every((row) => {
    const candidate = recoveryCandidates(row).find(
      (item) => item.id === candidates[row.id] && roots.includes(item.rootId),
    );
    return (
      candidate &&
      (mode !== "replace" || (candidate.checksumMatch && candidate.decodeValid))
    );
  });
  function apply() {
    try {
      onCommit(
        applyUtilityRecovery(state, {
          mode,
          rows,
          rootIds: roots,
          candidateIds: candidates,
          confirmed: consent,
          actorId: "taylor",
          admin: true,
        }),
      );
    } catch (cause) {
      setError(cause.message);
    }
  }
  return (
    <Dialog
      wide
      title={
        mode === "replace"
          ? "Recover damaged originals"
          : "Choose candidate originals"
      }
      close={close}
      actions={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button
            primary
            disabled={!valid || (mode === "replace" && !consent)}
            onClick={apply}
          >
            {mode === "replace"
              ? "Record verified recovery"
              : "Save candidate choices"}
          </Button>
        </>
      }
    >
      <p>
        {mode === "replace"
          ? "Choose an exact copy from a backup. A valid decode alone does not prove that a file is the same original."
          : "Select configured locations, then review a candidate for each missing original. Similar names do not prove an exact match."}
      </p>
      <fieldset>
        <legend>Search locations</legend>
        {recoveryRoots.map((root) => (
          <label className="um-check" key={root.id}>
            <input
              type="checkbox"
              checked={roots.includes(root.id)}
              onChange={() =>
                setRoots((previous) =>
                  previous.includes(root.id)
                    ? previous.filter((id) => id !== root.id)
                    : [...previous, root.id],
                )
              }
            />
            <span>
              {root.label}
              <small>{root.path}</small>
            </span>
          </label>
        ))}
      </fieldset>
      {rows.map((row) => (
        <section className="um-result-panel" key={row.id}>
          <h3>{row.name}</h3>
          <p>
            {ownerName(row.ownerId)} · {formatBytes(row.bytes)} · {row.status}
          </p>
          {recoveryCandidates(row)
            .filter((candidate) => roots.includes(candidate.rootId))
            .map((candidate) => (
              <label className="um-check" key={candidate.id}>
                <input
                  type="radio"
                  name={`candidate-${row.id}`}
                  checked={candidates[row.id] === candidate.id}
                  onChange={() =>
                    setCandidates((previous) => ({
                      ...previous,
                      [row.id]: candidate.id,
                    }))
                  }
                />
                <span>
                  <strong>{candidate.path}</strong>
                  <small>
                    Checksum:{" "}
                    {candidate.checksumMatch ? "exact match" : "different"} ·
                    Decode:{" "}
                    {candidate.decodeValid ? "validated" : "not validated"} ·{" "}
                    {formatBytes(candidate.bytes)}
                  </small>
                </span>
              </label>
            ))}
          {!roots.length && <p>Select a search location to see candidates.</p>}
        </section>
      ))}
      {mode === "replace" && (
        <label className="um-check">
          <input
            type="checkbox"
            checked={consent}
            onChange={(event) => setConsent(event.target.checked)}
          />
          I reviewed the checksum and decode evidence. Keep the previous damaged
          source and its provenance for recovery.
        </label>
      )}
      <p className="um-policy">
        Owner, file identity, current access, and stored evidence must be
        checked again before publishing a repaired original. This review does
        not grant access to hidden media.
      </p>
      {error && (
        <p role="alert" className="um-message error">
          {error}
        </p>
      )}
    </Dialog>
  );
}
