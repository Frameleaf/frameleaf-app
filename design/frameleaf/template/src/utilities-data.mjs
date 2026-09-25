import { media } from "./media.js";
import {
  migrateLegacyWorkflow,
  parseWorkflowDefinition,
  workflowCredentialPaths,
  workflowExecutionErrors,
} from "./workflow-schema.mjs";
// Deterministic UI fixtures. Production sources: UtilitiesMenu.svelte,
// MediaHealthReview.svelte, live-photos, duplicates, geolocation and workflow routes.
export const utilityTools = [
  {
    id: "duplicates",
    title: "Duplicate review",
    group: "Organize",
    icon: "mdiCompare",
    description: "Compare copies, choose keepers, or group related photos.",
  },
  {
    id: "large-files",
    title: "Large files",
    group: "Organize",
    icon: "mdiHarddisk",
    description:
      "Find the originals taking the most space before deciding what to keep.",
  },
  {
    id: "live-photos",
    title: "Live Photo pairing",
    group: "Repair",
    icon: "mdiMovieOpenOutline",
    description:
      "Reconnect Live Photos with their motion clips.",
  },
  {
    id: "geolocation",
    title: "Location editor",
    group: "Organize",
    icon: "mdiMapMarker",
    description:
      "Copy a location or place selected photos at precise coordinates.",
  },
  {
    id: "icloud",
    title: "iCloud Photos",
    group: "Import",
    icon: "mdiCloudOutline",
    description:
      "Manage connections, source albums, sync schedules and import results.",
  },
  {
    id: "missing-media",
    title: "Missing media",
    group: "Repair",
    icon: "mdiFolderSearchOutline",
    description:
      "Locate moved originals, inspect candidate files and restore their links.",
    admin: true,
  },
  {
    id: "corrupt-media",
    title: "Damaged media",
    group: "Repair",
    icon: "mdiShieldCheckOutline",
    description:
      "Find damaged files, and tell them apart from ones that just can't be shown.",
    admin: true,
  },
  {
    id: "workflows",
    title: "Workflows",
    group: "Automate",
    icon: "mdiTuneVariant",
    description:
      "Automate tidying with rules, and see what each run did.",
  },
  {
    id: "downloads",
    title: "Mobile applications",
    group: "Connect",
    icon: "mdiDevices",
    description: "Choose a mobile app and review backup and migration setup.",
  },
  {
    id: "obtainium",
    title: "Obtainium setup",
    group: "Connect",
    icon: "mdiDownload",
    description:
      "Prepare direct Android updates with limited download-only access.",
  },
];
export const utilityStorageKey = "frameleaf:utilities:v1";
const fixture = (id, name, image, ownerId, bytes, extra = {}) => ({
  id,
  name,
  image,
  ownerId,
  bytes,
  status: "Review",
  ...extra,
});
export const utilityFixtures = [
  fixture("trash-sunset", "Sunset test shot.jpg", "lake", "taylor", 5400000, {
    tool: "trash",
    status: "Trashed",
    deletedAt: "2026-09-18T18:30:00Z",
    width: 4032,
    height: 3024,
  }),
  fixture(
    "trash-camp-video",
    "Campfire outtake.mov",
    "campfire",
    "taylor",
    187000000,
    {
      tool: "trash",
      status: "Trashed",
      deletedAt: "2026-09-12T14:10:00Z",
      width: 3840,
      height: 2160,
    },
  ),
  fixture(
    "trash-jamie",
    "Jamie's private outtake.jpg",
    "hiking",
    "jamie",
    4800000,
    {
      tool: "trash",
      status: "Trashed",
      deletedAt: "2026-09-17T18:30:00Z",
      width: 4032,
      height: 3024,
    },
  ),
  fixture("dup-raw", "Moraine Lake.ARW", "lake", "taylor", 48600000, {
    tool: "duplicates",
    group: "lake",
    width: 6000,
    height: 4000,
    quality: "Original RAW",
    suggested: true,
  }),
  fixture("dup-jpg", "Moraine Lake copy.jpg", "lake", "taylor", 4400000, {
    tool: "duplicates",
    group: "lake",
    width: 3840,
    height: 2160,
    quality: "Compressed export",
  }),
  fixture("dup-forest", "Forest walk.HEIC", "forest", "taylor", 14800000, {
    tool: "duplicates",
    group: "forest",
    width: 4032,
    height: 3024,
    quality: "Camera original",
    suggested: true,
  }),
  fixture(
    "dup-forest-copy",
    "Forest walk shared.jpg",
    "forest",
    "taylor",
    2100000,
    {
      tool: "duplicates",
      group: "forest",
      width: 1920,
      height: 1440,
      quality: "Shared copy",
    },
  ),
  fixture(
    "dup-campfire",
    "Campfire evening.jpg",
    "campfire",
    "taylor",
    12200000,
    {
      tool: "duplicates",
      group: "campfire",
      width: 6000,
      height: 4000,
      quality: "Camera original",
      suggested: true,
    },
  ),
  fixture(
    "dup-campfire-copy",
    "Campfire evening copy.jpg",
    "campfire",
    "taylor",
    2900000,
    {
      tool: "duplicates",
      group: "campfire",
      width: 2400,
      height: 1600,
      quality: "Compressed export",
    },
  ),
  // Illustrative burst previews use distinct viewport crops of one local image;
  // metadata describes sample frames, not measured photographic quality.
  ...Array.from({ length: 24 }, (_, index) =>
    fixture(
      `burst-forest-${String(index + 1).padStart(2, "0")}`,
      `Forest walk ${String(index + 1).padStart(2, "0")}.HEIC`,
      "forest",
      "taylor",
      6_420_000 + ((index * 173_831) % 2_000_000),
      {
        tool: "duplicates",
        group: "forest-burst",
        groupKind: "burst",
        groupLabel: "Forest walk · burst",
        frameNumber: index + 1,
        capturedAt: new Date(
          Date.UTC(2026, 8, 6, 16, 24, 12) + index * 100,
        ).toISOString(),
        offsetMs: index * 100,
        width: 4032,
        height: 3024,
        quality: [
          "Sharp detail",
          "Camera movement",
          "Focus settling",
          "Balanced exposure",
          "Moving foliage",
          "Sharp detail",
        ][index % 6],
        sampleEvidence: true,
        suggested: false,
        previewPosition: `${Math.round(22 + index * 2.1)}% ${Math.round(43 + Math.sin(index / 3) * 9)}%`,
        previewScale: Number((1.18 + (index % 5) * 0.035).toFixed(3)),
        focus: ["Sharp", "Soft", "Settling", "Sharp", "Sharp", "Sharp"][
          index % 6
        ],
        motion: [
          "Still",
          "Camera movement",
          "Slight movement",
          "Still",
          "Foliage movement",
          "Still",
        ][index % 6],
      },
    ),
  ),
  fixture("dup-hike", "Hiking.jpg", "hiking", "jamie", 6100000, {
    tool: "duplicates",
    group: "hike",
    width: 4032,
    height: 3024,
    quality: "Camera original",
    suggested: true,
  }),
  fixture("dup-hike-copy", "Hiking copy.jpg", "hiking", "jamie", 1800000, {
    tool: "duplicates",
    group: "hike",
    width: 2048,
    height: 1536,
    quality: "Messaging copy",
  }),
  fixture("large-lake", "Lake morning.mov", "lake", "taylor", 4819000000, {
    tool: "large-files",
    format: "HEVC · 4K · HDR",
    duration: "12:42",
  }),
  fixture(
    "large-camp",
    "Campfire memories.mov",
    "campfire",
    "jamie",
    2328000000,
    { tool: "large-files", format: "H.264 · 4K", duration: "08:16" },
  ),
  fixture("large-summit", "Summit panorama.tif", "summit", "emma", 890000000, {
    tool: "large-files",
    format: "TIFF · 16-bit",
    duration: "—",
  }),
  fixture("live-lake", "IMG_1042.HEIC", "lake", "taylor", 8900000, {
    tool: "live-photos",
    pair: "IMG_1042.MOV",
    confidence: "High",
    evidence: "Matching content identifier · timestamps 0.1 s apart",
    status: "Ready",
  }),
  fixture("live-creek", "IMG_2078.HEIC", "creek", "taylor", 7200000, {
    tool: "live-photos",
    pair: "IMG_2079.MOV",
    confidence: "Low",
    evidence:
      "Similar filename · timestamps 2.4 s apart · no content identifier",
    status: "Review",
  }),
  fixture("live-kayak", "IMG_3120.HEIC", "kayak", "jamie", 9500000, {
    tool: "live-photos",
    pair: "IMG_3120.MOV",
    confidence: "High",
    evidence: "Matching content identifier · same capture time",
    status: "Ready",
  }),
  fixture("geo-lake", "Moraine Lake.jpg", "lake", "taylor", 6200000, {
    tool: "geolocation",
    latitude: 51.3217,
    longitude: -116.186,
  }),
  fixture("geo-hiking", "Hiking with Jamie.jpg", "hiking", "taylor", 8200000, {
    tool: "geolocation",
    latitude: null,
    longitude: null,
  }),
  fixture("geo-cabin", "Cabin at dusk.jpg", "cabin", "jamie", 5300000, {
    tool: "geolocation",
    latitude: 51.4254,
    longitude: -116.1773,
  }),
  fixture("missing-raw", "Forest trail.ARW", "forest", "taylor", 42100000, {
    tool: "missing-media",
    status: "Missing",
    path: "/mnt/archive/2026/forest.ARW",
    evidence:
      "The original path could not be opened. Thumbnail is still available.",
    candidate: "/mnt/photos/recovered/forest.ARW",
    checksum: "Match",
    candidateStatus: "Not checked",
    backup: { status: "in-backup", newest: "m-2026-09-25" },
  }),
  fixture("missing-cabin", "Cabin at dusk.jpg", "cabin", "jamie", 6700000, {
    tool: "missing-media",
    status: "Candidate",
    path: "/mnt/archive/2026/cabin.jpg",
    evidence: "A same-name file was found, but its checksum differs.",
    candidate: "/mnt/photos/recovered/cabin.jpg",
    checksum: "Different",
    candidateStatus: "Found",
    // The backup copy was taken after the file changed, so its fingerprint differs too.
    backup: { status: "in-backup", newest: "m-2026-09-24", fingerprintMismatch: true },
  }),
  fixture("missing-kayak", "Kayak.mp4", "kayak", "taylor", 188000000, {
    tool: "missing-media",
    status: "Missing",
    path: "/mnt/archive/2025/kayak.mp4",
    evidence:
      "The original path could not be opened. It was imported before cloud backup was set up.",
    candidate: null,
    checksum: "Not checked",
    candidateStatus: "Not checked",
    backup: { status: "none" },
  }),
  fixture("corrupt-video", "Campfire.mov", "campfire", "taylor", 287000000, {
    tool: "corrupt-media",
    status: "Confirmed damaged",
    path: "/mnt/photos/campfire.mov",
    evidence:
      "Repeated decode failure at 00:07.200; independent probe confirms a truncated stream.",
    backup: { status: "in-backup", newest: "m-2026-09-24" },
  }),
  fixture("corrupt-raw", "Summit.CR3", "summit", "emma", 56000000, {
    tool: "corrupt-media",
    status: "Unsupported RAW",
    path: "/mnt/photos/summit.CR3",
    evidence:
      "Decoder does not support this camera. The original has not been proven corrupt.",
    backup: { status: "in-backup", newest: "m-2026-09-25" },
  }),
  fixture("corrupt-suspect", "Elk.jpg", "elk", "jamie", 11200000, {
    tool: "corrupt-media",
    status: "Suspected damage",
    path: "/mnt/photos/elk.jpg",
    evidence: "A thumbnail job failed once. Further validation is needed.",
    backup: { status: "checking", newest: "m-2026-09-01" },
  }),
];
export function initialUtilities() {
  return {
    version: 1,
    rows: [
      ...structuredClone(utilityFixtures),
      ...media.map((asset) => ({
        id: `library-${asset.id}`,
        assetId: asset.id,
        people: asset.people,
        personIds: asset.personIds,
        tags: asset.tags,
        name: asset.name,
        image: asset.image.split("/").at(-1).replace(".png", ""),
        ownerId: asset.ownerId,
        tool: "library",
        status: "Ready",
        mediaType: asset.type,
        isLocked: asset.isLocked === true,
        isSuppressed: asset.isSuppressed === true,
        isSensitive: asset.isSensitive === true,
        isNsfw: asset.isNsfw === true,
        bytes: 0,
        deletedAt: null,
      })),
    ],
    history: [],
    runs: [],
    workflows: [
      {
        id: "receipt-rule",
        name: "Organize receipts",
        ownerId: "taylor",
        enabled: true,
        logging: true,
        trigger: "AssetCreate",
        steps: [
          {
            method: "immich-plugin-core#assetTypeFilter",
            config: { allowedTypes: ["IMAGE"] },
          },
          {
            method: "immich-plugin-core#assetAddTags",
            config: { tags: ["receipts"] },
          },
        ],
      },
    ],
    connections: [
      {
        id: "apple-taylor",
        ownerId: "taylor",
        name: "Personal iCloud",
        status: "Disconnected",
        albums: ["Recents"],
        intervalHours: 24,
        concurrency: 1,
        stagingGiB: 20,
        libraries: ["personal"],
        includeHidden: false,
        recoverExternalAsManaged: false,
        edits: true,
        results: [],
      },
    ],
  };
}
const allowedStatuses = new Set([
  "Review",
  "Ready",
  "Linked",
  "Missing",
  "Candidate",
  "Found",
  "Relinked",
  "Dismissed",
  "Confirmed damaged",
  "Unsupported RAW",
  "Suspected damage",
  "Trashed",
  "Restored",
  "Deleted",
  "Kept",
  "Stacked",
  "Resolved",
]);
export function parseUtilities(raw) {
  const base = initialUtilities();
  if (typeof raw === "string" && raw.length > 1_000_000) return base;
  let source;
  try {
    source = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return base;
  }
  if (
    !source ||
    source.version !== 1 ||
    typeof source !== "object" ||
    Array.isArray(source)
  )
    return base;
  if (Array.isArray(source.rows))
    base.rows = base.rows.map((row) => {
      const old = source.rows.slice(0, 100).find((x) => x?.id === row.id);
      if (!old) return row;
      return {
        ...row,
        ...(row.tool === "library"
          ? {
              isLocked:
                typeof old.isLocked === "boolean" ? old.isLocked : row.isLocked,
              isSuppressed:
                typeof old.isSuppressed === "boolean"
                  ? old.isSuppressed
                  : row.isSuppressed,
              isSensitive:
                typeof old.isSensitive === "boolean"
                  ? old.isSensitive
                  : row.isSensitive,
              isNsfw: typeof old.isNsfw === "boolean" ? old.isNsfw : row.isNsfw,
            }
          : {}),
        status: allowedStatuses.has(old.status) ? old.status : row.status,
        ...(old.deletedAt === null
          ? { deletedAt: null }
          : typeof old.deletedAt === "string" &&
              Number.isFinite(Date.parse(old.deletedAt))
            ? { deletedAt: old.deletedAt }
            : {}),
        candidateStatus: ["Not checked", "Found"].includes(old.candidateStatus)
          ? old.candidateStatus
          : row.candidateStatus,
        ...(typeof old.latitude === "number" &&
        Math.abs(old.latitude) <= 90 &&
        typeof old.longitude === "number" &&
        Math.abs(old.longitude) <= 180
          ? { latitude: old.latitude, longitude: old.longitude }
          : {}),
        ...restoreUtilityRecovery(row, old),
      };
    });
  if (Array.isArray(source.history))
    base.history = source.history
      .slice(0, 30)
      .filter(
        (x) =>
          x &&
          typeof x.title === "string" &&
          x.title.length < 300 &&
          typeof x.at === "string" &&
          Number.isFinite(Date.parse(x.at)),
      )
      .map(({ title, at }) => ({ title, at }));
  if (Array.isArray(source.workflows))
    base.workflows = source.workflows.slice(0, 30).flatMap((value) => {
      try {
        const workflow = migrateLegacyWorkflow(value);
        if (
          typeof workflow.id !== "string" ||
          !workflow.id ||
          workflow.id.length > 100 ||
          !["taylor", "jamie", "emma"].includes(workflow.ownerId) ||
          workflowCredentialPaths(workflow).length
        )
          return [];
        return [workflow];
      } catch {
        return [];
      }
    });
  if (Array.isArray(source.runs))
    base.runs = source.runs
      .slice(0, 20)
      .filter(
        (x) =>
          x &&
          ["missing-media", "corrupt-media"].includes(x.tool) &&
          ["Queued", "Cancelled", "Completed"].includes(x.status) &&
          typeof x.at === "string" &&
          Number.isFinite(Date.parse(x.at)),
      )
      .map(({ tool, status, at }) => ({ tool, status, at }));
  if (Array.isArray(source.connections))
    base.connections = source.connections
      .slice(0, 20)
      .filter(
        (x) =>
          x &&
          typeof x.id === "string" &&
          x.id.length <= 100 &&
          x.ownerId === "taylor" &&
          typeof x.name === "string" &&
          x.name.trim() &&
          x.name.length <= 120,
      )
      .filter((x, i, all) => all.findIndex((y) => y.id === x.id) === i)
      .map((old) => {
        const c = initialUtilities().connections[0];
        return {
          ...c,
          id: old.id,
          name: old.name,
          status: [
            "Disconnected",
            "Awaiting verification",
            "Connected",
            "Queued",
            "Paused",
            "Cancelled",
            "Completed",
          ].includes(old.status)
            ? old.status
            : c.status,
          albums: Array.isArray(old.albums)
            ? [
                ...new Set(
                  old.albums.filter((x) =>
                    ["Recents", "Summer trip", "Family"].includes(x),
                  ),
                ),
              ]
            : c.albums,
          intervalHours:
            Number.isInteger(old.intervalHours) &&
            old.intervalHours >= 1 &&
            old.intervalHours <= 8760
              ? old.intervalHours
              : c.intervalHours,
          concurrency:
            Number.isInteger(old.concurrency) &&
            old.concurrency >= 1 &&
            old.concurrency <= 4
              ? old.concurrency
              : c.concurrency,
          stagingGiB:
            Number.isFinite(Number(old.stagingGiB)) &&
            Number(old.stagingGiB) >= 1 / 1024 &&
            Number(old.stagingGiB) <= Number.MAX_SAFE_INTEGER / 1024 ** 3
              ? Number(old.stagingGiB)
              : c.stagingGiB,
          libraries: Array.isArray(old.libraries)
            ? [
                ...new Set(
                  old.libraries.filter((x) =>
                    ["personal", "shared-family"].includes(x),
                  ),
                ),
              ]
            : c.libraries,
          includeHidden: !!old.includeHidden,
          recoverExternalAsManaged: !!old.recoverExternalAsManaged,
          edits: old.edits !== false,
        };
      });
  return base;
}
/** Shown when a restored file doesn't match the fingerprint the library recorded. */
export const RESTORE_REFUSED =
  "Restore refused: the backup copy doesn’t match this item’s fingerprint. The finding stays open.";

export function applyUtilityAction(
  state,
  {
    action,
    ids,
    actorId = "taylor",
    admin = false,
    latitude,
    longitude,
    keeperId,
  },
) {
  const unique = [...new Set(ids)];
  const targets = state.rows.filter((row) => unique.includes(row.id));
  if (!targets.length || targets.length !== unique.length)
    throw Error("Choose available items.");
  if (targets.some((row) => row.status === "Deleted"))
    throw Error("Permanently deleted items cannot be changed.");
  if (
    targets.some(
      (row) =>
        row.ownerId !== actorId &&
        !(admin && ["missing-media", "corrupt-media"].includes(row.tool)),
    )
  )
    throw Error("Only the owner can change these items.");
  if (
    action === "relink" &&
    targets.some(
      (row) =>
        row.tool !== "missing-media" ||
        row.checksum !== "Match" ||
        row.candidateStatus !== "Found",
    )
  )
    throw Error("Verify an exact original match before relinking.");
  if (
    action === "trash-corrupt" &&
    targets.some(
      (row) =>
        row.tool !== "corrupt-media" || row.status !== "Confirmed damaged",
    )
  )
    throw Error("Only confirmed damaged files can be moved to trash.");
  if (action === "restore" && targets.some((row) => row.backup?.status !== "in-backup"))
    throw Error("Only items in a kept backup can be restored from it.");
  if (action === "restore" && targets.some((row) => row.backup.fingerprintMismatch))
    throw Error(RESTORE_REFUSED);
  if (
    action === "location" &&
    (!Number.isFinite(latitude) ||
      Math.abs(latitude) > 90 ||
      !Number.isFinite(longitude) ||
      Math.abs(longitude) > 180 ||
      targets.some((row) => row.tool !== "geolocation"))
  )
    throw Error("Enter valid latitude and longitude.");
  if (
    action === "resolve-duplicates" &&
    (!targets.every((row) => row.tool === "duplicates") ||
      new Set(targets.map((row) => row.group)).size !== 1 ||
      !targets.some((row) => row.id === keeperId))
  )
    throw Error("Choose a keeper from this duplicate group.");
  const allowed = {
    link: ["live-photos"],
    relink: ["missing-media"],
    locate: ["missing-media"],
    restore: ["missing-media", "corrupt-media"],
    location: ["geolocation"],
    keep: ["duplicates"],
    stack: ["duplicates"],
    resolve: ["duplicates"],
    trash: ["duplicates", "large-files"],
    "trash-corrupt": ["corrupt-media"],
    dismiss: ["missing-media", "corrupt-media"],
    "resolve-duplicates": ["duplicates"],
  };
  if (
    !allowed[action] ||
    targets.some((row) => !allowed[action].includes(row.tool))
  )
    throw Error("This action does not apply to the selected items.");
  const status = {
    link: "Linked",
    relink: "Relinked",
    restore: "Restored",
    dismiss: "Dismissed",
    trash: "Trashed",
    "trash-corrupt": "Trashed",
    keep: "Kept",
    stack: "Stacked",
    resolve: "Resolved",
  }[action];
  if (!status && !["locate", "location", "resolve-duplicates"].includes(action))
    throw Error("Unsupported action.");
  const rows = state.rows.map((row) =>
    !unique.includes(row.id)
      ? row
      : {
          ...row,
          ...(status ? { status } : {}),
          ...(action === "resolve-duplicates"
            ? { status: row.id === keeperId ? "Kept" : "Trashed" }
            : {}),
          ...(action === "locate"
            ? {
                candidateStatus: "Found",
                status: row.checksum === "Match" ? "Found" : "Candidate",
              }
            : {}),
          ...(action === "location" ? { latitude, longitude } : {}),
        },
  );
  return {
    ...state,
    rows,
    history: [
      {
        title: `${action === "location" ? "Location updated" : action[0].toUpperCase() + action.slice(1)} · ${targets.length} item${targets.length === 1 ? "" : "s"}`,
        at: new Date().toISOString(),
      },
      ...state.history,
    ].slice(0, 30),
  };
}
export const ownerName = (id) =>
  ({ taylor: "Taylor", jamie: "Jamie", emma: "Emma" })[id] || id;
export const formatBytes = (bytes) =>
  bytes >= 1e9
    ? `${(bytes / 1e9).toFixed(2)} GB`
    : `${(bytes / 1e6).toFixed(1)} MB`;

export function parseWorkflowImport(raw) {
  return migrateLegacyWorkflow(parseWorkflowDefinition(raw));
}
export function previewWorkflow(workflow) {
  const errors = workflowExecutionErrors(workflow);
  if (errors.length) throw Error(errors.join(" "));
  return workflow.steps.map((step) => ({
    ...step,
    result:
      step.enabled === false ? "Disabled" : "Schema validated; not executed",
  }));
}

export const recoveryRoots = Object.freeze([
  { id: "recovered", label: "Recovered files", path: "/mnt/photos/recovered" },
  { id: "backup", label: "Verified backup", path: "/mnt/backup/photos" },
]);
export function recoveryCandidates(row) {
  if (row.tool === "missing-media")
    return [
      {
        id: `${row.id}:recovered`,
        rootId: "recovered",
        path: row.candidate,
        checksumMatch: row.id === "missing-raw",
        decodeValid: row.id === "missing-raw",
        bytes: row.bytes,
      },
      {
        id: `${row.id}:backup`,
        rootId: "backup",
        path: `/mnt/backup/photos/${row.name}`,
        checksumMatch: true,
        decodeValid: true,
        bytes: row.bytes,
      },
    ];
  if (row.tool === "corrupt-media")
    return [
      {
        id: `${row.id}:backup`,
        rootId: "backup",
        path: `/mnt/backup/photos/${row.name}`,
        checksumMatch: row.status === "Confirmed damaged",
        decodeValid: row.status === "Confirmed damaged",
        bytes: row.bytes,
      },
      {
        id: `${row.id}:preview`,
        rootId: "recovered",
        path: `/mnt/photos/recovered/${row.name}.preview.mp4`,
        checksumMatch: false,
        decodeValid: true,
        bytes: Math.round(row.bytes / 4),
      },
    ];
  return [];
}
export function applyUtilityRecovery(
  state,
  {
    mode,
    rows,
    rootIds,
    candidateIds,
    confirmed = false,
    actorId = "taylor",
    admin = false,
  },
) {
  if (
    !["locate", "replace"].includes(mode) ||
    !Array.isArray(rows) ||
    !rows.length ||
    rows.length > 100
  )
    throw Error("Choose available media findings.");
  if (
    !Array.isArray(rootIds) ||
    !rootIds.length ||
    rootIds.length > recoveryRoots.length ||
    rootIds.some((id) => !recoveryRoots.some((root) => root.id === id))
  )
    throw Error("Choose a configured search root.");
  if (mode === "replace" && !confirmed)
    throw Error(
      "Confirm the verified replacement and retention of the previous source.",
    );
  const selected = new Map();
  for (const snapshot of rows) {
    const row = state.rows.find((item) => item.id === snapshot.id);
    if (
      !row ||
      selected.has(row.id) ||
      row.status !== snapshot.status ||
      row.path !== snapshot.path
    )
      throw Error("A finding changed. Review the latest evidence.");
    if (row.ownerId !== actorId && !admin)
      throw Error("Owner or administrator access is required.");
    if (
      mode === "replace" &&
      (row.tool !== "corrupt-media" || row.status !== "Confirmed damaged")
    )
      throw Error("Only confirmed damage can be replaced.");
    if (mode === "locate" && row.tool !== "missing-media")
      throw Error("Choose missing originals to locate.");
    const candidate = recoveryCandidates(row).find(
      (item) => item.id === candidateIds?.[row.id],
    );
    if (!candidate || !rootIds.includes(candidate.rootId))
      throw Error("Choose a candidate within the selected search roots.");
    if (
      mode === "replace" &&
      (!candidate.checksumMatch || !candidate.decodeValid)
    )
      throw Error(
        "Replacement requires an exact checksum and successful decode validation.",
      );
    selected.set(row.id, { candidate, snapshot });
  }
  return {
    ...state,
    rows: state.rows.map((row) => {
      const selection = selected.get(row.id);
      if (!selection) return row;
      const { candidate } = selection;
      return {
        ...row,
        status:
          mode === "replace"
            ? "Resolved"
            : candidate.checksumMatch
              ? "Found"
              : "Candidate",
        candidate: candidate.path,
        checksum: candidate.checksumMatch ? "Match" : "Different",
        candidateStatus: "Found",
        recovery: {
          mode,
          candidateId: candidate.id,
          rootIds: [...new Set(rootIds)],
          originalPath: row.path,
          previousSourceRetained: mode === "replace",
        },
      };
    }),
    history: [
      {
        title: `${mode === "replace" ? "Verified replacement" : "Candidate review"} · ${selected.size} items`,
        at: new Date().toISOString(),
      },
      ...state.history,
    ].slice(0, 30),
  };
}

function restoreUtilityRecovery(row, old) {
  const recovery = old.recovery;
  if (
    !recovery ||
    !["locate", "replace"].includes(recovery.mode) ||
    !Array.isArray(recovery.rootIds) ||
    recovery.rootIds.length > recoveryRoots.length ||
    recovery.rootIds.some(
      (id) => !recoveryRoots.some((root) => root.id === id),
    ) ||
    recovery.originalPath !== row.path
  )
    return {};
  const candidate = recoveryCandidates(row).find(
    (item) =>
      item.id === recovery.candidateId &&
      recovery.rootIds.includes(item.rootId),
  );
  if (
    !candidate ||
    (recovery.mode === "replace" &&
      (!candidate.checksumMatch ||
        !candidate.decodeValid ||
        recovery.previousSourceRetained !== true ||
        row.tool !== "corrupt-media")) ||
    (recovery.mode === "locate" && row.tool !== "missing-media")
  )
    return {};
  return {
    candidate: candidate.path,
    checksum: candidate.checksumMatch ? "Match" : "Different",
    candidateStatus: "Found",
    recovery: {
      mode: recovery.mode,
      candidateId: candidate.id,
      rootIds: [...new Set(recovery.rootIds)],
      originalPath: row.path,
      previousSourceRetained: recovery.mode === "replace",
    },
  };
}

export function coordinateBounds(
  latitude = 51.36,
  longitude = -116.18,
  zoom = 1,
) {
  const z = Number.isFinite(zoom) ? Math.max(1, Math.min(8, zoom)) : 1;
  const lat = Number.isFinite(latitude)
    ? Math.max(-90, Math.min(90, latitude))
    : 51.36;
  const lng = Number.isFinite(longitude)
    ? Math.max(-180, Math.min(180, longitude))
    : -116.18;
  return {
    north: Math.min(90, lat + 0.1 / z),
    south: Math.max(-90, lat - 0.1 / z),
    west: Math.max(-180, lng - 0.14 / z),
    east: Math.min(180, lng + 0.14 / z),
  };
}
export function pickCoordinates(bounds, x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y))
    throw Error("Choose a position inside the coordinate surface.");
  return {
    latitude: Number(
      (
        bounds.north -
        (bounds.north - bounds.south) * Math.max(0, Math.min(1, y))
      ).toFixed(6),
    ),
    longitude: Number(
      (
        bounds.west +
        (bounds.east - bounds.west) * Math.max(0, Math.min(1, x))
      ).toFixed(6),
    ),
  };
}
export function offsetCoordinates(
  latitude,
  longitude,
  direction,
  step = 0.001,
) {
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    !Number.isFinite(step) ||
    step <= 0
  )
    throw Error("Enter a valid starting location.");
  const offset = {
    north: [step, 0],
    south: [-step, 0],
    west: [0, -step],
    east: [0, step],
  }[direction];
  if (!offset) throw Error("Choose a direction.");
  return {
    latitude: Number(
      Math.max(-90, Math.min(90, latitude + offset[0])).toFixed(6),
    ),
    longitude: Number(
      Math.max(-180, Math.min(180, longitude + offset[1])).toFixed(6),
    ),
  };
}
