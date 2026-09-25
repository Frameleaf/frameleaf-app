import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

/**
 * FL-159 (CLD-201): Frameleaf Cloud replaced the previous GPU-provider integration (owner decision
 * FL-146, 2026-09-25). Customer-facing copy says "Frameleaf Cloud" and never names the previous
 * provider or its destination kinds.
 *
 * Scope: the translation catalogue and every documentation page. Dated planning records are history
 * (ledgers, handoffs, audits, evidence and design specs of what was built at the time) and are left
 * as written: `docs/docs/developer/frameleaf-plan`, `docs/docs/developer/evidence` and
 * `docs/superpowers`.
 */
const root = resolve(import.meta.dirname, "..");
const PROVIDER = /run\s*-?\s*pod/i;
const OLD_KINDS = /["'`](?:runpod|runpod-video)["'`]/;
const HISTORY = [
  "docs/docs/developer/frameleaf-plan/",
  "docs/docs/developer/evidence/",
  "docs/superpowers/",
];

const trackedDocs = () =>
  execFileSync("git", ["ls-files", "docs"], { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((path) => /\.(mdx?|json|ts|tsx|js|css)$/.test(path))
    .filter((path) => !HISTORY.some((prefix) => path.startsWith(prefix)));

/** Every string of the catalogue with its dotted key, including nested groups such as `admin`. */
const flatten = (value, prefix = "") =>
  Object.entries(value).flatMap(([key, child]) =>
    child !== null && typeof child === "object"
      ? flatten(child, `${prefix}${key}.`)
      : [[`${prefix}${key}`, child]],
  );

test("the translation catalogue never names the previous cloud provider", () => {
  const catalogue = JSON.parse(
    readFileSync(resolve(root, "i18n/en.json"), "utf8"),
  );
  const hits = flatten(catalogue).filter(
    ([key, value]) =>
      PROVIDER.test(key) ||
      PROVIDER.test(String(value)) ||
      OLD_KINDS.test(String(value)),
  );
  assert.deepEqual(hits, []);
});

test("the translation catalogue stays sorted", () => {
  const keys = Object.keys(
    JSON.parse(readFileSync(resolve(root, "i18n/en.json"), "utf8")),
  );
  assert.deepEqual(keys, keys.toSorted());
});

test("documentation never names the previous cloud provider or its destination kinds", () => {
  const hits = trackedDocs().flatMap((path) =>
    readFileSync(resolve(root, path), "utf8")
      .split("\n")
      .map((line, index) => ({ path, line: index + 1, text: line }))
      .filter(({ text }) => PROVIDER.test(text) || OLD_KINDS.test(text)),
  );
  assert.deepEqual(hits, []);
});

// FL-153 (CLD-000) naming rule: the Frameleaf Cloud documents never name the previous GPU-provider
// integration. They refer to it generically ("the previous GPU-provider integration") and locate it
// through the two destination kinds in `CLOUD_ML_DESTINATION_KINDS`, never by provider name or by
// provider-named identifiers.
const documents = [
  "docs/docs/developer/frameleaf-plan/15-frameleaf-cloud-integration.md",
  "docs/superpowers/specs/2026-09-24-frameleaf-cloud-design.md",
];
// Matches the provider name in any case or spacing, including identifiers built on it.
const providerName = /run[\s_-]*pod/i;

export const findProviderNames = (text) =>
  text
    .split("\n")
    .map((line, index) => ({ line: index + 1, text: line }))
    .filter(({ text: line }) => providerName.test(line));

test("the Frameleaf Cloud documents never name the previous GPU provider", async () => {
  for (const document of documents) {
    const text = await readFile(resolve(root, document), "utf8");
    const hits = findProviderNames(text);
    assert.deepEqual(
      hits,
      [],
      `${document} names the previous GPU provider on line(s) ${hits.map(({ line }) => line).join(", ")}`,
    );
  }
});

test("the naming check catches the provider name and provider-named identifiers", () => {
  for (const sample of [
    "Frameleaf Cloud replaces RunPod",
    "delete `runpod.service.ts`",
    "`MlDestinationKind.RunPodVideo`",
    "remove `machineLearning.runpod`",
    "run pod",
    "RUN_POD_API_KEY",
  ]) {
    assert.equal(findProviderNames(sample).length, 1, sample);
  }
  assert.deepEqual(
    findProviderNames(
      "the previous GPU-provider integration (`CLOUD_ML_DESTINATION_KINDS`)",
    ),
    [],
  );
});
