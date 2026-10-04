import assert from "node:assert/strict";
import { realpath, readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Inspect the real pnpm-deployed package without starting services or executing DDL. */
export async function verifyServerPackage(directory) {
  const root = await realpath(directory);
  const contained = async (file) => {
    const target = await realpath(file);
    const local = relative(root, target);
    assert(
      local !== ".." && !local.startsWith("../") && !isAbsolute(local),
      `Production dependency escapes deployed package: ${file}`,
    );
    assert((await stat(target)).isFile(), `Missing production file: ${file}`);
    return target;
  };
  for (const name of [
    "dist/main.js",
    "dist/queue/sharp-worker.js",
    "dist/queue/sharp-pool.js",
    "dist/queue/sharp-operations.js",
    "dist/queue/sharp-protocol.js",
    "dist/queue/sharp-configuration.js",
    "dist/schema/frameleaf-schema.js",
    "dist/schema/catalog-artifacts.js",
    "dist/schema/catalog-authority.js",
    "dist/schema/raw-catalog.js",
    "dist/schema/postgres-statements.js",
    "dist/schema/migrations/ORDER",
    "dist/schema/catalog/desired-schema.provenance.json",
    "dist/schema/catalog/desired-schema.catalog.json",
    "dist/schema/catalog/desired-schema.catalog.json.manifest.json",
    "dist/schema/catalog/baseline.catalog.json",
    "dist/schema/catalog/baseline.catalog.json.manifest.json",
    "dist/schema/catalog/baseline.sql",
    "dist/schema/catalog/baseline.sql.manifest.json",
  ])
    await contained(resolve(root, name));

  const require = createRequire(resolve(root, "package.json"));
  const entry = await contained(require.resolve("@frameleaf/sql-tools"));
  const sqlRoot = dirname(dirname(entry));
  const manifest = JSON.parse(
    await readFile(resolve(sqlRoot, "package.json"), "utf8"),
  );
  assert.equal(manifest.name, "@frameleaf/sql-tools");
  assert.equal(
    typeof manifest.bin?.["sql-tools"],
    "string",
    "Missing SQL-tools CLI entry",
  );
  for (const name of [
    "dist/index.d.ts",
    "dist/canonical-provider.js",
    "dist/cli.js",
    "LICENSE",
    manifest.bin["sql-tools"],
  ]) {
    await contained(resolve(sqlRoot, name));
  }
  const sqlRequire = createRequire(pathToFileURL(entry));
  for (const name of Object.keys(manifest.dependencies))
    await contained(sqlRequire.resolve(name));
  const tools = await import(pathToFileURL(entry).href);
  for (const name of [
    "createMigrationProvider",
    "schemaFromDatabase",
    "schemaDiff",
    "Column",
    "Table",
  ]) {
    assert.equal(
      typeof tools[name],
      "function",
      `Missing SQL-tools runtime export: ${name}`,
    );
  }

  // Use the compiled readers/provider: missing artifacts, digest drift, dangling
  // imports and migration ORDER mismatches must fail before an image can ship.
  const { getFrameleafSchema, getFrameleafBaselineSchema } = await import(
    pathToFileURL(resolve(root, "dist/schema/frameleaf-schema.js")).href
  );
  getFrameleafSchema();
  getFrameleafBaselineSchema();
  const { readPinnedArtifact } = await import(
    pathToFileURL(resolve(root, "dist/schema/catalog-artifacts.js")).href
  );
  readPinnedArtifact("baseline.sql");
  const folder = resolve(root, "dist/schema/migrations");
  const order = (await readFile(resolve(folder, "ORDER"), "utf8"))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const migrations = await tools
    .createMigrationProvider(folder)
    .getMigrations();
  assert.deepEqual(Object.keys(migrations), order);
  for (const migration of Object.values(migrations))
    assert.equal(typeof migration.up, "function");
  // Loads the rebuilt native addon and the standalone child's implementation.
  await import(
    pathToFileURL(resolve(root, "dist/queue/sharp-operations.js")).href
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await verifyServerPackage(process.argv[2]);
  console.log(
    "Pruned Frameleaf server dependencies, canonical artifacts and Sharp runtime verified",
  );
}
