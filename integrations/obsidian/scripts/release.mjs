// Generates the files Obsidian's community catalogue reads from a plugin repository (the "mirror")
// and the assets attached to a release. This directory stays the source of truth; nothing is published.
// Usage: node integrations/obsidian/scripts/release.mjs <output directory>
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = process.argv[2];
if (!output) throw new Error("Usage: release.mjs <output directory>");
if (resolve(output).startsWith(root))
  throw new Error("Write the release outside the source directory.");

const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const versions = JSON.parse(readFileSync(join(root, "versions.json"), "utf8"));
const problems = [];
if (!/^\d+\.\d+\.\d+$/.test(manifest.version))
  problems.push("version must be x.y.z");
if (versions[manifest.version] !== manifest.minAppVersion)
  problems.push("versions.json must map the version to minAppVersion");
if (manifest.isDesktopOnly !== true)
  problems.push("the plugin uses Node's http module, so it is desktop only");
if (
  /obsidian/i.test(manifest.id) ||
  /obsidian/i.test(manifest.description) ||
  !manifest.description.endsWith(".")
) {
  problems.push(
    "catalogue rules: no 'obsidian' in id or description, and the description ends with a period",
  );
}
if (problems.length) throw new Error(problems.join("\n"));

rmSync(output, { recursive: true, force: true });
const copy = (files, to) => {
  mkdirSync(to, { recursive: true });
  for (const file of files) copyFileSync(join(root, file), join(to, file));
};
copy(
  ["README.md", "PROVENANCE.md", "LICENSE", "manifest.json", "versions.json"],
  join(output, "mirror"),
);
const assets = ["main.js", "manifest.json", "styles.css"];
const release = join(output, "release", manifest.version);
copy(assets, release);
writeFileSync(
  join(release, "SHA256SUMS"),
  assets
    .map(
      (file) =>
        `${createHash("sha256")
          .update(readFileSync(join(root, file)))
          .digest("hex")}  ${file}\n`,
    )
    .join(""),
);
console.log(
  `Frameleaf Images ${manifest.version}: ${join(output, "mirror")} and ${release}`,
);
