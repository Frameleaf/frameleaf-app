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

if (
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
