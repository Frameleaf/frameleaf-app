import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAINTENANCE_LIMITS,
  advanceBackup,
  advanceIntegrityCheck,
  advanceRestore,
  backupFileName,
  beginBackup,
  beginRestore,
  checkStatusLabel,
  createMaintenanceState,
  deleteBackup,
  deleteReport,
  endMaintenance,
  filterFindings,
  finishRestore,
  formatBytes,
  generateFindings,
  integrityCheckTypes,
  parseMaintenanceState,
  postRestoreChecklist,
  reportFileName,
  reportToCsv,
  reportToText,
  restoreProgressLabel,
  restoreSteps,
  runAllIntegrityChecks,
  runIntegrityCheck,
  serializeMaintenance,
  startMaintenance,
  toggleChecklistItem,
} from "../src/maintenance-data.mjs";

const now = "2026-09-19T12:00:00.000Z";
const later = "2026-09-19T12:05:00.000Z";

test("seed state is consistent and survives a serialize/parse round trip", () => {
  const state = createMaintenanceState(now);
  assert.equal(state.mode.active, false);
  assert.equal(state.backups.length, 4);
  assert.ok(state.backups.every((backup) => backup.createdAt < now));
  assert.deepEqual(
    Object.keys(state.checks),
    integrityCheckTypes.map((type) => type.id),
  );
  assert.equal(state.checks.checksums.status, "passed");
  const parsed = parseMaintenanceState(serializeMaintenance(state), now);
  assert.deepEqual(parsed, state);
  assert.deepEqual(parseMaintenanceState("{oops", now), createMaintenanceState(now));
  assert.deepEqual(parseMaintenanceState({ version: 3 }, now), createMaintenanceState(now));
  assert.deepEqual(
    parseMaintenanceState("x".repeat(MAINTENANCE_LIMITS.jsonCharacters + 1), now),
    createMaintenanceState(now),
  );
});

test("parsing drops malformed records, resets interrupted work and keeps maintenance on", () => {
  const parsed = parseMaintenanceState(
    {
      version: 1,
      mode: { active: true, reason: 42 },
      backups: [
        { id: "ok", createdAt: now, sizeBytes: 5, kind: "manual", status: "complete" },
        { id: "ok", createdAt: now, status: "complete" },
        { id: "running", createdAt: now, status: "running", progress: 40 },
        { id: "bad-date", createdAt: "yesterday", status: "complete" },
        { id: "bad-status", createdAt: now, status: "sideways" },
        "nope",
      ],
      checks: {
        checksums: { status: "running", progress: 50, lastRun: now, reportId: "missing" },
        sidecars: { status: "issues", lastRun: "bad" },
        bogus: { status: "passed" },
      },
      reports: [
        {
          id: "r1",
          type: "sidecars",
          createdAt: now,
          findings: [
            { id: "f1", severity: "error", path: "/a", message: "Broken" },
            { severity: "loud", message: "ignored" },
            { severity: "info", message: "" },
          ],
        },
        { id: "r2", type: "unknown", createdAt: now, findings: [] },
      ],
      restore: { backupId: "ok", status: "running", step: 2 },
      lastRestore: { backupId: "ok", finishedAt: now, checklist: ["open", "bogus", "open"] },
    },
    now,
  );
  assert.equal(parsed.mode.active, true);
  assert.equal(parsed.mode.startedAt, now);
  assert.equal(parsed.mode.reason, "");
  assert.deepEqual(
    parsed.backups.map((backup) => [backup.id, backup.status, backup.kind]),
    [
      ["ok", "complete", "manual"],
      ["running", "failed", "manual"],
    ],
  );
  assert.equal(parsed.checks.checksums.status, "idle");
  assert.equal(parsed.checks.checksums.reportId, null);
  assert.equal(parsed.checks.checksums.lastRun, now);
  assert.equal(parsed.checks.sidecars.status, "issues");
  assert.equal(parsed.checks.sidecars.lastRun, null);
  assert.equal(parsed.checks.bogus, undefined);
  assert.equal(parsed.reports.length, 1);
  assert.equal(parsed.reports[0].findings.length, 1);
  assert.deepEqual(parsed.reports[0].summary, { error: 1, warning: 0, info: 0, total: 1 });
  assert.equal(parsed.restore, null);
  assert.deepEqual(parsed.lastRestore.checklist, ["open"]);
  assert.ok(
    parsed.lastRestore.checklist.every((item) =>
      postRestoreChecklist.some((step) => step.id === item),
    ),
  );
});

test("maintenance mode toggles with reasons and refuses to end mid-restore", () => {
  const state = createMaintenanceState(now);
  const on = startMaintenance(state, now, "  Disk swap  ");
  assert.equal(on.mode.active, true);
  assert.equal(on.mode.reason, "Disk swap");
  assert.equal(on.mode.startedAt, now);
  assert.throws(() => startMaintenance(on, now), /already on/);
  const off = endMaintenance(on, later);
  assert.equal(off.mode.active, false);
  assert.equal(off.mode.endedAt, later);
  assert.throws(() => endMaintenance(off, later), /already off/);
  const restoring = beginRestore(state, "backup-seed-1", now);
  assert.throws(() => endMaintenance(restoring, later), /Finish the restore/);
  assert.equal(state.mode.active, false, "inputs are not mutated");
});

test("backups run to completion with a plausible size and cannot be deleted while running", () => {
  const state = createMaintenanceState(now);
  const started = beginBackup(state, now, "manual", "Before the move");
  const running = started.backups[0];
  assert.equal(running.status, "running");
  assert.equal(running.note, "Before the move");
  assert.throws(() => beginBackup(started, now), /already running/);
  assert.throws(() => deleteBackup(started, running.id), /Wait for the backup/);
  assert.throws(() => beginRestore(started, "backup-seed-1", now), /running backup/);
  let next = started;
  for (let index = 0; index < 4; index += 1) next = advanceBackup(next, running.id, 30);
  const finished = next.backups.find((backup) => backup.id === running.id);
  assert.equal(finished.status, "complete");
  assert.equal(finished.progress, 100);
  assert.ok(finished.sizeBytes > 412_000_000 && finished.sizeBytes < 430_000_000);
  assert.equal(advanceBackup(next, running.id, 10), next);
  assert.equal(advanceBackup(next, "missing", 10), next);
  const deleted = deleteBackup(next, running.id);
  assert.equal(deleted.backups.length, state.backups.length);
  assert.throws(() => deleteBackup(deleted, running.id), /no longer exists/);
  assert.match(backupFileName(finished), /^frameleaf-db-2026-09-19-12-00-00\.sql\.gz$/);
  assert.equal(formatBytes(finished.sizeBytes).endsWith(" MB"), true);
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1_500), "1.5 KB");
});

test("restore walks every step under maintenance mode and ends with a checklist", () => {
  const state = createMaintenanceState(now);
  assert.throws(() => beginRestore(state, "backup-seed-4", now), /completed backup/);
  let next = beginRestore(state, "backup-seed-2", now);
  assert.equal(next.mode.active, true);
  assert.equal(next.mode.reason, "Restoring a database backup");
  assert.equal(next.restore.step, 0);
  assert.match(restoreProgressLabel(next.restore), /Step 1 of 4 · Enter maintenance mode/);
  assert.throws(() => beginRestore(next, "backup-seed-1", now), /already running/);
  assert.throws(() => deleteBackup(next, "backup-seed-2"), /being restored/);
  assert.throws(() => runIntegrityCheck(next, "checksums", now), /Wait for the restore/);
  for (let index = 0; index < restoreSteps.length - 1; index += 1) {
    next = advanceRestore(next, later);
    assert.equal(next.restore.status, "running");
  }
  next = advanceRestore(next, later);
  assert.equal(next.restore.status, "restored");
  assert.equal(next.restore.finishedAt, later);
  assert.equal(restoreProgressLabel(next.restore), "Restored");
  assert.deepEqual(next.lastRestore, { backupId: "backup-seed-2", finishedAt: later, checklist: [] });
  assert.equal(advanceRestore(next, later), next);
  next = toggleChecklistItem(next, "open");
  next = toggleChecklistItem(next, "bogus");
  assert.deepEqual(next.lastRestore.checklist, ["open"]);
  next = toggleChecklistItem(next, "open");
  assert.deepEqual(next.lastRestore.checklist, []);
  const done = finishRestore(next);
  assert.equal(done.restore, null);
  assert.equal(done.mode.active, true, "maintenance stays on until ended deliberately");
  const off = endMaintenance(done, later);
  assert.equal(off.mode.active, false);
  const reloaded = parseMaintenanceState(serializeMaintenance(next), later);
  assert.equal(reloaded.restore.status, "restored");
  assert.equal(reloaded.restore.step, restoreSteps.length);
});

test("integrity checks produce deterministic reports and status labels", () => {
  const state = createMaintenanceState(now);
  let next = runAllIntegrityChecks(state, now);
  assert.ok(Object.values(next.checks).every((check) => check.status === "running"));
  assert.equal(runIntegrityCheck(next, "sidecars", now), next);
  assert.throws(() => runIntegrityCheck(next, "bogus", now), /Unknown/);
  assert.match(checkStatusLabel(next.checks.checksums), /Running · 0%/);
  next = advanceIntegrityCheck(next, "checksums", 50, later);
  assert.equal(next.checks.checksums.progress, 50);
  next = advanceIntegrityCheck(next, "checksums", 50, later);
  assert.equal(next.reports.length, 1);
  const report = next.reports[0];
  assert.equal(report.type, "checksums");
  assert.equal(next.checks.checksums.reportId, report.id);
  assert.equal(next.checks.checksums.lastRun, later);
  assert.ok(["passed", "issues"].includes(next.checks.checksums.status));
  assert.deepEqual(report.summary.total, report.findings.length);
  assert.deepEqual(generateFindings("checksums", later), generateFindings("checksums", later));
  assert.notDeepEqual(generateFindings("checksums", later), generateFindings("sidecars", later));
  assert.deepEqual(generateFindings("bogus", later), []);
  const findings = generateFindings("sidecars", "seed");
  assert.ok(findings.length >= 2 && findings.length <= 8);
  assert.ok(findings.every((finding) => finding.path.endsWith(".xmp")));
  assert.ok(
    findings.every(
      (finding, index) =>
        index === 0 ||
        ["error", "warning", "info"].indexOf(findings[index - 1].severity) <=
          ["error", "warning", "info"].indexOf(finding.severity),
    ),
  );
  const filtered = filterFindings(findings, { severity: "info" });
  assert.ok(filtered.every((finding) => finding.severity === "info"));
  assert.deepEqual(filterFindings(findings, { query: "NOTHING-MATCHES" }), []);
  assert.equal(filterFindings(findings, { query: "xmp" }).length, findings.length);
  assert.equal(filterFindings(null).length, 0);
  const removed = deleteReport(next, report.id);
  assert.equal(removed.reports.length, 0);
  assert.equal(removed.checks.checksums.reportId, null);
  assert.equal(removed.checks.checksums.status, next.checks.checksums.status);
  assert.throws(() => deleteReport(removed, report.id), /no longer exists/);
  assert.equal(checkStatusLabel(removed.checks.sidecars), "Running · 0%");
  assert.equal(checkStatusLabel({ status: "idle" }), "Not run yet");
  assert.equal(checkStatusLabel(undefined), "Not run yet");
});

test("report exports are real CSV and text files with escaped cells and stable names", () => {
  const report = {
    id: "r",
    type: "orphaned-files",
    createdAt: now,
    scanned: 10,
    durationMs: 1500,
    findings: [
      { id: "1", severity: "warning", path: '/mnt/photos/"quoted", comma.jpg', message: "No record", detail: "line1\nline2" },
      { id: "2", severity: "info", path: "/mnt/photos/plain.jpg", message: "Temp", detail: "" },
    ],
    summary: { error: 0, warning: 1, info: 1, total: 2 },
  };
  const csv = reportToCsv(report);
  const lines = csv.split("\r\n");
  assert.equal(lines[0], "severity,path,message,detail");
  assert.equal(lines[1], 'warning,"/mnt/photos/""quoted"", comma.jpg",No record,"line1\nline2"');
  assert.equal(lines[2], "info,/mnt/photos/plain.jpg,Temp,");
  assert.equal(lines.at(-1), "");
  const text = reportToText(report);
  assert.match(text, /Orphaned files/);
  assert.match(text, /Scanned: 10 items in 1\.5 s/);
  assert.match(text, /\[WARNING\] \/mnt\/photos\/"quoted", comma\.jpg/);
  assert.equal(reportFileName(report, "csv"), "frameleaf-integrity-orphaned-files-2026-09-19-12-00-00.csv");
});
