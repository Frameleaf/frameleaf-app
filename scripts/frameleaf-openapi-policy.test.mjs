import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const oasdiffImage = process.env.OASDIFF_IMAGE ?? "tufin/oasdiff:v1.31.0";

// Hosted-only: CI supplies its fixed mirror; local invocation keeps the existing oasdiff version.
test("SDK operation renames and omissions fail while additive endpoints pass", () => {
  const fixtures = mkdtempSync(
    path.join(tmpdir(), "frameleaf-openapi-policy-"),
  );
  const base = {
    openapi: "3.0.3",
    info: { title: "SDK compatibility fixture", version: "1.0.0" },
    paths: {
      "/assets": {
        get: {
          operationId: "getAssets",
          responses: { 200: { description: "OK" } },
        },
      },
    },
  };
  const renamed = structuredClone(base);
  renamed.paths["/assets"].get.operationId = "listAssets";
  const omitted = structuredClone(base);
  delete omitted.paths["/assets"].get.operationId;
  const additive = structuredClone(base);
  additive.paths["/assets/count"] = {
    get: {
      operationId: "countAssets",
      responses: { 200: { description: "OK" } },
    },
  };
  try {
    for (const [name, spec] of Object.entries({
      base,
      renamed,
      omitted,
      additive,
    })) {
      writeFileSync(path.join(fixtures, `${name}.json`), JSON.stringify(spec));
    }
    for (const [revision, policy, expected] of [
      ["renamed", false, 0],
      ["renamed", true, 1],
      ["omitted", true, 1],
      ["additive", true, 0],
    ]) {
      const result = spawnSync(
        "docker",
        [
          "run",
          "--rm",
          "--network",
          "none",
          "-e",
          "OASDIFF_INTERNAL=1",
          "-v",
          `${root}:/workspace:ro`,
          "-v",
          `${fixtures}:/fixtures:ro`,
          "-w",
          policy ? "/workspace" : "/fixtures",
          oasdiffImage,
          "breaking",
          "--format",
          "json",
          "--fail-on",
          "ERR",
          "/fixtures/base.json",
          `/fixtures/${revision}.json`,
        ],
        { encoding: "utf8", timeout: 120_000 },
      );
      assert.ifError(result.error);
      assert.equal(
        result.status,
        expected,
        `${revision} (policy=${policy}): ${result.stderr}\n${result.stdout}`,
      );
      if (expected === 1) {
        assert.match(result.stdout, /"id":\s*"api-operation-id-removed"/u);
      }
    }
  } finally {
    rmSync(fixtures, { recursive: true, force: true });
  }
});
