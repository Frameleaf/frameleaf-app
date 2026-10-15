const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const {
  mkdtempSync,
  readFileSync,
  existsSync,
  writeFileSync,
  rmSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");
const { buildSync } = require("esbuild");

const code = buildSync({
  entryPoints: [require.resolve("../src/cli.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  write: false,
  tsconfig: require.resolve("../tsconfig.json"),
}).outputFiles[0].text;
const prepare = (t, args, manifest = { methods: [{ name: "inspect" }] }) => {
  const cwd = mkdtempSync(join(tmpdir(), "frameleaf-plugin-sdk-test-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(join(cwd, "manifest.json"), JSON.stringify(manifest));
  const cli = join(cwd, "cli.cjs");
  writeFileSync(cli, code);
  const result = spawnSync(process.execPath, [cli, "prepareBuild", ...args], {
    cwd,
    encoding: "utf8",
  });
  return { cwd, result };
};

for (const args of [
  [],
  ["--output", "nested/custom.d.ts"],
  ["-o", "nested/custom.d.ts"],
]) {
  test(`generates declarations with ${args.join(" ") || "the default output"}`, (t) => {
    const { cwd, result } = prepare(t, args);
    assert.equal(result.status, 0, result.stderr);
    const output = args.length ? "nested/custom.d.ts" : "dist/index.d.ts";
    const declarations = readFileSync(join(cwd, output), "utf8");
    assert.match(declarations, /export function inspect\(\): I32;/);
    assert.match(declarations, /declare module 'extism:host'/);
    assert.match(declarations, /export type Manifest =/);
    if (args.length)
      assert.equal(existsSync(join(cwd, "dist/index.d.ts")), false);
  });
}

test("rejects a malformed manifest before creating declarations", (t) => {
  const { cwd, result } = prepare(t, [], { methods: null });
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(join(cwd, "dist/index.d.ts")), false);
});

test("accepts a manifest with omitted methods, matching the server manifest default", (t) => {
  const { cwd, result } = prepare(t, [], { templates: [] });
  assert.equal(result.status, 0, result.stderr);
  const declarations = readFileSync(join(cwd, "dist/index.d.ts"), "utf8");
  assert.match(declarations, /declare module 'main' \{\s*\}/);
  assert.match(declarations, /export type Manifest =/);
});
