// Maintenance state for the command center: maintenance mode, database
// backups (with a restore flow) and integrity checks with reports. Pure state
// transitions with deterministic sample results; the screen drives timers.
export const MAINTENANCE_KEY = "frameleaf:maintenance:v1";
export const MAINTENANCE_LIMITS = Object.freeze({
  backups: 60,
  reports: 40,
  findings: 400,
  jsonCharacters: 2 * 1024 * 1024,
});
export const severities = Object.freeze(["error", "warning", "info"]);
export const severityLabels = Object.freeze({
  error: "Error",
  warning: "Warning",
  info: "Info",
});
export const backupKinds = Object.freeze({
  scheduled: "Scheduled",
  manual: "Manual",
  "pre-restore": "Before restore",
});
export const backupStatuses = Object.freeze([
  "complete",
  "running",
  "failed",
]);
export const checkStatuses = Object.freeze([
  "idle",
  "running",
  "passed",
  "issues",
  "failed",
]);
export const integrityCheckTypes = Object.freeze([
  {
    id: "checksums",
    title: "Checksums",
    description: "Compare stored checksums with the files on disk.",
    icon: "mdiShieldCheckOutline",
  },
  {
    id: "orphaned-files",
    title: "Orphaned files",
    description: "Find files in library folders that no record references.",
    icon: "mdiFileTree",
  },
  {
    id: "missing-thumbnails",
    title: "Missing thumbnails",
    description: "Find items whose previews or thumbnails were never generated.",
    icon: "mdiImageMultipleOutline",
  },
  {
    id: "sidecars",
    title: "Sidecars",
    description: "Check XMP sidecars for missing or unreadable metadata.",
    icon: "mdiFileDocumentOutline",
  },
]);
export const restoreSteps = Object.freeze([
  {
    id: "maintenance",
    title: "Enter maintenance mode",
    detail: "Everyone except administrators sees the maintenance page.",
  },
  {
    id: "restore",
    title: "Restore the database",
    detail: "The current database is replaced with the chosen backup.",
  },
  {
    id: "migrations",
    title: "Run migrations",
    detail: "Bring the restored database up to this server version.",
  },
  {
    id: "verification",
    title: "Verify the library",
    detail: "Check that records, users and libraries load correctly.",
  },
]);
export const restoreConsequences = Object.freeze([
  "Metadata, albums, people, edits and settings return to the state in this backup.",
  "Changes made after the backup are lost unless you create a backup first.",
  "Original files on disk are not touched.",
  "Everyone is signed out, and the server stays in maintenance mode until you end it.",
]);
export const postRestoreChecklist = Object.freeze([
  {
    id: "open",
    title: "Open the library and confirm recent photos appear",
  },
  {
    id: "integrity",
    title: "Run integrity checks for checksums and thumbnails",
  },
  {
    id: "scan",
    title: "Rescan external libraries to pick up files added after the backup",
  },
  { id: "end", title: "End maintenance mode so everyone can sign in again" },
]);

const record = (value) =>
  !!value && typeof value === "object" && !Array.isArray(value);
const string = (value, max = 500) =>
  typeof value === "string" ? value.slice(0, max) : "";
const isoDate = (value) =>
  typeof value === "string" &&
  value.length <= 40 &&
  Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : null;
const bounded = (value, min, max, fallback) =>
  typeof value === "number" && Number.isFinite(value) && value >= min
    ? Math.min(value, max)
    : fallback;
const clone = (value) => structuredClone(value);
const id = (prefix) =>
  `${prefix}-${
    globalThis.crypto?.randomUUID
      ? globalThis.crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10)
  }`;
const hoursAgo = (now, hours) =>
  new Date(Date.parse(now) - hours * 3_600_000).toISOString();

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes,
    unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function createMaintenanceState(now = new Date().toISOString()) {
  const at = isoDate(now) || new Date().toISOString();
  return {
    version: 1,
    mode: { active: false, startedAt: null, endedAt: hoursAgo(at, 7 * 24), reason: "" },
    backups: [
      {
        id: "backup-seed-1",
        createdAt: hoursAgo(at, 10),
        sizeBytes: 412_000_000,
        kind: "scheduled",
        status: "complete",
        progress: 100,
        note: "Nightly schedule",
      },
      {
        id: "backup-seed-2",
        createdAt: hoursAgo(at, 34),
        sizeBytes: 409_500_000,
        kind: "scheduled",
        status: "complete",
        progress: 100,
        note: "Nightly schedule",
      },
      {
        id: "backup-seed-3",
        createdAt: hoursAgo(at, 58),
        sizeBytes: 401_200_000,
        kind: "manual",
        status: "complete",
        progress: 100,
        note: "Before updating to the September release",
      },
      {
        id: "backup-seed-4",
        createdAt: hoursAgo(at, 82),
        sizeBytes: 0,
        kind: "scheduled",
        status: "failed",
        progress: 0,
        note: "Backup destination was not mounted",
      },
    ],
    restore: null,
    lastRestore: null,
    checks: Object.fromEntries(
      integrityCheckTypes.map((type) => [
        type.id,
        {
          status: type.id === "checksums" ? "passed" : "idle",
          progress: 0,
          lastRun: type.id === "checksums" ? hoursAgo(at, 30) : null,
          reportId: null,
        },
      ]),
    ),
    reports: [],
  };
}

function parseBackup(value) {
  if (!record(value) || !string(value.id, 80)) return null;
  const status = backupStatuses.includes(value.status) ? value.status : null;
  const createdAt = isoDate(value.createdAt);
  if (!status || !createdAt) return null;
  return {
    id: string(value.id, 80),
    createdAt,
    sizeBytes: bounded(value.sizeBytes, 0, 1e15, 0),
    kind: Object.hasOwn(backupKinds, value.kind) ? value.kind : "manual",
    // Interrupted backups cannot resume after a reload.
    status: status === "running" ? "failed" : status,
    progress: status === "complete" ? 100 : 0,
    note:
      status === "running"
        ? "Backup interrupted before it finished"
        : string(value.note, 200),
  };
}
function parseFinding(value, index) {
  if (!record(value)) return null;
  const severity = severities.includes(value.severity) ? value.severity : null;
  const message = string(value.message, 300);
  if (!severity || !message) return null;
  return {
    id: string(value.id, 80) || `finding-${index}`,
    severity,
    path: string(value.path, 500),
    message,
    detail: string(value.detail, 500),
  };
}
function parseReport(value) {
  if (!record(value) || !string(value.id, 80)) return null;
  const type = integrityCheckTypes.find((item) => item.id === value.type);
  const createdAt = isoDate(value.createdAt);
  if (!type || !createdAt || !Array.isArray(value.findings)) return null;
  const findings = value.findings
    .slice(0, MAINTENANCE_LIMITS.findings)
    .map(parseFinding)
    .filter(Boolean);
  return {
    id: string(value.id, 80),
    type: type.id,
    createdAt,
    scanned: bounded(value.scanned, 0, 1e9, findings.length),
    durationMs: bounded(value.durationMs, 0, 1e9, 0),
    findings,
    summary: summarize(findings),
  };
}
export function summarize(findings) {
  const summary = { error: 0, warning: 0, info: 0, total: 0 };
  for (const finding of findings) {
    summary[finding.severity] += 1;
    summary.total += 1;
  }
  return summary;
}
export function parseMaintenanceState(raw, now = new Date().toISOString()) {
  const base = createMaintenanceState(now);
  let source = raw;
  if (typeof source === "string") {
    if (source.length > MAINTENANCE_LIMITS.jsonCharacters) return base;
    try {
      source = JSON.parse(source);
    } catch {
      return base;
    }
  }
  if (!record(source) || source.version !== 1) return base;
  const state = base;
  if (record(source.mode)) {
    state.mode = {
      active: source.mode.active === true,
      startedAt: isoDate(source.mode.startedAt),
      endedAt: isoDate(source.mode.endedAt),
      reason: string(source.mode.reason, 200),
    };
    if (state.mode.active && !state.mode.startedAt)
      state.mode.startedAt = isoDate(now) || new Date().toISOString();
  }
  if (Array.isArray(source.backups)) {
    const seen = new Set();
    state.backups = source.backups
      .slice(0, MAINTENANCE_LIMITS.backups)
      .map(parseBackup)
      .filter((backup) => backup && !seen.has(backup.id) && seen.add(backup.id));
  }
  if (Array.isArray(source.reports)) {
    const seen = new Set();
    state.reports = source.reports
      .slice(0, MAINTENANCE_LIMITS.reports)
      .map(parseReport)
      .filter((report) => report && !seen.has(report.id) && seen.add(report.id));
  }
  if (record(source.checks)) {
    for (const type of integrityCheckTypes) {
      const check = source.checks[type.id];
      if (!record(check)) continue;
      const status = checkStatuses.includes(check.status) ? check.status : "idle";
      const reportId =
        typeof check.reportId === "string" &&
        state.reports.some((report) => report.id === check.reportId)
          ? check.reportId
          : null;
      state.checks[type.id] = {
        // A check interrupted by a reload starts over.
        status: status === "running" ? "idle" : status,
        progress: 0,
        lastRun: isoDate(check.lastRun),
        reportId,
      };
    }
  }
  if (record(source.lastRestore)) {
    state.lastRestore = {
      backupId: string(source.lastRestore.backupId, 80),
      finishedAt: isoDate(source.lastRestore.finishedAt),
      checklist: Array.isArray(source.lastRestore.checklist)
        ? [
            ...new Set(
              source.lastRestore.checklist.filter((item) =>
                postRestoreChecklist.some((step) => step.id === item),
              ),
            ),
          ]
        : [],
    };
  }
  // A restore in progress at reload cannot be trusted to resume; it stays in
  // maintenance mode and the administrator decides how to continue.
  if (record(source.restore) && source.restore.status === "restored") {
    const backupId = string(source.restore.backupId, 80);
    state.restore = state.backups.some((backup) => backup.id === backupId)
      ? {
          backupId,
          step: restoreSteps.length,
          status: "restored",
          startedAt: isoDate(source.restore.startedAt),
          finishedAt: isoDate(source.restore.finishedAt),
        }
      : null;
  }
  return state;
}
export function serializeMaintenance(state) {
  return JSON.stringify({ ...state, version: 1 });
}

const fail = (message) => {
  throw new Error(message);
};
export function startMaintenance(state, now, reason = "") {
  if (state.mode.active) fail("Maintenance mode is already on.");
  return {
    ...state,
    mode: {
      active: true,
      startedAt: isoDate(now) || new Date().toISOString(),
      endedAt: state.mode.endedAt,
      reason: string(reason, 200).trim(),
    },
  };
}
export function endMaintenance(state, now) {
  if (!state.mode.active) fail("Maintenance mode is already off.");
  if (state.restore?.status === "running")
    fail("Finish the restore before ending maintenance mode.");
  return {
    ...state,
    mode: {
      active: false,
      startedAt: null,
      endedAt: isoDate(now) || new Date().toISOString(),
      reason: "",
    },
  };
}

export function beginBackup(state, now, kind = "manual", note = "") {
  if (state.backups.some((backup) => backup.status === "running"))
    fail("A backup is already running.");
  if (state.backups.length >= MAINTENANCE_LIMITS.backups)
    fail(`Delete an older backup first (limit ${MAINTENANCE_LIMITS.backups}).`);
  const backup = {
    id: id("backup"),
    createdAt: isoDate(now) || new Date().toISOString(),
    sizeBytes: 0,
    kind: Object.hasOwn(backupKinds, kind) ? kind : "manual",
    status: "running",
    progress: 0,
    note: string(note, 200).trim() || (kind === "pre-restore" ? "Created before restore" : "Created on request"),
  };
  return { ...state, backups: [backup, ...state.backups] };
}
export function advanceBackup(state, backupId, increment = 20) {
  const backup = state.backups.find((item) => item.id === backupId);
  if (!backup || backup.status !== "running") return state;
  const progress = Math.min(100, backup.progress + Math.max(1, increment));
  const latest = state.backups.find((item) => item.status === "complete");
  const sizeBytes = latest
    ? Math.round(latest.sizeBytes * (1 + ((hash(backup.id) % 30) + 5) / 1000))
    : 412_000_000;
  return {
    ...state,
    backups: state.backups.map((item) =>
      item.id === backupId
        ? {
            ...item,
            progress,
            status: progress >= 100 ? "complete" : "running",
            sizeBytes: progress >= 100 ? sizeBytes : Math.round((sizeBytes * progress) / 100),
          }
        : item,
    ),
  };
}
export function deleteBackup(state, backupId) {
  const backup = state.backups.find((item) => item.id === backupId);
  if (!backup) fail("This backup no longer exists.");
  if (backup.status === "running") fail("Wait for the backup to finish.");
  if (state.restore && state.restore.backupId === backupId && state.restore.status === "running")
    fail("This backup is being restored.");
  return {
    ...state,
    backups: state.backups.filter((item) => item.id !== backupId),
  };
}
export const backupFileName = (backup) =>
  `frameleaf-db-${backup.createdAt.slice(0, 19).replace(/[:T]/g, "-")}.sql.gz`;

export function beginRestore(state, backupId, now) {
  const backup = state.backups.find((item) => item.id === backupId);
  if (!backup || backup.status !== "complete")
    fail("Choose a completed backup to restore.");
  if (state.restore?.status === "running") fail("A restore is already running.");
  if (state.backups.some((item) => item.status === "running"))
    fail("Wait for the running backup to finish.");
  const at = isoDate(now) || new Date().toISOString();
  return {
    ...state,
    mode: state.mode.active
      ? state.mode
      : { active: true, startedAt: at, endedAt: state.mode.endedAt, reason: "Restoring a database backup" },
    restore: { backupId, step: 0, status: "running", startedAt: at, finishedAt: null },
  };
}
export function advanceRestore(state, now) {
  if (!state.restore || state.restore.status !== "running") return state;
  const step = state.restore.step + 1;
  const done = step >= restoreSteps.length;
  const at = isoDate(now) || new Date().toISOString();
  return {
    ...state,
    restore: {
      ...state.restore,
      step,
      status: done ? "restored" : "running",
      finishedAt: done ? at : null,
    },
    lastRestore: done
      ? { backupId: state.restore.backupId, finishedAt: at, checklist: [] }
      : state.lastRestore,
  };
}
export function toggleChecklistItem(state, itemId) {
  if (!state.lastRestore || !postRestoreChecklist.some((item) => item.id === itemId))
    return state;
  const done = state.lastRestore.checklist.includes(itemId);
  return {
    ...state,
    lastRestore: {
      ...state.lastRestore,
      checklist: done
        ? state.lastRestore.checklist.filter((item) => item !== itemId)
        : [...state.lastRestore.checklist, itemId],
    },
  };
}
export function finishRestore(state) {
  if (!state.restore || state.restore.status !== "restored") return state;
  return { ...state, restore: null };
}
export const restoreProgressLabel = (restore) =>
  !restore
    ? ""
    : restore.status === "restored"
      ? "Restored"
      : `Step ${Math.min(restore.step + 1, restoreSteps.length)} of ${restoreSteps.length} · ${restoreSteps[Math.min(restore.step, restoreSteps.length - 1)].title}`;

function hash(text) {
  let value = 2166136261;
  for (const character of String(text)) {
    value ^= character.charCodeAt(0);
    value = Math.imul(value, 16777619) >>> 0;
  }
  return value;
}
const sampleFiles = [
  "2026/08/IMG_0421.HEIC",
  "2026/08/Lake morning.mov",
  "2026/08/Moraine Lake.jpg",
  "2026/07/Campfire evening.jpg",
  "2026/07/DSC_2210.NEF",
  "2025/12/Skating.mp4",
  "2025/11/IMG_9902.jpg",
  "2025/09/Hiking with Jamie.jpg",
  "2025/06/Kayak.mp4",
  "2025/05/Forest trail.mov",
  "2024/10/PANO_0018.jpg",
  "2024/03/IMG_7710.dng",
];
const findingTemplates = {
  checksums: [
    ["error", "Checksum mismatch", "Stored SHA-1 differs from the file on disk."],
    ["warning", "File modified after import", "Modification time is newer than the recorded checksum."],
    ["info", "Checksum recorded", "This file had no checksum and one was recorded."],
  ],
  "orphaned-files": [
    ["warning", "No library record references this file", "The file can be removed or imported."],
    ["info", "Temporary upload left behind", "Partial upload older than 7 days."],
    ["error", "Referenced path is a directory", "The record points at a folder, not a file."],
  ],
  "missing-thumbnails": [
    ["warning", "Preview missing", "The preview image was never generated."],
    ["warning", "Thumbnail missing", "The thumbnail image is absent from the cache."],
    ["info", "Video poster missing", "Playback still works; the poster can be regenerated."],
  ],
  sidecars: [
    ["error", "Sidecar unreadable", "The XMP file is not valid XML."],
    ["info", "Sidecar missing", "No sidecar exists; metadata comes from the file."],
    ["warning", "Sidecar newer than record", "Edits in the sidecar have not been imported."],
  ],
};
/** Deterministic sample findings so a report looks the same after a reload. */
export function generateFindings(type, seed = "") {
  const templates = findingTemplates[type];
  if (!templates) return [];
  const base = hash(`${type}:${seed}`);
  const count = 2 + (base % 7);
  const result = [];
  for (let index = 0; index < count; index += 1) {
    const value = hash(`${base}:${index}`);
    const [severity, message, detail] = templates[value % templates.length];
    const file = sampleFiles[(value >>> 4) % sampleFiles.length];
    const root = type === "orphaned-files" ? "/mnt/photos/upload/taylor" : "/mnt/photos/library";
    result.push({
      id: `${type}-${index + 1}`,
      severity,
      path:
        type === "sidecars"
          ? `${root}/${file.replace(/\.[^.]+$/, ".xmp")}`
          : `${root}/${file}`,
      message,
      detail,
    });
  }
  return result.sort(
    (a, b) => severities.indexOf(a.severity) - severities.indexOf(b.severity) || a.path.localeCompare(b.path),
  );
}
export function runIntegrityCheck(state, type, now) {
  if (!state.checks[type]) fail("Unknown integrity check.");
  if (state.checks[type].status === "running") return state;
  if (state.restore?.status === "running")
    fail("Wait for the restore to finish before running checks.");
  return {
    ...state,
    checks: {
      ...state.checks,
      [type]: { ...state.checks[type], status: "running", progress: 0, startedAt: isoDate(now) },
    },
  };
}
export function runAllIntegrityChecks(state, now) {
  return integrityCheckTypes.reduce(
    (next, type) => runIntegrityCheck(next, type.id, now),
    state,
  );
}
export function advanceIntegrityCheck(state, type, increment, now) {
  const check = state.checks[type];
  if (!check || check.status !== "running") return state;
  const progress = Math.min(100, check.progress + Math.max(1, increment));
  if (progress < 100)
    return { ...state, checks: { ...state.checks, [type]: { ...check, progress } } };
  const at = isoDate(now) || new Date().toISOString();
  const findings = generateFindings(type, at);
  const report = {
    id: id("report"),
    type,
    createdAt: at,
    scanned: 1200 + (hash(at) % 900),
    durationMs: 4_000 + (hash(`${at}:${type}`) % 26_000),
    findings,
    summary: summarize(findings),
  };
  return {
    ...state,
    reports: [report, ...state.reports].slice(0, MAINTENANCE_LIMITS.reports),
    checks: {
      ...state.checks,
      [type]: {
        status: findings.some((item) => item.severity !== "info") ? "issues" : "passed",
        progress: 100,
        lastRun: at,
        reportId: report.id,
      },
    },
  };
}
export function deleteReport(state, reportId) {
  if (!state.reports.some((report) => report.id === reportId))
    fail("This report no longer exists.");
  return {
    ...state,
    reports: state.reports.filter((report) => report.id !== reportId),
    checks: Object.fromEntries(
      Object.entries(state.checks).map(([type, check]) => [
        type,
        check.reportId === reportId ? { ...check, reportId: null } : check,
      ]),
    ),
  };
}
export const checkStatusLabel = (check) =>
  ({
    idle: "Not run yet",
    running: `Running · ${check?.progress ?? 0}%`,
    passed: "No issues",
    issues: "Issues found",
    failed: "Could not complete",
  })[check?.status] || "Not run yet";

export function filterFindings(findings, options = {}) {
  const severity = severities.includes(options.severity) ? options.severity : "";
  const query = string(options.query, 200).trim().toLowerCase();
  return (Array.isArray(findings) ? findings : []).filter(
    (finding) =>
      (!severity || finding.severity === severity) &&
      (!query ||
        `${finding.path} ${finding.message} ${finding.detail}`
          .toLowerCase()
          .includes(query)),
  );
}
const csvCell = (value) => {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
export function reportToCsv(report) {
  const rows = [["severity", "path", "message", "detail"]];
  for (const finding of report.findings)
    rows.push([finding.severity, finding.path, finding.message, finding.detail]);
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
export function reportToText(report) {
  const type = integrityCheckTypes.find((item) => item.id === report.type);
  const lines = [
    `Frameleaf integrity report · ${type?.title || report.type}`,
    `Created: ${report.createdAt}`,
    `Scanned: ${report.scanned} items in ${(report.durationMs / 1000).toFixed(1)} s`,
    `Findings: ${report.summary.total} (${report.summary.error} errors, ${report.summary.warning} warnings, ${report.summary.info} info)`,
    "",
  ];
  for (const finding of report.findings)
    lines.push(
      `[${finding.severity.toUpperCase()}] ${finding.path}`,
      `  ${finding.message}${finding.detail ? ` — ${finding.detail}` : ""}`,
    );
  return lines.join("\n") + "\n";
}
export const reportFileName = (report, extension) =>
  `frameleaf-integrity-${report.type}-${report.createdAt.slice(0, 19).replace(/[:T]/g, "-")}.${extension}`;
