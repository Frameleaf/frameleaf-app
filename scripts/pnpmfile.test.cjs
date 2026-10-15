const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { runInNewContext } = require("node:vm");
const test = require("node:test");

const source = readFileSync(require.resolve("../.pnpmfile.cjs"), "utf8");
const hookFor = (platform) => {
  const module = { exports: {} };
  runInNewContext(source, { module, process: { platform } });
  return module.exports.hooks.readPackage;
};

for (const platform of ["win32", "linux", "darwin"]) {
  test(`promotes only the platform's exiftool binary on ${platform}`, () => {
    const binary =
      platform === "win32" ? "exiftool-vendored.exe" : "exiftool-vendored.pl";
    const other =
      platform === "win32" ? "exiftool-vendored.pl" : "exiftool-vendored.exe";
    const pkg = {
      name: "exiftool-vendored",
      dependencies: { kept: "1.0.0" },
      optionalDependencies: { [binary]: "2.0.0", [other]: "3.0.0" },
    };
    const hook = hookFor(platform);
    assert.equal(hook(pkg), pkg);
    assert.deepEqual(pkg.dependencies, { kept: "1.0.0", [binary]: "2.0.0" });
    assert.deepEqual(pkg.optionalDependencies, { [other]: "3.0.0" });
    assert.equal(hook(pkg), pkg);
  });
}

test("accepts manifests without optional dependencies", () => {
  const pkg = { name: "exiftool-vendored" };
  assert.equal(hookFor("linux")(pkg), pkg);
  assert.deepEqual(pkg, { name: "exiftool-vendored" });
});

test("initializes regular dependencies when promoting a binary", () => {
  const pkg = {
    name: "exiftool-vendored",
    optionalDependencies: { "exiftool-vendored.pl": "2.0.0" },
  };
  hookFor("linux")(pkg);
  assert.equal(pkg.dependencies["exiftool-vendored.pl"], "2.0.0");
  assert.deepEqual(pkg.optionalDependencies, {});
});

test("leaves unrelated and unnamed manifests untouched", () => {
  const hook = hookFor("linux");
  for (const pkg of [
    {},
    {
      name: "other",
      optionalDependencies: { "exiftool-vendored.pl": "2.0.0" },
    },
  ]) {
    const before = JSON.stringify(pkg);
    assert.equal(hook(pkg), pkg);
    assert.equal(JSON.stringify(pkg), before);
  }
});
