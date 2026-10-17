/** Bounded real native pointer/keyboard join witness; fixture APIs arrange and observe only. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { inventory } from "./engine.mjs";
import { createHarness } from "./lib/cross-browser-harness.mjs";
const engineDirectory = new URL("../engine/", import.meta.url).pathname;
const source = JSON.parse(
  await readFile(
    new URL("../engine/frameleaf-source.json", import.meta.url),
    "utf8",
  ),
);
const configuration = JSON.parse(
  await readFile(new URL("../engine-build.json", import.meta.url), "utf8"),
);
assert.equal(source.sourceSha256, configuration.sourceSha256);
assert.deepEqual(
  await inventory(
    engineDirectory,
    "",
    new Set([
      "node_modules",
      "dist",
      "frameleaf-source.json",
      "frameleaf-build.json",
    ]),
  ),
  source.files,
);
const sourceBinding = {
  sourceSha256: source.sourceSha256,
  patches: source.patches.length,
  files: source.files.length,
  upstreamCommit: source.upstreamCommit,
};
const require = createRequire(
  new URL("../engine/package.json", import.meta.url),
);
const { chromium } = require("playwright");
const origin = process.env.STUDIO_TEST_ORIGIN ?? "http://127.0.0.1:5299";
assert.equal(new URL(origin).hostname, "127.0.0.1");
const evidence = process.env.STUDIO_TEST_EVIDENCE;
assert(
  evidence,
  "STUDIO_TEST_EVIDENCE must identify an owned evidence directory",
);
const harness = createHarness({ upstream: origin, inspectConnect: true });
let browser;
const witnesses = [];
try {
  const proxy = await harness.listen();
  browser = await chromium.launch({
    headless: true,
    proxy: { server: proxy },
    args: ["--proxy-bypass-list=<-loopback>"],
  });
  const page = await (
    await browser.newContext({ serviceWorkers: "block" })
  ).newPage();
  const url = `${origin}/studio-engine/test/editor-controls.browser.html`;
  await page.goto(url);
  await page.waitForFunction(() => !!window.fl100Editor);
  const state = () => page.evaluate(() => window.fl100Editor.state());
  for (const legacy of [false, true]) {
    await page.evaluate(
      (legacy) => window.fl100Editor.seedLinkedChain(legacy),
      legacy,
    );
    const initial = await state();
    assert.equal(initial.items.length, 6);
    await page
      .getByRole("button", { name: "Disable Linked Selection", exact: true })
      .click();
    assert.equal((await state()).linkedSelectionEnabled, false);
    for (const index of [2, 0, 1]) {
      await page
        .locator(`[data-item-id="chain-v-${index}"]`)
        .click({ modifiers: index === 2 ? [] : ["Meta"] });
    }
    const selected = await state();
    assert.deepEqual([...selected.selectedItemIds].sort(), [
      "chain-v-0",
      "chain-v-1",
      "chain-v-2",
    ]);
    await page
      .getByRole("button", { name: "Enable Linked Selection", exact: true })
      .click();
    assert.equal((await state()).linkedSelectionEnabled, true);
    await page.keyboard.press("Shift+j");
    const joined = await state();
    await mkdir(evidence, { recursive: true });
    await writeFile(
      path.join(
        evidence,
        `join-attempt-${legacy ? "legacy" : "explicit"}.json`,
      ),
      JSON.stringify(
        {
          sourceBinding,
          initial,
          selected,
          joined,
          requests: harness.observations,
        },
        null,
        2,
      ),
    );
    assert.equal(
      joined.items.length,
      2,
      "native Join Selected must join the complete A/V chain",
    );
    assert.equal(joined.undoCount, 1);
    for (const item of joined.items) {
      assert.equal(item.durationInFrames, 90);
      assert.equal(item.sourceStart, 0);
      assert.equal(item.sourceEnd, 72);
      assert.equal(item.linkedGroupId, legacy ? undefined : "chain-g-0");
    }
    const modifier = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.press(`${modifier}+z`);
    assert.deepEqual((await state()).items, initial.items);
    await page.keyboard.press(`${modifier}+Shift+z`);
    assert.deepEqual((await state()).items, joined.items);
    witnesses.push({
      legacy,
      initial,
      selected,
      joined,
      redone: await state(),
      userAgent: await page.evaluate(() => navigator.userAgent),
    });
  }
  await mkdir(evidence, { recursive: true });
  await page.screenshot({
    path: path.join(evidence, "native-chain-joined.png"),
  });
  assert(
    harness.observations.some(
      (entry) => entry.kind === "proxied" && entry.url === url,
    ),
    "actual entry GET must traverse the fence",
  );
  await writeFile(
    path.join(evidence, "observation.json"),
    JSON.stringify(
      { sourceBinding, witnesses, requests: harness.observations },
      null,
      2,
    ),
  );
  assert(
    !harness.observations.some(
      (entry) =>
        entry.kind === "tunnelled" ||
        (entry.kind === "error" &&
          !(
            entry.upgradeProtocol === "vite-hmr" &&
            new URL(entry.url).origin === origin
          )),
    ),
  );
  console.log(
    "PASS native off → pointer select three → on → Shift+J → keyboard undo/redo; one history entry",
  );
} finally {
  await browser?.close();
  await harness.close();
}
