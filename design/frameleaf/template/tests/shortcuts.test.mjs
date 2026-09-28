import test from "node:test";
import assert from "node:assert/strict";
import {
  formatKeys,
  isMacPlatform,
  isTypingTarget,
  matchShortcut,
  shortcutGroups,
  shortcuts,
} from "../src/shortcuts.mjs";

const press = (key, extra = {}) => ({
  key,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  target: { tagName: "BODY" },
  ...extra,
});
const id = (event) => matchShortcut(event)?.id ?? null;

test("shortcut ids are unique and every entry belongs to a known group", () => {
  const ids = shortcuts.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const entry of shortcuts) {
    assert.ok(["general", "actions"].includes(entry.group), entry.id);
    assert.ok(entry.label && entry.keys?.length, entry.id);
  }
  for (const required of [
    "select", "focus-previous", "focus-next", "select-range", "select-all", "clear-selection",
    "jump-day", "jump-month", "jump-year", "go-to-date", "focus-search", "help",
    "rate-1", "rate-5", "rate-clear", "favorite", "info", "edit", "stack", "add-to-album",
    "tag", "tag-people", "archive", "download", "delete",
  ])
    assert.ok(ids.includes(required), required);
});

test("plain letters, shifted letters and modifier combos resolve to distinct shortcuts", () => {
  assert.equal(id(press("d")), "jump-day");
  assert.equal(id(press("D", { shiftKey: true })), "download");
  assert.equal(id(press("d", { metaKey: true })), "clear-selection");
  assert.equal(id(press("d", { ctrlKey: true })), "clear-selection");
  assert.equal(id(press("a")), null, "plain a is unassigned");
  assert.equal(id(press("A", { shiftKey: true })), "archive");
  assert.equal(id(press("a", { metaKey: true })), "select-all");
  assert.equal(id(press("x")), "select");
  assert.equal(id(press("X", { shiftKey: true })), null);
  assert.equal(id(press("ArrowLeft")), "focus-previous");
  assert.equal(id(press("ArrowRight")), "focus-next");
  assert.equal(id(press("ArrowLeft", { altKey: true })), null);
});

test("question mark matches with or without shift, and delete accepts both delete keys", () => {
  assert.equal(id(press("?", { shiftKey: true })), "help");
  assert.equal(id(press("?")), "help");
  assert.equal(id(press("/")), "focus-search");
  assert.equal(id(press("Delete")), "delete");
  assert.equal(id(press("Backspace")), "delete");
  assert.equal(id(press("Backspace", { metaKey: true })), null);
});

test("rating digits map to values and ignore modifiers", () => {
  for (const digit of [1, 2, 3, 4, 5]) {
    const entry = matchShortcut(press(String(digit)));
    assert.equal(entry.id, `rate-${digit}`);
    assert.equal(entry.value, digit);
  }
  assert.equal(matchShortcut(press("0")).value, 0);
  assert.equal(id(press("3", { metaKey: true })), null);
});

test("typing contexts, composition and key repeat never trigger shortcuts", () => {
  assert.equal(id(press("x", { target: { tagName: "INPUT", type: "text" } })), null);
  assert.equal(id(press("x", { target: { tagName: "TEXTAREA" } })), null);
  assert.equal(id(press("x", { target: { tagName: "SELECT" } })), null);
  assert.equal(
    id(press("x", { target: { tagName: "DIV", isContentEditable: true } })),
    null,
  );
  assert.equal(
    id(press("x", { target: { tagName: "INPUT", type: "checkbox" } })),
    "select",
    "checkbox focus still allows shortcuts",
  );
  assert.equal(id(press("x", { isComposing: true })), null);
  assert.equal(id(press("x", { repeat: true })), null);
  assert.equal(
    matchShortcut(press("ArrowRight", { repeat: true }), shortcuts, {
      allowRepeat: true,
    })?.id,
    "focus-next",
  );
  assert.equal(id(press("x", { typing: true, target: undefined })), "select");
  assert.equal(
    matchShortcut(press("x"), shortcuts, { typing: true }),
    null,
    "explicit typing flag wins",
  );
  assert.equal(matchShortcut(null), null);
  assert.equal(isTypingTarget(null), false);
  assert.equal(isTypingTarget({ tagName: "input", type: "search" }), true);
  assert.equal(isTypingTarget({ tagName: "input", type: "range" }), false);
});

test("help groups split General and Actions and format the platform modifier", () => {
  const mac = shortcutGroups(shortcuts, { mac: true });
  assert.deepEqual(
    mac.map((group) => group.id),
    ["general", "actions"],
  );
  assert.deepEqual(
    mac.map((group) => group.title),
    ["General", "Actions"],
  );
  const total = mac.reduce((sum, group) => sum + group.items.length, 0);
  assert.equal(total, shortcuts.length);
  const selectAll = mac[0].items.find((item) => item.id === "select-all");
  assert.deepEqual(selectAll.keys, ["⌘", "A"]);
  const windows = shortcutGroups(shortcuts, { mac: false });
  assert.deepEqual(
    windows[0].items.find((item) => item.id === "select-all").keys,
    ["Ctrl", "A"],
  );
  assert.deepEqual(
    formatKeys({ keys: ["⇧", "Click"] }, { mac: true }),
    ["⇧", "Click"],
  );
  assert.equal(isMacPlatform({ platform: "MacIntel" }), true);
  assert.equal(isMacPlatform({ userAgent: "iPhone" }), true);
  assert.equal(isMacPlatform({ platform: "Win32", userAgent: "Windows" }), false);
  assert.equal(isMacPlatform(null), false);
});
