import React, { useEffect, useRef, useState } from "react";
import { Button, Dialog } from "./App";
import { Icon } from "./Icon";
import { SettingsAnalytics, LibraryGrowthChart } from "./SettingsAnalytics";
import {
  ANALYTICS_SUMMARY as summary,
  getAnalytics,
} from "./analytics-data.mjs";
import { PhysicalDedupManager } from "./PhysicalDedupManager";
import { WorkerManager } from "./WorkerManager";
import { HardwareCheck } from "./HardwareCheck";
import { JobsManager } from "./JobsManager";
import { FrameleafCloud, useCloudState } from "./FrameleafCloud";
import { CLOUD_DESTINATION, cloudSummary } from "./frameleaf-cloud-data.mjs";
import { AccountsLibraries, PersonalAccess } from "./AccountsLibraries";
import { ConfigurationTransfer } from "./ConfigurationTransfer";
import { previewStoragePath } from "./configuration-transfer.mjs";
import { ProtectedContent } from "./ProtectedContent";
import { SharingAccess } from "./SharingAccess";
import { TrashManager } from "./TrashManager";
import { UtilitiesManager } from "./UtilitiesManager";
import { Maintenance } from "./Maintenance";
import {
  accountPreferencesToSettings,
  settingsToAccountPreferencesPatch,
} from "./account-preference-settings.mjs";
import {
  loadResourceState,
  subscribeResourceState,
  getScopeOptions,
  applyResourceCommand,
  saveResourceState,
} from "./account-library-data.mjs";
import * as settingsCatalog from "./settings-catalog.mjs";
import {
  parseCommandCenter,
  COMMAND_CENTER_STORAGE_KEY,
  COMMAND_CENTER_LIMITS as limits,
  reconcileAppPreferences,
} from "./settings-state.mjs";
import {
  settingsAreas,
  settingsSections,
  defaultSettings,
  allSettings,
  findSettings,
  settingsDiff,
  displaySetting,
  validateSetting,
} from "./settings-catalog.mjs";
import "./command-center.css";

const storageKey = COMMAND_CENTER_STORAGE_KEY;
const tib = (bytes) => `${(bytes / 1024 ** 4).toFixed(2)} TiB`;
const usedPercent = ((100 * summary.usedBytes) / summary.capacityBytes).toFixed(
  1,
);
const initialEntities = {
  workers: [
    {
      id: "local",
      name: "Home workstation",
      detail: "render.home.arpa · RTX 4070 Ti SUPER · 16 GB",
      status: "Needs qualification",
      type: "Local / LAN",
    },
    {
      id: "cloud",
      name: CLOUD_DESTINATION.name,
      detail: "Only used when explicitly selected for a job",
      status: "Not linked",
      type: "Cloud",
    },
  ],
  libraries: [
    {
      id: "archive",
      name: "Family archive",
      detail: "/mnt/photos/family · Taylor · nightly scan",
      status: "Connected",
      type: "Read-only source",
    },
  ],
  users: [
    {
      id: "taylor",
      name: "Taylor",
      detail: "taylor@example.invalid · 1 TB quota",
      status: "Active",
      type: "Administrator",
    },
    {
      id: "jamie",
      name: "Jamie",
      detail: "jamie@example.invalid · 500 GB quota",
      status: "Active",
      type: "Member",
    },
    {
      id: "emma",
      name: "Emma",
      detail: "emma@example.invalid · 500 GB quota",
      status: "Active",
      type: "Member",
    },
  ],
  spaces: [
    {
      id: "family",
      name: "Family",
      detail: "3 members · owners retain originals",
      status: "Shared",
      type: "Owner",
    },
  ],
  sessions: [
    {
      id: "browser",
      name: "This browser",
      detail: "Taylor · this browser",
      status: "Current session",
      type: "Web",
    },
    {
      id: "phone",
      name: "Taylor’s iPhone",
      detail: "Last seen 2 hours ago",
      status: "Authorized",
      type: "iOS",
    },
    {
      id: "api",
      name: "Archive uploader",
      detail: "Upload-only access",
      status: "Authorized",
      type: "API key",
    },
  ],
};
function readCenter() {
  try {
    return parseCommandCenter(
      localStorage.getItem(storageKey),
      defaultSettings,
      allSettings,
      initialEntities,
    );
  } catch {
    return parseCommandCenter(
      null,
      defaultSettings,
      allSettings,
      initialEntities,
    );
  }
}
const areaFor = (id) =>
  settingsAreas.find((area) => area.id === id) || settingsAreas[0];
function downloadFile(name, data, type = "application/json") {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function CommandCenter({
  destination,
  setDestination,
  theme,
  setTheme,
  defaultLayout,
  showLocked = false,
  onRequestUnlock,
  onLock,
  startArea = "overview",
  onBack,
  onActivity,
  collapsed,
  setCollapsed,
  navOpen,
  closeNav,
  onLayout,
}) {
  const [resources, setResources] = useState(loadResourceState);
  const ownProfile = resources.users.find((user) => user.id === "taylor");
  const [saved] = useState(readCenter);
  const [settings, setSettings] = useState(() => ({
    ...defaultSettings,
    ...saved.settings,
    ...accountPreferencesToSettings(ownProfile.preferences),
    displayName: ownProfile.name,
    accountEmail: ownProfile.email,
    destination,
    themePreference: theme === "light" ? "Light" : "Dark",
    defaultLayout:
      defaultLayout === "timeline"
        ? "Timeline"
        : defaultLayout === "browse"
          ? "Browse"
          : "Work",
  }));
  const [draft, setDraft] = useState(() => ({
    ...settings,
    ...Object.fromEntries(
      allSettings
        .filter(
          (field) =>
            !field.locked && saved.draft[field.id] !== saved.settings[field.id],
        )
        .map((field) => [field.id, saved.draft[field.id]]),
    ),
  }));
  const [changes, setChanges] = useState(saved.history || []);
  const [entities, setEntities] = useState(() => ({
    ...initialEntities,
    ...saved.entities,
    // The retired GPU-provider worker row is shown as Frameleaf Cloud.
    ...(saved.entities?.workers && {
      workers: saved.entities.workers.map((worker) =>
        worker.id === "cloud" && worker.name !== CLOUD_DESTINATION.name
          ? initialEntities.workers.find((item) => item.id === "cloud")
          : worker,
      ),
    }),
  }));
  const [area, setArea] = useState(
    () =>
      areaFor(new URL(location.href).searchParams.get("settings") || startArea)
        .id,
  );
  const [activeSection, setActiveSection] = useState(() => {
    const section =
      new URL(location.href).searchParams.get("section") ||
      { users: "accounts", libraries: "sources", trash: "contents" }[area] ||
      "";
    return settingsSections[area]?.some((item) => item.id === section)
      ? section
      : "";
  });
  const scopeOptions = getScopeOptions(resources);
  const [requestedScope, setRequestedScope] = useState(
    () => new URL(location.href).searchParams.get("accountScope") || "all",
  );
  const scope = scopeOptions.some((item) => item.value === requestedScope)
    ? requestedScope
    : "all";
  const scopeOption = scopeOptions.find((item) => item.value === scope);
  const scopeOwner = scopeOption.userId || "all";
  useEffect(() => subscribeResourceState(setResources), []);
  const [credential, setCredential] = useState(null);
  const [credentialValue, setCredentialValue] = useState("");
  const [templatePreview, setTemplatePreview] = useState(null);
  const [unlinkProvider, setUnlinkProvider] = useState(false);
  const [emailTest, setEmailTest] = useState(null);
  const [unlinkConfirmation, setUnlinkConfirmation] = useState("");
  const [search, setSearch] = useState("");
  const [review, setReview] = useState(false);
  const [workflow, setWorkflow] = useState(null);
  const [entityForm, setEntityForm] = useState(null);
  const [notice, setNotice] = useState("");
  const [saveError, setSaveError] = useState("");
  const [externalConflict, setExternalConflict] = useState(false);
  const [pausedQueues, setPausedQueues] = useState([]);
  const main = useRef(null);
  const start = useRef(startArea);
  const previousPreferences = useRef({ theme, destination, defaultLayout });
  useEffect(() => {
    const patch = {
      displayName: ownProfile.name,
      accountEmail: ownProfile.email,
      ...accountPreferencesToSettings(ownProfile.preferences),
    };
    setDraft((previous) => ({
      ...previous,
      ...Object.fromEntries(
        Object.entries(patch).filter(([id]) => previous[id] === settings[id]),
      ),
    }));
    setSettings((previous) => ({ ...previous, ...patch }));
  }, [
    ownProfile.name,
    ownProfile.email,
    JSON.stringify(ownProfile.preferences),
  ]);
  useEffect(() => {
    const incoming = { theme, destination, defaultLayout };
    const next = reconcileAppPreferences(
      settings,
      draft,
      incoming,
      previousPreferences.current,
    );
    previousPreferences.current = incoming;
    if (next.settings !== settings) setSettings(next.settings);
    if (next.draft !== draft) setDraft(next.draft);
  }, [theme, destination, defaultLayout]);
  const diff = settingsDiff(settings, draft);
  const errors = diff
    .map((field) => ({ ...field, error: validateSetting(field, field.after) }))
    .filter((field) => field.error);
  if (!draft.passwordLogin && !draft.oauthEnabled) {
    errors.push({
      id: "passwordLogin",
      error: "Keep at least one sign-in method enabled.",
    });
  }
  const results = findSettings(search);
  const current = areaFor(area);
  const sections = settingsSections[area] || [];
  const selectedSection = sections.find((item) => item.id === activeSection);
  const ownDuplicateReview =
    area === "utilities" && activeSection === "duplicates";
  function changeSetting(id, value) {
    setDraft((previous) =>
      settingsCatalog.normalizeSettingChange
        ? settingsCatalog.normalizeSettingChange(previous, id, value)
        : { ...previous, [id]: value },
    );
  }
  function navigate(next, section = "") {
    if (
      ["analytics", "libraries"].includes(next) &&
      scopeOptions.some((item) => item.value === section)
    ) {
      setRequestedScope(section);
      section = next === "libraries" ? "sources" : "";
    }
    if (next === "processing" && section === "queue-manager")
      section = "queues";
    if (next === "security" && section === "accounts") next = "users";
    if (next === "backup" && section === "sources") next = "libraries";
    if (!section && next === "users") section = "accounts";
    if (!section && next === "libraries") section = "sources";
    if (!section && next === "trash") section = "contents";
    setArea(areaFor(next).id);
    setActiveSection(
      settingsSections[next]?.some((item) => item.id === section)
        ? section
        : "",
    );
    setSearch("");
    closeNav();
    main.current?.scrollTo({ top: 0 });
  }
  useEffect(() => {
    if (start.current !== startArea) {
      start.current = startArea;
      navigate(startArea);
    }
  }, [startArea]);
  useEffect(() => {
    const url = new URL(location.href);
    url.searchParams.set("screen", "admin");
    url.searchParams.set("settings", area);
    if (activeSection) url.searchParams.set("section", activeSection);
    else url.searchParams.delete("section");
    if (scope !== "all") url.searchParams.set("accountScope", scope);
    else url.searchParams.delete("accountScope");
    history.replaceState({}, "", url);
  }, [area, activeSection, scope]);
  useEffect(() => {
    main.current?.scrollTo({ top: 0 });
  }, [area, activeSection]);
  useEffect(() => {
    const changed = (event) => {
      if (event.key === storageKey || event.key === null)
        setExternalConflict(true);
    };
    addEventListener("storage", changed);
    return () => removeEventListener("storage", changed);
  }, []);
  useEffect(() => {
    if (externalConflict) return;
    try {
      localStorage.setItem(
        storageKey,
        JSON.stringify({
          version: 1,
          settings,
          draft,
          history: changes,
          entities,
        }),
      );
      setSaveError("");
    } catch {
      setSaveError(
        "Device storage is unavailable. Keep this tab open; changes cannot survive reload.",
      );
    }
  }, [settings, draft, changes, entities, externalConflict]);
  useEffect(() => {
    const warn = (event) => {
      if (diff.length && saveError) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    addEventListener("beforeunload", warn);
    return () => removeEventListener("beforeunload", warn);
  }, [diff.length, saveError]);
  function persistEntityChange(nextEntities, title, entries) {
    const nextChanges = [
      { id: crypto.randomUUID(), title, at: new Date().toISOString(), entries },
      ...changes,
    ].slice(0, 50);
    try {
      localStorage.setItem(
        storageKey,
        JSON.stringify({
          version: 1,
          settings,
          draft,
          history: nextChanges,
          entities: nextEntities,
        }),
      );
    } catch {
      setSaveError(
        "Device storage is unavailable. Your changes were not saved.",
      );
      return false;
    }
    setEntities(nextEntities);
    setChanges(nextChanges);
    return true;
  }
  function remember(title, entries) {
    return persistEntityChange(entities, title, entries);
  }
  function applyChanges() {
    if (errors.length || externalConflict) return;
    const next = { ...draft };
    for (const field of allSettings)
      if (field.type === "number") next[field.id] = Number(next[field.id]);
    if (!next.passwordLogin && !next.oauthEnabled) {
      setNotice("Keep at least one sign-in method enabled.");
      setReview(false);
      return;
    }
    let profileNext = null;
    let beforeStorage;
    try {
      beforeStorage = localStorage.getItem(storageKey);
    } catch {
      setSaveError(
        "Device storage is unavailable. Your pending changes have not been applied.",
      );
      setReview(false);
      return;
    }
    if (
      next.displayName !== ownProfile.name ||
      next.accountEmail !== ownProfile.email
    ) {
      try {
        profileNext = applyResourceCommand(resources, {
          type: "edit-user",
          userId: ownProfile.id,
          expectedRevision: resources.revision,
          fields: {
            ...ownProfile,
            name: next.displayName,
            email: next.accountEmail,
          },
        });
      } catch (error) {
        setSaveError(error.message);
        setReview(false);
        return;
      }
    }
    try {
      const preferencePatch = settingsToAccountPreferencesPatch(next, settings);
      if (Object.keys(preferencePatch).length) {
        const current = profileNext || resources;
        profileNext = applyResourceCommand(current, {
          type: "update-user-preferences",
          userId: ownProfile.id,
          expectedRevision: current.revision,
          preferences: preferencePatch,
        });
      }
    } catch (error) {
      setSaveError(error.message);
      setReview(false);
      return;
    }
    const entry = {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      title: `${diff.length} setting${diff.length === 1 ? "" : "s"} changed`,
      entries: diff.map((field) => ({
        label: field.label,
        before: displaySetting(field.before, field),
        after: displaySetting(field.after, field),
      })),
    };
    const nextHistory = [entry, ...changes].slice(0, 50);
    try {
      localStorage.setItem(
        storageKey,
        JSON.stringify({
          version: 1,
          settings: next,
          draft: next,
          history: nextHistory,
          entities,
        }),
      );
      if (profileNext)
        saveResourceState(profileNext, undefined, resources.revision);
    } catch {
      try {
        if (beforeStorage === null) localStorage.removeItem(storageKey);
        else localStorage.setItem(storageKey, beforeStorage);
      } catch {}
      setSaveError(
        "Device storage is unavailable. Your pending changes have not been applied.",
      );
      setNotice(
        "Keep this tab open and retry saving when device storage is available.",
      );
      setReview(false);
      return;
    }
    setChanges(nextHistory);
    setSettings(next);
    setDraft(next);
    setReview(false);
    if (next.destination !== settings.destination)
      setDestination(next.destination);
    if (next.themePreference !== settings.themePreference)
      setTheme(next.themePreference.toLowerCase());
    if (next.defaultLayout !== settings.defaultLayout)
      onLayout(next.defaultLayout.toLowerCase());
    setNotice("Changes saved on this device.");
  }
  function changeEntity(kind, id, updater) {
    const nextEntities = {
      ...entities,
      [kind]: entities[kind].map((item) =>
        item.id === id ? updater(item) : item,
      ),
    };
    const item = entities[kind].find((item) => item.id === id);
    return persistEntityChange(
      nextEntities,
      `Revoked access: ${item.name}`,
      [],
    );
  }
  const showWorkflow = (kind) => {
    if (kind === "health") {
      navigate("utilities", "missing-media");
      return;
    }
    if (kind === "worker") {
      navigate("processing", "workers");
      return;
    }
    setWorkflow({ kind, step: 0 });
  };
  const context = {
    settings: draft,
    entities,
    setEntityForm,
    changeEntity,
    remember,
    setNotice,
    showWorkflow,
    navigate,
    pausedQueues,
    setPausedQueues,
    onActivity,
  };
  return (
    <div
      className={`command-center ${collapsed ? "cc-collapsed" : ""} ${navOpen ? "cc-nav-open" : ""}`}
    >
      <aside className="cc-nav">
        <div className="cc-nav-title">
          <span>Settings</span>
          <Button
            aria-label={
              collapsed
                ? "Expand settings navigation"
                : "Collapse settings navigation"
            }
            icon={collapsed ? "mdiChevronDoubleRight" : "mdiChevronDoubleLeft"}
            onClick={() => setCollapsed(!collapsed)}
          />
        </div>
        <button className="cc-back" onClick={onBack} title="Back to library">
          <Icon name="mdiArrowLeft" />
          <span>Back to library</span>
        </button>
        <nav id="settings-navigation" aria-label="Settings navigation">
          {[...new Set(settingsAreas.map((item) => item.group))].map(
            (group) => (
              <div className="cc-nav-group" key={group}>
                <p>{group}</p>
                {settingsAreas
                  .filter((item) => item.group === group)
                  .map((item) => (
                    <React.Fragment key={item.id}>
                      <button
                        aria-label={item.title}
                        title={item.title}
                        aria-current={area === item.id ? "page" : undefined}
                        className={area === item.id ? "selected" : ""}
                        onClick={() => navigate(item.id)}
                      >
                        <Icon name={item.icon} />
                        <span>{item.title}</span>
                        {item.id === "history" && changes.length > 0 && (
                          <small>{changes.length}</small>
                        )}
                      </button>
                      {area === item.id &&
                        !collapsed &&
                        item.id !== "trash" &&
                        settingsSections[item.id]?.length > 0 && (
                          <div
                            className="cc-nav-children"
                            aria-label={`${item.title} pages`}
                          >
                            {settingsSections[item.id].map((section) => (
                              <button
                                key={section.id}
                                aria-current={
                                  activeSection === section.id
                                    ? "page"
                                    : undefined
                                }
                                onClick={() => navigate(item.id, section.id)}
                              >
                                {section.title}
                              </button>
                            ))}
                          </div>
                        )}
                    </React.Fragment>
                  ))}
              </div>
            ),
          )}
        </nav>
        <div className="cc-nav-foot">
          <Icon name="mdiShieldCheckOutline" />
          <span>
            Administrator <small>Home archive</small>
          </span>
        </div>
      </aside>
      {navOpen && (
        <button
          className="cc-nav-scrim"
          aria-label="Close settings navigation"
          onClick={closeNav}
        />
      )}
      <div className="cc-body">
        <div className="cc-context-bar">
          <span>
            <Icon name="mdiServerOutline" /> {settings.serverName}{" "}
            <span className="cc-context-divider">/</span> Settings
          </span>
          {ownDuplicateReview ? (
            <div className="cc-account-scope">
              <span>Viewing</span>
              <span>{ownProfile.name}’s library</span>
            </div>
          ) : (
            <label className="cc-account-scope">
              <span>Viewing</span>
              <select
                aria-label="Account or library scope"
                value={scope}
                onChange={(event) => setRequestedScope(event.target.value)}
              >
                {["system", "user", "library"].map((kind) => (
                  <optgroup
                    key={kind}
                    label={
                      {
                        system: "Server",
                        user: "Accounts",
                        library: "Libraries",
                      }[kind]
                    }
                  >
                    {scopeOptions
                      .filter((item) => item.kind === kind)
                      .map((item) => (
                        <option key={item.value} value={item.value}>
                          {item.label}
                        </option>
                      ))}
                  </optgroup>
                ))}
              </select>
            </label>
          )}
          <label className="cc-search">
            <Icon name="mdiMagnify" />
            <input
              id="settings-search"
              aria-label="Search all settings"
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Find a setting, feature, or task…"
            />
            <kbd>⌘ K</kbd>
          </label>
        </div>
        <main className="cc-main" ref={main}>
          {(search ||
            (area !== "analytics" &&
              !(
                selectedSection &&
                (["users", "libraries"].includes(area) ||
                  (area === "processing" && activeSection === "queues"))
              ))) && (
            <div className="cc-page-heading">
              <div>
                <p className="cc-overline">
                  {search ? (
                    "Settings search"
                  ) : selectedSection &&
                    selectedSection.title !== current.title ? (
                    <>
                      <button onClick={() => navigate(area)}>
                        {current.title}
                      </button>
                      <Icon name="mdiChevronRight" />
                      {selectedSection.title}
                    </>
                  ) : (
                    current.group
                  )}
                </p>
                <h1>
                  {search
                    ? "Search results"
                    : selectedSection?.title || current.title}
                </h1>
                <p>
                  {search
                    ? `${results.length} matching settings sections`
                    : selectedSection?.description || current.description}
                </p>
              </div>
              <span className="cc-demo">
                <span /> Preview · sample data
              </span>
            </div>
          )}
          {externalConflict && (
            <div role="alert" className="cc-notice error">
              <span>
                Settings changed in another tab. Your draft is kept here until
                you load the latest settings.
              </span>
              <Button
                onClick={() => {
                  const latest = readCenter();
                  setSettings(latest.settings);
                  setDraft(latest.draft);
                  setChanges(latest.history);
                  setEntities(latest.entities);
                  setExternalConflict(false);
                  setReview(false);
                }}
              >
                Discard this draft and load latest
              </Button>
            </div>
          )}
          {scopeOption.kind === "library" &&
            ["processing", "utilities"].includes(area) &&
            !ownDuplicateReview && (
              <p className="cc-subtle">
                Job and utility queues are filtered by account. This view
                includes all libraries owned by{" "}
                {resources.users.find((user) => user.id === scopeOwner)?.name}.
              </p>
            )}
          {saveError && (
            <p className="cc-notice error" role="alert">
              {saveError}
            </p>
          )}
          {notice && (
            <div className="cc-notice" role="status">
              <span>{notice}</span>
              <button
                aria-label="Dismiss settings notice"
                onClick={() => setNotice("")}
              >
                <Icon name="mdiClose" />
              </button>
            </div>
          )}
          {search ? (
            <div className="cc-search-results">
              {results.length ? (
                results.map((result) => (
                  <button
                    key={result.section}
                    onClick={() => navigate(result.area, result.section)}
                  >
                    <Icon name={areaFor(result.area).icon} />
                    <span>
                      <small>{result.areaTitle}</small>
                      <strong>{result.title}</strong>
                      <span>{result.description}</span>
                    </span>
                    <Icon name="mdiChevronRight" />
                  </button>
                ))
              ) : (
                <div className="cc-empty">
                  <h2>No settings found</h2>
                  <p>
                    Try “face”, “backup”, “OAuth”, “transcoding”, or
                    “originals”.
                  </p>
                  <Button onClick={() => setSearch("")}>Clear search</Button>
                </div>
              )}
            </div>
          ) : area === "overview" ? (
            <Overview
              settings={settings}
              navigate={navigate}
              onActivity={onActivity}
              showWorkflow={showWorkflow}
              scope={scope}
              resources={resources}
            />
          ) : area === "analytics" ? (
            <SettingsAnalytics
              onNavigate={navigate}
              scope={scope}
              onScopeChange={setRequestedScope}
            />
          ) : area === "history" ? (
            <ChangeHistory changes={changes} onNavigate={navigate} />
          ) : (
            <>
              {!selectedSection && (
                <SectionDirectory
                  area={current}
                  sections={sections}
                  navigate={navigate}
                />
              )}
              <div className="cc-settings-content">
                {sections
                  .filter((section) => section.id === activeSection)
                  .map((section) => (
                    <section
                      className="cc-section"
                      id={`setting-${section.id}`}
                      key={section.id}
                    >
                      {area === "storage" &&
                        ["retention", "retention-policy"].includes(
                          section.id,
                        ) && (
                          <Button
                            icon="mdiDeleteOutline"
                            onClick={() => navigate("trash", "contents")}
                          >
                            Open your trash
                          </Button>
                        )}
                      {section.id === "deduplication" && (
                        <PhysicalDedupManager
                          settings={settings}
                          scope={scopeOwner}
                          onScopeChange={(value) => setRequestedScope(value)}
                          onNavigate={navigate}
                        />
                      )}
                      {section.id === "workers" && (
                        <WorkerManager
                          values={draft}
                          onSettingChange={changeSetting}
                          onNavigate={navigate}
                        />
                      )}
                      {section.id === "configuration" && (
                        <ConfigurationTransfer
                          settings={settings}
                          draft={draft}
                          onImport={setDraft}
                        />
                      )}
                      {area === "users" && (
                        <AccountsLibraries
                          view="users"
                          defaultQuotaGiB={Number(settings.defaultQuota)}
                          serverConfig={settings}
                          scope={scope}
                          onNavigate={navigate}
                        />
                      )}
                      {area === "libraries" && (
                        <AccountsLibraries
                          view="libraries"
                          scope={scope}
                          onNavigate={navigate}
                        />
                      )}
                      {area === "trash" && (
                        <>
                          {scopeOption.kind === "library" && (
                            <p className="cc-subtle">
                              Trash includes all libraries owned by your
                              account.
                            </p>
                          )}
                          <TrashManager
                            showLocked={showLocked}
                            settings={settings}
                            scope={scopeOwner}
                            onNavigate={navigate}
                          />
                        </>
                      )}
                      {area === "maintenance" && (
                        <Maintenance section={section.id} onNavigate={navigate} />
                      )}
                      {area === "utilities" && (
                        <UtilitiesManager
                          actorId={ownProfile.id}
                          tool={section.id}
                          scope={scopeOwner}
                          onNavigate={navigate}
                        />
                      )}
                      {area === "processing" && section.id === "queues" && (
                        <JobsManager
                          settings={settings}
                          draft={draft}
                          onSettingChange={changeSetting}
                          onNavigate={navigate}
                          scope={scopeOwner}
                          onScopeChange={(value) =>
                            setRequestedScope(
                              value === "system" ? "all" : value,
                            )
                          }
                        />
                      )}
                      {section.id === "routing" && (
                        <FrameleafCloud
                          section="workload-routing"
                          onNavigate={navigate}
                        />
                      )}
                      {area === "processing" && section.id === "hardware" && (
                        <HardwareCheck onNavigate={navigate} />
                      )}
                      {section.module === "FrameleafCloud" && (
                        <FrameleafCloud
                          section={section.id}
                          onNavigate={navigate}
                          draft={draft}
                          onSettingChange={changeSetting}
                          fields={section.fields}
                          errors={errors}
                        />
                      )}
                      {section.id === "frameleaf-account" && (
                        <PersonalAccess
                          section="frameleaf"
                          onNavigate={navigate}
                        />
                      )}
                      {section.id === "advanced-protected-suppression" && (
                        <ProtectedContent
                          showLocked={showLocked}
                          onRequestUnlock={onRequestUnlock}
                          onLock={onLock}
                          onOpenSettings={() =>
                            navigate("preferences", "account-security")
                          }
                        />
                      )}
                      {section.id === "account-security" && (
                        <PersonalAccess
                          section="security"
                          providerAccountUrl={
                            settings.oauthAccountManagementUrl || ""
                          }
                          onNavigate={navigate}
                        />
                      )}
                      {area === "security" && section.id === "credentials" && (
                        <PersonalAccess
                          section="devices"
                          onNavigate={navigate}
                        />
                      )}
                      {area === "sharing" &&
                        ["partner", "advanced-sharing-boundaries"].includes(
                          section.id,
                        ) && (
                          <SharingAccess
                            section={section.id}
                            onNavigate={navigate}
                          />
                        )}
                      {section.panel &&
                        ![
                          "users",
                          "libraries",
                          "queues",
                          "sessions",
                          "workers",
                        ].includes(section.panel) && (
                          <SpecialPanel name={section.panel} {...context} />
                        )}
                      {(["queues", "advanced-protected-suppression"].includes(
                        section.id,
                      ) || section.module === "FrameleafCloud"
                        ? []
                        : section.fields
                      ).map((field) => (
                        <SettingField
                          key={field.id}
                          field={field}
                          value={draft[field.id]}
                          availability={settingsCatalog.getSettingAvailability?.(
                            field,
                            draft,
                          )}
                          errorOverride={
                            errors.find((error) => error.id === field.id)?.error
                          }
                          changed={diff.some(
                            (change) => change.id === field.id,
                          )}
                          onChange={(value) => changeSetting(field.id, value)}
                        />
                      ))}
                      {section.credentials?.map((item) => (
                        <div className="cc-field" key={item.id}>
                          <div>
                            <strong>{item.label}</strong>
                            <p>{item.help}</p>
                            <small>Values are hidden after saving.</small>
                          </div>
                          <Button
                            onClick={() => {
                              setCredential(item);
                              setCredentialValue("");
                            }}
                          >
                            Replace credential
                          </Button>
                        </div>
                      ))}
                      {section.id === "oauth-advanced" && (
                        <div className="cc-section-action">
                          <Button
                            disabled={!settings.oauthEnabled}
                            onClick={() => {
                              setUnlinkProvider(true);
                              setUnlinkConfirmation("");
                            }}
                          >
                            Disconnect all sign-in provider accounts
                          </Button>
                        </div>
                      )}
                      {section.id === "supporter-preference" && (
                        <PersonalAccess
                          section="supporter"
                          onNavigate={navigate}
                        />
                      )}
                      {section.id === "profile" && (
                        <PersonalAccess
                          section="profile"
                          onNavigate={navigate}
                        />
                      )}
                      {section.id === "database-backup" && (
                        <p className="cc-subtle">
                          Preset schedules update the custom expression. All
                          times use the server timezone.
                        </p>
                      )}
                      {section.id === "sources" && (
                        <div className="cc-section-action">
                          <span>Scan schedule</span>
                          {[
                            ["Every night", "0 0 * * *"],
                            ["Every six hours", "0 */6 * * *"],
                            ["Sunday morning", "0 3 * * 0"],
                          ].map(([label, cron]) => (
                            <Button
                              key={label}
                              onClick={() =>
                                changeSetting("libraryScanCron", cron)
                              }
                            >
                              {label}
                            </Button>
                          ))}
                        </div>
                      )}
                      {section.id === "advanced-description-identity" && (
                        <div className="cc-section-action">
                          <Button
                            onClick={() =>
                              changeSetting(
                                "advancedDescriptionRawTemplate",
                                defaultSettings.advancedDescriptionRawTemplate,
                              )
                            }
                          >
                            Restore default prompt
                          </Button>
                        </div>
                      )}
                      {section.id === "advanced-native-oauth" && (
                        <div className="cc-section-action">
                          <Button
                            disabled={
                              !serverCallback(draft.externalUrl) ||
                              !draft.oauthEnabled
                            }
                            onClick={() =>
                              changeSetting(
                                "advancedFrameleafCallback",
                                serverCallback(draft.externalUrl),
                              )
                            }
                          >
                            Use this server’s Frameleaf callback
                          </Button>
                        </div>
                      )}
                      {section.id === "email" && (
                        <div className="cc-section-action">
                          <Button
                            onClick={() =>
                              setEmailTest({
                                recipient: ownProfile.email,
                                result: "",
                                save: false,
                              })
                            }
                          >
                            Test email delivery
                          </Button>
                        </div>
                      )}
                      {section.id === "organization" && (
                        <div className="cc-section-action">
                          <span>Folder presets</span>
                          {[
                            ["Year / month", "{{y}}/{{MM}}/{{filename}}"],
                            [
                              "Year / month / day",
                              "{{y}}/{{MM}}/{{dd}}/{{filename}}",
                            ],
                            ["By album", "{{album}}/{{filename}}"],
                          ].map(([label, template]) => (
                            <Button
                              key={label}
                              onClick={() =>
                                changeSetting("template", template)
                              }
                            >
                              {label}
                            </Button>
                          ))}
                        </div>
                      )}
                      {section.id === "organization" && (
                        <div className="cc-template-sample">
                          <strong>Sample path · Moraine Lake.jpg</strong>
                          <code>
                            {previewStoragePath(draft.template).error ||
                              previewStoragePath(draft.template).path}
                          </code>
                          <p className="cc-subtle">
                            Existing files move only after you review a storage
                            migration.
                          </p>
                        </div>
                      )}
                      {section.id === "email-templates" && (
                        <div className="cc-section-action">
                          <Button
                            onClick={() =>
                              setTemplatePreview(section.fields[0])
                            }
                          >
                            Preview message
                          </Button>
                        </div>
                      )}
                      {section.id === "advanced-icloud" && (
                        <div className="cc-section-action">
                          <Button
                            onClick={() => navigate("utilities", "icloud")}
                          >
                            Manage iCloud connections
                          </Button>
                        </div>
                      )}
                      {section.id === "health" && (
                        <div className="cc-section-action">
                          <Button
                            onClick={() =>
                              navigate("utilities", "missing-media")
                            }
                          >
                            Review missing media
                          </Button>
                          <Button
                            onClick={() =>
                              navigate("utilities", "corrupt-media")
                            }
                          >
                            Review damaged media
                          </Button>
                        </div>
                      )}
                      {section.id === "advanced-duplicate-matching" && (
                        <div className="cc-section-action">
                          <Button
                            onClick={() => navigate("utilities", "duplicates")}
                          >
                            Open duplicate review
                          </Button>
                        </div>
                      )}
                      {section.fields.some((field) => !field.locked) && (
                        <div className="cc-page-tools">
                          <Button
                            onClick={() => {
                              for (const field of section.fields)
                                if (!field.locked)
                                  changeSetting(
                                    field.id,
                                    defaultSettings[field.id],
                                  );
                              setNotice(
                                "Defaults restored to your draft. Review changes to save them.",
                              );
                            }}
                          >
                            Reset this page
                          </Button>
                        </div>
                      )}
                      {section.action && (
                        <div className="cc-section-action">
                          <Button
                            icon={
                              section.actionKind === "diagnostics"
                                ? "mdiDownload"
                                : "mdiChevronRight"
                            }
                            onClick={() =>
                              section.actionKind === "diagnostics"
                                ? (downloadFile(
                                    "frameleaf-sample-diagnostics.json",
                                    JSON.stringify(
                                      {
                                        sample: true,
                                        generatedAt: new Date().toISOString(),
                                        build: "Frameleaf development",
                                        studioQualified: false,
                                        notes:
                                          "Illustrative report. No host inspection, secrets, or media paths.",
                                      },
                                      null,
                                      2,
                                    ),
                                  ),
                                  setNotice("Diagnostics downloaded."))
                                : showWorkflow(section.actionKind)
                            }
                          >
                            {section.action}
                          </Button>
                        </div>
                      )}
                    </section>
                  ))}
              </div>
            </>
          )}
          <div className="cc-bottom-note">
            Built on Immich <span>·</span> Interactive preview · sample data ·
            changes saved on this device
          </div>
        </main>
        {diff.length > 0 && (
          <div className="cc-savebar">
            <span>
              <strong>
                {diff.length} unsaved {diff.length === 1 ? "change" : "changes"}
              </strong>
              <small>
                {errors.length
                  ? `${errors.length} ${errors.length === 1 ? "value needs" : "values need"} attention`
                  : "Review the scope and effect before saving."}
              </small>
            </span>
            <Button
              onClick={() => {
                setDraft(settings);
                setNotice("Unsaved changes discarded.");
              }}
            >
              Discard
            </Button>
            <Button
              primary
              disabled={errors.length > 0 || externalConflict}
              onClick={() => setReview(true)}
            >
              Review changes
              <Icon name="mdiChevronRight" />
            </Button>
          </div>
        )}
      </div>
      {emailTest && (
        <Dialog
          title="Test email delivery"
          close={() => setEmailTest(null)}
          actions={
            <>
              <Button onClick={() => setEmailTest(null)}>Close</Button>
              <Button
                primary
                disabled={
                  !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailTest.recipient) ||
                  !draft.smtpHost.trim()
                }
                onClick={() =>
                  setEmailTest({
                    ...emailTest,
                    result: "Preview completed. No message was sent.",
                  })
                }
              >
                Preview delivery
              </Button>
            </>
          }
        >
          <p>
            Review the recipient and pending delivery settings before testing
            your connection.
          </p>
          <label>
            Recipient
            <input
              type="email"
              value={emailTest.recipient}
              onChange={(event) =>
                setEmailTest({ ...emailTest, recipient: event.target.value })
              }
            />
          </label>
          <dl className="resource-facts">
            <dt>Mail server</dt>
            <dd>
              {draft.smtpHost}:{draft.smtpPort}
            </dd>
            <dt>Security</dt>
            <dd>{draft.smtpSecurity}</dd>
            <dt>Sender</dt>
            <dd>{draft.emailFrom}</dd>
          </dl>
          <p>
            A successful delivery test also saves email settings. Review pending
            changes before using this action on your server.
          </p>
          {emailTest.result && (
            <p role="status" className="cc-notice">
              {emailTest.result}
            </p>
          )}
        </Dialog>
      )}
      {unlinkProvider && (
        <Dialog
          title="Disconnect all provider accounts"
          close={() => setUnlinkProvider(false)}
          actions={
            <>
              <Button onClick={() => setUnlinkProvider(false)}>Cancel</Button>
              <Button
                disabled={unlinkConfirmation !== "DISCONNECT ALL"}
                onClick={() => {
                  try {
                    const next = applyResourceCommand(resources, {
                      type: "admin-unlink-all-oauth",
                      oauthEnabled: settings.oauthEnabled,
                      confirmation: unlinkConfirmation,
                      expectedRevision: resources.revision,
                    });
                    saveResourceState(next, undefined, resources.revision);
                    setUnlinkProvider(false);
                    setNotice(
                      "Sign-in provider connections removed from the sample accounts.",
                    );
                  } catch (error) {
                    setNotice(error.message);
                  }
                }}
              >
                Disconnect all
              </Button>
            </>
          }
        >
          <p>
            {resources.users.filter((user) => user.oauthLinked).length} accounts
            will be disconnected from their sign-in provider. User accounts,
            passwords, sessions and libraries are retained.
          </p>
          <p>
            People who have no password will need an administrator to restore
            their access. This operation cannot be undone.
          </p>
          <label>
            Type DISCONNECT ALL
            <input
              value={unlinkConfirmation}
              onChange={(event) => setUnlinkConfirmation(event.target.value)}
              autoComplete="off"
            />
          </label>
        </Dialog>
      )}
      {credential && (
        <Dialog
          title={credential.label}
          close={() => {
            setCredential(null);
            setCredentialValue("");
          }}
          actions={
            <>
              <Button
                onClick={() => {
                  setCredential(null);
                  setCredentialValue("");
                }}
              >
                Cancel
              </Button>
              <Button
                primary
                disabled={!credentialValue.trim()}
                onClick={() => {
                  if (remember(`Updated ${credential.label}`, [])) {
                    setNotice(
                      "Credential update previewed. The value has been cleared from this form.",
                    );
                    setCredential(null);
                    setCredentialValue("");
                  }
                }}
              >
                Save credential
              </Button>
            </>
          }
        >
          <p>{credential.help}</p>
          <p className="cc-subtle">
            Interactive preview: use a sample value. Credentials are not stored
            on this device.
          </p>
          <label>
            New value
            <input
              type="password"
              autoComplete="new-password"
              maxLength={4096}
              value={credentialValue}
              onChange={(event) => setCredentialValue(event.target.value)}
            />
          </label>
        </Dialog>
      )}
      {templatePreview && (
        <Dialog
          title="Email preview"
          close={() => setTemplatePreview(null)}
          wide
        >
          <label>
            Message
            <select
              value={templatePreview.id}
              onChange={(event) =>
                setTemplatePreview(
                  settingsSections.notifications
                    .find((section) => section.id === "email-templates")
                    .fields.find((field) => field.id === event.target.value),
                )
              }
            >
              {settingsSections.notifications
                .find((section) => section.id === "email-templates")
                .fields.map((field) => (
                  <option key={field.id} value={field.id}>
                    {field.label}
                  </option>
                ))}
            </select>
          </label>
          <p className="cc-subtle">
            Sample recipient · Taylor. Scripts and remote images are disabled.
          </p>
          <iframe
            title="Email message preview"
            className="cc-email-preview"
            sandbox=""
            srcDoc={
              draft[templatePreview.id] ||
              "<p>Your default Frameleaf message will appear here.</p>"
            }
          />
        </Dialog>
      )}
      {review && (
        <Dialog
          title="Review settings changes"
          close={() => setReview(false)}
          wide
          actions={
            <>
              <Button onClick={() => setReview(false)}>Keep editing</Button>
              <Button primary onClick={applyChanges}>
                Save changes
              </Button>
            </>
          }
        >
          <p className="cc-review-intro">
            Review what will change. Jobs already in progress keep their current
            settings and processing location.
          </p>
          <div className="cc-diff">
            {diff.map((field) => (
              <article key={field.id}>
                <strong>{field.label}</strong>
                <small>
                  {areaFor(field.area).title} · {field.impact}
                </small>
                <div>
                  <del>{displaySetting(field.before, field)}</del>
                  <Icon name="mdiChevronRight" />
                  <ins>{displaySetting(field.after, field)}</ins>
                </div>
              </article>
            ))}
          </div>
        </Dialog>
      )}
      {workflow && (
        <WorkflowDialog
          workflow={workflow}
          setWorkflow={setWorkflow}
          settings={draft}
          remember={remember}
          setNotice={setNotice}
          navigate={navigate}
        />
      )}
      {entityForm && (
        <EntityDialog
          form={entityForm}
          close={() => setEntityForm(null)}
          saveError={saveError}
          onSave={(record) => {
            const nextEntities = {
              ...entities,
              [entityForm.kind]: entityForm.item
                ? entities[entityForm.kind].map((item) =>
                    item.id === record.id ? record : item,
                  )
                : [...entities[entityForm.kind], record],
            };
            if (
              !persistEntityChange(
                nextEntities,
                `${entityForm.item ? "Updated" : "Added"} ${record.name}`,
                [
                  {
                    label: entityForm.kind,
                    before: entityForm.item?.type || "Not configured",
                    after: record.type,
                  },
                ],
              )
            )
              return;
            setEntityForm(null);
            setNotice("Changes saved on this device.");
          }}
        />
      )}
    </div>
  );
}

function SettingField({
  field,
  value,
  changed,
  onChange,
  errorOverride,
  availability,
}) {
  const unavailable =
    availability?.enabled === false || availability?.disabled === true;
  const error = errorOverride || validateSetting(field, value);
  const id = `cc-field-${field.id}`;
  return (
    <div className={`cc-field ${changed ? "is-changed" : ""}`}>
      <div>
        <label htmlFor={id}>
          {field.label}
          {changed && (
            <span
              className="cc-changed-dot"
              title="Unsaved change"
              aria-hidden="true"
            />
          )}
        </label>
        <p id={`${id}-help`}>
          {field.help}
          {unavailable && (
            <span className="cc-dependency">{availability.reason}</span>
          )}
        </p>
        {field.locked && (
          <small className="cc-locked">
            {field.policy || "Managed by server policy"}
          </small>
        )}
      </div>
      <div className="cc-field-control">
        {field.type === "toggle" ? (
          <button
            id={id}
            type="button"
            role="switch"
            aria-checked={value}
            aria-describedby={`${id}-help${error ? ` ${id}-error` : ""}`}
            aria-invalid={!!error}
            aria-label={field.label}
            disabled={field.locked || unavailable}
            className={`cc-switch ${value ? "on" : ""}`}
            onClick={() => onChange(!value)}
          >
            <span />
            {value ? "On" : "Off"}
          </button>
        ) : field.type === "select" ? (
          <select
            id={id}
            disabled={field.locked || unavailable}
            value={value}
            aria-describedby={`${id}-help`}
            onChange={(event) => onChange(event.target.value)}
          >
            {field.options.map((option) => (
              <option
                key={option.value ?? option}
                value={option.value ?? option}
              >
                {option.label ?? option}
              </option>
            ))}
          </select>
        ) : field.type === "textarea" ? (
          <textarea
            id={id}
            disabled={field.locked || unavailable}
            value={value}
            aria-describedby={`${id}-help`}
            rows={3}
            maxLength={field.maxLength ?? limits.textCharacters}
            onChange={(event) => onChange(event.target.value)}
          />
        ) : (
          <div className="cc-input-unit">
            <input
              id={id}
              disabled={field.locked || unavailable}
              type={field.type}
              maxLength={field.maxLength ?? limits.textCharacters}
              value={value}
              min={field.min}
              max={field.max}
              step={
                field.type === "number" && field.max <= 1
                  ? 0.05
                  : field.type === "number"
                    ? 1
                    : undefined
              }
              aria-invalid={!!error}
              aria-describedby={`${id}-help${error ? ` ${id}-error` : ""}`}
              onChange={(event) => onChange(event.target.value)}
            />
            {field.unit && <span>{field.unit}</span>}
          </div>
        )}
        {error && (
          <small className="cc-error" id={`${id}-error`}>
            {error}
          </small>
        )}
      </div>
    </div>
  );
}

function Overview({
  settings,
  navigate,
  onActivity,
  showWorkflow,
  scope,
  resources,
}) {
  const report = getAnalytics({ scope, resources });
  const [cloud] = useCloudState();
  const glance = cloudSummary(cloud);
  return (
    <>
      <div className="cc-health-line">
        <span className="cc-status-dot" /> <strong>Library available</strong>
        <span>2 things need attention</span>
        <span className="cc-time">Snapshot · 19 Sep 2026, 12:00 UTC</span>
      </div>
      <div className="cc-metrics">
        <button onClick={() => navigate("analytics")}>
          <span>{report.scopeLabel}</span>
          <strong>{report.summary.items.toLocaleString()}</strong>
          <small>
            Photos, videos & RAW originals
            <Icon name="mdiChevronRight" />
          </small>
        </button>
        <button onClick={() => navigate("storage", "volumes")}>
          <span>Library filesystem</span>
          <strong>
            {(summary.usedBytes / 1024 ** 4).toFixed(2)}{" "}
            <em>/ {tib(summary.capacityBytes)}</em>
          </strong>
          <small>
            {tib(summary.freeBytes)} available
            <Icon name="mdiChevronRight" />
          </small>
        </button>
        <button onClick={() => navigate("backup", "database-backup")}>
          <span>Latest database backup</span>
          <strong>
            02:00 <em>19 Sep</em>
          </strong>
          <small>
            Time to test restoring your photos
            <Icon name="mdiChevronRight" />
          </small>
        </button>
        <button onClick={() => navigate("server", "updates")}>
          <span>Frameleaf version</span>
          <strong className="cc-version">Development</strong>
          <small>
            Updates & build information
            <Icon name="mdiChevronRight" />
          </small>
        </button>
      </div>
      <div className="cc-overview-grid">
        <section className="cc-panel cc-growth">
          <div className="cc-panel-title">
            <div>
              <h2>Library growth</h2>
              <p>Last 12 months</p>
            </div>
            <button onClick={() => navigate("analytics")}>
              Explore analytics <Icon name="mdiChevronRight" />
            </button>
          </div>
          <LibraryGrowthChart compact scope={scope} />
        </section>
        <section className="cc-panel cc-attention">
          <div className="cc-panel-title">
            <h2>Needs your attention</h2>
            <span className="cc-count">2</span>
          </div>
          <button
            className="cc-action-row"
            onClick={() => navigate("backup", "database-backup")}
          >
            <Icon name="mdiBackupRestore" />
            <span>
              <strong>Prove your backup can restore</strong>
              <small>
                Albums, people and edits are backed up, but restoring your
                original photos hasn't been tested yet.
              </small>
            </span>
            <Icon name="mdiChevronRight" />
          </button>
          <button
            className="cc-action-row"
            onClick={() => navigate("processing", "workers")}
          >
            <Icon name="mdiDesktopTowerMonitor" />
            <span>
              <strong>Check what your computers can run</strong>
              <small>
                Studio video export and Dolby Vision aren't set up yet.
              </small>
            </span>
            <Icon name="mdiChevronRight" />
          </button>
          <p className="cc-subtle">Only actionable issues appear here.</p>
        </section>
        <section className="cc-panel">
          <div className="cc-panel-title">
            <div>
              <h2>Storage</h2>
              <p>Photo archive · library filesystem</p>
            </div>
            <button onClick={() => navigate("storage")}>
              Manage
              <Icon name="mdiChevronRight" />
            </button>
          </div>
          <div className="cc-storage-value">
            <strong>{usedPercent}%</strong>
            <span>of {tib(summary.capacityBytes)} used</span>
          </div>
          <meter
            min="0"
            max={summary.capacityBytes}
            value={summary.usedBytes}
            aria-label={`Filesystem storage: ${tib(summary.usedBytes)} of ${tib(summary.capacityBytes)} used`}
          />
          <div className="cc-storage-key">
            <span>
              <i className="originals" />
              Physical originals <strong>{tib(summary.physicalBytes)}</strong>
            </span>
            <span>
              <i className="derivatives" />
              Thumbnails & proxies{" "}
              <strong>
                {tib(summary.thumbnailBytes + summary.proxyBytes)}
              </strong>
            </span>
            <span>
              <i className="other" />
              Database & other{" "}
              <strong>
                {tib(
                  summary.usedBytes -
                    summary.physicalBytes -
                    summary.thumbnailBytes -
                    summary.proxyBytes,
                )}
              </strong>
            </span>
          </div>
          <p className="cc-subtle">
            Counts everything on this drive. Each person's usage can add up to
            more, because identical files are stored only once.
          </p>
        </section>
        <section className="cc-panel">
          <div className="cc-panel-title">
            <div>
              <h2>Background work</h2>
              <p>What's running right now (sample)</p>
            </div>
            <button onClick={() => navigate("processing", "queues")}>
              All work
              <Icon name="mdiChevronRight" />
            </button>
          </div>
          {[
            [
              "Making thumbnails",
              "3 running · 124 waiting",
              "mdiImageMultipleOutline",
            ],
            [
              "Recognising faces",
              "1 running · 42 waiting",
              "mdiAccountMultipleOutline",
            ],
            [
              "Cloud processing",
              cloud.processing.enabled
                ? `${CLOUD_DESTINATION.name} · on`
                : `${CLOUD_DESTINATION.name} · off`,
              "mdiCloudOutline",
            ],
          ].map(([title, status, icon]) => (
            <div className="cc-service-row" key={title}>
              <Icon name={icon} />
              <span>{title}</span>
              <small>{status}</small>
            </div>
          ))}
          <button className="cc-text-link" onClick={onActivity}>
            See all activity <Icon name="mdiChevronRight" />
          </button>
        </section>
      </div>
      <section className="cc-services">
        <h2>System at a glance</h2>
        <div>
          {[
            ["Server", "Running", "mdiServerOutline"],
            ["AI features", "Ready", "mdiImageSearchOutline"],
            [
              "Studio video export",
              "Needs a hardware check",
              "mdiDesktopTowerMonitor",
            ],
            [CLOUD_DESTINATION.name, glance.text, "mdiCloudOutline"],
          ].map(([label, state, icon]) => (
            <button
              key={label}
              className={
                label === CLOUD_DESTINATION.name && glance.attention
                  ? "cc-glance-attention"
                  : undefined
              }
              onClick={() =>
                label === CLOUD_DESTINATION.name
                  ? navigate("cloud")
                  : navigate(label === "Server" ? "server" : "processing")
              }
            >
              <Icon name={icon} />
              <span>
                <strong>{label}</strong>
                <small>{state}</small>
              </span>
              <Icon name="mdiChevronRight" />
            </button>
          ))}
        </div>
      </section>
    </>
  );
}

function SpecialPanel({
  name,
  settings,
  entities,
  setEntityForm,
  changeEntity,
  remember,
  setNotice,
  showWorkflow,
  navigate,
  pausedQueues,
  setPausedQueues,
  onActivity,
}) {
  if (["workers", "libraries", "users", "spaces", "sessions"].includes(name))
    return (
      <div className="cc-entity-list">
        {entities[name]?.map((item) => (
          <article className="cc-entity" key={item.id}>
            <Icon
              name={
                name === "workers"
                  ? item.id === "cloud"
                    ? "mdiCloudOutline"
                    : "mdiDesktopTowerMonitor"
                  : name === "libraries"
                    ? "mdiFolderOutline"
                    : name === "sessions"
                      ? "mdiDevices"
                      : "mdiAccountMultipleOutline"
              }
              size={22}
            />
            <div>
              <strong>{item.name}</strong>
              <p>{item.detail}</p>
              <small>
                {item.type} <span>·</span> {item.status}
              </small>
            </div>
            <div className="cc-entity-actions">
              {name === "sessions" ? (
                <Button
                  disabled={item.id === "browser" || item.status === "Revoked"}
                  onClick={() => {
                    changeEntity(name, item.id, (old) => ({
                      ...old,
                      status: "Revoked",
                    }));
                  }}
                >
                  Revoke
                </Button>
              ) : (
                <Button onClick={() => setEntityForm({ kind: name, item })}>
                  Configure
                </Button>
              )}
              {name === "workers" && (
                <Button onClick={() => showWorkflow("worker")}>
                  Capabilities
                </Button>
              )}
            </div>
          </article>
        ))}
        {name !== "sessions" && (
          <Button
            icon="mdiPlus"
            disabled={entities[name]?.length >= limits.entities}
            onClick={() => setEntityForm({ kind: name })}
          >
            {
              {
                workers: "Add a computer",
                libraries: "Add source folder",
                users: "Add account",
                spaces: "Create Space",
              }[name]
            }
          </Button>
        )}
        {name === "sessions" && (
          <p className="cc-subtle">
            Revoking access signs out the selected device or disables its API
            key.
          </p>
        )}
        {entities[name]?.length >= limits.entities && (
          <p className="cc-subtle">
            This group has reached its limit of {limits.entities} records.
          </p>
        )}
      </div>
    );
  if (name === "volumes")
    return (
      <div className="cc-volume">
        <div>
          <Icon name="mdiHarddisk" size={28} />
          <span>
            <strong>Photo archive</strong>
            <small>/mnt/photos</small>
          </span>
          <span className="cc-volume-free">{tib(summary.freeBytes)} free</span>
        </div>
        <meter
          min="0"
          max={summary.capacityBytes}
          value={summary.usedBytes}
          aria-label={`${tib(summary.usedBytes)} used of ${tib(summary.capacityBytes)}`}
        />
        <p>
          {tib(summary.usedBytes)} used / {tib(summary.capacityBytes)} capacity.
          This is filesystem usage, including non-media files.
        </p>
      </div>
    );
  if (name === "queues")
    return (
      <div className="cc-queue-list">
        {[
          ["Thumbnails", 124, 3],
          ["Photo details", 0, 0],
          ["Face recognition", 42, 1],
          ["Descriptions", 18, 1],
          ["Video playback copies", 6, 1],
          ["Imports", 0, 0],
        ].map(([label, waiting, active]) => (
          <div key={label}>
            <span>
              <strong>{label}</strong>
              <small>
                {pausedQueues.includes(label)
                  ? "Paused for new work"
                  : `${active} running · ${waiting} waiting`}
              </small>
            </span>
            <Button
              onClick={() => {
                setPausedQueues((previous) =>
                  previous.includes(label)
                    ? previous.filter((item) => item !== label)
                    : [...previous, label],
                );
                setNotice("Updated. This only affects new work.");
              }}
            >
              {pausedQueues.includes(label) ? "Resume" : "Pause"}
            </Button>
          </div>
        ))}
        <Button onClick={onActivity}>Open persistent media jobs</Button>
      </div>
    );
  if (name === "devices")
    return (
      <div className="cc-fact-grid">
        <div>
          <strong>Taylor’s iPhone</strong>
          <span>Backup enabled · Wi-Fi only</span>
        </div>
        <div>
          <strong>Permissions belong to the device</strong>
          <span>
            Limited-library access, background uploads, casting, and offline
            files stay available in native apps.
          </span>
        </div>
      </div>
    );
  if (name === "repairs")
    return (
      <div className="cc-repair-grid">
        {[
          [
            "Live Photo pairs",
            "Pair photos with their motion clips",
            "live-photos",
          ],
          [
            "Missing originals",
            "Find moved files and verify their identity",
            "missing-media",
          ],
          [
            "Duplicate groups",
            "Compare copies and choose your keepers",
            "duplicates",
          ],
          [
            "Damaged media & RAW",
            "Separate unsupported formats from confirmed damage",
            "corrupt-media",
          ],
        ].map(([label, description, tool]) => (
          <button key={label} onClick={() => navigate("utilities", tool)}>
            <strong>{label}</strong>
            <span>{description}</span>
            <Icon name="mdiChevronRight" />
          </button>
        ))}
      </div>
    );
  if (name === "qualification")
    return (
      <div className="cc-checklist">
        {[
          ["Studio editing", "Setup required"],
          ["High-precision HDR rendering", "Proof required"],
          ["Edited Dolby Vision", "CM Analyze + Metafier needed"],
          ["Tablet & browser editing", "Setup required"],
        ].map(([label, status]) => (
          <div key={label}>
            <Icon name="mdiCircleOutline" />
            <span>{label}</span>
            <strong>{status}</strong>
          </div>
        ))}
        <p className="cc-subtle">
          ML reachability does not qualify a Studio worker. Local-library and
          quick-edit access remain independent.
        </p>
        <Button onClick={() => navigate("processing", "workers")}>
          Configure worker destinations
        </Button>
      </div>
    );
  if (name === "versions")
    return (
      <>
        <div className="cc-fact-grid">
          <div>
            <strong>Frameleaf · development</strong>
            <span>Development build · release version unavailable.</span>
          </div>
          <div>
            <strong>Built on Immich</strong>
            <span>
              Frameleaf builds on Immich’s open-source photo library. Licenses
              and acknowledgments remain available in About.
            </span>
          </div>
          <div>
            <strong>Video editor build</strong>
            <code>4d62e8082c5e</code>
          </div>
          <div>
            <strong>Studio availability</strong>
            <span>Setup and compatibility checks required.</span>
          </div>
        </div>
        <ReleaseConnection settings={settings} />
      </>
    );
  if (name === "compatibility")
    return (
      <div className="cc-checklist">
        {[
          "Existing library and client connections retained",
          "Existing mobile sign-in supported",
          "Frameleaf mobile apps install alongside existing clients",
          "Library transfer requires integrity checks",
        ].map((label) => (
          <div key={label}>
            <Icon name="mdiShieldCheckOutline" />
            <span>{label}</span>
          </div>
        ))}
      </div>
    );
  return null;
}

function ReleaseConnection({ settings }) {
  const [checked, setChecked] = useState(false);
  return (
    <div className="cc-release-connection">
      <div className="cc-release-status">
        <Icon name="mdiServerOutline" size={22} />
        <div>
          <strong>Frameleaf updates</strong>
          <p>
            Updates come directly from Frameleaf. Your photos and library
            information stay private.
          </p>
        </div>
        <span className="cc-release-badge">
          {checked ? "Unavailable" : "Not checked"}
        </span>
      </div>
      <div className="cc-release-policy">
        <span>
          <Icon name="mdiShieldCheckOutline" /> Frameleaf update service
        </span>
        <span>You decide when to install</span>
      </div>
      <Button onClick={() => setChecked(true)} icon="mdiMagnify">
        {checked ? "Try again" : "Check for updates"}
      </Button>
      {checked && (
        <p className="cc-update-result" role="status">
          Update information is unavailable. Try again later.
        </p>
      )}
    </div>
  );
}

function EntityDialog({ form, close, onSave, saveError }) {
  const [name, setName] = useState(form.item?.name || "");
  const [detail, setDetail] = useState(form.item?.detail || "");
  const options = {
    workers: ["Local / LAN", "Cloud"],
    libraries: ["Read-only source", "Managed uploads"],
    users: ["Member", "Administrator"],
    spaces: ["Owner", "Editor", "Viewer"],
  }[form.kind];
  const [type, setType] = useState(form.item?.type || options[0]);
  return (
    <Dialog
      title={`${form.item ? "Configure" : "Add"} ${{ workers: "computer", libraries: "source folder", users: "account", spaces: "Space" }[form.kind]}`}
      close={close}
      actions={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button
            primary
            disabled={!name.trim() || !detail.trim()}
            onClick={() =>
              onSave({
                id: form.item?.id || crypto.randomUUID(),
                name: name.trim(),
                detail: detail.trim(),
                type,
                status: form.item?.status || "Configured",
              })
            }
          >
            Save changes
          </Button>
        </>
      }
    >
      <p>Keep the name and connection details easy to recognize.</p>
      {saveError && (
        <p className="cc-notice error" role="alert">
          {saveError}
        </p>
      )}
      <label>
        Name
        <input
          autoFocus
          maxLength={limits.entity.name}
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
        />
      </label>
      <label>
        {
          {
            workers: "Address and hardware notes",
            libraries: "Path and scan notes",
            users: "Email and quota notes",
            spaces: "Members and ownership notes",
          }[form.kind]
        }
        <input
          value={detail}
          maxLength={limits.entity.detail}
          onChange={(event) => setDetail(event.target.value)}
          required
        />
      </label>
      <label>
        {form.kind === "users" ? "Server role" : "Type"}
        <select value={type} onChange={(event) => setType(event.target.value)}>
          {options.map((option) => (
            <option key={option}>{option}</option>
          ))}
        </select>
      </label>
      {form.kind === "workers" && (
        <p className="cc-subtle">
          After adding a worker, check its connection and supported tools. Video
          rendering and HDR need additional compatibility checks.
        </p>
      )}
    </Dialog>
  );
}

const workflows = {
  migration: {
    title: "Plan a library move",
    stages: ["Source", "Preflight", "Review"],
    intro: "Move physical files without breaking ownership or references.",
    rows: [
      ["Source", "Photo archive · /mnt/photos"],
      ["Destination", "New administrator-selected volume"],
      ["Verify", "Checksums, references, permissions, and free space"],
      ["Rollback", "Keep source until destination verification completes"],
    ],
    final: "Migration preflight is ready for review. No files were moved.",
  },
  import: {
    title: "Import Google Photos",
    stages: ["Stage", "Scan", "Reconcile"],
    intro: "The import keeps going on the server even if you close this page.",
    rows: [
      ["Source", "2 Takeout archives"],
      ["New photos and videos", "1,248"],
      ["Matched originals", "312 · restore album memberships"],
      ["Needs review", "3 unclear photo details · 2 possible Live Photo pairs"],
    ],
    final: "Review complete. Resolve the flagged items before importing.",
  },
  recovery: {
    title: "Recovery readiness",
    stages: ["Metadata", "Originals", "Restore drill"],
    intro: "A successful database backup is only one part of recovery.",
    rows: [
      ["Database", "Latest backup: 19 Sep at 02:00 UTC"],
      ["Originals", "Independent copy has not been verified"],
      ["Restore drill", "Not recorded"],
      [
        "Next step",
        "Restore into an isolated destination and verify checksums",
      ],
    ],
    final: "Recovery review saved. Original-file verification is still needed.",
  },
  preservation: {
    title: "Preservation export",
    stages: ["Include", "Verify", "Manifest"],
    intro:
      "A portable archive of originals, metadata, and how the library is organized.",
    rows: [
      ["Original files", "Checksums and owner/reference manifest"],
      ["Metadata", "Dates, places, descriptions, manual edits, provenance"],
      ["Organization", "Album hierarchy and memberships"],
      ["Editing", "Versioned recipes and derivative lineage"],
    ],
    final: "Export contents reviewed. Original files remain in your library.",
  },
  description: {
    title: "Try an enrichment change",
    stages: ["Choose sample", "Compare", "Scope"],
    intro: "Understand a prompt change before it reaches your library.",
    rows: [
      ["Sample", "Moraine Lake.jpg"],
      ["Current", "A turquoise lake below the mountains."],
      [
        "Candidate",
        "A turquoise alpine lake with a forested shoreline beneath rugged peaks.",
      ],
      [
        "Impact",
        "Reprocess only explicitly selected descriptions; preserve manual edits.",
      ],
    ],
    final: "Comparison reviewed. Existing descriptions are unchanged.",
  },
  health: {
    title: "Inspect repair evidence",
    stages: ["Findings", "Evidence", "Review"],
    intro: "Never confuse a repair suggestion with a verified fix.",
    rows: [
      ["Finding", "2 original paths are unavailable"],
      ["Evidence", "External mount /mnt/archive is unavailable"],
      [
        "Suggested action",
        "Reconnect the source, then rerun a targeted health check",
      ],
      [
        "Integrity",
        "Nothing is removed from your library while you fix this",
      ],
    ],
    final: "Findings reviewed. Reconnect the source before attempting repairs.",
  },
  email: {
    title: "Preview an alert",
    stages: ["Message", "Recipient", "Delivery"],
    intro: "Send a useful notification with a clear next step.",
    rows: [
      ["Subject", "Frameleaf: your photo archive needs attention"],
      [
        "Message",
        "Storage has crossed your warning threshold. Review the archive before the next import.",
      ],
      ["Recipient", "Administrator"],
      ["Action", "Open Storage & originals"],
    ],
    final: "Preview completed. No email was sent.",
  },
  worker: {
    title: "What this computer can run",
    stages: ["Connection", "Tools", "Checks"],
    intro: "See which editing tools this computer can run.",
    rows: [
      ["AI features", "Answering · models not checked yet"],
      ["Studio renderer", "Rendering compatibility check needed"],
      ["HDR", "HDR compatibility check needed"],
      ["Dolby Vision", "Dolby Vision tools need verification"],
    ],
    final: "Checked. Finish setting up this computer to use Studio.",
  },
  suppression: {
    title: "Hidden memory rules",
    stages: ["People", "Dates", "Review"],
    intro: "Choose what Memories skips; the photos stay in your library.",
    rows: [
      ["People", "No hidden people"],
      ["Dates", "No hidden date ranges"],
      ["Scope", "Memories and suggested stories only"],
      ["Access", "Doesn't change who can see the photos"],
    ],
    final: "Hidden memory rules reviewed.",
  },
};
function WorkflowDialog({
  workflow,
  setWorkflow,
  settings,
  remember,
  setNotice,
}) {
  const model = workflows[workflow.kind];
  const done = workflow.step === model.stages.length - 1;
  return (
    <Dialog
      title={model.title}
      close={() => setWorkflow(null)}
      wide
      actions={
        <>
          <Button
            onClick={() =>
              workflow.step
                ? setWorkflow({ ...workflow, step: workflow.step - 1 })
                : setWorkflow(null)
            }
          >
            {workflow.step ? "Back" : "Cancel"}
          </Button>
          <Button
            primary
            onClick={() => {
              if (!done) setWorkflow({ ...workflow, step: workflow.step + 1 });
              else if (remember(`Reviewed: ${model.title}`, [])) {
                setNotice(model.final);
                setWorkflow(null);
              }
            }}
          >
            {done ? "Done" : "Continue"}
          </Button>
        </>
      }
    >
      <ol className="cc-stepper">
        {model.stages.map((stage, index) => (
          <li
            key={stage}
            aria-current={workflow.step === index ? "step" : undefined}
          >
            <span>{index + 1}</span>
            {stage}
          </li>
        ))}
      </ol>
      <p>{model.intro}</p>
      {workflow.kind === "description" && (
        <img
          className="cc-description-sample"
          src="/media/lake.png"
          alt="Sample photo for description review"
        />
      )}
      <dl className="cc-workflow-facts">
        {model.rows
          .slice(
            workflow.step === 0 ? 0 : workflow.step === 1 ? 1 : 0,
            workflow.step === 0 ? 2 : 4,
          )
          .map(([label, value]) => (
            <React.Fragment key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </React.Fragment>
          ))}
      </dl>
      {done && <p className="cc-notice">{model.final}</p>}
    </Dialog>
  );
}
function ChangeHistory({ changes, onNavigate }) {
  if (!changes.length)
    return (
      <div className="cc-empty">
        <Icon name="mdiHistory" size={36} />
        <h2>No changes yet</h2>
        <p>
          Review and save a setting to start your device’s history. Values,
          scope, and time stay together.
        </p>
        <Button onClick={() => onNavigate("processing")}>
          Configure processing
        </Button>
      </div>
    );
  return (
    <div className="cc-history">
      {changes.map((change) => (
        <article key={change.id}>
          <div>
            <Icon name="mdiHistory" />
            <strong>{change.title}</strong>
            <time>{new Date(change.at).toLocaleString()}</time>
          </div>
          {change.entries?.length > 0 && (
            <details>
              <summary>View changes</summary>
              {change.entries.map((entry, index) => (
                <p key={index}>
                  <strong>{entry.label}</strong>
                  <span>
                    {entry.before} → {entry.after}
                  </span>
                </p>
              ))}
            </details>
          )}
          <small>Taylor · this device</small>
        </article>
      ))}
    </div>
  );
}

// Most areas are server-wide, so only scopes that differ get a tag on the row.
const directoryScope = {
  account: "Just you",
  device: "This device",
  deployment: "Set by your installation",
};
// Section groups for areas that don't need bespoke logic below.
const directoryGroups = {
  storage: {
    volumes: "Storage",
    organization: "Storage",
    migration: "Storage",
    deduplication: "Identical files",
    "advanced-dedup-owner": "Identical files",
    retention: "Trash",
    "retention-policy": "Trash",
  },
  backup: {
    takeout: "Import",
    "devices-backup": "Import",
    "advanced-icloud": "Import",
    "database-backup": "Protection",
    preservation: "Protection",
  },
  sharing: {
    spaces: "Sharing",
    links: "Sharing",
    partner: "Sharing",
    "shared-identities": "People",
    "advanced-sharing-boundaries": "People",
  },
  care: {
    health: "Health",
    "integrity-schedules": "Health",
    "advanced-integrity-budget": "Health",
    repair: "Repairs",
    "enrichment-care": "Repairs",
    "advanced-duplicate-matching": "Duplicates",
  },
  cloud: {
    "cloud-account": "Account",
    "cloud-plan": "Account",
    "cloud-license": "Account",
    "cloud-remote": "Features",
    "cloud-processing": "Features",
    "cloud-backup": "Features",
  },
  security: {
    signin: "Sign-in",
    "frameleaf-signin": "Sign-in",
    "oauth-advanced": "Sign-in",
    "advanced-native-oauth": "Sign-in",
    privacy: "Locked content",
    "advanced-protected-suppression": "Locked content",
    credentials: "Devices",
  },
  notifications: {
    signals: "Alerts",
    email: "Email",
    "email-delivery-advanced": "Email",
    "advanced-mail-reply": "Email",
    templates: "Email templates",
    "email-templates": "Email templates",
  },
  server: {
    identity: "This server",
    branding: "This server",
    "instance-options": "This server",
    updates: "Updates & diagnostics",
    diagnostics: "Updates & diagnostics",
    configuration: "Updates & diagnostics",
    maps: "Maps",
    "advanced-metadata-maps": "Maps",
  },
  preferences: {
    profile: "Account",
    "account-security": "Account",
    "email-preferences": "Account",
    "supporter-preference": "Account",
    "frameleaf-account": "Account",
    appearance: "Library",
    "device-playback": "Library",
    "library-features": "Library",
    rediscovery: "Memories",
    suppression: "Memories",
    downloads: "Downloads",
    "advanced-download-packaging": "Downloads",
  },
};
function sectionGroup(area, section) {
  const id = section.id;
  if (directoryGroups[area]) return directoryGroups[area][id] || "More";
  if (area === "utilities")
    return {
      duplicates: "Organize",
      "large-files": "Organize",
      geolocation: "Organize",
      "live-photos": "Repair",
      "missing-media": "Repair",
      "corrupt-media": "Repair",
      icloud: "Import",
      workflows: "Automate",
      downloads: "Connect",
      obtainium: "Connect",
    }[id];
  if (area === "editing")
    return /image|thumbnail|previews/.test(id)
      ? "Photos"
      : /playback|hls|encoder/.test(id)
        ? "Video playback"
        : "Editing & restoration";
  if (area === "processing")
    return id === "queues"
      ? "Job management"
      : /nightly|schedules/.test(id)
        ? "Schedules & caching"
        : "Computers & where work runs";
  if (area === "intelligence")
    return /smart-album|travel-album|classification/.test(id)
      ? "Categories & smart albums"
      : /description/.test(id)
        ? "Descriptions"
        : /faces|recognition|pets|sensitive|documents/.test(id)
          ? "Recognition & understanding"
          : "Search";
  return "";
}
// Library care is the hub for fixing things, so it also lists the repair tools.
const CARE_TOOLS = ["duplicates", "missing-media", "corrupt-media", "live-photos"];
function SectionDirectory({ area, sections, navigate }) {
  // Tag only the exceptions: an area that is all "just you" needn't say so per row.
  const scopes = sections.map((section) => section.scope);
  const usual = scopes.sort(
    (a, b) =>
      scopes.filter((scope) => scope === b).length -
      scopes.filter((scope) => scope === a).length,
  )[0];
  const rows = [
    ...sections.map((section) => ({
      section,
      areaId: area.id,
      group: sectionGroup(area.id, section),
    })),
    ...(area.id === "care"
      ? (settingsSections.utilities || [])
          .filter((section) => CARE_TOOLS.includes(section.id))
          .map((section) => ({ section, areaId: "utilities", group: "Tools" }))
      : []),
  ];
  return (
    <div className="cc-directory">
      {[...new Set(rows.map((row) => row.group))].map((group) => (
        <section key={group}>
          {group && <h2>{group}</h2>}
          <div className="cc-directory-list">
            {rows
              .filter((row) => row.group === group)
              .map(({ section, areaId }) => (
                <button
                  key={`${areaId}-${section.id}`}
                  onClick={() => navigate(areaId, section.id)}
                >
                  {section.icon && <Icon name={section.icon} />}
                  <span>
                    <strong>{section.title}</strong>
                    <span>{section.description}</span>
                  </span>
                  {section.scope !== usual && directoryScope[section.scope] && (
                    <small className="cc-directory-scope">
                      {directoryScope[section.scope]}
                    </small>
                  )}
                  <Icon name="mdiChevronRight" />
                </button>
              ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function serverCallback(value) {
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return "";
    return new URL("/api/oauth/frameleaf-mobile-redirect", url.origin).href;
  } catch {
    return "";
  }
}
