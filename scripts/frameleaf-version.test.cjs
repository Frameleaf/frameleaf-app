const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { setVersion, PACKAGES } = require("./frameleaf-version.cjs");

test("version preparation updates the application together, preserves import history, and detects drift", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "frameleaf-version-"));
  const write = (name, body) => {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), body);
  };
  try {
    for (const name of PACKAGES) write(name, '{\n  "version": "3.2.0"\n}\n');
    for (const name of [
      "machine-learning/pyproject.toml",
      "machine-learning/uv.lock",
    ])
      write(name, 'name = "frameleaf-ml"\nversion = "3.2.0"\n');
    write(
      "open-api/immich-openapi-specs.json",
      JSON.stringify({
        info: { title: "Frameleaf", version: "3.2.0" },
        history: "v3.2.0",
      }),
    );
    write(
      "packages/sdk/src/fetch-client.ts",
      "/**\n * Frameleaf\n * 3.2.0\n */\n",
    );
    setVersion(root, "1.0.0");
    setVersion(root, "1.0.0", true);
    assert.equal(
      fs
        .readFileSync(
          path.join(root, "open-api/immich-openapi-specs.json"),
          "utf8",
        )
        .endsWith("\n"),
      false,
      "OpenAPI bytes must match the server generator",
    );
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(root, "server/package.json")))
        .version,
      "1.0.0",
    );
    assert.equal(
      JSON.parse(
        fs.readFileSync(path.join(root, "open-api/immich-openapi-specs.json")),
      ).history,
      "v3.2.0",
    );
    setVersion(root, "1.1.0-rc.1");
    assert.match(
      fs.readFileSync(path.join(root, "machine-learning/uv.lock"), "utf8"),
      /version = "1.1.0rc1"/,
    );
    write("web/package.json", '{\n  "version": "9.0.0"\n}\n');
    assert.throws(
      () => setVersion(root, "1.1.0-rc.1", true),
      /Version drift: web\/package.json/,
    );
    for (const invalid of ["v1.0.0", "1.0", "01.0.0", "1.0.0-1", "../1.0.0"])
      assert.throws(() => setVersion(root, invalid));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
