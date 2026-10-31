// Adds replayed Immich 2.x releases to the importer's frozen fixtures (run.sh calls this).
// Usage: node generate.mjs <replay output dir> <repo root> <tag...>
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
const [out, root, ...tags] = process.argv.slice(2);
const fixtures = `${root}/server/src/immich-import/fixtures`;
const adapters = readFileSync(
  `${root}/server/src/immich-import/adapters.ts`,
  "utf8",
);
const CONTENT = [
  ...adapters.match(/CONTENT_TABLES = \[([\s\S]*?)\]/)[1].matchAll(/'(\w+)'/g),
].map((m) => m[1]);
const canonical = (value) =>
  JSON.stringify(value, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => a.localeCompare(b)),
        )
      : v,
  );
const sha = (value) =>
  createHash("sha256").update(canonical(value)).digest("hex");
const frozen = JSON.parse(
  readFileSync(`${fixtures}/frozen-sources.json`, "utf8"),
);
const legacy = { provenance: "", releases: {} };
const seen = new Map();
for (const tag of tags) {
  const replay = JSON.parse(readFileSync(`${out}/${tag}.json`, "utf8"));
  const version = tag.replace(/^v/, "");
  const raw = Object.fromEntries(
    CONTENT.filter((table) => replay.structure[table]).map((table) => [
      table,
      replay.structure[table],
    ]),
  );
  const shapeKey = sha(raw);
  if (!seen.has(shapeKey)) {
    seen.set(shapeKey, version);
    legacy.releases[version] = {
      tables: raw,
      constraints: [],
      uniqueIndexes: [],
      enums: [],
    };
  }
  // Rows are read through views that emit the 3.0.0 columns; adapters skip tables the release lacks.
  const schema = frozen.versions["3.0.0"].schema;
  const migrations = sha(replay.migrations);
  frozen.migrations[migrations] = replay.migrations;
  frozen.versions[version] = {
    commit: execFileSync("git", ["-C", root, "rev-parse", `${tag}^{commit}`], {
      encoding: "utf8",
    }).trim(),
    schema,
    migrations,
    structure: seen.get(shapeKey),
  };
}
legacy.provenance =
  "Content-table catalogs of each Immich 2.x tag, captured by replaying that tag's own server/src/schema/migrations into an empty PostgreSQL database (scripts/immich-import-replay). 2.x sources are admitted by readable-column checks, not exact catalog equality.";
frozen.versions = Object.fromEntries(
  Object.entries(frozen.versions).sort(([a], [b]) =>
    a.localeCompare(b, undefined, { numeric: true }),
  ),
);
writeFileSync(
  `${fixtures}/frozen-sources.json`,
  JSON.stringify(frozen, null, 2) + "\n",
);
writeFileSync(
  `${fixtures}/structure/2.x.json`,
  JSON.stringify(legacy, null, 2) + "\n",
);
console.log(
  "structures",
  [...seen.values()].join(" "),
  "| versions",
  Object.keys(frozen.versions).length,
);
