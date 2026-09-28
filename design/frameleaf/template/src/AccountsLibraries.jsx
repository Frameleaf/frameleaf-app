import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { PersonAvatar } from "./People";
import { AccountPreferences } from "./AccountPreferences";
import { AVATAR_COLORS } from "./account-preferences.mjs";
import { GiB, getAnalytics } from "./analytics-data.mjs";
import {
  RESOURCE_ACTOR_ID,
  PERSONAL_KEY_SCOPES,
  advanceResourceScans,
  applyResourceCommand,
  getScopeOptions,
  loadResourceState,
  saveResourceState,
  subscribeResourceState,
  validateImportPaths,
  providerAccountManagementLink,
} from "./account-library-data.mjs";
import { FrameleafAccountLink } from "./FrameleafCloud";
import "./accounts-libraries.css";

const count = (value) => value.toLocaleString("en-CA");
const bytes = (value) =>
  `${(value / GiB).toLocaleString("en-CA", { maximumFractionDigits: 1 })} GiB`;
const when = (value) =>
  value
    ? new Date(value).toLocaleDateString("en-CA", {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "Not yet";
const makeId = (prefix) => `${prefix}-${crypto.randomUUID()}`;
const statsFor = (state, scope) =>
  getAnalytics({ resources: state, scope }).summary;

function useAccounts() {
  const [state, setState] = useState(loadResourceState);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => subscribeResourceState(setState), []);
  useEffect(() => {
    if (
      !state.libraries.some((l) =>
        ["queued", "running"].includes(l.scan?.status),
      )
    )
      return;
    const timer = setInterval(() => {
      try {
        const current = loadResourceState();
        const next = advanceResourceScans(current);
        if (next !== current)
          setState(saveResourceState(next, undefined, current.revision));
      } catch (error) {
        setError(error.message);
      }
    }, 500);
    return () => clearInterval(timer);
  }, [state.libraries]);
  const run = (command, success) => {
    try {
      const current = loadResourceState();
      const next = applyResourceCommand(current, command);
      setState(saveResourceState(next, undefined, current.revision));
      setError("");
      setNotice(success || next.history[0].action);
      return true;
    } catch (error) {
      setError(error.message);
      return false;
    }
  };
  return { state, error, notice, run, setError };
}

function Button({ children, primary = false, danger = false, ...props }) {
  return (
    <button
      type="button"
      className={`resource-button ${primary ? "primary" : ""} ${danger ? "danger" : ""}`}
      {...props}
    >
      {children}
    </button>
  );
}
function Status({ children, warning = false }) {
  return (
    <span className={`resource-status ${warning ? "warning" : ""}`}>
      {children}
    </span>
  );
}
function Field({ label, children, hint }) {
  return (
    <label className="resource-field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
function Check({ label, ...props }) {
  return (
    <label className="resource-check">
      <input type="checkbox" {...props} />
      <span>{label}</span>
    </label>
  );
}
function Dialog({ title, onClose, children, error }) {
  const dialog = useRef(null);
  const titleId = useId();
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.showModal();
    return () => previous?.isConnected && previous.focus();
  }, []);
  return (
    <dialog
      className="resource-dialog"
      ref={dialog}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header>
        <h2 id={titleId}>{title}</h2>
        <Button aria-label="Close dialog" onClick={onClose}>
          ×
        </Button>
      </header>
      {error && (
        <p className="resource-error" role="alert">
          {error}
        </p>
      )}
      {children}
    </dialog>
  );
}
function Snapshot({ stats }) {
  return (
    <>
      <dl className="resource-stats">
        <div>
          <dt>Photos</dt>
          <dd>{count(stats.photos)}</dd>
        </div>
        <div>
          <dt>Videos</dt>
          <dd>{count(stats.videos)}</dd>
        </div>
        <div>
          <dt>Originals · logical</dt>
          <dd>{bytes(stats.logicalBytes)}</dd>
        </div>
        <div>
          <dt>Originals · physical</dt>
          <dd>{bytes(stats.physicalBytes)}</dd>
        </div>
      </dl>
      <p className="resource-footnote">
        Library snapshot · {when(stats.asOf)}. Logical storage counts each
        original reference; physical storage counts shared files once.
      </p>
    </>
  );
}
function Quota({ user, stats }) {
  return (
    <div className="resource-quota">
      <span>
        {bytes(stats.logicalBytes)}{" "}
        <small>
          / {user.quotaBytes === null ? "unlimited" : bytes(user.quotaBytes)}
        </small>
      </span>
      {user.quotaBytes !== null && (
        <>
          <progress
            aria-label={`${user.name} quota usage`}
            max={Math.max(1, user.quotaBytes)}
            value={Math.min(stats.logicalBytes, Math.max(1, user.quotaBytes))}
          />
          <small>
            {stats.logicalBytes > user.quotaBytes
              ? "Over quota · new uploads need more space"
              : `${bytes(Math.max(0, user.quotaBytes - stats.logicalBytes))} remaining`}
          </small>
        </>
      )}
    </div>
  );
}

function UserForm({
  user,
  state,
  onSave,
  onClose,
  defaultQuotaGiB,
  serverConfig,
}) {
  const [fields, setFields] = useState(() => ({
    name: user?.name || "",
    email: user?.email || "",
    storageLabel: user?.storageLabel || "",
    isAdmin: user?.isAdmin || false,
    avatarColor: user?.avatarColor ?? "",
    quota: user
      ? user.quotaBytes === null
        ? ""
        : String(user.quotaBytes / GiB)
      : Number.isFinite(defaultQuotaGiB) && defaultQuotaGiB >= 0
        ? String(defaultQuotaGiB)
        : "",
    shouldChangePassword: user?.shouldChangePassword ?? true,
    notify: !!serverConfig.smtpEnabled,
    password: "",
    confirm: "",
  }));
  const [authentication, setAuthentication] = useState(
    !user && serverConfig.oauthEnabled && serverConfig.passwordLogin === false
      ? "provider"
      : "password",
  );
  const [revision] = useState(state.revision);
  const [error, setError] = useState("");
  const set = (key, value) =>
    setFields((fields) => ({ ...fields, [key]: value }));
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (
          !user &&
          authentication === "password" &&
          fields.password !== fields.confirm
        )
          return setError("The passwords do not match.");
        const quotaBytes =
          fields.quota === "" ? null : Math.round(Number(fields.quota) * GiB);
        if (
          onSave({
            type: user ? "edit-user" : "create-user",
            userId: user?.id,
            id: user ? undefined : makeId("user"),
            expectedRevision: revision,
            authentication: user ? undefined : authentication,
            serverConfig,
            fields: {
              ...fields,
              avatarColor: fields.avatarColor || null,
              quotaBytes,
            },
          })
        )
          onClose();
      }}
    >
      <div className="resource-form-grid">
        <Field label="Name">
          <input
            required
            maxLength={160}
            autoFocus
            value={fields.name}
            onChange={(e) => set("name", e.target.value)}
          />
        </Field>
        <Field label="Email">
          <input
            type="email"
            required
            maxLength={254}
            value={fields.email}
            onChange={(e) => set("email", e.target.value)}
          />
        </Field>
        <Field label="Role">
          <select
            value={fields.isAdmin ? "admin" : "user"}
            disabled={user?.id === RESOURCE_ACTOR_ID}
            onChange={(e) => set("isAdmin", e.target.value === "admin")}
          >
            <option value="user">User</option>
            <option value="admin">Administrator</option>
          </select>
        </Field>
        <Field
          label="Avatar color"
          hint="Used when the account has no profile photo."
        >
          <select
            value={fields.avatarColor}
            onChange={(e) => set("avatarColor", e.target.value)}
          >
            <option value="">Automatic</option>
            {AVATAR_COLORS.map((color) => (
              <option key={color} value={color}>
                {color[0].toUpperCase() + color.slice(1)}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Storage quota (GiB)"
          hint="Leave blank for no limit. A quota of 0 blocks new uploads while keeping existing photos."
        >
          <input
            type="number"
            min={0}
            step="any"
            placeholder="Unlimited"
            value={fields.quota}
            onChange={(e) => set("quota", e.target.value)}
          />
        </Field>
        <Field
          label="Storage label"
          hint="Optional folder label: letters, numbers, hyphens or underscores."
        >
          <input
            maxLength={80}
            pattern="[a-zA-Z0-9_-]*"
            value={fields.storageLabel}
            onChange={(e) => set("storageLabel", e.target.value)}
          />
        </Field>
        {!user && serverConfig.oauthEnabled && (
          <Field label="Sign-in method">
            <select
              value={authentication}
              onChange={(e) => setAuthentication(e.target.value)}
            >
              <option value="password">Password</option>
              <option value="provider">Sign-in provider only</option>
            </select>
          </Field>
        )}
        {!user && authentication === "password" && (
          <>
            <Field label="Initial password">
              <input
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                maxLength={256}
                value={fields.password}
                onChange={(e) => set("password", e.target.value)}
              />
            </Field>
            <Field label="Confirm password">
              <input
                type="password"
                autoComplete="new-password"
                required
                value={fields.confirm}
                onChange={(e) => set("confirm", e.target.value)}
              />
            </Field>
          </>
        )}
      </div>
      {user && fields.storageLabel !== user.storageLabel && (
        <p className="resource-notice">
          Changing the label does not move existing files. Run storage template
          migration separately when you are ready.
        </p>
      )}
      {fields.quota !== "" &&
        Number(fields.quota) * GiB > statsFor(state, "all").capacityBytes && (
          <p className="resource-notice">
            This quota is larger than the host’s total capacity. A quota does
            not reserve disk space.
          </p>
        )}
      {authentication !== "provider" && (
        <Check
          label="Require a password change at next sign-in"
          checked={fields.shouldChangePassword}
          onChange={(e) => set("shouldChangePassword", e.target.checked)}
        />
      )}
      {!user && serverConfig.smtpEnabled && (
        <Check
          label="Send a welcome email"
          checked={fields.notify}
          onChange={(e) => set("notify", e.target.checked)}
        />
      )}
      {error && (
        <p role="alert" className="resource-error">
          {error}
        </p>
      )}
      <footer>
        <Button onClick={onClose}>Cancel</Button>
        <button className="resource-button primary" type="submit">
          {user ? "Save account" : "Create account"}
        </button>
      </footer>
    </form>
  );
}
function PathList({ label, values, onChange, placeholder }) {
  return (
    <fieldset className="resource-path-list">
      <legend>{label}</legend>
      {values.map((value, index) => (
        <div key={index}>
          <input
            aria-label={`${label} ${index + 1}`}
            value={value}
            maxLength={1024}
            required
            placeholder={placeholder}
            onChange={(e) =>
              onChange(
                values.map((item, i) => (i === index ? e.target.value : item)),
              )
            }
          />
          <Button
            aria-label={`Remove ${label.toLowerCase()} ${index + 1}`}
            onClick={() => onChange(values.filter((_, i) => i !== index))}
          >
            Remove
          </Button>
        </div>
      ))}
      <Button
        disabled={values.length >= 128}
        onClick={() => onChange([...values, ""])}
      >
        Add {label === "Import folders" ? "folder" : "exclusion"}
      </Button>
    </fieldset>
  );
}
function LibraryForm({ library, state, onSave, onClose, ownerId }) {
  const [fields, setFields] = useState(() => ({
    name: library?.name || "",
    ownerId: library?.ownerId || ownerId || RESOURCE_ACTOR_ID,
    importPaths: library?.importPaths || [],
    exclusionPatterns: library?.exclusionPatterns || ["**/.DS_Store"],
  }));
  const [revision] = useState(state.revision);
  const [validation, setValidation] = useState(null);
  const set = (key, value) => {
    setFields((f) => ({ ...f, [key]: value }));
    setValidation(null);
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (
          onSave({
            type: library ? "edit-library" : "create-library",
            id: library ? undefined : makeId("library"),
            libraryId: library?.id,
            expectedRevision: revision,
            fields,
          })
        )
          onClose();
      }}
    >
      <div className="resource-form-grid">
        <Field label="Library name">
          <input
            required
            autoFocus
            maxLength={160}
            value={fields.name}
            onChange={(e) => set("name", e.target.value)}
          />
        </Field>
        <Field
          label="Owner"
          hint="Ownership is fixed after the library is created."
        >
          <select
            disabled={!!library}
            value={fields.ownerId}
            onChange={(e) => set("ownerId", e.target.value)}
          >
            {state.users
              .filter((u) => u.status === "active")
              .map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
          </select>
        </Field>
      </div>
      <p className="resource-notice">
        External libraries index files already on your server. Your source
        folders stay in place.
      </p>
      <PathList
        label="Import folders"
        values={fields.importPaths}
        onChange={(value) => set("importPaths", value)}
        placeholder="/mnt/photos/family"
      />
      <PathList
        label="Exclusion patterns"
        values={fields.exclusionPatterns}
        onChange={(value) => set("exclusionPatterns", value)}
        placeholder="**/cache/**"
      />
      <Button
        onClick={() => setValidation(validateImportPaths(fields.importPaths))}
        disabled={!fields.importPaths.length}
      >
        Check path format
      </Button>
      {validation && (
        <div role="status" className="resource-validation">
          {validation.map((row, i) => (
            <p key={i}>
              <code>{row.path || "Empty path"}</code> · {row.message}
            </p>
          ))}
          <small>
            Folder availability and permissions are checked when the server
            scans.
          </small>
        </div>
      )}
      <p className="resource-footnote">
        Saving paths and exclusions does not start a scan.
      </p>
      <footer>
        <Button onClick={onClose}>Cancel</Button>
        <button className="resource-button primary" type="submit">
          {library ? "Save library" : "Create library"}
        </button>
      </footer>
    </form>
  );
}

const passwordAlphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
export function generateTemporaryPassword(length = 16) {
  const values = new Uint32Array(length);
  if (globalThis.crypto?.getRandomValues) crypto.getRandomValues(values);
  else for (let i = 0; i < length; i += 1) values[i] = Math.floor(Math.random() * 2 ** 32);
  const characters = [...values].map(
    (value) => passwordAlphabet[value % passwordAlphabet.length],
  );
  return characters.join("").replace(/(.{4})(?=.)/g, "$1-");
}
function ResourceAction({ action, state, run, onClose, deleteDelay = 7 }) {
  const [confirmation, setConfirmation] = useState("");
  const [approved, setApproved] = useState(false);
  const [password, setPassword] = useState("");
  const [force, setForce] = useState(false);
  const [issued, setIssued] = useState("");
  const [copied, setCopied] = useState(false);
  const user = state.users.find((u) => u.id === action.userId);
  const library = state.libraries.find((l) => l.id === action.libraryId);
  const deleting = action.type === "delete-user";
  const removing = action.type === "remove-library";
  const resetting = action.type === "reset-password";
  if (issued)
    return (
      <div className="resource-issued">
        <p>
          Give this temporary password to {user.name}. It is shown once and must
          be changed at their next sign-in.
        </p>
        <div className="resource-secret">
          <code aria-label="Temporary password">{issued}</code>
          <Button
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(issued);
                setCopied(true);
              } catch {
                setCopied(false);
              }
            }}
          >
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
        <p role="status" className="resource-footnote">
          {copied
            ? "Copied to the clipboard."
            : "Copy it now. Closing this dialog hides it for good."}
        </p>
        <footer>
          <button
            type="button"
            className="resource-button primary"
            onClick={onClose}
          >
            Done
          </button>
        </footer>
      </div>
    );
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const temporary = resetting ? generateTemporaryPassword() : "";
        if (
          run({
            ...action,
            confirmEmail: confirmation,
            confirmName: confirmation,
            confirmAssets: approved,
            password: resetting ? temporary.replace(/-/g, "") : password,
            pin: password,
            force,
            deleteDelay,
          })
        ) {
          if (resetting) setIssued(temporary);
          else onClose();
        }
      }}
    >
      {deleting ? (
        <>
          <p>
            {user.name} will lose access. Their account can be restored for{" "}
            {deleteDelay} days, and their files remain during that recovery
            period.
          </p>
          <Check
            label="Skip recovery and permanently remove this account"
            checked={force}
            onChange={(e) => setForce(e.target.checked)}
          />
          {force && (
            <p className="resource-error">
              The account and its owned library entries will be removed. This
              cannot be undone.
            </p>
          )}
          <Field label="Type the account email to confirm">
            <input
              autoFocus
              required
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              placeholder={user.email}
            />
          </Field>
        </>
      ) : removing ? (
        <>
          <p>
            Remove {library.name} and its indexed entries? The files in your
            source folders will remain.
          </p>
          <Field label="Type the library name to confirm">
            <input
              autoFocus
              required
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
            />
          </Field>
          <Check
            label={`I understand that ${count(statsFor(state, `library:${library.id}`).items)} indexed items will be removed from the library.`}
            checked={approved}
            required
            onChange={(e) => setApproved(e.target.checked)}
          />
        </>
      ) : resetting ? (
        <>
          <p>
            A one-time temporary password will be generated for {user.name}.
            Their current password stops working, their devices stay signed in,
            and they must choose a new password at their next sign-in.
          </p>
          <p className="resource-footnote">
            The temporary password is shown once, right after you confirm.
          </p>
        </>
      ) : action.type === "set-pin" ? (
        <Field label="New six-digit PIN">
          <input
            required
            autoFocus
            type="password"
            inputMode="numeric"
            autoComplete="new-password"
            pattern="[0-9]{6}"
            minLength={6}
            maxLength={6}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
      ) : action.type === "reset-pin" ? (
        <p>
          Clear {user.name}’s PIN so they can set a new one after signing in.
          Their protected media stays protected.
        </p>
      ) : action.type === "restore-user" ? (
        <p>
          Restore {user.name}’s account and library access? Previously
          signed-out devices will need to sign in again.
        </p>
      ) : (
        <p>
          Sign this device out? It will need to sign in again to access the
          library.
        </p>
      )}
      <footer>
        <Button onClick={onClose}>Cancel</Button>
        <button
          type="submit"
          className={`resource-button ${deleting || removing ? "danger" : "primary"}`}
        >
          {resetting ? "Generate temporary password" : action.label || "Confirm"}
        </button>
      </footer>
    </form>
  );
}

export function AccountsLibraries({
  view = "users",
  onNavigate,
  scope = "all",
  defaultQuotaGiB,
  serverConfig = {},
}) {
  const { state, error, notice, run, setError } = useAccounts();
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("name");
  const [filter, setFilter] = useState("active");
  const [selectedId, setSelectedId] = useState(null);
  const [tab, setTab] = useState("overview");
  const [preferenceSection, setPreferenceSection] = useState("features");
  const [preferencesDirty, setPreferencesDirty] = useState(false);
  const [pendingDetail, setPendingDetail] = useState(null);
  const detailRef = useRef(null);
  useEffect(() => {
    if (selectedId) detailRef.current?.scrollIntoView?.({ block: "start" });
  }, [selectedId, tab]);
  const [modal, setModal] = useState(null);
  const selectedScope = getScopeOptions(state).find(
    (option) => option.value === scope,
  );
  const usersView = view === "users";
  const selectDetail = (id) => {
    if (id === selectedId) return;
    if (preferencesDirty) {
      setPendingDetail({ id });
      return;
    }
    setSelectedId(id);
    setTab("overview");
  };
  const deleteDelay =
    Number.isInteger(Number(serverConfig.deleteDelay)) &&
    Number(serverConfig.deleteDelay) >= 1
      ? Number(serverConfig.deleteDelay)
      : 7;
  useEffect(() => {
    setSearch("");
    setFilter("active");
    setSelectedId(null);
    setTab("overview");
    setModal(null);
    setPreferencesDirty(false);
    setPendingDetail(null);
  }, [view]);
  useEffect(() => {
    if (usersView && selectedScope?.userId) selectDetail(selectedScope.userId);
    if (!usersView && selectedScope?.libraryId)
      setSelectedId(selectedScope.libraryId);
  }, [scope, usersView]);
  const summaries = useMemo(
    () =>
      Object.fromEntries(
        [
          ...[
            ...state.users.map((u) => u.id),
            ...state.libraries.map((l) => `library:${l.id}`),
          ],
        ].map((scope) => [scope, statsFor(state, scope)]),
      ),
    [state.users, state.libraries],
  );
  const rows = (usersView ? state.users : state.libraries)
    .filter((row) => {
      if (
        selectedScope?.userId &&
        (usersView ? row.id : row.ownerId) !== selectedScope.userId
      )
        return false;
      if (
        !usersView &&
        selectedScope?.libraryId &&
        row.id !== selectedScope.libraryId
      )
        return false;
      if (filter === "active" && row.status !== "active") return false;
      if (filter === "deleted" && row.status === "active") return false;
      if (filter === "admin" && !row.isAdmin) return false;
      if (["upload", "external"].includes(filter) && row.kind !== filter)
        return false;
      return `${row.name} ${row.email || ""} ${state.users.find((u) => u.id === row.ownerId)?.name || ""}`
        .toLowerCase()
        .includes(search.toLowerCase());
    })
    .sort((a, b) =>
      sort === "storage"
        ? summaries[usersView ? b.id : `library:${b.id}`].logicalBytes -
          summaries[usersView ? a.id : `library:${a.id}`].logicalBytes
        : sort === "created"
          ? b.createdAt.localeCompare(a.createdAt)
          : a.name.localeCompare(b.name),
    );
  const selected = (usersView ? state.users : state.libraries).find(
    (row) => row.id === selectedId,
  );
  const selectedStats =
    selected && summaries[usersView ? selected.id : `library:${selected.id}`];
  const owner = selected && state.users.find((u) => u.id === selected.ownerId);
  const open = (value) => {
    setError("");
    setModal(value);
  };
  const scan = (library) =>
    run({
      type: "scan-library",
      libraryId: library.id,
      matched: summaries[`library:${library.id}`].items,
    });
  const activeExternal = rows.filter(
    (l) =>
      l.kind === "external" &&
      l.status === "active" &&
      l.importPaths.length &&
      state.users.find((u) => u.id === l.ownerId)?.status === "active" &&
      !["queued", "running"].includes(l.scan?.status),
  );
  return (
    <section
      className="accounts-libraries"
      aria-label={usersView ? "Accounts" : "Libraries"}
    >
      <header className="resource-heading">
        <div>
          <p className="resource-eyebrow">
            {usersView ? "Your server" : "Your library"}
          </p>
          <h1>{usersView ? "Users" : "Libraries"}</h1>
          <p>
            {usersView
              ? "Manage profiles, features, preferences, storage and sign-in."
              : "Connect existing folders and manage each owner’s collection."}
          </p>
        </div>
        <div className="resource-actions">
          {!usersView && (
            <Button
              disabled={!activeExternal.length}
              onClick={() => {
                for (const library of activeExternal) scan(library);
              }}
            >
              Scan {activeExternal.length} libraries
            </Button>
          )}
          <Button
            primary
            onClick={() =>
              open({ type: usersView ? "create-user" : "create-library" })
            }
          >
            {usersView ? "Create account" : "Add external library"}
          </Button>
        </div>
      </header>
      <div className="resource-toolbar">
        <input
          type="search"
          aria-label={usersView ? "Find an account" : "Find a library"}
          placeholder={
            usersView ? "Search names or email" : "Search libraries or owners"
          }
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          aria-label="Filter records"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          <option value="active">Active</option>
          <option value="all">All</option>
          <option value="deleted">{usersView ? "Deleted" : "Removed"}</option>
          {usersView ? (
            <option value="admin">Administrators</option>
          ) : (
            <>
              <option value="upload">Managed uploads</option>
              <option value="external">External folders</option>
            </>
          )}
        </select>
        <select
          aria-label="Sort records"
          value={sort}
          onChange={(e) => setSort(e.target.value)}
        >
          <option value="name">Name</option>
          <option value="storage">Storage used</option>
          <option value="created">Newest first</option>
        </select>
        <span>
          {rows.length} {usersView ? "accounts" : "libraries"}
        </span>
      </div>
      {!modal && error && (
        <p className="resource-error" role="alert">
          {error}
        </p>
      )}
      <p className="resource-live" role="status">
        {notice}
      </p>
      <div
        className="resource-table-scroll"
        role="region"
        aria-label={usersView ? "Account table" : "Library table"}
        tabIndex={0}
      >
        <table className="resource-table">
          <thead>
            <tr>
              <th scope="col">{usersView ? "Account" : "Library"}</th>
              <th scope="col">{usersView ? "Role" : "Owner / source"}</th>
              <th scope="col">Items</th>
              <th scope="col">
                {usersView ? "Storage used / quota" : "Originals · logical"}
              </th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const stats = summaries[usersView ? row.id : `library:${row.id}`];
              const rowOwner = state.users.find((u) => u.id === row.ownerId);
              return (
                <tr key={row.id} data-selected={selectedId === row.id}>
                  <th scope="row">
                    <button
                      className="resource-row-name"
                      onClick={() => {
                        selectDetail(row.id);
                      }}
                    >
                      {usersView && <PersonAvatar person={row} size={36} />}
                      <span>
                        <strong>{row.name}</strong>
                        <small>
                          {usersView
                            ? row.email
                            : row.kind === "upload"
                              ? "Managed uploads"
                              : `${row.importPaths.length} import folders`}
                        </small>
                      </span>
                    </button>
                  </th>
                  <td>
                    {usersView
                      ? row.isAdmin
                        ? "Administrator"
                        : "User"
                      : rowOwner.name}
                  </td>
                  <td>
                    {count(stats.items)}
                    <small>{count(stats.videos)} videos</small>
                  </td>
                  <td>
                    {usersView ? (
                      <Quota user={row} stats={stats} />
                    ) : (
                      bytes(stats.logicalBytes)
                    )}
                  </td>
                  <td>
                    <Status warning={row.status !== "active"}>
                      {row.status !== "active"
                        ? row.status
                        : row.scan?.status || "Active"}
                    </Status>
                    {row.scan &&
                      ["queued", "running"].includes(row.scan.status) && (
                        <progress
                          value={row.scan.progress}
                          max={100}
                          aria-label={`${row.name} scan progress`}
                        />
                      )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!rows.length && (
          <p className="resource-empty">
            No {usersView ? "accounts" : "libraries"} match this view. Try a
            different filter or viewing scope.
          </p>
        )}
      </div>
      {pendingDetail && (
        <div className="resource-notice resource-actions" role="alert">
          <span>
            Save or discard {selected?.name}’s preference changes before leaving
            this account.
          </span>
          <Button
            onClick={() => {
              setPendingDetail(null);
              setTab(preferenceSection);
            }}
          >
            Keep editing
          </Button>
          <Button
            onClick={() => {
              setPreferencesDirty(false);
              setSelectedId(pendingDetail.id);
              setTab("overview");
              setPendingDetail(null);
            }}
          >
            Discard and continue
          </Button>
        </div>
      )}
      {selected && (
        <section
          className="resource-detail"
          ref={detailRef}
          aria-label={`${selected.name} details`}
        >
          <header>
            <div className="resource-profile">
              {usersView && <PersonAvatar person={selected} size={64} />}
              <div>
                <h2>{selected.name}</h2>
                <p>
                  {usersView
                    ? selected.email
                    : `${owner.name} · ${selected.kind === "upload" ? "Managed uploads" : "External folders"}`}
                </p>
              </div>
            </div>
            <div className="resource-actions">
              <Button
                onClick={() =>
                  onNavigate?.(
                    "analytics",
                    usersView ? selected.id : `library:${selected.id}`,
                  )
                }
              >
                View analytics
              </Button>
              {selected.status === "active" &&
                (usersView || selected.kind === "external") && (
                  <Button
                    onClick={() =>
                      open({
                        type: usersView ? "edit-user" : "edit-library",
                        id: selected.id,
                      })
                    }
                  >
                    Edit {usersView ? "account" : "library"}
                  </Button>
                )}
              <Button
                aria-label="Close details"
                onClick={() => selectDetail(null)}
              >
                ×
              </Button>
            </div>
          </header>
          <nav className="resource-tabs" aria-label="Detail sections">
            {(usersView
              ? [
                  "overview",
                  "features",
                  "preferences",
                  "notifications",
                  "libraries",
                  "security",
                  "activity",
                ]
              : ["overview", "folders", "activity"]
            ).map((name) => (
              <button
                key={name}
                aria-current={tab === name ? "page" : undefined}
                onClick={() => {
                  setTab(name);
                  if (
                    ["features", "preferences", "notifications"].includes(name)
                  )
                    setPreferenceSection(name);
                }}
              >
                {name}
              </button>
            ))}
          </nav>
          {usersView && (
            <div
              hidden={
                !["features", "preferences", "notifications"].includes(tab)
              }
            >
              <AccountPreferences
                key={selected.id}
                user={selected}
                revision={state.revision}
                section={preferenceSection}
                onDirtyChange={setPreferencesDirty}
                onOpenPrivacy={
                  selected.id === RESOURCE_ACTOR_ID
                    ? () =>
                        onNavigate?.(
                          "security",
                          "advanced-protected-suppression",
                        )
                    : undefined
                }
                onSave={(preferences, expectedRevision) =>
                  run(
                    {
                      type: "update-user-preferences",
                      userId: selected.id,
                      preferences,
                      expectedRevision,
                    },
                    `${selected.name}’s preferences saved`,
                  )
                }
              />
            </div>
          )}
          {tab === "overview" && (
            <>
              <Snapshot stats={selectedStats} />
              {usersView ? (
                <div className="resource-two-column">
                  <div>
                    <h3>Storage allowance</h3>
                    <Quota user={selected} stats={selectedStats} />
                    <p className="resource-footnote">
                      Quotas use logical original sizes. Deduplicated files do
                      not give one account free access to another account’s
                      originals.
                    </p>
                    <div className="resource-actions">
                      <Button
                        onClick={() => {
                          setTab("features");
                          setPreferenceSection("features");
                        }}
                      >
                        Feature settings
                      </Button>
                      <Button onClick={() => setTab("security")}>
                        Sign-in & security
                      </Button>
                    </div>
                  </div>
                  <dl className="resource-facts">
                    <dt>Role</dt>
                    <dd>{selected.isAdmin ? "Administrator" : "User"}</dd>
                    <dt>Storage label</dt>
                    <dd>{selected.storageLabel || "Automatic"}</dd>
                    <dt>Created</dt>
                    <dd>{when(selected.createdAt)}</dd>
                    <dt>Account ID</dt>
                    <dd>
                      <code>{selected.id}</code>
                    </dd>
                  </dl>
                </div>
              ) : (
                <>
                  <dl className="resource-facts">
                    <dt>Owner</dt>
                    <dd>{owner.name} · fixed</dd>
                    <dt>Source</dt>
                    <dd>
                      {selected.kind === "upload"
                        ? "Uploads stored and managed by Frameleaf"
                        : "Referenced files in external folders"}
                    </dd>
                    <dt>Last scan</dt>
                    <dd>{when(selected.refreshedAt)}</dd>
                  </dl>
                  {selected.kind === "external" &&
                    selected.status === "active" && (
                      <div className="resource-scan">
                        <div>
                          <h3>Library scan</h3>
                          <p>
                            {selected.scan?.message ||
                              "Check folders for new, changed and missing items."}
                          </p>
                        </div>
                        {["queued", "running"].includes(
                          selected.scan?.status,
                        ) ? (
                          <>
                            <progress
                              max={100}
                              value={selected.scan.progress}
                              aria-label="Scan progress"
                            />
                            <Button
                              onClick={() =>
                                run({
                                  type: "cancel-scan",
                                  libraryId: selected.id,
                                })
                              }
                            >
                              Cancel scan
                            </Button>
                          </>
                        ) : (
                          <Button
                            disabled={
                              owner.status !== "active" ||
                              !selected.importPaths.length
                            }
                            onClick={() => scan(selected)}
                          >
                            Scan library
                          </Button>
                        )}
                      </div>
                    )}
                </>
              )}
              <div className="resource-danger-zone">
                {usersView ? (
                  selected.status === "deleted" ? (
                    <>
                      <p>
                        Deleted {when(selected.deletedAt)}. Recovery is
                        available for {deleteDelay} days.
                      </p>
                      <Button
                        onClick={() =>
                          open({
                            type: "restore-user",
                            userId: selected.id,
                            label: "Restore account",
                          })
                        }
                      >
                        Restore account
                      </Button>
                    </>
                  ) : selected.status === "removing" ? (
                    <p>
                      This account is scheduled for permanent removal and cannot
                      be restored.
                    </p>
                  ) : selected.id === RESOURCE_ACTOR_ID ? (
                    <p>
                      Your administrator account cannot be deleted or demoted
                      from this session.
                    </p>
                  ) : (
                    <>
                      <p>
                        Deleting an account signs out its devices and starts a
                        {deleteDelay}-day recovery period.
                      </p>
                      <Button
                        danger
                        onClick={() =>
                          open({
                            type: "delete-user",
                            userId: selected.id,
                            label: "Delete account",
                          })
                        }
                      >
                        Delete account
                      </Button>
                    </>
                  )
                ) : selected.kind === "external" &&
                  selected.status === "active" ? (
                  <>
                    <p>
                      Removing this library removes its indexed entries. Source
                      files stay in their folders.
                    </p>
                    <Button
                      danger
                      onClick={() =>
                        open({
                          type: "remove-library",
                          libraryId: selected.id,
                          label: "Remove library",
                        })
                      }
                    >
                      Remove library
                    </Button>
                  </>
                ) : (
                  <p>
                    {selected.status === "removed"
                      ? "This library has been removed. Historical storage remains in the dated analytics snapshot."
                      : "Managed uploads belong to this account. Manage their storage through the account and storage settings."}
                  </p>
                )}
              </div>
            </>
          )}
          {tab === "libraries" && (
            <div className="resource-list">
              {state.libraries
                .filter((l) => l.ownerId === selected.id)
                .map((l) => (
                  <div key={l.id}>
                    <div>
                      <strong>{l.name}</strong>
                      <small>
                        {l.kind === "external"
                          ? "External folders"
                          : "Managed uploads"}{" "}
                        · {l.status}
                      </small>
                    </div>
                    <span>
                      {count(summaries[`library:${l.id}`].items)} items
                    </span>
                    <Button
                      onClick={() =>
                        onNavigate?.("libraries", `library:${l.id}`)
                      }
                    >
                      Open library
                    </Button>
                  </div>
                ))}
            </div>
          )}
          {tab === "security" && (
            <>
              <div className="resource-list">
                <div>
                  <div>
                    <strong>Password</strong>
                    <small>
                      Last changed {when(selected.passwordUpdatedAt)} ·{" "}
                      {selected.shouldChangePassword
                        ? "Change required at sign-in"
                        : "No change required"}
                    </small>
                  </div>
                  <Button
                    disabled={selected.status !== "active"}
                    onClick={() =>
                      open({
                        type: "reset-password",
                        userId: selected.id,
                        label: "Reset password",
                      })
                    }
                  >
                    Reset password
                  </Button>
                </div>
                <div>
                  <div>
                    <strong>Locked folder PIN</strong>
                    <small>
                      {selected.pinEnabled ? "PIN is set" : "No PIN set"}
                    </small>
                  </div>
                  <Button
                    disabled={selected.status !== "active"}
                    onClick={() =>
                      open({
                        type: "set-pin",
                        userId: selected.id,
                        label: selected.pinEnabled ? "Change PIN" : "Set PIN",
                      })
                    }
                  >
                    {selected.pinEnabled ? "Change PIN" : "Set PIN"}
                  </Button>
                  <Button
                    disabled={
                      !selected.pinEnabled || selected.status !== "active"
                    }
                    onClick={() =>
                      open({
                        type: "reset-pin",
                        userId: selected.id,
                        label: "Reset PIN",
                      })
                    }
                  >
                    Reset PIN
                  </Button>
                </div>
                <div>
                  <div>
                    <strong>Sign-in provider</strong>
                    <small>
                      {selected.oauthLinked ? "Connected" : "Not connected"} ·
                      managed by the account owner
                    </small>
                  </div>
                </div>
              </div>
              <h3>Signed-in devices</h3>
              <SessionList
                sessions={state.sessions.filter(
                  (s) => s.userId === selected.id,
                )}
                onRevoke={(s) =>
                  open({
                    type: "revoke-session",
                    userId: selected.id,
                    sessionId: s.id,
                    label: "Sign out device",
                  })
                }
              />
            </>
          )}
          {tab === "folders" && (
            <>
              {selected.kind === "upload" ? (
                <p>
                  Upload folders are managed by Frameleaf. External import paths
                  and exclusions do not apply.
                </p>
              ) : (
                <div className="resource-two-column">
                  <div>
                    <h3>Import folders</h3>
                    {selected.importPaths.map((path) => (
                      <p className="resource-path" key={path}>
                        <code>{path}</code>
                      </p>
                    ))}
                    {!selected.importPaths.length && <p>No folders added.</p>}
                  </div>
                  <div>
                    <h3>Exclusions</h3>
                    {selected.exclusionPatterns.map((path) => (
                      <p className="resource-path" key={path}>
                        <code>{path}</code>
                      </p>
                    ))}
                    {!selected.exclusionPatterns.length && (
                      <p>No exclusions.</p>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
          {tab === "activity" && (
            <Activity
              events={state.history.filter((e) => e.subject === selected.name)}
            />
          )}
        </section>
      )}
      {modal && (
        <Dialog
          title={
            modal.type === "create-user"
              ? "Create account"
              : modal.type === "edit-user"
                ? "Edit account"
                : modal.type === "create-library"
                  ? "Add external library"
                  : modal.type === "edit-library"
                    ? "Edit external library"
                    : modal.label
          }
          error={error}
          onClose={() => setModal(null)}
        >
          {["create-user", "edit-user"].includes(modal.type) ? (
            <UserForm
              defaultQuotaGiB={defaultQuotaGiB}
              serverConfig={serverConfig}
              user={state.users.find((u) => u.id === modal.id)}
              state={state}
              onSave={(command) => {
                if (!run(command)) return false;
                if (command.type === "create-user") {
                  setSelectedId(command.id);
                  setTab("features");
                  setPreferenceSection("features");
                }
                return true;
              }}
              onClose={() => setModal(null)}
            />
          ) : ["create-library", "edit-library"].includes(modal.type) ? (
            <LibraryForm
              library={state.libraries.find((l) => l.id === modal.id)}
              ownerId={selectedScope?.userId}
              state={state}
              onSave={run}
              onClose={() => setModal(null)}
            />
          ) : (
            <ResourceAction
              action={modal}
              deleteDelay={deleteDelay}
              state={state}
              run={run}
              onClose={() => setModal(null)}
            />
          )}
        </Dialog>
      )}
    </section>
  );
}
function Activity({ events }) {
  return events.length ? (
    <ol className="resource-history">
      {events.map((event) => (
        <li key={event.id}>
          <strong>{event.action}</strong>
          <span>
            {event.subject} · {when(event.at)}
          </span>
        </li>
      ))}
    </ol>
  ) : (
    <p className="resource-empty">Changes you make will appear here.</p>
  );
}
function SessionList({ sessions, onRevoke }) {
  return (
    <div className="resource-list">
      {sessions.map((session) => (
        <div key={session.id}>
          <div>
            <strong>{session.device}</strong>
            <small>
              {session.revokedAt
                ? `Signed out ${when(session.revokedAt)}`
                : `Last active ${when(session.lastActiveAt)}`}
            </small>
          </div>
          {session.current ? (
            <Status>This device</Status>
          ) : session.revokedAt ? (
            <Status>Signed out</Status>
          ) : (
            <Button onClick={() => onRevoke(session)}>Sign out</Button>
          )}
        </div>
      ))}
      {!sessions.length && <p>No signed-in devices.</p>}
    </div>
  );
}

function PersonalForm({ action, state, run, onClose }) {
  const [password, setPassword] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [permissionSearch, setPermissionSearch] = useState("");
  const [name, setName] = useState(action.key?.name || "");
  const [permissions, setPermissions] = useState(
    action.key?.permissions || ["asset.read"],
  );
  const [invalidate, setInvalidate] = useState(true);
  const [error, setError] = useState("");
  const [secret, setSecret] = useState("");
  const [copyStatus, setCopyStatus] = useState("");
  const actor = state.users.find((u) => u.id === RESOURCE_ACTOR_ID);
  const type = action.type;
  const keyForm = ["personal-key-create", "personal-key-edit"].includes(type);
  const pinSet = type === "personal-pin-set";
  const finish = (event) => {
    event.preventDefault();
    if ((type === "personal-password" || pinSet) && next !== confirm)
      return setError("The confirmation does not match.");
    const command = {
      type,
      password,
      newPassword: next,
      pin: password,
      newPin: next,
      invalidateSessions: invalidate,
      name,
      permissions,
      keyId: action.key?.id,
      activationKey: password,
    };
    if (type === "personal-key-create") command.id = makeId("key");
    const displaySecret = [
      "personal-key-create",
      "personal-key-rotate",
    ].includes(type)
      ? `SAMPLE_NOT_VALID_${crypto.randomUUID()}`
      : "";
    if (run(command)) {
      setPassword("");
      setNext("");
      setConfirm("");
      if (displaySecret) setSecret(displaySecret);
      else onClose();
    }
  };
  if (secret)
    return (
      <div>
        <p>This sample key is shown once. It cannot authenticate requests.</p>
        <code className="resource-secret">{secret}</code>
        <p className="resource-footnote">
          Keep real API keys private. Closing this window removes this displayed
          value.
        </p>
        <p role="status">{copyStatus}</p>
        <footer>
          <Button
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(secret);
                setCopyStatus("Copied sample key.");
              } catch {
                setCopyStatus(
                  "Copy is unavailable. Select the key to copy it manually.",
                );
              }
            }}
          >
            Copy sample key
          </Button>
          <Button primary onClick={onClose}>
            Done
          </Button>
        </footer>
      </div>
    );
  return (
    <form onSubmit={finish}>
      {type === "personal-password" && (
        <>
          <Field label="Current password">
            <input
              type="password"
              required
              autoFocus
              autoComplete="current-password"
              maxLength={256}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <Field label="New password">
            <input
              type="password"
              required
              minLength={8}
              maxLength={256}
              autoComplete="new-password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
            />
          </Field>
          <Field label="Confirm new password">
            <input
              type="password"
              required
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </Field>
          <Check
            label="Sign out my other devices"
            checked={invalidate}
            onChange={(e) => setInvalidate(e.target.checked)}
          />
        </>
      )}
      {[
        "personal-pin-set",
        "personal-pin-clear",
        "personal-pin-reset",
      ].includes(type) && (
        <>
          <p>
            {type === "personal-pin-reset"
              ? "Use your password to clear a forgotten PIN. Your protected photos stay protected."
              : "Your PIN controls access to protected photos on this account."}
          </p>
          <Field
            label={
              !actor.pinEnabled || type === "personal-pin-reset"
                ? "Account password"
                : "Current six-digit PIN"
            }
          >
            <input
              type="password"
              autoFocus
              required
              autoComplete="current-password"
              inputMode={
                actor.pinEnabled && type !== "personal-pin-reset"
                  ? "numeric"
                  : undefined
              }
              pattern={
                actor.pinEnabled && type !== "personal-pin-reset"
                  ? "[0-9]{6}"
                  : undefined
              }
              maxLength={
                actor.pinEnabled && type !== "personal-pin-reset" ? 6 : 256
              }
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          {pinSet && (
            <>
              <Field label="New six-digit PIN">
                <input
                  type="password"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  required
                  maxLength={6}
                  value={next}
                  onChange={(e) => setNext(e.target.value)}
                />
              </Field>
              <Field label="Confirm PIN">
                <input
                  type="password"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  required
                  maxLength={6}
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                />
              </Field>
            </>
          )}
        </>
      )}
      {keyForm && (
        <>
          <Field label="API key name">
            <input
              required
              autoFocus
              maxLength={100}
              placeholder="Photo importer"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <p>
            Choose only the access this application needs. {permissions.length}{" "}
            permissions selected.
          </p>
          <Field label="Find permissions">
            <input
              type="search"
              value={permissionSearch}
              onChange={(e) => setPermissionSearch(e.target.value)}
            />
          </Field>
          <div
            className="resource-permissions"
            role="group"
            aria-label="API key permissions"
          >
            {PERSONAL_KEY_SCOPES.filter((permission) =>
              permission.toLowerCase().includes(permissionSearch.toLowerCase()),
            ).map((permission) => (
              <Check
                key={permission}
                label={permission}
                checked={permissions.includes(permission)}
                onChange={(e) =>
                  setPermissions((values) =>
                    e.target.checked
                      ? [...values, permission]
                      : values.filter((value) => value !== permission),
                  )
                }
              />
            ))}
          </div>
          {permissions.some((p) => p === "all" || p.endsWith(".delete")) && (
            <p className="resource-notice">
              This key can delete the items covered by the selected permissions.
            </p>
          )}
        </>
      )}
      {type === "personal-key-rotate" && (
        <p>
          Replace the key for {action.key.name}? Applications using the old key
          will need the new value.
        </p>
      )}
      {type === "personal-key-delete" && (
        <p>
          Delete {action.key.name}? Applications using this key will lose
          access.
        </p>
      )}
      {type === "personal-oauth-link" && (
        <>
          <p>Connect the sample sign-in account to {actor.name}’s library.</p>
          <dl className="resource-facts">
            <dt>Account</dt>
            <dd>{actor.email}</dd>
            <dt>Provider</dt>
            <dd>Family sign-in</dd>
          </dl>
          <p className="resource-footnote">
            This sample connection stays in this browser. No sign-in request is
            sent.
          </p>
        </>
      )}
      {type === "personal-oauth-unlink" && (
        <p>
          Disconnect the sign-in provider? You can continue to use your email
          and password.
        </p>
      )}
      {type === "personal-supporter-activate" && (
        <Field label="Activation key">
          <input
            type="password"
            required
            autoFocus
            maxLength={256}
            autoComplete="off"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
      )}
      {type === "personal-revoke-other-sessions" && (
        <p>
          Sign out all{" "}
          {
            state.sessions.filter(
              (session) =>
                session.userId === actor.id &&
                !session.current &&
                !session.revokedAt,
            ).length
          }{" "}
          other devices? This device stays signed in. Other accounts are
          unaffected.
        </p>
      )}
      {type === "personal-server-support-remove" && (
        <p>
          Remove the server support key from this server? Individual supporter
          status and all photos remain. This does not cancel a purchase or issue
          a refund.
        </p>
      )}
      {type === "personal-supporter-remove" && (
        <p>
          Remove supporter status from this account? Your photos and settings
          will stay in place.
        </p>
      )}
      {error && (
        <p role="alert" className="resource-error">
          {error}
        </p>
      )}
      <footer>
        <Button onClick={onClose}>Cancel</Button>
        <button type="submit" className="resource-button primary">
          {action.label}
        </button>
      </footer>
    </form>
  );
}

export function PersonalAccess({
  section = "security",
  providerAccountUrl = "",
}) {
  const { state, error, notice, run, setError } = useAccounts();
  const [modal, setModal] = useState(null);
  const actor = state.users.find((u) => u.id === RESOURCE_ACTOR_ID);
  const personal = state.personal;
  const managementLink = providerAccountManagementLink(providerAccountUrl);
  const managementReasonId = useId();
  const aliases = {
    "account-security": "security",
    account: "security",
    apiKeys: "api-keys",
    "pin-code": "pin",
    sessions: "devices",
    authentication: "security",
  };
  const selected = aliases[section] || section;
  const show = (name) =>
    ["security", "all"].includes(selected) || selected === name;
  const open = (type, label, extra = {}) => {
    setError("");
    setModal({ type, label, ...extra });
  };
  return (
    <div className="personal-access" aria-label="Personal account security">
      <header className="resource-heading">
        <div>
          <p className="resource-eyebrow">Settings / Your account</p>
          <h1>
            {
              {
                profile: "Your profile",
                security: "Account access",
                devices: "Devices & API access",
                supporter: "Supporter status",
                frameleaf: "Frameleaf account",
              }[selected] || "Your account"
            }
          </h1>
          <p>
            {actor.name} · {actor.email}
          </p>
        </div>
        <PersonAvatar person={actor} size={48} />
      </header>
      {!modal && error && (
        <p className="resource-error" role="alert">
          {error}
        </p>
      )}
      <p role="status" className="resource-live">
        {notice}
      </p>
      {["security", "all", "profile"].includes(selected) && (
        <dl className="resource-facts">
          <dt>Account ID</dt>
          <dd>
            <code>{actor.id}</code>
          </dd>
          <dt>Storage label</dt>
          <dd>{actor.storageLabel || "Automatic"}</dd>
        </dl>
      )}
      {show("password") && (
        <section>
          <header>
            <div>
              <h2>Password</h2>
              <p>Last changed {when(actor.passwordUpdatedAt)}.</p>
            </div>
            <Button
              onClick={() => open("personal-password", "Change password")}
            >
              Change password
            </Button>
          </header>
        </section>
      )}
      {show("pin") && (
        <section>
          <header>
            <div>
              <h2>Locked folder PIN</h2>
              <p>
                {actor.pinEnabled
                  ? "A six-digit PIN protects your locked content."
                  : "Set a PIN before opening protected photos."}
              </p>
            </div>
            <div className="resource-actions">
              <Button
                onClick={() =>
                  open(
                    "personal-pin-set",
                    actor.pinEnabled ? "Change PIN" : "Create PIN",
                  )
                }
              >
                {actor.pinEnabled ? "Change PIN" : "Create PIN"}
              </Button>
              {actor.pinEnabled && (
                <Button onClick={() => open("personal-pin-clear", "Clear PIN")}>
                  Clear PIN
                </Button>
              )}
            </div>
          </header>
          {actor.pinEnabled && (
            <Button
              onClick={() => open("personal-pin-reset", "Reset forgotten PIN")}
            >
              Forgot your PIN?
            </Button>
          )}
        </section>
      )}
      {show("api-keys") && (
        <section>
          <header>
            <div>
              <h2>API keys</h2>
              <p>
                Separate access for importers, scripts and trusted applications.
              </p>
            </div>
            <Button
              primary
              onClick={() => open("personal-key-create", "Create API key")}
            >
              Create API key
            </Button>
          </header>
          <div className="resource-list">
            {personal.keys.map((key) => (
              <div key={key.id}>
                <div>
                  <strong>{key.name}</strong>
                  <small>{key.permissions.join(" · ")}</small>
                  <small>
                    Updated {when(key.updatedAt)} · generation {key.generation}
                  </small>
                </div>
                <div className="resource-actions">
                  <Button
                    onClick={() =>
                      open("personal-key-edit", "Edit API key", { key })
                    }
                  >
                    Edit
                  </Button>
                  <Button
                    onClick={() =>
                      open("personal-key-rotate", "Rotate key", { key })
                    }
                  >
                    Rotate
                  </Button>
                  <Button
                    danger
                    onClick={() =>
                      open("personal-key-delete", "Delete key", { key })
                    }
                  >
                    Delete
                  </Button>
                </div>
              </div>
            ))}
          </div>
          {!personal.keys.length && (
            <p className="resource-empty">
              No API keys. Create one when an application needs access.
            </p>
          )}
        </section>
      )}
      {show("oauth") && (
        <section>
          <header>
            <div>
              <h2>Sign-in provider</h2>
              <p>
                {actor.oauthLinked
                  ? "Family sign-in is connected to this account."
                  : "Use a connected provider to sign in to your existing account."}
              </p>
            </div>
            <Button
              onClick={() =>
                open(
                  actor.oauthLinked
                    ? "personal-oauth-unlink"
                    : "personal-oauth-link",
                  actor.oauthLinked
                    ? "Disconnect provider"
                    : "Connect provider",
                )
              }
            >
              {actor.oauthLinked ? "Disconnect" : "Connect provider"}
            </Button>
          </header>
          {managementLink ? (
            <a
              className="resource-button"
              href={managementLink}
              target="_blank"
              rel="noopener noreferrer"
              referrerPolicy="no-referrer"
            >
              Manage provider account
            </a>
          ) : (
            <>
              <Button disabled aria-describedby={managementReasonId}>
                Manage provider account
              </Button>
              <p id={managementReasonId} className="resource-footnote">
                Your administrator has not configured an account-management
                address.
              </p>
            </>
          )}
        </section>
      )}
      {show("frameleaf") && (
        <section>
          <FrameleafAccountLink userId={actor.id} email={actor.email} />
        </section>
      )}
      {show("devices") && (
        <section>
          <h2>Signed-in devices</h2>
          <p>
            Review where your account is signed in and remove devices you no
            longer use.
          </p>
          <Button
            disabled={
              !state.sessions.some(
                (session) =>
                  session.userId === actor.id &&
                  !session.current &&
                  !session.revokedAt,
              )
            }
            onClick={() =>
              open("personal-revoke-other-sessions", "Sign out other devices")
            }
          >
            Sign out other devices
          </Button>
          <SessionList
            sessions={state.sessions.filter((s) => s.userId === actor.id)}
            onRevoke={(session) =>
              open("revoke-session", "Sign out device", {
                userId: actor.id,
                sessionId: session.id,
              })
            }
          />
        </section>
      )}
      {show("supporter") && (
        <section>
          <header>
            <div>
              <h2>Supporter status</h2>
              <p>
                {personal.supporter
                  ? `Active since ${when(personal.supporterActivatedAt)}.`
                  : "Add an activation key to associate supporter status with your account."}
              </p>
            </div>
            <Button
              onClick={() =>
                open(
                  personal.supporter
                    ? "personal-supporter-remove"
                    : "personal-supporter-activate",
                  personal.supporter
                    ? "Remove supporter status"
                    : "Activate supporter status",
                )
              }
            >
              {personal.supporter ? "Remove" : "Activate"}
            </Button>
          </header>
          {actor.isAdmin && (
            <div className="resource-support-details">
              <h3>Server support key</h3>
              <dl className="resource-facts">
                <dt>Status</dt>
                <dd>
                  {personal.serverSupportActive
                    ? "Registered · sample data"
                    : "Not registered"}
                </dd>
                <dt>Product</dt>
                <dd>Immich server support</dd>
                {personal.serverSupportActive && (
                  <>
                    <dt>Key reference</dt>
                    <dd>
                      <code>SAMPLE-SERVER-SUPPORT</code>
                    </dd>
                    <dt>Activated</dt>
                    <dd>{when(personal.serverSupportActivatedAt)}</dd>
                  </>
                )}
              </dl>
              <Button
                danger
                disabled={!personal.serverSupportActive}
                onClick={() =>
                  open(
                    "personal-server-support-remove",
                    "Remove server support key",
                  )
                }
              >
                Remove server support key
              </Button>
            </div>
          )}
          <div className="resource-notice">
            <strong>Built on Immich</strong>
            <p>
              Frameleaf builds on the open-source Immich photo library. Immich
              supporter information remains attributed to Immich. A Frameleaf
              purchase or activation service has not been configured.
            </p>
            <p>
              For help with this installation, contact your server
              administrator. Keep passwords, activation keys and private media
              out of support reports.
            </p>
          </div>
        </section>
      )}
      {![
        "security",
        "all",
        "password",
        "pin",
        "api-keys",
        "oauth",
        "devices",
        "supporter",
        "profile",
        "frameleaf",
      ].includes(selected) && (
        <p className="resource-empty">
          Select a security category to review its settings.
        </p>
      )}
      {modal && (
        <Dialog
          title={modal.label}
          error={error}
          onClose={() => setModal(null)}
        >
          {modal.type === "revoke-session" ? (
            <ResourceAction
              action={modal}
              state={state}
              run={run}
              onClose={() => setModal(null)}
            />
          ) : (
            <PersonalForm
              action={modal}
              state={state}
              run={run}
              onClose={() => setModal(null)}
            />
          )}
        </Dialog>
      )}
    </div>
  );
}
