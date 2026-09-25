import assert from "node:assert/strict";
import { test } from "node:test";
import {
  NOTIFICATIONS_KEY,
  SUPPORTER_KEY,
  UPLOAD_ERROR_REASONS,
  aboutInfo,
  activateSupporter,
  advanceDownloads,
  advanceMaintenance,
  advanceUploads,
  cancelDownload,
  cancelUploads,
  checkForUpdates,
  createDownload,
  createMaintenance,
  createSupporter,
  createUploads,
  dismissNotification,
  dismissUploadErrors,
  downloadSummary,
  formatBytes,
  formatPrice,
  loadNotifications,
  loadSupporter,
  maintenanceSummary,
  markAllRead,
  markRead,
  normalizeProductKey,
  notificationTypes,
  parseNotifications,
  parseSupporter,
  passwordStrength,
  relativeTime,
  removeSupporter,
  renderStorageTemplate,
  retryUploads,
  sampleNotifications,
  saveNotifications,
  saveSupporter,
  setSupporterBadgeHidden,
  sortNotifications,
  supporterProducts,
  unreadCount,
  uploadSummary,
  validPin,
  validateEmail,
  validateProductKey,
  versionHistory,
} from "../src/system-data.mjs";

const NOW = "2026-09-22T12:00:00.000Z";
const memoryStorage = () => {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    map,
  };
};
const files = (count, size = 2 * 1024 * 1024, ext = "jpg") =>
  Array.from({ length: count }, (_, i) => ({
    name: `IMG_${String(i + 1).padStart(4, "0")}.${ext}`,
    size,
    type: ext === "mp4" ? "video/mp4" : "image/jpeg",
  }));
const settle = (items, concurrency = 3, ticks = 200) => {
  let state = items;
  for (let i = 0; i < ticks; i += 1) {
    state = advanceUploads(state, concurrency, 250);
    if (!uploadSummary(state).active) break;
  }
  return state;
};

// notifications

test("sample notifications are typed, sorted newest first and count unread", () => {
  const items = sampleNotifications(NOW);
  assert.equal(items.length, 5);
  assert.ok(items.every((item) => notificationTypes[item.type]));
  assert.equal(unreadCount(items), 3);
  const sorted = sortNotifications(items);
  assert.equal(sorted[0].id, "notice-invite-lake");
  assert.equal(sorted.at(-1).type, "new-version");
  assert.equal(relativeTime(sorted[0].createdAt, NOW), "14 min ago");
  assert.equal(relativeTime(sorted[1].createdAt, NOW), "3 h ago");
  assert.equal(relativeTime(sorted[3].createdAt, NOW), "Yesterday");
  assert.equal(relativeTime(sorted[4].createdAt, NOW), "3 days ago");
  assert.equal(relativeTime("2026-01-05T00:00:00.000Z", NOW), "5 Jan");
  assert.equal(relativeTime("nonsense", NOW), "");
});

test("read helpers are pure and persist through storage with defensive parsing", () => {
  const items = sampleNotifications(NOW);
  const one = markRead(items, "notice-invite-lake", NOW);
  assert.equal(unreadCount(one), 2);
  assert.equal(unreadCount(items), 3);
  assert.equal(one.find((item) => item.id === "notice-invite-lake").readAt, NOW);
  const all = markAllRead(items, NOW);
  assert.equal(unreadCount(all), 0);
  assert.equal(
    all.find((item) => item.id === "notice-storage").readAt,
    items.find((item) => item.id === "notice-storage").readAt,
    "already-read items keep their original read time",
  );
  assert.equal(dismissNotification(items, "notice-storage").length, 4);

  const storage = memoryStorage();
  assert.equal(saveNotifications(one, storage), true);
  assert.ok(storage.map.has(NOTIFICATIONS_KEY));
  assert.deepEqual(loadNotifications(storage, NOW), one);

  assert.equal(parseNotifications("not json"), null);
  assert.equal(parseNotifications(JSON.stringify({ version: 2, items: [] })), null);
  assert.equal(
    parseNotifications(
      JSON.stringify({ version: 1, items: [{ id: "x", type: "evil" }] }),
    ),
    null,
  );
  assert.equal(
    parseNotifications(
      JSON.stringify({ version: 1, items: [one[0], { ...one[0] }] }),
    ),
    null,
    "duplicate ids are rejected",
  );
  storage.setItem(NOTIFICATIONS_KEY, "{broken");
  assert.equal(loadNotifications(storage, NOW).length, 5, "falls back to samples");
  assert.equal(loadNotifications({ getItem() { throw new Error("blocked"); } }, NOW).length, 5);
});

// uploads

test("createUploads reads only names, sizes and types and marks outcomes", () => {
  const items = createUploads(files(18), { albumId: "family" });
  assert.equal(items.length, 18);
  assert.ok(items.every((item) => item.status === "queued" && item.progress === 0));
  assert.ok(items.every((item) => item.albumId === "family"));
  assert.equal(items[0].id, "upload-1-img-0001-jpg");
  assert.deepEqual(
    items.filter((item) => item.outcome === "duplicate").map((item) => item.seq),
    [6, 12],
  );
  assert.deepEqual(
    items.filter((item) => item.outcome === "error").map((item) => item.seq),
    [9, 18],
  );
  assert.equal(createUploads(null).length, 0);
  assert.equal(createUploads([{ size: 3 }, { name: "  " }]).length, 0);
  const typed = createUploads([
    { name: "clip.mov", size: 10 },
    { name: "notes.txt", size: 10 },
  ]);
  assert.equal(typed[0].type, "video/*");
  assert.equal(typed[1].outcome, "unsupported");
  const later = createUploads(files(3), { offset: 5 });
  assert.equal(later[0].seq, 6);
  assert.equal(later[0].outcome, "duplicate");
});

test("advanceUploads honours concurrency and reaches the expected terminal states", () => {
  const items = createUploads(files(10));
  const first = advanceUploads(items, 2, 250);
  assert.equal(first.filter((item) => item.status === "uploading").length, 2);
  assert.equal(items[0].status, "queued", "input list is untouched");
  const second = advanceUploads(first, 2, 250);
  assert.ok(second[0].progress > 0 && second[0].progress <= 100);
  const done = settle(items, 3);
  const summary = uploadSummary(done);
  assert.equal(summary.active, false);
  assert.equal(summary.done, 8);
  assert.equal(summary.duplicates, 1);
  assert.equal(summary.errors, 1);
  assert.equal(summary.percent, 100);
  assert.equal(summary.label, "1 upload needs attention");
  const failed = done.find((item) => item.status === "error");
  assert.ok(UPLOAD_ERROR_REASONS.includes(failed.error));
  assert.equal(done.find((item) => item.status === "duplicate").progress, 100);
  assert.equal(advanceUploads(undefined).length, 0);
  const huge = settle(createUploads([{ name: "movie.mp4", size: 2 ** 31, type: "video/mp4" }]), 10, 3);
  assert.equal(huge[0].status, "uploading");
  assert.ok(huge[0].progress >= 6, "large files still move at the minimum step");
  assert.equal(advanceUploads(createUploads(files(20)), 99, 250).filter((item) => item.status === "uploading").length, 10, "concurrency is capped at 10");
});

test("upload summary, retry, dismiss and cancel keep the list consistent", () => {
  const empty = uploadSummary([]);
  assert.equal(empty.label, "No uploads");
  const running = advanceUploads(createUploads(files(4)), 1, 250);
  assert.equal(uploadSummary(running).label, "Uploading 1 of 4");
  const done = settle(createUploads(files(9)), 3);
  assert.equal(uploadSummary(done).errors, 1);
  const retried = retryUploads(done);
  const row = retried.find((item) => item.seq === 9);
  assert.equal(row.status, "queued");
  assert.equal(row.attempts, 1);
  assert.equal(row.error, null);
  const afterRetry = settle(retried, 3);
  assert.equal(uploadSummary(afterRetry).errors, 0);
  assert.equal(uploadSummary(afterRetry).label, "Upload complete");
  assert.equal(dismissUploadErrors(done).length, 8);
  const unsupported = advanceUploads(createUploads([{ name: "a.txt", size: 1 }]), 1, 250);
  assert.equal(unsupported[0].status, "error");
  assert.equal(retryUploads(unsupported)[0].status, "error", "unsupported types are not retried");
  const partial = advanceUploads(createUploads(files(5)), 2, 250);
  assert.equal(cancelUploads(partial).length, 0);
  assert.equal(cancelUploads(done).length, 9);
  assert.equal(uploadSummary(createUploads([{ name: "empty.jpg", size: 0 }])).percent, 0);
});

// downloads

test("downloads prepare, become ready and can be cancelled", () => {
  const zip = createDownload("Summer in the Rockies", ["a", "b", "c", 4], { now: NOW });
  assert.equal(zip.name, "Summer in the Rockies.zip");
  assert.equal(zip.count, 3);
  assert.equal(zip.status, "preparing");
  const none = createDownload("", [], { now: NOW });
  assert.equal(none.status, "error");
  assert.equal(none.name, "frameleaf-download.zip");
  let list = [zip, none];
  for (let i = 0; i < 100 && downloadSummary(list).active; i += 1)
    list = advanceDownloads(list, 250);
  assert.equal(list[0].status, "ready");
  assert.equal(list[0].progress, 100);
  assert.equal(list[1].status, "error");
  assert.deepEqual(downloadSummary(list), { total: 2, preparing: 0, ready: 1, active: false });
  assert.equal(cancelDownload(list, zip.id).length, 1);
  assert.equal(advanceDownloads("nope").length, 0);
  assert.equal(formatBytes(zip.bytes), "13 MB");
  assert.equal(formatBytes(1.5 * 1024 * 1024), "1.5 MB");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(-1), "0 B");
  assert.equal(formatBytes(3 * 1024 ** 3), "3.0 GB");
});

test("storage template preview expands known tokens and flags unknown ones", () => {
  const preview = renderStorageTemplate("{{y}}/{{y}}-{{MM}}-{{dd}}/{{filename}}");
  assert.equal(preview.path, "library/taylor/2026/2026-09-14/IMG_4021.jpg");
  assert.equal(preview.valid, true);
  const unknown = renderStorageTemplate("{{album}}/{{nope}}/{{filename}}");
  assert.deepEqual(unknown.unknown, ["nope"]);
  assert.equal(unknown.valid, false);
  assert.match(unknown.path, /Summer in the Rockies\/\{\{nope\}\}\/IMG_4021\.jpg$/);
  assert.equal(renderStorageTemplate("").valid, false);
  assert.equal(renderStorageTemplate("../{{filename}}").valid, false);
  assert.equal(renderStorageTemplate("//{{MMM}}//{{filename}}/").path, "library/taylor/Sep/IMG_4021.jpg");
  assert.equal(renderStorageTemplate("{{ext}}").valid, false, "the extension is appended, not a token");
});

// supporter

test("product keys normalise, validate and distinguish server from individual", () => {
  assert.equal(normalizeProductKey("fl-srvr 2026_demo"), "FL-SRVR-2026-DEMO");
  assert.equal(normalizeProductKey("flsrvr2026demoEXTRA"), "FL-SRVR-2026-DEMO");
  assert.equal(normalizeProductKey(42), "");
  assert.deepEqual(validateProductKey("FL-SRVR-2026-DEMO"), {
    valid: true,
    key: "FL-SRVR-2026-DEMO",
    kind: "server",
    message: "",
  });
  assert.equal(validateProductKey("fl-indv-2026-demo").kind, "individual");
  assert.equal(validateProductKey("").message, "Enter your product key");
  assert.match(validateProductKey("FL-SRVR-2026").message, /FL-XXXX-XXXX-XXXX/);
  assert.match(validateProductKey("FL-ZZZZ-2026-DEMO").message, /does not belong/);
  assert.match(validateProductKey("XX-SRVR-2026-DEMO").message, /FL-XXXX/);
  assert.equal(supporterProducts.length, 2);
  assert.equal(formatPrice(supporterProducts[0]), "$100");
  assert.equal(formatPrice(supporterProducts[1]), "$25");
});

test("supporter state activates, hides the badge and persists without the full key", () => {
  const base = createSupporter();
  assert.throws(() => activateSupporter(base, "FL-BAD"), /FL-XXXX/);
  const active = activateSupporter(base, "fl-indv-2026-demo", NOW);
  assert.equal(active.activated, true);
  assert.equal(active.kind, "individual");
  assert.equal(active.keyHint, "DEMO");
  assert.equal(active.activatedAt, NOW);
  assert.equal(JSON.stringify(active).includes("INDV"), false, "full key is never stored");
  const hidden = setSupporterBadgeHidden(active, true);
  assert.equal(hidden.hideBadge, true);
  assert.equal(active.hideBadge, false);
  const storage = memoryStorage();
  saveSupporter(hidden, storage);
  assert.ok(storage.map.has(SUPPORTER_KEY));
  assert.deepEqual(loadSupporter(storage), hidden);
  const removed = removeSupporter(hidden);
  assert.equal(removed.activated, false);
  assert.equal(removed.hideBadge, true);
  assert.equal(parseSupporter(JSON.stringify({ version: 1, activated: true, kind: "server" })), null, "activated needs a timestamp");
  assert.equal(parseSupporter(JSON.stringify({ version: 1, activated: true, kind: "gold", activatedAt: NOW })), null);
  assert.deepEqual(parseSupporter(JSON.stringify({ version: 1, activated: false, kind: "server", keyHint: "ABCD" })), { ...base });
  assert.deepEqual(loadSupporter(memoryStorage()), base);
});

// maintenance

test("maintenance tasks run in order and skip rollback when everything succeeds", () => {
  let tasks = createMaintenance();
  assert.equal(tasks[0].status, "running");
  assert.equal(tasks.at(-1).status, "standby");
  const before = maintenanceSummary(tasks);
  assert.equal(before.currentTitle, "Database backup");
  assert.equal(before.complete, false);
  for (let i = 0; i < 200 && !maintenanceSummary(tasks).complete; i += 1)
    tasks = advanceMaintenance(tasks, 500);
  const after = maintenanceSummary(tasks);
  assert.equal(after.complete, true);
  assert.equal(after.percent, 100);
  assert.equal(after.currentTitle, null);
  assert.equal(tasks.at(-1).status, "skipped");
  assert.ok(tasks.slice(0, 3).every((task) => task.status === "done"));
  assert.equal(advanceMaintenance(null).length, 0);
});

// credentials

test("password strength grades requirements and pins need six digits", () => {
  assert.equal(passwordStrength("").score, 0);
  assert.equal(passwordStrength("").label, "Enter a password");
  assert.equal(passwordStrength("abc").label, "Weak");
  assert.equal(passwordStrength("abc").checks.length, false);
  const fair = passwordStrength("abcdefgh");
  assert.equal(fair.label, "Weak");
  assert.equal(fair.acceptable, false);
  const good = passwordStrength("Abcdefg1");
  assert.equal(good.label, "Good");
  assert.equal(good.acceptable, true);
  const strong = passwordStrength("Abcdefg1!");
  assert.equal(strong.label, "Strong");
  assert.equal(strong.passed, 5);
  assert.equal(passwordStrength("abcdefghijklmnop").label, "Fair", "length alone lifts a step");
  assert.equal(passwordStrength(null).score, 0);
  assert.equal(validPin("123456"), true);
  assert.equal(validPin("12345"), false);
  assert.equal(validPin("12345a"), false);
  assert.equal(validPin(123456), false);
  assert.equal(validateEmail("taylor@example.test"), true);
  assert.equal(validateEmail("taylor@example"), false);
  assert.equal(validateEmail(""), false);
});

// about

test("about info exposes version, attribution and a simulated update check", () => {
  assert.equal(aboutInfo.product, "Frameleaf");
  assert.equal(aboutInfo.upstream.name, "Immich");
  assert.equal(aboutInfo.licence, "AGPL-3.0");
  assert.ok(aboutInfo.thirdParty.some((entry) => entry.name === "Immich"));
  assert.ok(versionHistory.length >= 3);
  assert.ok(versionHistory.every((entry) => entry.notes.length > 0));
  const result = checkForUpdates(aboutInfo, NOW);
  assert.equal(result.status, "current");
  assert.equal(result.checkedAt, NOW);
  assert.equal(result.latest.version, versionHistory[0].version);
  const stale = checkForUpdates({ version: "2026.7", channel: "release" }, NOW);
  assert.equal(stale.status, "available");
  assert.match(stale.message, /2026\.9/);
});
