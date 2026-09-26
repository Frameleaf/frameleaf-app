#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { format, resolveConfig } from "prettier";

const root = resolve(import.meta.dirname, "..");
const evidencePath = resolve(
  root,
  "docs/docs/developer/frameleaf-plan/preservation-source-evidence.json",
);
const ledgerPath = resolve(
  root,
  "docs/docs/developer/frameleaf-plan/action-preservation-ledger.json",
);
const actionRegistryPath = resolve(
  root,
  "docs/docs/developer/frameleaf-plan/action-id-registry.json",
);
const highRiskDesignEvidencePath = resolve(
  root,
  "docs/docs/developer/frameleaf-plan/high-risk-workflow-design-evidence.json",
);

async function formatJson(value, path) {
  const config = (await resolveConfig(path)) ?? {};
  return format(JSON.stringify(value), { ...config, filepath: path });
}

function assertNoDuplicateJsonKeys(text, path) {
  let index = 0;
  const whitespace = () => {
    while (/\s/.test(text[index] ?? "")) index++;
  };
  const stringToken = () => {
    const start = index++;
    while (index < text.length) {
      if (text[index] === "\\") index += 2;
      else if (text[index++] === '"')
        return JSON.parse(text.slice(start, index));
    }
    throw new Error(`${path}: unterminated JSON string`);
  };
  const value = () => {
    whitespace();
    if (text[index] === "{") {
      index++;
      const keys = new Set();
      whitespace();
      while (text[index] !== "}") {
        if (text[index] !== '"')
          throw new Error(`${path}: expected object key at ${index}`);
        const key = stringToken();
        if (keys.has(key))
          throw new Error(`${path}: duplicate JSON key ${key}`);
        keys.add(key);
        whitespace();
        if (text[index++] !== ":")
          throw new Error(`${path}: expected colon at ${index - 1}`);
        value();
        whitespace();
        if (text[index] === ",") {
          index++;
          whitespace();
        } else break;
      }
      if (text[index++] !== "}")
        throw new Error(`${path}: expected object close at ${index - 1}`);
    } else if (text[index] === "[") {
      index++;
      whitespace();
      while (text[index] !== "]") {
        value();
        whitespace();
        if (text[index] === ",") {
          index++;
          whitespace();
        } else break;
      }
      if (text[index++] !== "]")
        throw new Error(`${path}: expected array close at ${index - 1}`);
    } else if (text[index] === '"') stringToken();
    else {
      const match = text
        .slice(index)
        .match(
          /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/,
        );
      if (!match) throw new Error(`${path}: invalid JSON token at ${index}`);
      index += match[0].length;
    }
  };
  value();
  whitespace();
  if (index !== text.length)
    throw new Error(`${path}: trailing JSON content at ${index}`);
}

const readJson = async (path) => {
  const text = await readFile(path, "utf8");
  assertNoDuplicateJsonKeys(text, path);
  return JSON.parse(text);
};
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const stableSlug = (value) =>
  value
    .toLowerCase()
    .replace(/[`*_“”'’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

const sectionPolicies = {
  1: {
    id: "viewer",
    primaryIssueId: "LIB-003",
    secondaryIssueIds: ["LIB-004", "LIB-005", "LIB-205", "QA-101"],
    entrypoints: [
      "route:/photos/[[assetId=id]]",
      "route:/albums/[albumId=id]/[[photos=photos]]/[[assetId=id]]",
      "route:/share/[key]/[[photos=photos]]/[[assetId=id]]",
    ],
  },
  2: {
    id: "info-people",
    primaryIssueId: "LIB-004",
    secondaryIssueIds: ["REC-002", "REC-003", "QA-101"],
    entrypoints: [
      "route:/photos/[[assetId=id]]",
      "route:/people/[personId]/[[photos=photos]]/[[assetId=id]]",
    ],
  },
  3: {
    id: "quick-edit",
    primaryIssueId: "VID-105",
    secondaryIssueIds: ["MOB-102", "STU-201", "QA-102"],
    entrypoints: ["route:/photos/[[assetId=id]]", "route:/studio"],
  },
  4: {
    id: "albums-organization",
    primaryIssueId: "LIB-202",
    secondaryIssueIds: ["LIB-201", "LIB-203", "LIB-204", "QA-101"],
    entrypoints: [
      "route:/albums",
      "route:/albums/[albumId=id]/[[photos=photos]]/[[assetId=id]]",
      "route:/folders/[[photos=photos]]/[[assetId=id]]",
    ],
  },
  5: {
    id: "timeline-bulk",
    primaryIssueId: "LIB-001",
    secondaryIssueIds: ["LIB-004", "FN-204", "LIB-005", "QA-101"],
    entrypoints: ["route:/photos/[[assetId=id]]"],
  },
  6: {
    id: "search-discovery",
    primaryIssueId: "LIB-102",
    secondaryIssueIds: ["LIB-101", "LIB-103", "LIB-104", "QA-101"],
    entrypoints: [
      "route:/search/[[photos=photos]]/[[assetId=id]]",
      "route:/discover",
      "route:/explore",
    ],
  },
};

const settingsOwners = {
  analytics: ["ADM-102", ["MOB-107", "QA-101"]],
  backup: ["MOB-302", ["ADM-002", "QA-104"]],
  care: ["ADM-104", ["MOB-106", "QA-101"]],
  editing: ["ADM-002", ["VID-105", "MOB-107"]],
  intelligence: ["ADM-002", ["AI-104", "MOB-107"]],
  libraries: ["ADM-006", ["MOB-107", "QA-101"]],
  notifications: ["ADM-004", ["MOB-303", "QA-103"]],
  preferences: ["ADM-004", ["MOB-107", "QA-103"]],
  processing: ["ADM-101", ["MOB-107", "QA-102"]],
  security: ["ADM-005", ["MOB-107", "QA-101"]],
  server: ["ADM-002", ["MOB-107", "QA-104"]],
  sharing: ["ADM-005", ["LIB-203", "MOB-107", "QA-101"]],
  storage: ["ADM-006", ["MOB-107", "QA-104"]],
  trash: ["LIB-007", ["MOB-107", "QA-101"]],
  users: ["ADM-003", ["ADM-004", "MOB-107", "QA-101"]],
  utilities: ["ADM-105", ["MOB-106", "MOB-107", "QA-104"]],
};

const settingIdOverrides = {
  "admin-account:0": "admin-account:list-filter-sort",
  "admin-account:1": "admin-account:create",
  "admin-account:2": "admin-account:edit-profile-role-quota",
  "admin-account:3": "admin-account:require-password-change",
  "admin-account:4": "admin-account:review-libraries-storage",
  "admin-account:5": "admin-account:inspect-revoke-sessions",
  "admin-account:6": "admin-account:reset-password",
  "admin-account:7": "admin-account:reset-pin",
  "admin-account:8": "admin-account:soft-delete",
  "admin-account:9": "admin-account:restore",
  "admin-library:0": "admin-library:list-filter-sort",
  "admin-library:1": "admin-library:create-fixed-owner",
  "admin-library:2": "admin-library:rename",
  "admin-library:3": "admin-library:manage-import-paths",
  "admin-library:4": "admin-library:manage-exclusion-patterns",
  "admin-library:5": "admin-library:validate-path-syntax",
  "admin-library:6": "admin-library:queue-review-cancel-scan",
  "admin-library:7": "admin-library:confirm-removal",
  "utility:icloud:gap:0": "utility-gap:icloud-live-auth-inventory",
  "utility:missing-media:gap:0": "utility-gap:missing-media-recovery",
  "utility:workflows:gap:0": "utility-gap:workflow-plugin-discovery",
  "utility:downloads:gap:0": "utility-gap:signed-application-release",
  "utility:obtainium:gap:0": "utility-gap:obtainium-signed-release",
};

const candidateOnlySettings = new Set([
  "system:oauth.frameleafMobileRedirectUri",
  "roadmap:takeout",
  "roadmap:preservation",
  "roadmap:enrichment",
  "roadmap:care",
]);
// Settings rows connected to production workflows.
// The row stays unqualified until acceptance; it no longer claims "not yet built".
const shippedSettingHomes = {
  // FL-75: the prototype's Storage & originals migration checklist opens the CLI audit report.
  "roadmap:migration": {
    target: {
      module:
        "web/src/lib/components/frameleaf/settings/MigrationSettingsSection.svelte",
      area: "storage",
      section: "migration",
    },
    evidence: [
      "web/src/lib/components/frameleaf/settings/MigrationSettingsSection.spec.ts",
      "web/src/lib/frameleaf/migration-report.spec.ts",
      "packages/cli/src/commands/migrate/migrate-fixtures.spec.ts",
      "docs/docs/administration/server-migration.md",
    ],
    notes:
      "Server migration is the resumable command-line tool; the web home shows its exact commands and opens its audit report read-only. It never runs a migration or holds API keys.",
  },
  // FL-71: the separate job settings form is gone. Queue concurrency is edited in the Job manager's
  // Concurrency dialog (template `ConcurrencyDialog` in `JobsManager.jsx`) and saved or discarded
  // through the one settings draft's save bar and review.
  "action:system/job/reset-saved": {
    target: {
      module:
        "web/src/lib/components/frameleaf/settings/SettingsSaveBar.svelte",
      area: "processing",
      section: "queues",
    },
    evidence: ["web/src/lib/frameleaf/system-config-draft.svelte.spec.ts"],
    notes:
      "Discard in the settings save bar returns pending concurrency values to the saved settings.",
  },
  "action:system/job/save": {
    target: {
      module:
        "web/src/lib/components/frameleaf/jobs/JobsConcurrencyDialog.svelte",
      area: "processing",
      section: "queues",
    },
    evidence: [
      "web/src/lib/components/frameleaf/jobs/JobsConcurrencyDialog.spec.ts",
    ],
    notes:
      "The Concurrency dialog's Review opens the settings review; saving there writes job.<queue>.concurrency with every other pending setting.",
  },
  "action:system/job/reset-defaults": {
    removed: true,
    target: {
      module:
        "web/src/lib/components/frameleaf/jobs/JobsConcurrencyDialog.svelte",
      area: "processing",
      section: "queues",
    },
    evidence: [],
    notes:
      "Removed per the prototype: the template's Concurrency dialog offers Done and Review only, with no reset to defaults.",
  },
};
// FL-71: routes whose screens moved into the Command Center (`/user-settings?area=&section=`).
// Their old addresses only redirect there; the row stays unqualified until acceptance and names the
// Command Center home (area, section, production module) instead of the retired page.
const commandCenterRouteHomes = {
  "/admin": {
    area: "overview",
    module:
      "web/src/lib/components/frameleaf/settings/CommandCenterOverview.svelte",
  },
  "/admin/system-settings": {
    area: "overview",
    module: "web/src/routes/(user)/user-settings/SystemSettings.svelte",
  },
  "/admin/server-status": {
    area: "analytics",
    module: "web/src/lib/components/frameleaf/analytics/AnalyticsArea.svelte",
  },
  "/admin/jobs-status": {
    area: "processing",
    section: "queues",
    module: "web/src/lib/components/frameleaf/JobsManager.svelte",
  },
  "/admin/queues": {
    area: "processing",
    section: "queues",
    module: "web/src/lib/components/frameleaf/JobsManager.svelte",
  },
  "/admin/queues/[name]": {
    area: "processing",
    section: "queues",
    module: "web/src/lib/components/frameleaf/JobsManager.svelte",
  },
  "/admin/render-workers": {
    area: "processing",
    section: "render-workers",
    module:
      "web/src/routes/(user)/user-settings/sections/RenderWorkersSection.svelte",
  },
  // The old page held the worker inventory (`#workers`) above the workload destinations.
  "/admin/processing-destinations": {
    area: "processing",
    sections: ["routing", "workers"],
    module:
      "web/src/routes/(user)/user-settings/sections/ProcessingSection.svelte",
  },
  "/admin/physical-deduplication": {
    area: "storage",
    section: "deduplication",
    module:
      "web/src/routes/(user)/user-settings/sections/DeduplicationSection.svelte",
  },
  "/admin/maintenance": {
    area: "maintenance",
    module:
      "web/src/routes/(user)/user-settings/sections/MaintenanceSection.svelte",
  },
  "/admin/maintenance/integrity-report/[type]": {
    area: "maintenance",
    section: "integrity",
    module:
      "web/src/routes/(user)/user-settings/sections/IntegrityReportSection.svelte",
  },
  "/admin/user-management": {
    area: "users",
    section: "accounts",
    module: "web/src/routes/(user)/user-settings/sections/UsersSection.svelte",
  },
  "/admin/users": {
    area: "users",
    section: "accounts",
    module: "web/src/routes/(user)/user-settings/sections/UsersSection.svelte",
  },
  "/admin/users/new": {
    area: "users",
    section: "accounts",
    module: "web/src/lib/components/frameleaf/AccountFormDialog.svelte",
  },
  "/admin/users/[id]": {
    area: "users",
    section: "accounts",
    module: "web/src/routes/(user)/user-settings/sections/UserDetail.svelte",
  },
  "/admin/users/[id]/edit": {
    area: "users",
    section: "accounts",
    module: "web/src/lib/components/frameleaf/AccountFormDialog.svelte",
  },
  "/admin/library-management": {
    area: "libraries",
    module: "web/src/lib/components/frameleaf/LibrariesManager.svelte",
  },
  "/admin/library-management/new": {
    area: "libraries",
    module: "web/src/lib/components/frameleaf/LibraryFormDialog.svelte",
  },
  "/admin/library-management/[id]": {
    area: "libraries",
    module: "web/src/lib/components/frameleaf/LibraryDetail.svelte",
  },
  "/admin/library-management/[id]/edit": {
    area: "libraries",
    module: "web/src/lib/components/frameleaf/LibraryFormDialog.svelte",
  },
  "/trash/[[photos=photos]]/[[assetId=id]]": {
    area: "trash",
    section: "contents",
    module: "web/src/routes/(user)/user-settings/sections/TrashSection.svelte",
  },
};
const sharedQueueConcurrency = new Set([
  "backgroundTask",
  "editor",
  "faceDetection",
  "imageDescription",
  "imageEnrichment",
  "integrityCheck",
  "library",
  "mediaHealth",
  "metadataExtraction",
  "migration",
  "notifications",
  "nsfwDetection",
  "ocr",
  "search",
  "sidecar",
  "smartSearch",
  "thumbnailGeneration",
  "videoConversion",
  "videoDuplicateDetection",
  "workflow",
]);

function normalizeSetting(row) {
  const id = settingIdOverrides[row.id] ?? row.id;
  const aliases = id === row.id ? [] : [row.id];
  const target = { ...row.target };
  if (target.area === "analytics" && target.section == null)
    target.section = "usage-overview";
  const queueMatch = id.match(/^queue:([^:]+):concurrency$/);
  const schemaMatch = id.match(/^system:job\.([^.]+)\.concurrency$/);
  const queueName = queueMatch?.[1] ?? schemaMatch?.[1];
  const sharedRequirementId =
    queueName && sharedQueueConcurrency.has(queueName)
      ? `setting:system:job.${queueName}.concurrency`
      : null;
  return {
    id,
    aliases,
    sharedRequirementId,
    label: row.label ?? row.path ?? id,
    source: row.source,
    auditStatus: row.status,
    target,
    productionConnected: row.productionConnected ?? false,
    sourceAvailability: candidateOnlySettings.has(row.id)
      ? "candidate-unaccepted"
      : "accepted-main",
    notes: row.notes ?? "",
  };
}

function settingOwnership(row) {
  if (
    row.id.startsWith("queue:") ||
    row.id.startsWith("manual-job:") ||
    row.id.startsWith("action:runpod-")
  )
    return ["ADM-101", ["MOB-107", "QA-102"]];
  if (row.id.startsWith("admin-account:"))
    return ["ADM-003", ["ADM-004", "MOB-107", "QA-101"]];
  if (row.id.startsWith("admin-library:"))
    return ["ADM-006", ["MOB-107", "QA-101"]];
  if (row.id.startsWith("roadmap:")) {
    const plan = {
      takeout: "IMP-001",
      migration: "IMP-007",
      preservation: "IMP-006",
      enrichment: "REC-101",
      care: "IMP-003",
    }[row.id.split(":")[1]];
    return [plan, ["MOB-106", "QA-104"]];
  }
  const utility = {
    "utility-gap:icloud-live-auth-inventory": "IMP-002",
    "utility-gap:missing-media-recovery": "IMP-003",
    "utility-gap:workflow-plugin-discovery": "ADM-105",
    "utility-gap:signed-application-release": "ADM-105",
    "utility-gap:obtainium-signed-release": "ADM-105",
    "action:physical-dedup-apply": "REC-103",
    "manual-job:physical-deduplication-apply": "REC-103",
  }[row.id];
  if (utility) return [utility, ["MOB-106", "QA-104"]];
  if (/oauth|callback/.test(row.id))
    return ["ADM-103", ["ADM-005", "REL-102", "MOB-107"]];
  if (
    /save|reset|discard|export|import/.test(row.id) &&
    row.id.startsWith("action:")
  )
    return ["ADM-001", ["ADM-002", "MOB-107"]];
  return settingsOwners[row.target?.area] ?? ["ADM-001", ["MOB-107", "QA-101"]];
}

function markdownLinks(line) {
  const links = [];
  let cursor = 0;
  while ((cursor = line.indexOf("](", cursor)) >= 0) {
    cursor += 2;
    if (line[cursor] === "<") {
      const end = line.indexOf(">)", cursor);
      if (end < 0)
        throw new Error(`Unclosed angle-bracket Markdown link: ${line}`);
      links.push(line.slice(cursor + 1, end));
      cursor = end + 2;
      continue;
    }
    const start = cursor;
    let depth = 1;
    while (cursor < line.length && depth > 0) {
      if (line[cursor] === "(") depth++;
      else if (line[cursor] === ")") depth--;
      cursor++;
    }
    if (depth !== 0) throw new Error(`Unclosed Markdown link: ${line}`);
    links.push(line.slice(start, cursor - 1));
  }
  return links;
}

function parseActionAudit(markdown, registry) {
  const rows = [];
  let section;
  const seen = new Map();
  for (const line of markdown.split(/\r?\n/)) {
    const heading = line.match(/^# (\d+)\. (.+)$/);
    if (heading)
      section = {
        number: heading[1],
        title: heading[2],
        sourcePaths: [],
        ...sectionPolicies[heading[1]],
      };
    if (section && line.startsWith("Source:")) {
      for (const link of markdownLinks(line)) {
        const path = link.replace(/^\.\.\/\.\.\/\.\.\//, "");
        if (!section.sourcePaths.includes(path)) section.sourcePaths.push(path);
      }
    }
    if (
      !section ||
      !line.startsWith("| ") ||
      line.startsWith("| ---") ||
      line.includes("Source-visible action/behavior")
    )
      continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length !== 3) continue;
    const [behavior, auditStatus, boundary] = cells;
    const sourceKey = `${section.id}:${behavior}`;
    const registered = registry?.get(sourceKey);
    const baseId =
      registered?.requirementId ??
      `action:${section.id}:${stableSlug(behavior.replace(/<[^>]+>/g, ""))}`;
    const occurrence = (seen.get(baseId) ?? 0) + 1;
    seen.set(baseId, occurrence);
    if (registry && !registered)
      throw new Error(
        `Action is missing from immutable ID registry: ${sourceKey}`,
      );
    rows.push({
      id: occurrence === 1 ? baseId : `${baseId}-${occurrence}`,
      aliases: registered?.aliases ?? [],
      sourceKey,
      behavior,
      auditStatus,
      boundary,
      section: section.title,
      primaryIssueId: section.primaryIssueId,
      secondaryIssueIds: section.secondaryIssueIds,
      entrypoints: section.entrypoints,
      source: section.sourcePaths,
    });
  }
  return rows;
}

async function importEvidence(sourceRoot) {
  const routeMapPath = resolve(
    sourceRoot,
    "docs/docs/developer/frameleaf-plan/route-issue-map.json",
  );
  const actionAuditPath = resolve(
    sourceRoot,
    "docs/docs/developer/frameleaf-library-action-parity.md",
  );
  const settingsPath = resolve(
    root,
    "design/frameleaf/template/src/settings-coverage.mjs",
  );
  const freecutPath = resolve(root, "studio/freecut-feature-manifest.json");
  const acceptedRoutePath = resolve(
    root,
    "docs/docs/developer/frameleaf-route-inventory.json",
  );
  const acceptedActionPath = resolve(
    root,
    "docs/docs/developer/frameleaf-library-action-parity.md",
  );
  const nativePath = resolve(root, "mobile/frameleaf-parity.json");
  const actionRegistryRaw = await readFile(actionRegistryPath, "utf8");
  const actionRegistry = await readJson(actionRegistryPath);
  const actionRegistryByKey = new Map(
    actionRegistry.rows.map((row) => [row.sourceKey, row]),
  );
  const [
    routeRaw,
    actionRaw,
    settingsRaw,
    freecutRaw,
    acceptedRouteRaw,
    acceptedActionRaw,
    nativeRaw,
  ] = await Promise.all([
    readFile(routeMapPath, "utf8"),
    readFile(actionAuditPath, "utf8"),
    readFile(settingsPath, "utf8"),
    readFile(freecutPath, "utf8"),
    readFile(acceptedRoutePath, "utf8"),
    readFile(acceptedActionPath, "utf8"),
    readFile(nativePath, "utf8"),
  ]);
  const routeMap = JSON.parse(routeRaw);
  const settingsModule = await import(
    `${pathToFileURL(settingsPath).href}?sha=${sha256(settingsRaw)}`
  );
  const freecut = JSON.parse(freecutRaw);
  const actions = parseActionAudit(actionRaw, actionRegistryByKey);
  for (const row of actions) {
    row.source = await Promise.all(
      row.source.map(async (path) => {
        try {
          const info = await stat(resolve(root, path));
          return {
            path,
            availability: info.isDirectory()
              ? "accepted-main-directory"
              : "accepted-main",
            sha256: info.isFile()
              ? sha256(await readFile(resolve(root, path)))
              : null,
          };
        } catch {
          const preservedPath = resolve(sourceRoot, path);
          const info = await stat(preservedPath);
          return {
            path,
            availability: info.isDirectory()
              ? "preserved-dirty-directory"
              : "preserved-dirty-only",
            sha256: info.isFile()
              ? sha256(await readFile(preservedPath))
              : null,
          };
        }
      }),
    );
  }
  const evidence = {
    schemaVersion: 1,
    status: "preservation-input-not-runtime-qualification",
    sourceSnapshots: {
      acceptedRoutes: {
        path: "docs/docs/developer/frameleaf-route-inventory.json",
        sha256: sha256(acceptedRouteRaw),
      },
      acceptedActionFamilies: {
        path: "docs/docs/developer/frameleaf-library-action-parity.md",
        sha256: sha256(acceptedActionRaw),
      },
      acceptedNative: {
        path: "mobile/frameleaf-parity.json",
        sha256: sha256(nativeRaw),
      },
      acceptedFreecut: {
        path: "studio/freecut-feature-manifest.json",
        sha256: sha256(freecutRaw),
      },
      routeOwnershipEvidence: {
        path: "preserved-dirty:docs/docs/developer/frameleaf-plan/route-issue-map.json",
        sha256: sha256(routeRaw),
        qualification: "normalization-input-only",
      },
      actionAuditEvidence: {
        path: "preserved-dirty:docs/docs/developer/frameleaf-library-action-parity.md",
        sha256: sha256(actionRaw),
        qualification: "normalization-input-only",
      },
      settings: {
        path: "design/frameleaf/template/src/settings-coverage.mjs",
        sha256: sha256(settingsRaw),
      },
      freecut: {
        path: "studio/freecut-feature-manifest.json",
        sha256: sha256(freecutRaw),
      },
      actionRegistry: {
        path: "docs/docs/developer/frameleaf-plan/action-id-registry.json",
        sha256: sha256(actionRegistryRaw),
      },
    },
    routes: routeMap.entries.map((row) => ({
      id: row.route,
      family: row.family,
      access: row.requires,
      source: row.pageFiles,
      loaders: row.loaderFiles,
      primaryIssueId: row.primaryIssueId,
      secondaryIssueIds: row.secondaryIssueIds,
      rationale: row.rationale,
      loaderRationale: row.loaderRationale,
      status: row.status,
    })),
    actions,
    settings: settingsModule.fullSettingsCoverage.map(normalizeSetting),
    freecut: freecut.features.map((row) => ({
      id: row.id,
      title: row.title,
      category: row.category,
      basis: row.basis,
      source: row.source.map(({ path, line, sha256: sourceSha256 }) => ({
        path: `studio/${path}`,
        line,
        sha256: sourceSha256,
      })),
      status: {
        native: row.status.native,
        command: row.status.command,
        render: row.status.render,
        upstreamTestCount: row.status.test?.upstreamTestFiles?.length ?? 0,
      },
    })),
  };
  await writeFile(evidencePath, await formatJson(evidence, evidencePath));
}

const issueOwner = (planId, jiraMap) => {
  const issue = jiraMap.issues[planId];
  if (!issue) throw new Error(`Unknown Jira owner ${planId}`);
  return { planId, jiraKey: issue.key, url: issue.url };
};

function mapping(source, newUi, api, native, tests) {
  return Object.fromEntries(
    Object.entries({ source, newUi, api, native, tests }).map(
      ([axis, value]) => [
        axis,
        {
          ...value,
          evidence: value.evidence?.length
            ? value.evidence
            : value.paths?.length
              ? value.paths
              : ["none-qualified"],
        },
      ],
    ),
  );
}

function canonicalize(rawRequirements) {
  const parent = rawRequirements.map((_, index) => index);
  const find = (index) =>
    parent[index] === index ? index : (parent[index] = find(parent[index]));
  const union = (left, right) => {
    const a = find(left);
    const b = find(right);
    if (a !== b) parent[b] = a;
  };
  const bySharedRequirement = new Map();
  for (const [index, row] of rawRequirements.entries()) {
    if (!row.sharedRequirementId) continue;
    const prior = bySharedRequirement.get(row.sharedRequirementId);
    if (prior != null) union(index, prior);
    else bySharedRequirement.set(row.sharedRequirementId, index);
  }
  const groups = new Map();
  for (let index = 0; index < rawRequirements.length; index++) {
    const key = find(index);
    const rows = groups.get(key) ?? [];
    rows.push(rawRequirements[index]);
    groups.set(key, rows);
  }
  const sourceRows = [];
  const requirements = [];
  const reverseIndex = {};
  const entrypointIndex = {};
  const priority = {
    "web-route": 0,
    setting: 1,
    "web-action": 2,
    "native-entry": 3,
    "freecut-feature": 4,
  };
  for (const rows of groups.values()) {
    rows.sort(
      (a, b) =>
        priority[a.kind] - priority[b.kind] ||
        a.requirementId.localeCompare(b.requirementId),
    );
    const aliases = [
      ...new Set(
        rows.flatMap((row) => [row.requirementId, ...(row.aliases ?? [])]),
      ),
    ].sort();
    const declaredSharedIds = [
      ...new Set(rows.map((row) => row.sharedRequirementId).filter(Boolean)),
    ];
    const canonicalId =
      declaredSharedIds.length === 1
        ? declaredSharedIds[0]
        : rows[0].requirementId;
    const owners = rows.flatMap((row) => [
      row.owners.primary,
      ...row.owners.secondary,
    ]);
    const ownerByPlan = new Map(owners.map((owner) => [owner.planId, owner]));
    const entrypoints = [
      ...new Set(rows.flatMap((row) => row.entrypoints)),
    ].sort();
    const sourceRowIds = [];
    for (const row of rows) {
      const ref = row.inventoryRefs[0];
      const sourceRowId = `${ref.inventory}:${ref.id}`;
      sourceRowIds.push(sourceRowId);
      reverseIndex[sourceRowId] = canonicalId;
      sourceRows.push({
        sourceRowId,
        canonicalRequirementId: canonicalId,
        rawRequirementId: row.requirementId,
        aliases: row.aliases ?? [],
        inventory: ref.inventory,
        inventoryId: ref.id,
        kind: row.kind,
        title: row.title,
        entrypoints: row.entrypoints,
        qualification: row.qualification,
        mappings: row.mappings,
        auditGap: row.auditGap ?? null,
      });
    }
    for (const entrypoint of entrypoints) {
      const ids = entrypointIndex[entrypoint] ?? [];
      if (!ids.includes(canonicalId)) ids.push(canonicalId);
      entrypointIndex[entrypoint] = ids.sort();
    }
    const kinds = [...new Set(rows.map(({ kind }) => kind))].sort();
    const dispositions = rows.map((row) => row.disposition.kind);
    const disposition = dispositions.includes("intentional-product-change")
      ? "intentional-product-change"
      : dispositions.includes("not-yet-designed")
        ? "not-yet-designed"
        : dispositions.includes("retained-production-route")
          ? "retained-production-route"
          : "legacy-fallback-until-qualified";
    requirements.push({
      requirementId: canonicalId,
      aliases,
      kinds,
      title:
        rows.length === 1
          ? rows[0].title
          : `Shared preservation contract for ${rows.length} source rows`,
      sourceRowIds: sourceRowIds.sort(),
      entrypoints,
      owners: {
        primary: rows[0].owners.primary,
        secondary: [...ownerByPlan.values()]
          .filter(({ planId }) => planId !== rows[0].owners.primary.planId)
          .sort((a, b) => a.planId.localeCompare(b.planId)),
      },
      disposition: {
        kind: disposition,
        legacyFallback: rows.some((row) => row.disposition.legacyFallback),
      },
      qualification: "planned-not-qualified",
      mappings: Object.fromEntries(
        ["source", "newUi", "api", "native", "tests"].map((axis) => [
          axis,
          {
            status: "explicit-per-source-row",
            evidence: ["source-row-mappings"],
          },
        ]),
      ),
    });
  }
  return {
    requirements: requirements.sort((a, b) =>
      a.requirementId.localeCompare(b.requirementId),
    ),
    sourceRows: sourceRows.sort((a, b) =>
      a.sourceRowId.localeCompare(b.sourceRowId),
    ),
    reverseIndex,
    entrypointIndex,
  };
}

function actionDisposition(row) {
  if (/intentional change/i.test(row.auditStatus))
    return { kind: "intentional-product-change", legacyFallback: true };
  if (/missing/i.test(row.auditStatus))
    return { kind: "not-yet-designed", legacyFallback: true };
  return { kind: "legacy-fallback-until-qualified", legacyFallback: true };
}

async function buildLedger() {
  const [
    evidence,
    routeInventory,
    freecutOwners,
    nativeOwners,
    backlog,
    jiraMap,
    highRiskDesignEvidence,
  ] = await Promise.all([
    readJson(evidencePath),
    readJson(
      resolve(root, "docs/docs/developer/frameleaf-route-inventory.json"),
    ),
    readJson(
      resolve(
        root,
        "docs/docs/developer/frameleaf-plan/freecut-issue-map.json",
      ),
    ),
    readJson(
      resolve(root, "docs/docs/developer/frameleaf-plan/native-issue-map.json"),
    ),
    readJson(resolve(root, "docs/docs/developer/frameleaf-plan/backlog.json")),
    readJson(resolve(root, "docs/docs/developer/frameleaf-plan/jira-map.json")),
    readJson(highRiskDesignEvidencePath),
  ]);
  const backlogIds = new Set(backlog.items.map(({ id }) => id));
  const ownerSet = (primary, secondary = []) => ({
    primary: issueOwner(primary, jiraMap),
    secondary: secondary.map((id) => issueOwner(id, jiraMap)),
  });
  const requirements = [];
  const committedRoutes = new Set(routeInventory.productionRoutes);

  for (const row of evidence.routes) {
    requirements.push({
      requirementId: `route:${row.id}`,
      kind: "web-route",
      title: `${row.family} route ${row.id}`,
      inventoryRefs: [{ inventory: "web-routes", id: row.id }],
      entrypoints: [...row.source, ...row.loaders],
      owners: ownerSet(row.primaryIssueId, row.secondaryIssueIds),
      disposition: { kind: "retained-production-route", legacyFallback: true },
      qualification: "planned-not-qualified",
      mappings: mapping(
        {
          status: committedRoutes.has(row.id)
            ? "committed-source"
            : "preserved-dirty-only",
          paths: row.source,
          access: row.access,
        },
        {
          status: "not-qualified",
          target: commandCenterRouteHomes[row.id] ?? row.id,
        },
        { status: "preserve-existing-contracts", evidence: [] },
        { status: "not-qualified", evidence: [] },
        { status: "missing-route-action-qualification", evidence: [] },
      ),
      notes: [row.rationale, row.loaderRationale],
    });
  }

  for (const row of evidence.actions) {
    requirements.push({
      requirementId: row.id,
      aliases: row.aliases,
      kind: "web-action",
      title: row.behavior,
      inventoryRefs: [{ inventory: "web-action-audit", id: row.id }],
      entrypoints: row.entrypoints,
      owners: ownerSet(row.primaryIssueId, row.secondaryIssueIds),
      disposition: actionDisposition(row),
      qualification: "planned-not-qualified",
      mappings: mapping(
        {
          status: "audited-source-behavior",
          paths: row.source.map(({ path }) => path),
          evidence: row.source.map(
            ({ path, availability, sha256: sourceSha256 }) =>
              `${availability}:${path}:${sourceSha256 ?? "directory"}`,
          ),
        },
        { status: row.auditStatus, target: row.section },
        { status: "explicit-mapping-required", evidence: [] },
        { status: "explicit-mapping-required", evidence: [] },
        { status: "explicit-evidence-required", evidence: [] },
      ),
      auditGap: /missing|partial|presentation/i.test(row.auditStatus)
        ? {
            mapped: true,
            issue: issueOwner(row.primaryIssueId, jiraMap),
            boundary: row.boundary,
          }
        : null,
    });
  }

  for (const sourceRow of evidence.settings) {
    const shipped = shippedSettingHomes[sourceRow.id];
    const row = shipped
      ? {
          ...sourceRow,
          // A removed action keeps its target only as the place it was removed from.
          auditStatus: shipped.removed ? "Intentional change" : "mapped-unqualified",
          target: shipped.target,
          notes: shipped.notes,
        }
      : sourceRow;
    const area = row.target?.area;
    const [primary, secondary] = settingOwnership(row);
    requirements.push({
      requirementId: `setting:${row.id}`,
      aliases: row.aliases.map((id) => `setting:${id}`),
      sharedRequirementId: row.sharedRequirementId,
      kind: "setting",
      title: row.label,
      inventoryRefs: [{ inventory: "settings", id: row.id }],
      entrypoints: [
        row.source,
        `${row.target?.module ?? "unknown"}:${area ?? "unknown"}/${row.target?.section ?? "unknown"}`,
      ].filter(Boolean),
      owners: ownerSet(primary, secondary),
      disposition: shipped?.removed
        ? { kind: "intentional-product-change", legacyFallback: false }
        : shipped
          ? { kind: "legacy-fallback-until-qualified", legacyFallback: false }
          : row.auditStatus === "not-yet-built"
            ? { kind: "not-yet-designed", legacyFallback: true }
            : { kind: "legacy-fallback-until-qualified", legacyFallback: true },
      qualification: "planned-not-qualified",
      mappings: mapping(
        { status: row.sourceAvailability, paths: [row.source] },
        shipped
          ? {
              status: row.auditStatus,
              target: row.target,
              evidence: shipped.evidence,
            }
          : { status: row.auditStatus, target: row.target },
        {
          status: row.productionConnected
            ? "connected-unqualified"
            : "not-connected",
          evidence: [],
        },
        { status: "planned-not-qualified", evidence: ["MOB-107"] },
        { status: "explicit-evidence-required", evidence: [] },
      ),
      auditGap:
        row.auditStatus === "not-yet-built"
          ? {
              mapped: true,
              issue: issueOwner(primary, jiraMap),
              boundary: row.notes,
            }
          : null,
      notes: row.notes ? [row.notes] : [],
    });
  }

  const freecutOwnerById = new Map(
    freecutOwners.rows.map((row) => [row.id, row]),
  );
  for (const row of evidence.freecut) {
    const ownership = freecutOwnerById.get(row.id);
    if (!ownership) throw new Error(`Freecut row ${row.id} has no owner`);
    requirements.push({
      requirementId: `freecut:${row.id}`,
      kind: "freecut-feature",
      title: row.title,
      inventoryRefs: [{ inventory: "freecut", id: row.id }],
      entrypoints: row.source.map(({ path, line }) => `${path}:${line}`),
      owners: ownerSet(ownership.issueIds[0], ownership.issueIds.slice(1)),
      disposition: { kind: "not-yet-designed", legacyFallback: true },
      qualification: ownership.status,
      mappings: mapping(
        { status: row.basis, paths: row.source.map(({ path }) => path) },
        { status: "not-qualified", target: row.category },
        { status: row.status.command, evidence: [] },
        { status: row.status.native, evidence: [] },
        {
          status: "upstream-only-not-frameleaf-qualified",
          evidenceCount: row.status.upstreamTestCount,
        },
      ),
      render: { status: row.status.render },
    });
  }

  for (const row of nativeOwners.entries) {
    requirements.push({
      requirementId: `native:${row.id}`,
      kind: "native-entry",
      title: row.id,
      inventoryRefs: [{ inventory: "native", id: row.id }],
      entrypoints: [row.source],
      owners: ownerSet(row.primaryIssueId, row.secondaryIssueIds),
      disposition:
        row.sourceAvailability === "preserved-dirty-only"
          ? { kind: "not-yet-designed", legacyFallback: false }
          : { kind: "legacy-fallback-until-qualified", legacyFallback: true },
      qualification: row.qualification,
      mappings: mapping(
        { status: row.sourceAvailability, paths: [row.source] },
        { status: row.frameleafRedesign ?? "pending", target: row.kind },
        { status: "preserve-generated-api-contracts", evidence: [] },
        {
          status:
            row.runtimeQualification ??
            row.implementation ??
            "not-device-qualified",
          evidence: [],
        },
        { status: "device-and-offline-evidence-required", evidence: [] },
      ),
      notes: [row.rationale],
    });
  }

  const acceptedRoutes = [
    ...routeInventory.productionRoutes,
    ...routeInventory.dirtyOnlyEvidence,
  ];
  const rawCounts = {
    webRoutes: evidence.routes.length,
    webActions: evidence.actions.length,
    settings: evidence.settings.length,
    freecut: evidence.freecut.length,
    native: nativeOwners.entries.length,
  };
  const canonical = canonicalize(requirements);
  const highRiskRequirementIds = new Set(
    highRiskDesignEvidence.flows.flatMap(
      ({ requirementIds }) => requirementIds,
    ),
  );
  const highRiskReceipt =
    "docs/docs/developer/frameleaf-plan/high-risk-workflow-design-evidence.json";
  const highRiskTest = "scripts/frameleaf-high-risk-workflows.test.mjs";
  for (const requirement of canonical.requirements) {
    if (!highRiskRequirementIds.has(requirement.requirementId)) continue;
    requirement.mappings.newUi.evidence = [
      ...new Set([...requirement.mappings.newUi.evidence, highRiskReceipt]),
    ];
    requirement.mappings.tests.evidence = [
      ...new Set([...requirement.mappings.tests.evidence, highRiskTest]),
    ];
  }
  const counts = {
    ...rawCounts,
    sourceRows: canonical.sourceRows.length,
    canonicalRequirements: canonical.requirements.length,
  };
  const ledger = {
    schemaVersion: 1,
    status: "ownership-complete-implementation-not-qualified",
    scope:
      "Action-level preservation and ownership. Source or route presence never means implemented, authorized, tested, or release-qualified.",
    baseline: {
      commit: "84d32454ec558abf35f1cfe44694c1754b2cbbbf",
      defaultBranch: "fork/main",
    },
    sourceSnapshots: evidence.sourceSnapshots,
    sourceEvidenceSha256: sha256(JSON.stringify(evidence)),
    securityInvariants: [
      {
        id: "public-loader-is-not-resource-authorization",
        rule: "A public/root loader never grants asset, album, share, project, or administrator access; page and resource authorization remain authoritative.",
      },
      {
        id: "sensitive-classification-preserves-membership",
        rule: "Marking or unmarking Sensitive changes classification only and preserves album membership; legacy locked visibility remains readable fallback.",
      },
      {
        id: "duplicates-are-actor-only",
        rule: "Duplicate rows, counts, history, thumbnails, exports, and actions remain visible only to the signed-in asset owner.",
      },
    ],
    secretPolicies: [
      ["oauth-client-secret", "settings:system:oauth.clientSecret", "ADM-005"],
      [
        "smtp-password",
        "settings:system:notifications.smtp.transport.password",
        "ADM-002",
      ],
      [
        "runpod-api-key",
        "settings:system:machineLearning.runpod.apiKey",
        "ADM-101",
      ],
      [
        "huggingface-token",
        "settings:system:machineLearning.runpod.hfToken",
        "ADM-101",
      ],
      ["video-worker-token", null, "ADM-101"],
    ].map(([credentialId, sourceRowId, ownerPlanId]) => ({
      credentialId,
      sourceRowId,
      owner: issueOwner(ownerPlanId, jiraMap),
      status: sourceRowId ? "mapped-unqualified" : "not-yet-designed",
      policy: [
        "ephemeral-input",
        "write-only-secret",
        "configured-state-only",
        "excluded-from-history",
        "excluded-from-export",
        "excluded-from-telemetry",
      ],
    })),
    expectedInventory: {
      webRoutes: acceptedRoutes.length,
      settings: 535,
      freecut: 210,
      native: 227,
    },
    counts,
    dispositionVocabulary: [
      "retained-production-route",
      "legacy-fallback-until-qualified",
      "intentional-product-change",
      "not-yet-designed",
    ],
    mappingAxes: ["source", "newUi", "api", "native", "tests"],
    requirements: canonical.requirements,
    sourceRows: canonical.sourceRows,
    reverseIndex: canonical.reverseIndex,
    entrypointIndex: canonical.entrypointIndex,
  };

  for (const requirement of canonical.requirements) {
    if (
      !requirement.owners.primary ||
      !backlogIds.has(requirement.owners.primary.planId)
    )
      throw new Error(`Unowned requirement ${requirement.requirementId}`);
  }
  return ledger;
}

async function validateLedger(ledger) {
  const errors = [];
  const allowedTop = new Set([
    "schemaVersion",
    "status",
    "scope",
    "baseline",
    "sourceSnapshots",
    "sourceEvidenceSha256",
    "securityInvariants",
    "secretPolicies",
    "expectedInventory",
    "counts",
    "dispositionVocabulary",
    "mappingAxes",
    "requirements",
    "sourceRows",
    "reverseIndex",
    "entrypointIndex",
  ]);
  const allowedRequirement = new Set([
    "requirementId",
    "aliases",
    "kinds",
    "title",
    "sourceRowIds",
    "entrypoints",
    "owners",
    "disposition",
    "qualification",
    "mappings",
  ]);
  const allowedSourceRow = new Set([
    "sourceRowId",
    "canonicalRequirementId",
    "rawRequirementId",
    "aliases",
    "inventory",
    "inventoryId",
    "kind",
    "title",
    "entrypoints",
    "qualification",
    "mappings",
    "auditGap",
  ]);
  const allowedMapping = new Set([
    "status",
    "evidence",
    "paths",
    "access",
    "target",
    "owner",
    "evidenceCount",
  ]);
  const allowedMappingStatuses = new Set([
    "explicit-per-source-row",
    "source-presence-only",
    "audited-source-behavior",
    "source-mapped",
    "committed-source",
    "preserved-dirty-only",
    "readme-claim-with-source-family-inventory",
    "source-inventory",
    "complete-module-file-inventory",
    "accepted-main",
    "candidate-unaccepted",
    "not-qualified",
    "ui-control",
    "resource-flow",
    "deployment-policy",
    "not-yet-built",
    "mapped-unqualified",
    "pending",
    "review-only-preview",
    "Local",
    "Local/partial",
    "Local/presentation",
    "Local; production partial",
    "Missing",
    "Missing/partial",
    "Partial",
    "Partial/missing",
    "Presentation",
    "Presentation/partial",
    "Intentional change",
    "preserve-existing-contracts",
    "explicit-mapping-required",
    "not-connected",
    "connected-unqualified",
    "not-exposed-as-dedicated-command",
    "upstream-addEffect-command-source-present",
    "upstream-addTransition-command-source-present",
    "upstream-command-schema-and-runner-present",
    "preserve-generated-api-contracts",
    "not-device-qualified",
    "not-implemented-in-frameleaf",
    "planned-not-qualified",
    "missing-route-action-qualification",
    "explicit-evidence-required",
    "upstream-only-not-frameleaf-qualified",
    "device-and-offline-evidence-required",
  ]);
  const allowedQualifications = new Set([
    "planned-not-qualified",
    "inventory-only-not-qualified",
    "not-committed-not-qualified",
  ]);
  for (const key of Object.keys(ledger))
    if (!allowedTop.has(key)) errors.push(`unknown ledger field: ${key}`);
  if (ledger.schemaVersion !== 1)
    errors.push(`unsupported schema version: ${ledger.schemaVersion}`);
  if (ledger.status !== "ownership-complete-implementation-not-qualified")
    errors.push(
      `qualification inflation or unknown ledger status: ${ledger.status}`,
    );
  if (
    Object.keys(ledger.baseline ?? {})
      .sort()
      .join(",") !== "commit,defaultBranch" ||
    ledger.baseline.commit !== "84d32454ec558abf35f1cfe44694c1754b2cbbbf" ||
    ledger.baseline.defaultBranch !== "fork/main"
  )
    errors.push("invalid or changed baseline contract");
  const expectedInventoryContract = {
    webRoutes: 94,
    settings: 535,
    freecut: 210,
    native: 227,
  };
  if (
    JSON.stringify(ledger.expectedInventory) !==
    JSON.stringify(expectedInventoryContract)
  )
    errors.push("invalid expected-inventory contract");
  const expectedSnapshotKeys = [
    "acceptedRoutes",
    "acceptedActionFamilies",
    "acceptedNative",
    "acceptedFreecut",
    "routeOwnershipEvidence",
    "actionAuditEvidence",
    "settings",
    "freecut",
    "actionRegistry",
  ].sort();
  if (
    Object.keys(ledger.sourceSnapshots ?? {})
      .sort()
      .join(",") !== expectedSnapshotKeys.join(",")
  )
    errors.push("invalid source-snapshot set");
  for (const [name, snapshot] of Object.entries(ledger.sourceSnapshots ?? {})) {
    const expectedFields = name.endsWith("Evidence")
      ? "path,qualification,sha256"
      : "path,sha256";
    if (Object.keys(snapshot).sort().join(",") !== expectedFields)
      errors.push(`unknown or missing source-snapshot fields: ${name}`);
    if (
      name.endsWith("Evidence") &&
      snapshot.qualification !== "normalization-input-only"
    )
      errors.push(`invalid normalization evidence status: ${name}`);
  }
  const expectedInvariants = new Map([
    [
      "public-loader-is-not-resource-authorization",
      "A public/root loader never grants asset, album, share, project, or administrator access; page and resource authorization remain authoritative.",
    ],
    [
      "sensitive-classification-preserves-membership",
      "Marking or unmarking Sensitive changes classification only and preserves album membership; legacy locked visibility remains readable fallback.",
    ],
    [
      "duplicates-are-actor-only",
      "Duplicate rows, counts, history, thumbnails, exports, and actions remain visible only to the signed-in asset owner.",
    ],
  ]);
  if (
    !Array.isArray(ledger.securityInvariants) ||
    ledger.securityInvariants.length !== 3 ||
    ledger.securityInvariants
      .map(({ id }) => id)
      .sort()
      .join(",") !== [...expectedInvariants.keys()].sort().join(",")
  )
    errors.push("invalid or missing security invariants");
  for (const invariant of ledger.securityInvariants ?? []) {
    if (
      Object.keys(invariant).sort().join(",") !== "id,rule" ||
      invariant.rule !== expectedInvariants.get(invariant.id)
    )
      errors.push(`invalid security invariant: ${invariant.id}`);
  }
  const ids = new Set();
  const aliasOwners = new Map();
  for (const requirement of ledger.requirements) {
    for (const key of Object.keys(requirement))
      if (!allowedRequirement.has(key))
        errors.push(
          `unknown requirement field ${key}: ${requirement.requirementId}`,
        );
    if (!requirement.requirementId || ids.has(requirement.requirementId))
      errors.push(
        `duplicate or missing requirement ID: ${requirement.requirementId}`,
      );
    ids.add(requirement.requirementId);
    if (!requirement.owners?.primary?.jiraKey)
      errors.push(`unowned requirement: ${requirement.requirementId}`);
    for (const owner of [
      requirement.owners?.primary,
      ...(requirement.owners?.secondary ?? []),
    ]) {
      if (
        !owner ||
        Object.keys(owner).sort().join(",") !== "jiraKey,planId,url"
      )
        errors.push(
          `unknown or missing owner fields: ${requirement.requirementId}`,
        );
    }
    if (!requirement.entrypoints?.length)
      errors.push(`missing entrypoint: ${requirement.requirementId}`);
    if (!allowedQualifications.has(requirement.qualification))
      errors.push(`qualification inflation: ${requirement.requirementId}`);
    for (const axis of ledger.mappingAxes) {
      const value = requirement.mappings?.[axis];
      if (!value?.status || !value.evidence?.length)
        errors.push(
          `missing ${axis} mapping/evidence: ${requirement.requirementId}`,
        );
      for (const key of Object.keys(value ?? {}))
        if (!allowedMapping.has(key))
          errors.push(
            `unknown ${axis} mapping field ${key}: ${requirement.requirementId}`,
          );
      if (value && !allowedMappingStatuses.has(value.status))
        errors.push(
          `unknown ${axis} mapping status ${value.status}: ${requirement.requirementId}`,
        );
    }
    if (!ledger.dispositionVocabulary.includes(requirement.disposition?.kind))
      errors.push(`invalid disposition: ${requirement.requirementId}`);
    if (
      Object.keys(requirement.disposition ?? {})
        .sort()
        .join(",") !== "kind,legacyFallback"
    )
      errors.push(`unknown disposition fields: ${requirement.requirementId}`);
    for (const alias of requirement.aliases ?? []) {
      const prior = aliasOwners.get(alias);
      if (prior && prior !== requirement.requirementId)
        errors.push(`alias maps to multiple requirements: ${alias}`);
      aliasOwners.set(alias, requirement.requirementId);
    }
  }
  const sourceIds = new Set();
  const actual = { webRoutes: 0, settings: 0, freecut: 0, native: 0 };
  const inventoryCountKeys = {
    "web-routes": "webRoutes",
    settings: "settings",
    freecut: "freecut",
    native: "native",
  };
  for (const row of ledger.sourceRows) {
    for (const key of Object.keys(row))
      if (!allowedSourceRow.has(key))
        errors.push(`unknown source-row field ${key}: ${row.sourceRowId}`);
    if (!row.sourceRowId || sourceIds.has(row.sourceRowId))
      errors.push(`duplicate or missing source-row ID: ${row.sourceRowId}`);
    sourceIds.add(row.sourceRowId);
    if (!ids.has(row.canonicalRequirementId))
      errors.push(`orphan source row: ${row.sourceRowId}`);
    if (ledger.reverseIndex[row.sourceRowId] !== row.canonicalRequirementId)
      errors.push(`broken reverse mapping: ${row.sourceRowId}`);
    if (!row.entrypoints?.length)
      errors.push(`missing source-row entrypoint: ${row.sourceRowId}`);
    if (!allowedQualifications.has(row.qualification))
      errors.push(`source-row qualification inflation: ${row.sourceRowId}`);
    for (const axis of ledger.mappingAxes) {
      const value = row.mappings?.[axis];
      if (!value?.status || !value.evidence?.length)
        errors.push(
          `missing source-row ${axis} mapping/evidence: ${row.sourceRowId}`,
        );
      for (const key of Object.keys(value ?? {}))
        if (!allowedMapping.has(key))
          errors.push(
            `unknown source-row ${axis} field ${key}: ${row.sourceRowId}`,
          );
      if (value && !allowedMappingStatuses.has(value.status))
        errors.push(
          `unknown source-row ${axis} status ${value.status}: ${row.sourceRowId}`,
        );
    }
    if (row.auditGap && (!row.auditGap.mapped || !row.auditGap.issue?.jiraKey))
      errors.push(`unmapped audit gap: ${row.sourceRowId}`);
    const countKey = inventoryCountKeys[row.inventory];
    if (countKey) actual[countKey]++;
  }
  for (const [name, expected] of Object.entries(ledger.expectedInventory))
    if (actual[name] !== expected)
      errors.push(`${name}: expected ${expected}, found ${actual[name]}`);
  if (
    !ledger.requirements.some(
      (row) => row.disposition.kind === "intentional-product-change",
    )
  )
    errors.push("no intentional product change recorded");
  if (
    !ledger.requirements.some(
      (row) => row.disposition.kind === "not-yet-designed",
    )
  )
    errors.push("no not-yet-designed requirement recorded");
  const shared = ledger.requirements.filter(
    ({ sourceRowIds }) => sourceRowIds.length > 1,
  );
  if (
    shared.length !== 20 ||
    shared.some(
      ({ requirementId, sourceRowIds }) =>
        !requirementId.startsWith("setting:system:job.") ||
        sourceRowIds.length !== 2,
    )
  )
    errors.push(
      "reviewed shared-requirement set must contain exactly twenty queue concurrency pairs",
    );
  const candidateOnly = ledger.sourceRows.filter(
    (row) =>
      row.inventory === "settings" &&
      row.mappings.source.status === "candidate-unaccepted",
  );
  if (candidateOnly.length !== 5)
    errors.push("expected five candidate-unaccepted settings rows");
  const expectedSecretPolicy = [
    "ephemeral-input",
    "write-only-secret",
    "configured-state-only",
    "excluded-from-history",
    "excluded-from-export",
    "excluded-from-telemetry",
  ];
  if (ledger.secretPolicies?.length !== 5)
    errors.push("expected five explicit secret policies");
  const expectedSecrets = new Map([
    [
      "oauth-client-secret",
      ["settings:system:oauth.clientSecret", "ADM-005", "mapped-unqualified"],
    ],
    [
      "smtp-password",
      [
        "settings:system:notifications.smtp.transport.password",
        "ADM-002",
        "mapped-unqualified",
      ],
    ],
    [
      "runpod-api-key",
      [
        "settings:system:machineLearning.runpod.apiKey",
        "ADM-101",
        "mapped-unqualified",
      ],
    ],
    [
      "huggingface-token",
      [
        "settings:system:machineLearning.runpod.hfToken",
        "ADM-101",
        "mapped-unqualified",
      ],
    ],
    ["video-worker-token", [null, "ADM-101", "not-yet-designed"]],
  ]);
  if (
    (ledger.secretPolicies ?? [])
      .map(({ credentialId }) => credentialId)
      .sort()
      .join(",") !== [...expectedSecrets.keys()].sort().join(",")
  )
    errors.push("invalid secret credential set");
  for (const secret of ledger.secretPolicies ?? []) {
    if (
      Object.keys(secret).sort().join(",") !==
      "credentialId,owner,policy,sourceRowId,status"
    )
      errors.push(`unknown or missing secret fields: ${secret.credentialId}`);
    if (
      Object.keys(secret.owner ?? {})
        .sort()
        .join(",") !== "jiraKey,planId,url"
    )
      errors.push(
        `unknown or missing secret owner fields: ${secret.credentialId}`,
      );
    const expected = expectedSecrets.get(secret.credentialId);
    if (
      !expected ||
      secret.sourceRowId !== expected[0] ||
      secret.owner?.planId !== expected[1] ||
      secret.status !== expected[2]
    )
      errors.push(`invalid secret contract: ${secret.credentialId}`);
    if (JSON.stringify(secret.policy) !== JSON.stringify(expectedSecretPolicy))
      errors.push(`invalid secret policy: ${secret.credentialId}`);
    if (secret.sourceRowId && !sourceIds.has(secret.sourceRowId))
      errors.push(`orphan secret mapping: ${secret.credentialId}`);
  }
  for (const requirement of ledger.requirements) {
    for (const sourceRowId of requirement.sourceRowIds)
      if (
        !sourceIds.has(sourceRowId) ||
        ledger.reverseIndex[sourceRowId] !== requirement.requirementId
      )
        errors.push(
          `missing/extra source row reference: ${requirement.requirementId} -> ${sourceRowId}`,
        );
    for (const alias of requirement.aliases)
      if (
        !ledger.sourceRows.some(
          (row) =>
            (row.rawRequirementId === alias || row.aliases.includes(alias)) &&
            row.canonicalRequirementId === requirement.requirementId,
        )
      )
        errors.push(`orphan alias: ${alias}`);
    for (const entrypoint of requirement.entrypoints)
      if (
        !ledger.entrypointIndex[entrypoint]?.includes(requirement.requirementId)
      )
        errors.push(
          `orphan entrypoint: ${requirement.requirementId} -> ${entrypoint}`,
        );
  }
  if (Object.keys(ledger.reverseIndex).length !== ledger.sourceRows.length)
    errors.push("extra or missing reverse-index entries");
  for (const [sourceRowId, requirementId] of Object.entries(
    ledger.reverseIndex,
  )) {
    if (!sourceIds.has(sourceRowId) || !ids.has(requirementId))
      errors.push(`orphan reverse-index entry: ${sourceRowId}`);
  }
  for (const [entrypoint, requirementIds] of Object.entries(
    ledger.entrypointIndex,
  )) {
    if (!requirementIds.length)
      errors.push(`empty entrypoint index: ${entrypoint}`);
    for (const requirementId of requirementIds) {
      const requirement = ledger.requirements.find(
        (row) => row.requirementId === requirementId,
      );
      if (!requirement?.entrypoints.includes(entrypoint))
        errors.push(
          `extra/orphan entrypoint index: ${entrypoint} -> ${requirementId}`,
        );
    }
  }
  const [evidence, backlog, jiraMap, nativeMap, actionRegistry] =
    await Promise.all([
      readJson(evidencePath),
      readJson(
        resolve(root, "docs/docs/developer/frameleaf-plan/backlog.json"),
      ),
      readJson(
        resolve(root, "docs/docs/developer/frameleaf-plan/jira-map.json"),
      ),
      readJson(
        resolve(
          root,
          "docs/docs/developer/frameleaf-plan/native-issue-map.json",
        ),
      ),
      readJson(actionRegistryPath),
    ]);
  if (
    Object.keys(actionRegistry).sort().join(",") !==
      "rows,schemaVersion,status" ||
    actionRegistry.schemaVersion !== 1 ||
    actionRegistry.status !== "immutable-action-identities" ||
    actionRegistry.rows.length !== 153
  )
    errors.push("invalid action-ID registry contract");
  const registryIds = new Set();
  const registryKeys = new Set();
  for (const row of actionRegistry.rows) {
    if (Object.keys(row).sort().join(",") !== "aliases,requirementId,sourceKey")
      errors.push(`unknown action registry fields: ${row.sourceKey}`);
    if (
      registryIds.has(row.requirementId) ||
      registryKeys.has(row.sourceKey) ||
      !row.requirementId.startsWith("action:") ||
      row.requirementId.endsWith("-")
    )
      errors.push(`invalid or duplicate action registry row: ${row.sourceKey}`);
    registryIds.add(row.requirementId);
    registryKeys.add(row.sourceKey);
  }
  for (const action of evidence.actions) {
    const registered = actionRegistry.rows.find(
      ({ sourceKey }) => sourceKey === action.sourceKey,
    );
    if (
      !registered ||
      registered.requirementId !== action.id ||
      JSON.stringify(registered.aliases) !== JSON.stringify(action.aliases)
    )
      errors.push(`action identity drift: ${action.sourceKey}`);
    for (const source of action.source) {
      if (
        ![
          "accepted-main",
          "accepted-main-directory",
          "preserved-dirty-only",
          "preserved-dirty-directory",
        ].includes(source.availability) ||
        (source.availability.endsWith("only") && !source.sha256)
      )
        errors.push(`invalid action source evidence: ${source.path}`);
    }
  }
  const expectedRows = {
    "web-routes": evidence.routes.map(({ id }) => id),
    "web-action-audit": evidence.actions.map(({ id }) => id),
    settings: evidence.settings.map(({ id }) => id),
    freecut: evidence.freecut.map(({ id }) => id),
    native: nativeMap.entries.map(({ id }) => id),
  };
  for (const [inventory, expectedIds] of Object.entries(expectedRows)) {
    const actualIds = ledger.sourceRows
      .filter((row) => row.inventory === inventory)
      .map(({ inventoryId }) => inventoryId)
      .sort();
    if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds.sort()))
      errors.push(`missing/extra ${inventory} source rows`);
  }
  const recomputedCounts = {
    webRoutes: expectedRows["web-routes"].length,
    webActions: expectedRows["web-action-audit"].length,
    settings: expectedRows.settings.length,
    freecut: expectedRows.freecut.length,
    native: expectedRows.native.length,
    sourceRows: ledger.sourceRows.length,
    canonicalRequirements: ledger.requirements.length,
  };
  if (JSON.stringify(ledger.counts) !== JSON.stringify(recomputedCounts))
    errors.push("stale ledger counts");
  if (ledger.sourceEvidenceSha256 !== sha256(JSON.stringify(evidence)))
    errors.push("stale normalized source evidence hash");
  const expectedHashes = {
    acceptedRoutes:
      "bd3c5ae5f8fa9867cb6e049f53bad1cd275d14f8d481c7fbb2e9a0b963aa670f",
    acceptedActionFamilies:
      "b6a4dd66d641441ed3bb3913c95f5a160b0c4fb8ec25b7626294cf02f9005154",
    acceptedNative:
      "7433d51fd0112b7e99e812647f0f7113b7a20b46e7ab0034e7085a179cc60bc6",
    acceptedFreecut:
      "dba7454283c4b72ef27b237ff62b384b063775bf14c7bb3bd8cb71ec4eab296a",
    routeOwnershipEvidence:
      "1ff9ef561aa8663d14d118cbe4ad2d0acb326100f5260ffc69a888b777290f56",
    actionAuditEvidence:
      "d8f5942885a144221798f81f458eb58a7a6f8f8bd1f2cb1f7c04d80aea834379",
    actionRegistry:
      "e47a54cab6c3010d4727eb4ca0d6f06e3bb6b313657a82fa0c4300eb9ba246c7",
    settings:
      "b0feba0fde5fff70f2d2204c08c8307d380ead8d993e3cf32d969d31b4394c20",
  };
  for (const [name, expected] of Object.entries(expectedHashes)) {
    const snapshot = ledger.sourceSnapshots[name];
    if (snapshot?.sha256 !== expected) errors.push(`stale ${name} receipt`);
    if (snapshot?.path && !snapshot.path.startsWith("preserved-dirty:")) {
      const current = sha256(
        await readFile(resolve(root, snapshot.path), "utf8"),
      );
      if (current !== expected) errors.push(`changed ${name} source input`);
    }
  }
  const backlogById = new Map(backlog.items.map((item) => [item.id, item]));
  for (const row of ledger.requirements)
    for (const owner of [row.owners.primary, ...row.owners.secondary]) {
      const canonical = jiraMap.issues[owner.planId];
      if (
        backlogById.get(owner.planId)?.type !== "story" ||
        !canonical ||
        canonical.key !== owner.jiraKey ||
        canonical.url !== owner.url
      )
        errors.push(
          `unknown or noncanonical owner ${owner.planId}: ${row.requirementId ?? row.sourceRowId}`,
        );
    }
  for (const secret of ledger.secretPolicies ?? []) {
    const canonical = jiraMap.issues[secret.owner.planId];
    if (!canonical || canonical.key !== secret.owner.jiraKey)
      errors.push(`unknown secret owner: ${secret.credentialId}`);
  }
  if (errors.length) throw new Error(errors.join("\n"));
}

const args = process.argv.slice(2);
const importIndex = args.indexOf("--import-evidence");
if (importIndex >= 0) {
  const sourceRoot = args[importIndex + 1];
  if (!sourceRoot)
    throw new Error(
      "--import-evidence requires the preserved source checkout path",
    );
  await importEvidence(resolve(sourceRoot));
}
const ledger = await buildLedger();
await validateLedger(ledger);
const serialized = await formatJson(ledger, ledgerPath);
const validateIndex = args.indexOf("--validate-ledger");
if (validateIndex >= 0) {
  const candidatePath = args[validateIndex + 1];
  if (!candidatePath) throw new Error("--validate-ledger requires a path");
  await validateLedger(await readJson(resolve(candidatePath)));
  console.log(`Validated candidate ${candidatePath}.`);
} else if (args.includes("--check")) {
  const committed = await readFile(ledgerPath, "utf8");
  if (committed !== serialized)
    throw new Error(
      "action-preservation-ledger.json is stale; regenerate it with this script",
    );
  console.log(
    `Validated ${ledger.counts.canonicalRequirements} canonical requirements and ${ledger.counts.sourceRows} source rows (${ledger.counts.webRoutes} routes, ${ledger.counts.webActions} actions, ${ledger.counts.settings} settings, ${ledger.counts.freecut} Freecut, ${ledger.counts.native} native).`,
  );
} else {
  await writeFile(ledgerPath, serialized);
  console.log(`Wrote ${ledgerPath}`);
}
