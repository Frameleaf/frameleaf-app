import React, { useEffect, useId, useRef, useState } from "react";
import {
  ACCOUNT_FEATURES,
  createAccountPreferences,
  normalizeAccountPreferences,
} from "./account-preferences.mjs";
import "./account-preferences.css";

const GiB = 1024 ** 3;
const PAGE_GROUPS = {
  features: [
    "folders",
    "memories",
    "people",
    "sharedLinks",
    "tags",
    "ratings",
    "cast",
    "recentlyAdded",
  ],
  preferences: ["albums", "download", "purchase"],
  notifications: ["emailNotifications"],
};
const clone = (value) => structuredClone(value);
const read = (value, path) =>
  path.reduce((current, key) => current?.[key], value);

function Toggle({ label, checked, onChange, disabled, description }) {
  const id = useId();
  return (
    <label className="ap-toggle" htmlFor={id}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>
        <strong>{label}</strong>
        {description && <small>{description}</small>}
      </span>
    </label>
  );
}

function PreferenceField({ label, help, children }) {
  const id = useId();
  return (
    <label className="ap-field" htmlFor={id}>
      <span>{label}</span>
      {React.cloneElement(children, {
        id,
        "aria-describedby": help ? `${id}-help` : undefined,
      })}
      {help && <small id={`${id}-help`}>{help}</small>}
    </label>
  );
}

export function AccountPreferences(props) {
  return <AccountPreferencesForm key={props.user.id} {...props} />;
}

function AccountPreferencesForm({
  user,
  revision,
  section = "features",
  onSave,
  onOpenPrivacy,
  onDirtyChange,
}) {
  const [baseline, setBaseline] = useState(() =>
    normalizeAccountPreferences(user.preferences),
  );
  const [draft, setDraft] = useState(() => clone(baseline));
  const [loadedRevision, setLoadedRevision] = useState(revision);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const pendingSave = useRef(null);
  const dirtyCallback = useRef(onDirtyChange);
  dirtyCallback.current = onDirtyChange;
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);
  const editable = user.status === "active";
  const stale = revision !== loadedRevision;

  useEffect(() => {
    dirtyCallback.current?.(dirty);
  }, [dirty]);
  useEffect(() => () => dirtyCallback.current?.(false), []);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // Only acknowledge our own save. An unrelated newer revision must never
  // replace a draft or silently advance the revision used to submit it.
  useEffect(() => {
    if (!pendingSave.current || revision === loadedRevision) return;
    const current = normalizeAccountPreferences(user.preferences);
    if (JSON.stringify(current) === JSON.stringify(pendingSave.current)) {
      setLoadedRevision(revision);
      pendingSave.current = null;
    } else {
      pendingSave.current = null;
      setError(
        "This account changed again after saving. Load the latest preferences before making more changes.",
      );
    }
  }, [revision, user.preferences, loadedRevision]);

  const change = (path, value) => {
    setDraft((current) => {
      const next = clone(current);
      let target = next;
      for (const key of path.slice(0, -1)) target = target[key];
      target[path.at(-1)] = value;
      return next;
    });
    setError("");
    setNotice("");
  };
  const loadLatest = () => {
    const current = normalizeAccountPreferences(user.preferences);
    setBaseline(current);
    setDraft(clone(current));
    setLoadedRevision(revision);
    pendingSave.current = null;
    setError("");
    setNotice("Latest preferences loaded.");
  };
  const resetPage = () => {
    const defaults = createAccountPreferences();
    setDraft((current) => {
      const next = clone(current);
      for (const key of PAGE_GROUPS[section] || [])
        next[key] = clone(defaults[key]);
      return next;
    });
    setError("");
    setNotice("Defaults restored to this page. Save to apply them.");
  };
  const save = (event) => {
    event.preventDefault();
    if (!editable || !dirty) return;
    setNotice("");
    if (
      !Number.isSafeInteger(draft.people.minimumFaces) ||
      draft.people.minimumFaces < 1
    ) {
      setError("Minimum faces must be a whole number of at least 1.");
      return;
    }
    if (
      !Number.isSafeInteger(draft.memories.duration) ||
      draft.memories.duration < 1
    ) {
      setError("Memory duration must be a whole number of at least 1 second.");
      return;
    }
    if (
      !Number.isSafeInteger(draft.download.archiveSize) ||
      draft.download.archiveSize < 1
    ) {
      setError(
        "Enter a positive download archive size that resolves to a whole number of bytes.",
      );
      return;
    }
    try {
      const normalized = normalizeAccountPreferences(draft);
      if (onSave(normalized, loadedRevision) !== true) {
        setError(
          "Preferences could not be saved. Your changes are still here.",
        );
        return;
      }
      pendingSave.current = normalized;
      setBaseline(normalized);
      setDraft(clone(normalized));
      setError("");
      setNotice("Preferences saved.");
    } catch {
      setError(
        "Preferences could not be saved. Check these values and try again; your changes are still here.",
      );
    }
  };

  return (
    <form
      className="account-preferences"
      aria-label={`${user.name} ${section}`}
      onSubmit={save}
    >
      {stale && !pendingSave.current && (
        <div className="ap-conflict" role="status">
          <span>
            This account changed since you opened it. Your draft is kept until
            you load the latest preferences.
          </span>
          <button type="button" onClick={loadLatest}>
            Discard draft and load latest
          </button>
        </div>
      )}
      <fieldset className="ap-controls" disabled={!editable}>
        {section === "features" && (
          <>
            <p className="ap-context">
              Feature preferences control tools and navigation for this account.
              They do not restrict access to its data.
            </p>
            <div className="ap-feature-head" aria-hidden="true">
              <span>Feature</span>
              <span>Use tool</span>
              <span>In library navigation</span>
            </div>
            <div className="ap-feature-list">
              {ACCOUNT_FEATURES.map((feature) => {
                const enabled = read(draft, feature.enabledPath);
                return (
                  <div className="ap-feature" key={feature.id}>
                    <div className="ap-feature-name">
                      <strong>{feature.label}</strong>
                      <small>{feature.description}</small>
                    </div>
                    <label className="ap-feature-check">
                      <input
                        type="checkbox"
                        aria-label={feature.label}
                        checked={enabled}
                        onChange={(event) =>
                          change(feature.enabledPath, event.target.checked)
                        }
                      />
                      <span>Use tool</span>
                    </label>
                    {feature.sidebarPath ? (
                      <label className="ap-feature-check">
                        <input
                          type="checkbox"
                          aria-label={`Show ${feature.label.toLowerCase()} in library navigation`}
                          checked={read(draft, feature.sidebarPath)}
                          disabled={!enabled}
                          onChange={(event) =>
                            change(feature.sidebarPath, event.target.checked)
                          }
                        />
                        <span>In library navigation</span>
                      </label>
                    ) : (
                      <span
                        className="ap-not-applicable"
                        aria-label="No separate navigation preference"
                      >
                        —
                      </span>
                    )}
                    {feature.id === "people" && enabled && (
                      <div className="ap-feature-detail">
                        <PreferenceField
                          label="Minimum faces"
                          help="People with fewer matching faces stay out of the main People list."
                        >
                          <input
                            type="number"
                            min="1"
                            step="1"
                            required
                            value={draft.people.minimumFaces}
                            onChange={(event) =>
                              change(
                                ["people", "minimumFaces"],
                                event.target.value === ""
                                  ? ""
                                  : Number(event.target.value),
                              )
                            }
                          />
                        </PreferenceField>
                      </div>
                    )}
                    {feature.id === "memories" && (
                      <div className="ap-feature-detail">
                        <PreferenceField
                          label="Memory duration (seconds)"
                          help="How long each photo appears in a memory."
                        >
                          <input
                            type="number"
                            min="1"
                            step="1"
                            required
                            value={draft.memories.duration}
                            onChange={(event) =>
                              change(
                                ["memories", "duration"],
                                event.target.value === ""
                                  ? ""
                                  : Number(event.target.value),
                              )
                            }
                          />
                        </PreferenceField>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="ap-standalone">
              <Toggle
                label="Show Recently added in library navigation"
                checked={draft.recentlyAdded.sidebarWeb}
                onChange={(value) =>
                  change(["recentlyAdded", "sidebarWeb"], value)
                }
              />
            </div>
          </>
        )}
        {section === "preferences" && (
          <>
            <div className="ap-fields">
              <PreferenceField label="Default album order">
                <select
                  value={draft.albums.defaultAssetOrder}
                  onChange={(event) =>
                    change(["albums", "defaultAssetOrder"], event.target.value)
                  }
                >
                  <option value="desc">Newest first</option>
                  <option value="asc">Oldest first</option>
                </select>
              </PreferenceField>
              <PreferenceField
                label="Download archive size (GiB)"
                help="Larger downloads are split into archives of this size. One GiB is 1,073,741,824 bytes."
              >
                <input
                  type="number"
                  min={1 / GiB}
                  step="any"
                  required
                  value={
                    draft.download.archiveSize === ""
                      ? ""
                      : draft.download.archiveSize / GiB
                  }
                  onChange={(event) =>
                    change(
                      ["download", "archiveSize"],
                      event.target.value === ""
                        ? ""
                        : Math.round(Number(event.target.value) * GiB),
                    )
                  }
                />
              </PreferenceField>
            </div>
            <Toggle
              label="Include motion videos in downloads"
              description="Download the video portion of motion photos along with the still image."
              checked={draft.download.includeEmbeddedVideos}
              onChange={(value) =>
                change(["download", "includeEmbeddedVideos"], value)
              }
            />
            <div className="ap-group">
              <h3>Supporter display</h3>
              <Toggle
                label="Show supporter badge"
                description="Display the badge when this account has an activated supporter key."
                checked={draft.purchase.showSupportBadge}
                onChange={(value) =>
                  change(["purchase", "showSupportBadge"], value)
                }
              />
              <PreferenceField
                label="Support reminder date"
                help="Hide the support reminder until this date. Leave blank to allow it now."
              >
                <input
                  type="date"
                  value={
                    draft.purchase.hideBuyButtonUntil ===
                    "1970-01-01T00:00:00.000Z"
                      ? ""
                      : draft.purchase.hideBuyButtonUntil.slice(0, 10)
                  }
                  onChange={(event) =>
                    change(
                      ["purchase", "hideBuyButtonUntil"],
                      event.target.value
                        ? `${event.target.value}T00:00:00.000Z`
                        : new Date(0).toISOString(),
                    )
                  }
                />
              </PreferenceField>
            </div>
          </>
        )}
        {section === "notifications" && (
          <div className="ap-notifications">
            <Toggle
              label="Email notifications"
              description="Receive email about activity in this account’s albums."
              checked={draft.emailNotifications.enabled}
              onChange={(value) => {
                setDraft((current) => ({
                  ...current,
                  emailNotifications: {
                    ...current.emailNotifications,
                    enabled: value,
                    ...(value
                      ? {}
                      : { albumInvite: false, albumUpdate: false }),
                  },
                }));
                setError("");
                setNotice("");
              }}
            />
            <div className="ap-notification-children">
              <Toggle
                label="Album invitations"
                description="When someone invites this account to an album."
                checked={draft.emailNotifications.albumInvite}
                disabled={!draft.emailNotifications.enabled}
                onChange={(value) =>
                  change(["emailNotifications", "albumInvite"], value)
                }
              />
              <Toggle
                label="Album updates"
                description="When photos or videos are added to a shared album."
                checked={draft.emailNotifications.albumUpdate}
                disabled={!draft.emailNotifications.enabled}
                onChange={(value) =>
                  change(["emailNotifications", "albumUpdate"], value)
                }
              />
            </div>
          </div>
        )}
      </fieldset>
      {section === "preferences" && (
        <div className="ap-private">
          <div>
            <h3>Locked content choices</h3>
            <p>Locked people and tags are managed by the account owner.</p>
          </div>
          {onOpenPrivacy && (
            <button type="button" onClick={onOpenPrivacy}>
              Open my Locked settings
            </button>
          )}
        </div>
      )}
      {error && (
        <p className="ap-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="ap-notice" role="status">
          {notice}
        </p>
      )}
      <footer className="ap-save-bar">
        <span>
          {!editable
            ? "Restore this account to change preferences."
            : dirty
              ? "Unsaved changes"
              : "No unsaved changes"}
        </span>
        <div>
          <button type="button" disabled={!editable} onClick={resetPage}>
            Reset this page
          </button>
          <button
            type="button"
            disabled={!dirty}
            onClick={() => {
              setDraft(clone(baseline));
              setError("");
              setNotice("");
            }}
          >
            Cancel changes
          </button>
          <button
            className="ap-primary"
            type="submit"
            disabled={!dirty || !editable}
          >
            Save preferences
          </button>
        </div>
      </footer>
    </form>
  );
}
