import {
  AVATAR_COLORS,
  createAccountPreferences,
  normalizeAccountPreferences,
  applyAccountPreferences,
} from "./account-preferences.mjs";
import { settingsToAccountPreferencesPatch } from "./account-preference-settings.mjs";

export const RESOURCE_KEY = "frameleaf:accounts-libraries:v1";
export const RESOURCE_EVENT = "frameleaf:accounts-libraries-changed";
export const RESOURCE_ACTOR_ID = "taylor";
export const PERSONAL_KEY_SCOPES = Object.freeze([
  "all",
  "activity.create",
  "activity.read",
  "activity.update",
  "activity.delete",
  "activity.statistics",
  "apiKey.create",
  "apiKey.read",
  "apiKey.update",
  "apiKey.delete",
  "apiKey.rotate",
  "asset.read",
  "asset.update",
  "asset.delete",
  "asset.statistics",
  "asset.share",
  "asset.view",
  "asset.download",
  "asset.upload",
  "asset.copy",
  "asset.derive",
  "assetFile.read",
  "assetFile.delete",
  "assetFile.download",
  "asset.edit.get",
  "asset.edit.create",
  "asset.edit.delete",
  "album.create",
  "album.read",
  "album.update",
  "album.delete",
  "album.statistics",
  "album.share",
  "album.download",
  "albumAsset.create",
  "albumAsset.delete",
  "albumUser.create",
  "albumUser.update",
  "albumUser.delete",
  "auth.changePassword",
  "authDevice.delete",
  "archive.read",
  "backup.list",
  "backup.download",
  "backup.upload",
  "backup.delete",
  "clusterGroup.read",
  "clusterGroup.leave",
  "clusterGroupRequest.create",
  "clusterGroupRequest.read",
  "clusterGroupRequest.delete",
  "adminConfig.read",
  "adminConfig.update",
  "userConfig.read",
  "duplicate.read",
  "duplicate.delete",
  "face.create",
  "face.read",
  "face.update",
  "face.delete",
  "folder.read",
  "job.create",
  "job.read",
  "library.create",
  "library.read",
  "library.update",
  "library.delete",
  "library.statistics",
  "timeline.read",
  "timeline.download",
  "maintenance",
  "map.read",
  "map.search",
  "memory.create",
  "memory.read",
  "memory.update",
  "memory.delete",
  "memory.statistics",
  "memoryAsset.create",
  "memoryAsset.delete",
  "notification.create",
  "notification.read",
  "notification.update",
  "notification.delete",
  "partner.create",
  "partner.read",
  "partner.update",
  "partner.delete",
  "person.create",
  "person.read",
  "person.update",
  "person.delete",
  "person.statistics",
  "person.merge",
  "person.reassign",
  "pinCode.create",
  "pinCode.update",
  "pinCode.delete",
  "plugin.create",
  "plugin.read",
  "plugin.update",
  "plugin.delete",
  "server.about",
  "server.apkLinks",
  "server.storage",
  "server.statistics",
  "server.versionCheck",
  "serverLicense.read",
  "serverLicense.update",
  "serverLicense.delete",
  "session.create",
  "session.read",
  "session.update",
  "session.delete",
  "session.lock",
  "sharedLink.create",
  "sharedLink.read",
  "sharedLink.update",
  "sharedLink.delete",
  "stack.create",
  "stack.read",
  "stack.update",
  "stack.delete",
  "sync.stream",
  "syncCheckpoint.read",
  "syncCheckpoint.update",
  "syncCheckpoint.delete",
  "systemConfig.read",
  "systemConfig.update",
  "systemMetadata.read",
  "systemMetadata.update",
  "tag.create",
  "tag.read",
  "tag.update",
  "tag.delete",
  "tag.asset",
  "user.read",
  "user.update",
  "userLicense.create",
  "userLicense.read",
  "userLicense.update",
  "userLicense.delete",
  "userOnboarding.read",
  "userOnboarding.update",
  "userOnboarding.delete",
  "userPreference.read",
  "userPreference.update",
  "userProfileImage.create",
  "userProfileImage.read",
  "userProfileImage.update",
  "userProfileImage.delete",
  "queue.read",
  "queue.update",
  "queueJob.create",
  "queueJob.read",
  "queueJob.update",
  "queueJob.delete",
  "workflow.create",
  "workflow.read",
  "workflow.update",
  "workflow.delete",
  "workflow.logs",
  "adminUser.create",
  "adminUser.read",
  "adminUser.update",
  "adminUser.delete",
  "adminSession.read",
  "adminAuth.unlinkAll",
]);
const GiB = 1024 ** 3;
const stamp = "2026-09-19T12:00:00.000Z";
const clone = (value) => structuredClone(value);
const fail = (message) => {
  throw new Error(message);
};
const text = (value, max = 160) =>
  typeof value === "string" && value.length <= max;
const idValid = (value) =>
  typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value);
const validDate = (value) =>
  typeof value === "string" &&
  value.length < 40 &&
  Number.isFinite(Date.parse(value));

export const SEED_LIBRARIES = Object.freeze([
  {
    id: "upload-taylor",
    ownerId: "taylor",
    kind: "upload",
    name: "Taylor’s uploads",
    importPaths: [],
    exclusionPatterns: [],
  },
  {
    id: "external-taylor",
    ownerId: "taylor",
    kind: "external",
    name: "Family photo archive",
    importPaths: ["/mnt/photos/taylor"],
    exclusionPatterns: ["**/.DS_Store", "**/@eaDir/**"],
  },
  {
    id: "upload-jamie",
    ownerId: "jamie",
    kind: "upload",
    name: "Jamie’s uploads",
    importPaths: [],
    exclusionPatterns: [],
  },
  {
    id: "external-jamie",
    ownerId: "jamie",
    kind: "external",
    name: "Trail camera archive",
    importPaths: ["/mnt/photos/jamie"],
    exclusionPatterns: ["**/cache/**"],
  },
  {
    id: "upload-emma",
    ownerId: "emma",
    kind: "upload",
    name: "Emma’s uploads",
    importPaths: [],
    exclusionPatterns: [],
  },
]);

export function createResourceState() {
  return {
    version: 1,
    revision: 0,
    users: [
      {
        id: "taylor",
        name: "Taylor",
        email: "taylor@example.test",
        isAdmin: true,
        quotaBytes: null,
        storageLabel: "taylor",
        shouldChangePassword: false,
        pinEnabled: true,
        oauthLinked: true,
        image: "/media/avatar-taylor.png",
      },
      {
        id: "jamie",
        name: "Jamie",
        email: "jamie@example.test",
        isAdmin: false,
        quotaBytes: 1024 * GiB,
        storageLabel: "jamie",
        shouldChangePassword: false,
        pinEnabled: true,
        oauthLinked: false,
        image: "/media/avatar-jamie.png",
      },
      {
        id: "emma",
        name: "Emma",
        email: "emma@example.test",
        isAdmin: false,
        quotaBytes: 700 * GiB,
        storageLabel: "emma",
        shouldChangePassword: false,
        pinEnabled: false,
        oauthLinked: true,
        image: "/media/avatar-emma.png",
      },
    ].map((user) => ({
      ...user,
      avatarColor: null,
      preferences: createAccountPreferences(),
      preferencesConfigured: false,
      status: "active",
      passwordSet: true,
      notify: false,
      createdAt: "2025-05-12T10:00:00.000Z",
      updatedAt: stamp,
      deletedAt: null,
      passwordUpdatedAt: stamp,
      pinResetAt: null,
    })),
    libraries: SEED_LIBRARIES.map((library) => ({
      ...clone(library),
      status: "active",
      createdAt: "2025-06-01T10:00:00.000Z",
      updatedAt: stamp,
      refreshedAt: library.kind === "external" ? stamp : null,
      scan: null,
    })),
    sessions: [
      {
        id: "taylor-web",
        userId: "taylor",
        device: "Safari · MacBook Pro",
        lastActiveAt: stamp,
        createdAt: "2026-09-18T10:00:00.000Z",
        current: true,
        revokedAt: null,
      },
      {
        id: "taylor-phone",
        userId: "taylor",
        device: "iPhone 16 Pro",
        lastActiveAt: stamp,
        createdAt: "2026-08-01T10:00:00.000Z",
        current: false,
        revokedAt: null,
      },
      {
        id: "jamie-phone",
        userId: "jamie",
        device: "Pixel 9",
        lastActiveAt: "2026-09-19T08:14:00.000Z",
        createdAt: "2026-08-02T10:00:00.000Z",
        current: false,
        revokedAt: null,
      },
      {
        id: "emma-tablet",
        userId: "emma",
        device: "iPad Air",
        lastActiveAt: "2026-09-18T20:20:00.000Z",
        createdAt: "2026-07-12T10:00:00.000Z",
        current: false,
        revokedAt: null,
      },
    ],
    personal: {
      keys: [],
      supporter: false,
      supporterActivatedAt: null,
      serverSupportActive: true,
      serverSupportActivatedAt: stamp,
    },
    history: [],
  };
}

function boundedList(value) {
  return (
    Array.isArray(value) &&
    value.length <= 128 &&
    value.every((item) => text(item, 1024) && item.trim()) &&
    new Set(value).size === value.length
  );
}

export function parseResourceState(raw) {
  try {
    if (typeof raw !== "string" || raw.length > 512_000) return null;
    const source = JSON.parse(raw);
    if (
      source?.version !== 1 ||
      !Number.isSafeInteger(source.revision) ||
      source.revision < 0
    )
      return null;
    if (
      !Array.isArray(source.users) ||
      !source.users.length ||
      source.users.length > 100 ||
      !Array.isArray(source.libraries) ||
      source.libraries.length > 200 ||
      !Array.isArray(source.sessions) ||
      source.sessions.length > 300 ||
      !Array.isArray(source.history) ||
      source.history.length > 100
    )
      return null;
    const users = source.users.map((u) => {
      if (
        !idValid(u.id) ||
        !text(u.name) ||
        !u.name.trim() ||
        !text(u.email, 254) ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(u.email) ||
        !text(u.storageLabel, 80) ||
        !/^[a-zA-Z0-9_-]*$/.test(u.storageLabel)
      )
        fail("Invalid account");
      if (
        u.quotaBytes !== null &&
        (!Number.isSafeInteger(u.quotaBytes) ||
          u.quotaBytes < 0 ||
          u.quotaBytes > 1024 ** 5)
      )
        fail("Invalid quota");
      if (
        !["active", "deleted", "removing"].includes(u.status) ||
        !validDate(u.createdAt) ||
        !validDate(u.updatedAt)
      )
        fail("Invalid account state");
      const fields = [
        "isAdmin",
        "shouldChangePassword",
        "pinEnabled",
        "oauthLinked",
        "passwordSet",
        "notify",
      ];
      if (fields.some((field) => typeof u[field] !== "boolean"))
        fail("Invalid account flags");
      if (
        ["deletedAt", "passwordUpdatedAt", "pinResetAt"].some(
          (field) => u[field] !== null && !validDate(u[field]),
        )
      )
        fail("Invalid security dates");
      const seedImage =
        createResourceState().users.find((user) => user.id === u.id)?.image ||
        "";
      if (u.avatarColor != null && !AVATAR_COLORS.includes(u.avatarColor))
        fail("Invalid avatar color");
      if (
        u.preferencesConfigured !== undefined &&
        typeof u.preferencesConfigured !== "boolean"
      )
        fail("Invalid preference state");
      return {
        id: u.id,
        name: u.name,
        email: u.email,
        storageLabel: u.storageLabel,
        quotaBytes: u.quotaBytes,
        status: u.status,
        createdAt: u.createdAt,
        updatedAt: u.updatedAt,
        deletedAt: u.deletedAt,
        passwordUpdatedAt: u.passwordUpdatedAt,
        pinResetAt: u.pinResetAt,
        image: seedImage,
        avatarColor: u.avatarColor ?? null,
        preferences: normalizeAccountPreferences(u.preferences),
        preferencesConfigured:
          u.preferencesConfigured === undefined
            ? u.preferences !== undefined
            : u.preferencesConfigured === true,
        ...Object.fromEntries(fields.map((field) => [field, u[field]])),
      };
    });
    if (
      new Set(users.map((u) => u.id)).size !== users.length ||
      new Set(users.map((u) => u.email.toLowerCase())).size !== users.length
    )
      return null;
    const labels = users.map((u) => u.storageLabel).filter(Boolean);
    if (new Set(labels).size !== labels.length) return null;
    if (
      !users.some(
        (u) => u.id === RESOURCE_ACTOR_ID && u.isAdmin && u.status === "active",
      )
    )
      return null;
    const libraries = source.libraries.map((l) => {
      if (
        !idValid(l.id) ||
        !users.some((u) => u.id === l.ownerId) ||
        !["upload", "external"].includes(l.kind) ||
        !["active", "removed"].includes(l.status) ||
        !text(l.name) ||
        !l.name.trim() ||
        !boundedList(l.importPaths) ||
        !boundedList(l.exclusionPatterns) ||
        !validDate(l.createdAt) ||
        !validDate(l.updatedAt) ||
        (l.refreshedAt !== null && !validDate(l.refreshedAt))
      )
        fail("Invalid library");
      if (
        l.kind === "upload" &&
        (l.importPaths.length || l.exclusionPatterns.length)
      )
        fail("Managed uploads have no external paths");
      let scan = null;
      if (l.scan) {
        const s = l.scan;
        if (
          !["queued", "running", "completed", "failed", "cancelled"].includes(
            s.status,
          ) ||
          !validDate(s.startedAt) ||
          !Number.isFinite(s.progress) ||
          s.progress < 0 ||
          s.progress > 100 ||
          !Number.isSafeInteger(s.matched) ||
          s.matched < 0 ||
          s.matched > 1e9 ||
          !text(s.message, 300)
        )
          fail("Invalid scan");
        scan = {
          status: s.status,
          startedAt: s.startedAt,
          progress: s.progress,
          matched: s.matched,
          message: s.message,
        };
      }
      return {
        id: l.id,
        ownerId: l.ownerId,
        kind: l.kind,
        name: l.name,
        status: l.status,
        importPaths: l.importPaths,
        exclusionPatterns: l.exclusionPatterns,
        createdAt: l.createdAt,
        updatedAt: l.updatedAt,
        refreshedAt: l.refreshedAt,
        scan,
      };
    });
    if (new Set(libraries.map((l) => l.id)).size !== libraries.length)
      return null;
    for (const seed of SEED_LIBRARIES) {
      const current = libraries.find((l) => l.id === seed.id);
      if (
        !current ||
        current.ownerId !== seed.ownerId ||
        current.kind !== seed.kind
      )
        return null;
    }
    const sessions = source.sessions.map((s) => {
      if (
        !idValid(s.id) ||
        !users.some((u) => u.id === s.userId) ||
        !text(s.device) ||
        !validDate(s.lastActiveAt) ||
        !validDate(s.createdAt) ||
        typeof s.current !== "boolean" ||
        (s.revokedAt !== null && !validDate(s.revokedAt))
      )
        fail("Invalid session");
      return {
        id: s.id,
        userId: s.userId,
        device: s.device,
        current: s.current,
        lastActiveAt: s.lastActiveAt,
        createdAt: s.createdAt,
        revokedAt: s.revokedAt,
      };
    });
    const history = source.history.map((event) => {
      if (
        !idValid(event.id) ||
        !validDate(event.at) ||
        !text(event.action, 200) ||
        !text(event.subject, 160)
      )
        fail("Invalid history");
      return {
        id: event.id,
        at: event.at,
        action: event.action,
        subject: event.subject,
      };
    });
    const p = source.personal ?? {
      keys: [],
      supporter: false,
      supporterActivatedAt: null,
    };
    if (
      !Array.isArray(p.keys) ||
      p.keys.length > 100 ||
      typeof p.supporter !== "boolean" ||
      (p.supporterActivatedAt !== null && !validDate(p.supporterActivatedAt))
    )
      fail("Invalid personal settings");
    const serverSupportActive = p.serverSupportActive ?? true;
    const serverSupportActivatedAt =
      p.serverSupportActivatedAt === undefined
        ? stamp
        : p.serverSupportActivatedAt;
    if (
      typeof serverSupportActive !== "boolean" ||
      (serverSupportActivatedAt !== null &&
        !validDate(serverSupportActivatedAt))
    )
      fail("Invalid server support metadata");
    const keys = p.keys.map((key) => {
      if (
        !idValid(key.id) ||
        !text(key.name, 100) ||
        !key.name.trim() ||
        !validDate(key.createdAt) ||
        !validDate(key.updatedAt) ||
        !Array.isArray(key.permissions) ||
        !key.permissions.length ||
        key.permissions.length > PERSONAL_KEY_SCOPES.length ||
        key.permissions.some((p) => !PERSONAL_KEY_SCOPES.includes(p)) ||
        new Set(key.permissions).size !== key.permissions.length ||
        !Number.isSafeInteger(key.generation) ||
        key.generation < 1 ||
        key.generation > 100000
      )
        fail("Invalid API key");
      return {
        id: key.id,
        name: key.name,
        permissions: key.permissions,
        createdAt: key.createdAt,
        updatedAt: key.updatedAt,
        generation: key.generation,
      };
    });
    if (new Set(keys.map((key) => key.id)).size !== keys.length)
      fail("Duplicate key");
    return {
      version: 1,
      revision: source.revision,
      users,
      libraries,
      sessions,
      history,
      personal: {
        keys,
        supporter: p.supporter,
        supporterActivatedAt: p.supporterActivatedAt,
        serverSupportActive,
        serverSupportActivatedAt,
      },
    };
  } catch {
    return null;
  }
}

export function loadResourceState(storage) {
  try {
    const target = storage ?? globalThis.localStorage;
    const state =
      parseResourceState(target?.getItem(RESOURCE_KEY)) ??
      createResourceState();
    // Before per-account controls existed, the signed-in user's preferences
    // lived in the command-center settings. Preserve them until first migrated save.
    const actor = state.users.find((u) => u.id === RESOURCE_ACTOR_ID);
    if (actor && !actor.preferencesConfigured) {
      try {
        const raw = target?.getItem("frameleaf:command-center:v1");
        if (raw && raw.length <= 8 * 1024 * 1024) {
          const settings = JSON.parse(raw)?.settings;
          if (settings)
            actor.preferences = applyAccountPreferences(
              actor.preferences,
              settingsToAccountPreferencesPatch(settings),
            );
        }
      } catch {
        /* Invalid legacy settings never overwrite validated account data. */
      }
    }
    return state;
  } catch {
    return createResourceState();
  }
}
export function saveResourceState(value, storage, expectedRevision) {
  const clean = parseResourceState(JSON.stringify(value));
  if (!clean)
    fail(
      "The changes could not be saved. Check the account and library fields.",
    );
  const target = storage ?? globalThis.localStorage;
  if (!target)
    fail("Browser storage is unavailable. Your changes have not been saved.");
  if (
    expectedRevision !== undefined &&
    loadResourceState(target).revision !== expectedRevision
  )
    fail("Accounts changed elsewhere. Review the latest values before saving.");
  target.setItem(RESOURCE_KEY, JSON.stringify(clean));
  if (typeof window !== "undefined")
    window.dispatchEvent(new Event(RESOURCE_EVENT));
  return clean;
}
export function subscribeResourceState(callback) {
  if (typeof window === "undefined") return () => {};
  const listener = (event) => {
    if (
      event.type !== "storage" ||
      event.key === RESOURCE_KEY ||
      event.key === null
    )
      callback(loadResourceState());
  };
  window.addEventListener(RESOURCE_EVENT, listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(RESOURCE_EVENT, listener);
    window.removeEventListener("storage", listener);
  };
}
export function getScopeOptions(state = loadResourceState()) {
  return [
    { value: "all", label: "All accounts & libraries", kind: "system" },
    ...state.users.map((u) => ({
      value: u.id,
      label: `${u.name}${u.status !== "active" ? " (deleted)" : ""}`,
      kind: "user",
      userId: u.id,
    })),
    ...state.libraries.map((l) => ({
      value: `library:${l.id}`,
      label: `${l.name}${l.status !== "active" ? " (removed)" : ""}`,
      kind: "library",
      userId: l.ownerId,
      libraryId: l.id,
    })),
  ];
}

export function validateImportPaths(paths) {
  return paths.map((path) => ({
    path,
    valid:
      path.startsWith("/") &&
      !path.split("/").includes("..") &&
      !/[\u0000-\u001f]/.test(path),
    message:
      path.startsWith("/") &&
      !path.split("/").includes("..") &&
      !/[\u0000-\u001f]/.test(path)
        ? "Path format valid"
        : "Use an absolute path without parent-directory traversal",
  }));
}

export function applyResourceCommand(
  state,
  command,
  now = new Date().toISOString(),
) {
  if (!validDate(now)) fail("Invalid action time");
  const next = clone(state);
  const actor = next.users.find((u) => u.id === RESOURCE_ACTOR_ID);
  if (!actor?.isAdmin || actor.status !== "active")
    fail("Administrator access is required");
  if (
    command.expectedRevision !== undefined &&
    command.expectedRevision !== state.revision
  )
    fail("Accounts changed elsewhere. Reload before saving.");
  let subject = "";
  let action = "";
  const user =
    command.type === "create-user"
      ? undefined
      : next.users.find((u) => u.id === command.userId);
  const library =
    command.type === "create-library"
      ? undefined
      : next.libraries.find((l) => l.id === command.libraryId);
  if (["create-user", "edit-user"].includes(command.type)) {
    if (command.type === "edit-user" && (!user || user.status !== "active"))
      fail("Choose an active account");
    if (
      command.type === "create-user" &&
      (next.users.length >= 100 ||
        !idValid(command.id) ||
        next.users.some((u) => u.id === command.id))
    )
      fail("Choose a unique account");
    const input = command.fields;
    const name = input.name?.trim();
    const email = input.email?.trim().toLowerCase();
    const storageLabel = input.storageLabel?.trim() ?? "";
    if (
      !name ||
      !text(name) ||
      !text(email, 254) ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    )
      fail("Enter a name and valid email address");
    if (!/^[a-zA-Z0-9_-]{0,80}$/.test(storageLabel))
      fail("Storage labels use letters, numbers, hyphens or underscores");
    if (
      next.users.some(
        (u) =>
          u.id !== user?.id &&
          (u.email.toLowerCase() === email ||
            (storageLabel && u.storageLabel === storageLabel)),
      )
    )
      fail("Email address and storage label must be unique");
    const quota = input.quotaBytes;
    if (
      quota !== null &&
      (!Number.isSafeInteger(quota) || quota < 0 || quota > 1024 ** 5)
    )
      fail("Enter a valid quota or choose unlimited");
    if (user?.id === RESOURCE_ACTOR_ID && !input.isAdmin)
      fail("You cannot remove your own administrator access");
    const providerOnly = command.authentication === "provider";
    if (providerOnly && command.serverConfig?.oauthEnabled !== true)
      fail(
        "Enable your sign-in provider before creating a provider-only account",
      );
    if (
      command.type === "create-user" &&
      !providerOnly &&
      (!text(input.password, 256) || input.password.length < 8)
    )
      fail("Use at least eight characters for the initial password");
    const avatarColor =
      input.avatarColor === undefined
        ? (user?.avatarColor ?? null)
        : input.avatarColor;
    if (avatarColor !== null && !AVATAR_COLORS.includes(avatarColor))
      fail("Choose a valid avatar color");
    const fields = {
      name,
      email,
      storageLabel,
      quotaBytes: quota,
      avatarColor,
      isAdmin: !!input.isAdmin,
      shouldChangePassword: providerOnly ? false : !!input.shouldChangePassword,
      notify: !!input.notify,
      updatedAt: now,
    };
    if (user) Object.assign(user, fields);
    else {
      const id = command.id;
      next.users.push({
        ...fields,
        id,
        status: "active",
        createdAt: now,
        deletedAt: null,
        preferences: createAccountPreferences(),
        preferencesConfigured: true,
        passwordSet: !providerOnly,
        passwordUpdatedAt: providerOnly ? null : now,
        pinEnabled: false,
        pinResetAt: null,
        oauthLinked: false,
        image: "",
      });
      next.libraries.push({
        id: `upload-${id}`,
        ownerId: id,
        kind: "upload",
        name: `${name}’s uploads`,
        importPaths: [],
        exclusionPatterns: [],
        status: "active",
        createdAt: now,
        updatedAt: now,
        refreshedAt: null,
        scan: null,
      });
    }
    subject = name;
    action = user ? "Account updated" : "Account created";
  } else if (command.type === "update-user-preferences") {
    if (!user || user.status !== "active") fail("Choose an active account");
    user.preferences = applyAccountPreferences(
      user.preferences,
      command.preferences,
    );
    user.preferencesConfigured = true;
    user.updatedAt = now;
    subject = user.name;
    action = "Account preferences updated";
  } else if (
    [
      "delete-user",
      "restore-user",
      "reset-password",
      "set-pin",
      "reset-pin",
      "revoke-session",
    ].includes(command.type)
  ) {
    if (!user) fail("Account not found");
    subject = user.name;
    const deleteDelay = command.deleteDelay ?? 7;
    if (
      !Number.isSafeInteger(deleteDelay) ||
      deleteDelay < 1 ||
      deleteDelay > 365
    )
      fail("Choose a valid account recovery period");
    if (command.type === "delete-user") {
      if (user.id === RESOURCE_ACTOR_ID)
        fail("You cannot delete your own administrator account");
      if (user.status !== "active") fail("This account is already deleted");
      if (command.confirmEmail !== user.email)
        fail("Enter the account email to confirm deletion");
      user.status = command.force === true ? "removing" : "deleted";
      user.deletedAt = now;
      for (const session of next.sessions.filter((s) => s.userId === user.id))
        session.revokedAt = now;
      for (const library of next.libraries.filter((l) => l.ownerId === user.id))
        if (["queued", "running"].includes(library.scan?.status)) {
          library.scan.status = "cancelled";
          library.scan.message =
            "Scan cancelled because the owner account was deleted";
        }
      action =
        command.force === true
          ? "Account scheduled for permanent removal"
          : `Account deleted · recovery available for ${deleteDelay} days`;
    } else if (command.type === "restore-user") {
      if (user.status !== "deleted") fail("This account cannot be restored");
      if (
        Date.parse(now) - Date.parse(user.deletedAt) >
        deleteDelay * 86_400_000
      )
        fail(`The ${deleteDelay}-day recovery period has ended`);
      user.status = "active";
      user.deletedAt = null;
      action = "Account restored · sign-in required";
    } else {
      if (user.status !== "active") fail("Restore the account first");
      if (command.type === "reset-password") {
        if (!text(command.password, 256) || command.password.length < 8)
          fail("Use at least eight characters for the password");
        user.passwordSet = true;
        user.passwordUpdatedAt = now;
        user.shouldChangePassword = true;
        action = "Password reset · change required at next sign-in";
      } else if (command.type === "set-pin") {
        if (typeof command.pin !== "string" || !/^\d{6}$/.test(command.pin))
          fail("Enter a six-digit PIN");
        user.pinEnabled = true;
        user.pinResetAt = null;
        action = "Locked folder PIN updated";
      } else if (command.type === "reset-pin") {
        user.pinEnabled = false;
        user.pinResetAt = now;
        action = "PIN reset";
      } else {
        const session = next.sessions.find(
          (s) => s.id === command.sessionId && s.userId === user.id,
        );
        if (!session || session.current)
          fail("This session cannot be signed out here");
        session.revokedAt = now;
        action = `Device signed out: ${session.device}`;
      }
    }
    user.updatedAt = now;
  } else if (["create-library", "edit-library"].includes(command.type)) {
    const fields = command.fields;
    if (
      command.type === "edit-library" &&
      (!library || library.status !== "active" || library.kind !== "external")
    )
      fail("Choose an active external library");
    const ownerId = library?.ownerId ?? fields.ownerId;
    const owner = next.users.find(
      (u) => u.id === ownerId && u.status === "active",
    );
    if (!owner) fail("Choose an active owner");
    if (
      library &&
      fields.ownerId !== undefined &&
      fields.ownerId !== library.ownerId
    )
      fail("A library owner cannot be changed");
    if (
      !text(fields.name) ||
      !fields.name.trim() ||
      !boundedList(fields.importPaths) ||
      !boundedList(fields.exclusionPatterns)
    )
      fail("Enter a library name and unique, non-empty paths and exclusions");
    if (validateImportPaths(fields.importPaths).some((p) => !p.valid))
      fail("Import folders must use valid absolute paths");
    const update = {
      name: fields.name.trim(),
      importPaths: [...fields.importPaths],
      exclusionPatterns: [...fields.exclusionPatterns],
      updatedAt: now,
    };
    if (library) Object.assign(library, update);
    else {
      if (
        next.libraries.length >= 200 ||
        !idValid(command.id) ||
        next.libraries.some((l) => l.id === command.id)
      )
        fail("Choose a unique library");
      next.libraries.push({
        ...update,
        id: command.id,
        ownerId,
        kind: "external",
        status: "active",
        createdAt: now,
        refreshedAt: null,
        scan: null,
      });
    }
    subject = update.name;
    action = library ? "Library settings updated" : "External library created";
  } else if (
    ["scan-library", "cancel-scan", "remove-library"].includes(command.type)
  ) {
    if (!library || library.kind !== "external" || library.status !== "active")
      fail("Choose an active external library");
    if (
      !next.users.some((u) => u.id === library.ownerId && u.status === "active")
    )
      fail("Restore the owner account first");
    subject = library.name;
    if (command.type === "scan-library") {
      if (!library.importPaths.length)
        fail("Add at least one import folder before scanning");
      if (["queued", "running"].includes(library.scan?.status))
        fail("A scan is already in progress");
      library.scan = {
        status: "queued",
        startedAt: now,
        progress: 0,
        matched:
          Number.isSafeInteger(command.matched) && command.matched >= 0
            ? command.matched
            : 0,
        message: "Waiting to scan",
      };
      action = "Library scan queued";
    } else if (command.type === "cancel-scan") {
      if (!["queued", "running"].includes(library.scan?.status))
        fail("No active scan to cancel");
      library.scan.status = "cancelled";
      library.scan.message = "Scan cancelled; existing items retained";
      action = "Library scan cancelled";
    } else {
      if (command.confirmName !== library.name || !command.confirmAssets)
        fail("Confirm the library name and removal of its indexed entries");
      library.status = "removed";
      if (["queued", "running"].includes(library.scan?.status))
        library.scan.status = "cancelled";
      action = "Library removed · source files retained";
    }
    library.updatedAt = now;
  } else if (command.type === "admin-unlink-all-oauth") {
    if (command.oauthEnabled !== true)
      fail("Enable provider sign-in before managing its account links");
    if (command.confirmation !== "DISCONNECT ALL")
      fail("Type DISCONNECT ALL to confirm");
    if (actor.oauthLinked && !actor.passwordSet)
      fail(
        "Set a password on your administrator account before disconnecting its provider",
      );
    const affected = next.users.filter((u) => u.oauthLinked);
    for (const account of affected) {
      account.oauthLinked = false;
      account.updatedAt = now;
    }
    subject = "All accounts";
    action = `Disconnected ${affected.length} sign-in provider links`;
  } else if (command.type.startsWith("personal-")) {
    subject = actor.name;
    next.personal ??= {
      keys: [],
      supporter: false,
      supporterActivatedAt: null,
    };
    const requirePassword = () => {
      if (!text(command.password, 256) || !command.password.length)
        fail("Enter your current password");
    };
    if (command.type === "personal-password") {
      requirePassword();
      if (!text(command.newPassword, 256) || command.newPassword.length < 8)
        fail("Use at least eight characters for your new password");
      actor.passwordUpdatedAt = now;
      actor.passwordSet = true;
      actor.shouldChangePassword = false;
      if (command.invalidateSessions)
        for (const session of next.sessions.filter(
          (s) => s.userId === actor.id && !s.current,
        ))
          session.revokedAt = now;
      action = "Password changed";
    } else if (
      ["personal-pin-set", "personal-pin-clear", "personal-pin-reset"].includes(
        command.type,
      )
    ) {
      if (command.type === "personal-pin-reset" || !actor.pinEnabled)
        requirePassword();
      else if (!/^\d{6}$/.test(command.pin))
        fail("Enter your current six-digit PIN");
      if (
        command.type === "personal-pin-set" &&
        !/^\d{6}$/.test(command.newPin)
      )
        fail("Use a six-digit PIN");
      actor.pinEnabled = command.type === "personal-pin-set";
      actor.pinResetAt = now;
      action = actor.pinEnabled ? "PIN updated" : "PIN cleared";
    } else if (
      [
        "personal-key-create",
        "personal-key-edit",
        "personal-key-rotate",
        "personal-key-delete",
      ].includes(command.type)
    ) {
      const key = next.personal.keys.find((k) => k.id === command.keyId);
      if (command.type !== "personal-key-create" && !key)
        fail("API key not found");
      if (command.type === "personal-key-delete") {
        next.personal.keys = next.personal.keys.filter((k) => k.id !== key.id);
        action = "API key deleted";
      } else if (command.type === "personal-key-rotate") {
        key.generation++;
        key.updatedAt = now;
        action = "API key rotated";
      } else {
        if (
          !text(command.name, 100) ||
          !command.name.trim() ||
          !Array.isArray(command.permissions) ||
          !command.permissions.length ||
          command.permissions.some((p) => !PERSONAL_KEY_SCOPES.includes(p))
        )
          fail("Enter a key name and choose at least one permission");
        const fields = {
          name: command.name.trim(),
          permissions: [...new Set(command.permissions)],
          updatedAt: now,
        };
        if (key) Object.assign(key, fields);
        else {
          if (
            !idValid(command.id) ||
            next.personal.keys.some((k) => k.id === command.id)
          )
            fail("Choose a unique key");
          next.personal.keys.push({
            ...fields,
            id: command.id,
            createdAt: now,
            generation: 1,
          });
        }
        action = key ? "API key updated" : "API key created";
      }
    } else if (
      ["personal-oauth-link", "personal-oauth-unlink"].includes(command.type)
    ) {
      if (command.type === "personal-oauth-unlink" && !actor.passwordSet)
        fail("Set a password before disconnecting your sign-in provider");
      actor.oauthLinked = command.type === "personal-oauth-link";
      action = actor.oauthLinked
        ? "Sign-in provider connected"
        : "Sign-in provider disconnected";
    } else if (command.type === "personal-revoke-other-sessions") {
      const sessions = next.sessions.filter(
        (s) => s.userId === actor.id && !s.current && !s.revokedAt,
      );
      if (!sessions.length) fail("No other devices are signed in");
      for (const session of sessions) session.revokedAt = now;
      action = `Signed out ${sessions.length} other devices`;
    } else if (command.type === "personal-server-support-remove") {
      if (!actor.isAdmin) fail("Administrator access is required");
      if (next.personal.serverSupportActive === false)
        fail("No server support key is registered");
      next.personal.serverSupportActive = false;
      next.personal.serverSupportActivatedAt = null;
      action = "Server support key removed";
    } else if (command.type === "personal-supporter-activate") {
      if (!text(command.activationKey, 256) || !command.activationKey.trim())
        fail("Enter your activation key");
      next.personal.supporter = true;
      next.personal.supporterActivatedAt = now;
      action = "Supporter status activated";
    } else if (command.type === "personal-supporter-remove") {
      next.personal.supporter = false;
      next.personal.supporterActivatedAt = null;
      action = "Supporter status removed";
    } else fail("Unknown personal action");
    actor.updatedAt = now;
  } else fail("Unknown action");
  next.revision++;
  next.history = [
    { id: `event-${next.revision}`, at: now, action, subject },
    ...next.history,
  ].slice(0, 100);
  const clean = parseResourceState(JSON.stringify(next));
  if (!clean) fail("The change exceeds the account or library limits");
  return clean;
}

export function advanceResourceScans(state, now = new Date().toISOString()) {
  if (!validDate(now)) fail("Invalid scan time");
  const next = clone(state);
  let changed = false;
  for (const library of next.libraries) {
    const scan = library.scan;
    if (!["queued", "running"].includes(scan?.status)) continue;
    const progress = Math.min(
      100,
      Math.max(
        0,
        Math.floor((Date.parse(now) - Date.parse(scan.startedAt)) / 60),
      ),
    );
    if (progress === scan.progress) continue;
    scan.progress = progress;
    scan.status = progress >= 100 ? "completed" : "running";
    scan.message =
      progress >= 100
        ? `${scan.matched.toLocaleString("en-CA")} existing items matched · 0 added · 0 missing`
        : "Checking folders and matching existing items";
    if (progress >= 100) library.refreshedAt = now;
    changed = true;
  }
  if (changed) next.revision++;
  return changed ? next : state;
}

export function getResourceSummary(state = loadResourceState()) {
  return {
    activeUsers: state.users.filter((u) => u.status === "active").length,
    deletedUsers: state.users.filter((u) => u.status !== "active").length,
    administrators: state.users.filter(
      (u) => u.isAdmin && u.status === "active",
    ).length,
    uploadLibraries: state.libraries.filter(
      (l) => l.kind === "upload" && l.status === "active",
    ).length,
    externalLibraries: state.libraries.filter(
      (l) => l.kind === "external" && l.status === "active",
    ).length,
    activeScans: state.libraries.filter((l) =>
      ["queued", "running"].includes(l.scan?.status),
    ).length,
  };
}

export function providerAccountManagementLink(value) {
  if (typeof value !== "string" || value.length > 2048 || !value.trim())
    return null;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
