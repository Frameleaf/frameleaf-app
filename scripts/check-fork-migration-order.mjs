import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Upstream timestamps precede the fork's reserved 2100 timestamps. Preserve
// append-only history within each authority without renumbering either side.
export function checkOrder(base, current, upstream) {
  for (const official of [true, false]) {
    const belongs = (name) => upstream.has(name) === official;
    const before = base.filter(belongs);
    const after = current.filter(belongs);
    assert.deepEqual(
      after.slice(0, before.length),
      before,
      `${official ? "Upstream" : "Fork"} migration history must be append-only`,
    );
  }
}

/**
 * FL-156: the fork-schema migration manifest
 * (`server/src/fork-schema/manifests/fork-migration-order.json`) is append-only: the base's list must
 * be a prefix of the head's (checked with `checkOrder`, everything in the fork authority), and the
 * head's list must be strictly ascending, so a new fork migration always sorts after every released
 * one (Kysely runs fork migrations in ordered mode).
 */
export function checkForkManifest(base, current) {
  checkOrder(base, current, new Set());
  for (let index = 1; index < current.length; index++) {
    assert.ok(
      current[index] > current[index - 1],
      `Fork migration ${current[index]} must sort after ${current[index - 1]}`,
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href &&
  process.argv[2] === "--fork-manifest"
) {
  // A base without the manifest (before it existed) has released nothing it lists.
  const migrations = (path) => {
    try {
      return JSON.parse(readFileSync(path, "utf8")).migrations;
    } catch (error) {
      if (error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  };
  checkForkManifest(migrations(process.argv[3]), migrations(process.argv[4]));
} else if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const read = (path) => readFileSync(path, "utf8").trim().split(/\r?\n/);
  const manifest = JSON.parse(
    readFileSync(
      new URL(
        "../server/src/fork-schema/supported-versions.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  checkOrder(
    read(process.argv[2]),
    read(process.argv[3]),
    new Set(manifest.upstreamMigrations),
  );
}
