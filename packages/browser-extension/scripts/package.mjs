#!/usr/bin/env node
/**
 * FL-669: turn `dist/` into the zip the Chrome Web Store takes (`pnpm package` builds first).
 * It refuses a build the store would reject or that does not match this package's version, so the
 * zip in `release/` is always the one that was just checked. Publishing stays a manual step.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dist = join(root, "dist");
const release = join(root, "release");
const { version } = JSON.parse(
  readFileSync(join(root, "package.json"), "utf8"),
);

const fail = (message) => {
  console.error(`package: ${message}`);
  process.exit(1);
};

if (!existsSync(join(dist, "manifest.json"))) {
  fail("no dist/manifest.json; run `pnpm package`, which builds first");
}
const manifest = JSON.parse(readFileSync(join(dist, "manifest.json"), "utf8"));

if (manifest.manifest_version !== 3) {
  fail("the store only takes Manifest V3");
}
if (manifest.version !== version) {
  fail(
    `manifest version ${manifest.version} does not match package.json ${version}`,
  );
}
if (
  !/^\d+(\.\d+){0,3}$/.test(version) ||
  version.split(".").some((part) => Number(part) > 65_535)
) {
  fail(
    `${version} is not a version Chrome accepts (1 to 4 numbers, each 0 to 65535)`,
  );
}
if ("key" in manifest) {
  // a local key pins the unpacked id; the store assigns its own
  fail('remove "key" from the manifest before uploading');
}
for (const [size, file] of Object.entries(manifest.icons ?? {})) {
  if (!existsSync(join(dist, file))) {
    fail(`icon ${size} (${file}) is missing from dist`);
  }
}
if (!manifest.icons?.["128"]) {
  fail("the store needs a 128 px icon");
}
const referenced = [
  manifest.background?.service_worker,
  manifest.action?.default_popup,
  manifest.options_ui?.page,
].filter(Boolean);
for (const file of referenced) {
  if (!existsSync(join(dist, file))) {
    fail(`${file} is named in the manifest but missing from dist`);
  }
}
const stray = readdirSync(dist, { recursive: true }).filter((file) =>
  /\.map$|(^|\/)\.DS_Store$/.test(String(file)),
);
if (stray.length > 0) {
  fail(`remove these before uploading: ${stray.join(", ")}`);
}

mkdirSync(release, { recursive: true });
const zip = join(release, `save-to-frameleaf-${version}.zip`);
rmSync(zip, { force: true });
// -X leaves out extra file attributes, so the same build gives the same zip
execFileSync("zip", ["-r", "-X", "-q", zip, "."], {
  cwd: dist,
  stdio: "inherit",
});

const kb = Math.round(statSync(zip).size / 1024);
console.log(
  `package: ${zip} (${kb} KB), version ${version}, ready to upload to the Chrome Web Store`,
);
