import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// FL-153 (CLD-000) naming rule: the Frameleaf Cloud documents never name the previous GPU-provider
// integration. They refer to it generically ("the previous GPU-provider integration") and locate it
// through the two destination kinds in `CLOUD_ML_DESTINATION_KINDS`, never by provider name or by
// provider-named identifiers.
const repository = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
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
    const text = await readFile(path.join(repository, document), "utf8");
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
