import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { Window } from "happy-dom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { createServer } from "vite";

const root = resolve(import.meta.dirname, "..");
const window = new Window({ url: "http://localhost/?screen=review" });
const globals = {
  IS_REACT_ACT_ENVIRONMENT: true,
  window,
  document: window.document,
  location: window.location,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLDialogElement: window.HTMLDialogElement,
  Event: window.Event,
  KeyboardEvent: window.KeyboardEvent,
  MouseEvent: window.MouseEvent,
  requestAnimationFrame: (callback) => setTimeout(callback, 0),
  cancelAnimationFrame: clearTimeout,
};
for (const [name, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value,
    writable: true,
  });
}

let vite;
let HighRiskWorkflows;
let mounted;
let backCalls;

before(async () => {
  vite = await createServer({
    root,
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  ({ HighRiskWorkflows } = await vite.ssrLoadModule(
    "/src/HighRiskWorkflows.jsx",
  ));
});

beforeEach(async () => {
  backCalls = 0;
  window.document.body.innerHTML = '<div id="root"></div>';
  await act(async () => {
    mounted = createRoot(window.document.querySelector("#root"));
    mounted.render(
      React.createElement(HighRiskWorkflows, {
        back() {
          backCalls += 1;
        },
      }),
    );
  });
});

afterEach(async () => {
  await act(async () => mounted?.unmount());
  mounted = undefined;
});

after(async () => {
  await vite?.close();
  window.close();
});

const buttons = () => [...document.querySelectorAll("button")];
const button = (name) => {
  const match = buttons().find(
    (candidate) => candidate.textContent.trim() === name,
  );
  assert.ok(match, `missing button ${name}`);
  return match;
};
const click = async (name) => act(async () => button(name).click());
const flushFocus = () =>
  act(() => new Promise((resolve) => setTimeout(resolve, 0)));
const outcome = () =>
  document.querySelector(".hr-action-outcome")?.textContent.trim();
const surface = () => document.querySelector("[data-action-surface]");

test("Invite opens a focus-managed review and Cancel closes it", async () => {
  await click("Invite collaborator");
  assert.equal(outcome(), "Invite review opened. No invitation has been sent.");
  assert.equal(surface()?.dataset.actionSurface, "invite-review");
  assert.equal(surface()?.querySelectorAll("li").length, 3);
  assert.equal(
    document.activeElement.textContent.trim(),
    "Invite collaborator review",
  );
  await click("Cancel");
  assert.equal(outcome(), "Invite cancelled. Album and roles are unchanged.");
  assert.equal(surface(), null);
  await flushFocus();
  assert.equal(document.activeElement, button("Invite collaborator"));
});

test("Review changes and Retry sequences expose recoverable outcomes", async () => {
  await click("Studio");
  await click("Stale");
  await click("Review changes");
  assert.match(outcome(), /Newer changes still block overwrite/);
  assert.equal(surface()?.dataset.actionSurface, "revision-comparison");
  assert.match(
    surface().textContent,
    /revision 18.*revision 19.*Overwrite blocked/s,
  );
  await click("Close review");
  assert.equal(surface(), null);

  await click("Recovery");
  await click("Cancel / retry");
  assert.match(document.body.textContent, /1 finding was recovered/);
  assert.doesNotMatch(
    document.body.textContent,
    /previous attempt changed nothing/i,
  );
  await click("Retry unresolved 2");
  assert.equal(
    outcome(),
    "Retry review opened for 2 unchanged findings. Lake morning.mov remains recovered.",
  );
  assert.equal(surface()?.dataset.actionSurface, "recovery-retry-checkpoint");
  assert.equal(surface()?.querySelectorAll("li").length, 2);
  assert.doesNotMatch(
    [...surface().querySelectorAll("li")]
      .map((item) => item.textContent)
      .join(" "),
    /Lake morning/,
  );
  await click("Close results");
  assert.match(outcome(), /Lake morning\.mov remains recovered/);
  assert.equal(surface(), null);
  assert.equal(
    document.querySelector("[data-results-closed]")?.dataset.resultsClosed,
    "true",
  );
});

test("Keyboard state uses a real focused button for Enter and Escape", async () => {
  await click("Keyboard");
  const primary = button("Apply with Enter");
  assert.equal(document.activeElement, primary);
  assert.equal(primary.tabIndex, 0);

  await act(async () => {
    primary.dispatchEvent(
      new window.KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  assert.match(outcome(), /Keyboard action applied/);
  assert.equal(surface()?.dataset.actionSurface, "keyboard-review");
  assert.equal(
    document.activeElement.textContent.trim(),
    "Keyboard review opened",
  );

  await act(async () => {
    document.activeElement.dispatchEvent(
      new window.KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  assert.equal(
    outcome(),
    "Keyboard action cancelled. No changes were applied.",
  );
  assert.equal(surface(), null);
  await flushFocus();
  assert.equal(document.activeElement, primary);
});

test("Return performs bounded navigation and access guidance stays private", async () => {
  await click("Forbidden");
  await click("Learn about access");
  assert.equal(surface()?.dataset.actionSurface, "access-guidance");
  assert.doesNotMatch(surface().textContent, /Emma|Jamie|Taylor/);
  await click("Close review");
  assert.equal(surface(), null);
  await click("Return to library");
  assert.equal(backCalls, 1);
});

test("focus styling is limited to actual focus-visible buttons", async () => {
  const css = await readFile(
    resolve(root, "src/high-risk-workflows.css"),
    "utf8",
  );
  assert.match(css, /\.high-risk-review button:focus-visible/);
  assert.doesNotMatch(css, /\.state-keyboard .*\.primary/);
  assert.doesNotMatch(css, /\.tone-focus[^{]*{[^}]*outline/s);
});
