import React, { useEffect, useRef, useState } from "react";
import { Button } from "./App";
import { Icon } from "./Icon";
import {
  applyResourceCommand,
  loadResourceState,
  saveResourceState,
  subscribeResourceState,
} from "./account-library-data.mjs";
import { lockedAccessSnapshot } from "./locked-content.mjs";
import {
  LOCKED_PEOPLE,
  LOCKED_RULES_KEY,
  lockedTagId,
  readLockedRuleCatalog,
  resolveLockedRules,
} from "./locked-rules.mjs";

const ruleKey = (rules) =>
  JSON.stringify([rules?.scope, rules?.tagIds, rules?.personIds]);

export function ProtectedContent({
  showLocked = false,
  onRequestUnlock,
  onLock,
  onOpenSettings,
}) {
  const [resources, setResources] = useState(loadResourceState);
  const [draft, setDraft] = useState(null);
  const [catalog, setCatalog] = useState([]);
  const [personQuery, setPersonQuery] = useState("");
  const [tagQuery, setTagQuery] = useState("");
  const [notice, setNotice] = useState("");
  const [conflict, setConflict] = useState(false);
  const baseline = useRef(null);
  const access = lockedAccessSnapshot(resources);
  const [admittedToken, setAdmittedToken] = useState(() =>
    showLocked ? access.token : null,
  );
  const unlocked =
    showLocked &&
    access.available &&
    access.pinEnabled &&
    admittedToken === access.token;
  const actor = resources.users.find((user) => user.id === "taylor");
  const currentKey = ruleKey(actor?.preferences.privacy.suppression);
  const load = () => {
    try {
      const current = loadResourceState();
      const latest = lockedAccessSnapshot(current);
      if (
        !showLocked ||
        !latest.available ||
        !latest.pinEnabled ||
        latest.token !== admittedToken
      )
        return;
      const owner = current.users.find((user) => user.id === "taylor");
      const raw = localStorage.getItem(LOCKED_RULES_KEY);
      baseline.current = {
        raw,
        rules: ruleKey(owner.preferences.privacy.suppression),
        access: latest.token,
      };
      setDraft(resolveLockedRules(owner.preferences, raw));
      setCatalog(readLockedRuleCatalog(raw)?.tags || []);
      setConflict(false);
      setNotice("");
      setPersonQuery("");
      setTagQuery("");
    } catch {
      setNotice("Locked rules could not be loaded. Try again.");
    }
  };
  useEffect(() => subscribeResourceState(setResources), []);
  useEffect(() => {
    setAdmittedToken(showLocked ? access.token : null);
  }, [showLocked]);
  useEffect(() => {
    if (unlocked) load();
    else {
      baseline.current = null;
      setDraft(null);
      setCatalog([]);
      setPersonQuery("");
      setTagQuery("");
      setNotice("");
      setConflict(false);
    }
  }, [unlocked, access.token]);
  useEffect(() => {
    if (unlocked && baseline.current && baseline.current.rules !== currentKey)
      setConflict(true);
  }, [currentKey, unlocked]);
  useEffect(() => {
    const changed = (event) => {
      if (event.key === null) {
        setDraft(null);
        baseline.current = null;
        onLock?.();
      } else if (unlocked && event.key === LOCKED_RULES_KEY) setConflict(true);
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, [unlocked]);

  const save = () => {
    if (!unlocked || !draft || !baseline.current) return;
    let oldRaw;
    try {
      const current = loadResourceState();
      const latest = lockedAccessSnapshot(current);
      const owner = current.users.find((user) => user.id === "taylor");
      if (
        !latest.available ||
        !latest.pinEnabled ||
        latest.token !== baseline.current.access
      ) {
        onLock?.();
        setDraft(null);
        setNotice("Unlock again before saving Locked rules.");
        return;
      }
      oldRaw = localStorage.getItem(LOCKED_RULES_KEY);
      if (
        oldRaw !== baseline.current.raw ||
        ruleKey(owner.preferences.privacy.suppression) !==
          baseline.current.rules
      ) {
        setConflict(true);
        return;
      }
      const next = applyResourceCommand(current, {
        type: "update-user-preferences",
        userId: "taylor",
        expectedRevision: current.revision,
        preferences: { privacy: { suppression: draft } },
      });
      // Names remain in the sample catalog; account preferences contain IDs.
      // Unavailable IDs are retained when editing other known selections.
      const raw = JSON.stringify({
        version: 2,
        tags: catalog,
        people: [],
        scope: draft.scope,
      });
      localStorage.setItem(LOCKED_RULES_KEY, raw);
      try {
        saveResourceState(next, undefined, current.revision);
      } catch (error) {
        if (oldRaw === null) localStorage.removeItem(LOCKED_RULES_KEY);
        else localStorage.setItem(LOCKED_RULES_KEY, oldRaw);
        throw error;
      }
      baseline.current = { raw, rules: ruleKey(draft), access: latest.token };
      setResources(next);
      setConflict(false);
      setNotice("Locked rules saved.");
    } catch {
      setNotice(
        "Changes couldn't be saved. They're still here; try again.",
      );
    }
  };
  if (!unlocked || !draft)
    return (
      <div className="cc-protected-lock">
        <Icon name="mdiLockOutline" size={28} />
        <h3>Locked tags and people</h3>
        <p>Unlock to view or change the photos and videos you keep private.</p>
        {!access.available ? (
          <p>This session is unavailable. Check your account settings.</p>
        ) : !access.pinEnabled ? (
          <>
            <p>Set up your PIN to continue.</p>
            <Button onClick={onOpenSettings}>PIN settings</Button>
          </>
        ) : (
          <Button primary onClick={onRequestUnlock} disabled={!onRequestUnlock}>
            Unlock Locked settings
          </Button>
        )}
        {notice && <p role="status">{notice}</p>}
      </div>
    );
  const tags = [
    ...new Set(["medical", "receipts", "private", ...catalog]),
  ].filter((name) =>
    name.toLocaleLowerCase().includes(tagQuery.toLocaleLowerCase()),
  );
  const toggle = (field, id) =>
    setDraft((current) => ({
      ...current,
      [field]: current[field].includes(id)
        ? current[field].filter((value) => value !== id)
        : [...current[field], id],
    }));
  return (
    <div className="cc-protected-rules">
      <div className="cc-section-action">
        <p>Locked settings are revealed for this session.</p>
        <Button onClick={onLock}>Hide Locked content</Button>
      </div>
      {conflict && (
        <p role="alert" className="cc-notice">
          These rules changed somewhere else. Your changes stay until you reload.
          <Button onClick={load}>Discard my changes and reload</Button>
        </p>
      )}
      {notice && (
        <p role="status" className="cc-notice">
          {notice}
        </p>
      )}
      <label>
        Apply Locked rules to
        <select
          value={draft.scope}
          onChange={(event) =>
            setDraft({ ...draft, scope: event.target.value })
          }
        >
          <option value="owned">My photos and videos</option>
          <option value="visible">All photos and videos I can access</option>
        </select>
      </label>
      <div className="cc-protected-grid">
        <section>
          <h3>People</h3>
          <label>
            Find a person
            <input
              type="search"
              value={personQuery}
              onChange={(event) => setPersonQuery(event.target.value)}
            />
          </label>
          {LOCKED_PEOPLE.filter((person) =>
            person.name
              .toLocaleLowerCase()
              .includes(personQuery.toLocaleLowerCase()),
          ).map((person) => (
            <label className="cc-protected-option" key={person.id}>
              <input
                type="checkbox"
                checked={draft.personIds.includes(person.id)}
                onChange={() => toggle("personIds", person.id)}
              />
              <img src={`/media/avatar-${person.legacyId}.png`} alt="" />
              {person.name}
            </label>
          ))}
        </section>
        <section>
          <h3>Tags</h3>
          <label>
            Find or create a tag
            <input
              type="search"
              maxLength={100}
              value={tagQuery}
              onChange={(event) => setTagQuery(event.target.value)}
            />
          </label>
          {tags.map((name) => (
            <label className="cc-protected-option" key={name}>
              <input
                type="checkbox"
                checked={draft.tagIds.includes(lockedTagId(name))}
                onChange={() => toggle("tagIds", lockedTagId(name))}
              />
              {name}
            </label>
          ))}
          {tagQuery.trim() &&
            !tags.some(
              (name) =>
                name.toLocaleLowerCase() ===
                tagQuery.trim().toLocaleLowerCase(),
            ) && (
              <Button
                disabled={catalog.length >= 100}
                onClick={() => {
                  const name = tagQuery.trim();
                  setCatalog((current) => [...current, name]);
                  toggle("tagIds", lockedTagId(name));
                  setTagQuery("");
                }}
              >
                Create “{tagQuery.trim()}”
              </Button>
            )}
        </section>
      </div>
      <div className="cc-section-action">
        <Button onClick={load}>Discard rule changes</Button>
        <Button primary disabled={conflict} onClick={save}>
          Save Locked rules
        </Button>
      </div>
    </div>
  );
}
