import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (file) =>
  readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

test("Frameleaf package identities and workspace dependencies never require Immich npm packages", () => {
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: root })
    .toString()
    .split("\0");
  files.push(
    "packages/ui/package.json",
    "packages/justified-layout-wasm/package.json",
  );
  const manifests = [...new Set(files)].filter(
    (file) => file.endsWith("package.json") && !file.startsWith("mobile/"),
  );
  const names = new Set(manifests.map((file) => JSON.parse(read(file)).name));
  for (const file of manifests) {
    const pkg = JSON.parse(read(file));
    assert.doesNotMatch(pkg.name ?? "", /immich/i, file);
    for (const group of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ]) {
      for (const [name, version] of Object.entries(pkg[group] ?? {})) {
        assert.doesNotMatch(`${name} ${version}`, /@immich\//, file);
        if (version.startsWith("workspace:"))
          assert.ok(names.has(name), `${file}: missing ${name}`);
      }
    }
  }
  assert.doesNotMatch(read("pnpm-lock.yaml"), /@immich\//);
  for (const file of files.filter((file) =>
    /(?:\.github\/.*\.ya?ml|Dockerfile(?:\.dev)?|mise\.toml)$/.test(file),
  )) {
    assert.doesNotMatch(
      read(file),
      /--filter(?:=|\s+)["']?immich(?:[-.\s"']|$)/,
      file,
    );
  }
  assert.match(
    read("server/Dockerfile"),
    /COPY \.\/packages\/ui \.\/packages\/ui\//,
  );
  assert.match(
    read("server/Dockerfile"),
    /COPY \.\/packages\/justified-layout-wasm \.\/packages\/justified-layout-wasm\//,
  );
  assert.match(
    read("server/Dockerfile"),
    /pnpm --filter 'frameleaf-web\.\.\.' install --frozen-lockfile/,
  );
  assert.match(
    read("web/mise.toml"),
    /run = "pnpm install --filter 'frameleaf-web\.\.\.' --frozen-lockfile"/,
  );
  assert.match(read(".dockerignore"), /!packages\/ui\/dist\/\*\*/);
});

test("local layout payload runs without npm resolution", () => {
  execFileSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--input-type=module",
      "-e",
      `
    import assert from 'node:assert/strict';
    import { JustifiedLayout } from './packages/justified-layout-wasm/js/index.ts';
    const options = { rowWidth: 600, rowHeight: 200, spacing: 4, heightTolerance: 0.1 };
    const empty = new JustifiedLayout(new Float32Array(), options);
    assert.equal(empty.containerHeight, 0);
    const layout = new JustifiedLayout(new Float32Array([1, 1.5, 0.75]), options);
    assert.ok(layout.containerWidth > 0 && layout.containerWidth <= 600);
    assert.ok(layout.containerHeight > 0);
    for (let i = 0; i < 3; i++) {
      const box = layout.getPosition(i);
      assert.ok(Object.values(box).every(Number.isFinite));
      assert.ok(box.width > 0 && box.height > 0);
    }
  `,
    ],
    { cwd: root, stdio: "pipe" },
  );
});
