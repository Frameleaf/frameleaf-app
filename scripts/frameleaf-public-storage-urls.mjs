#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(import.meta.dirname, "..");
const provider = ["wasa", "bi"].join("");
const providerDomain = new RegExp(
  String.raw`(?<![\w.-])(?:[\w-]+\.)*(?:${provider}sys\.[a-z0-9-]+(?:\.[a-z0-9-]+)*|${provider}\.com)(?![\w-]|\.[\w-])`,
  "gi",
);

export function scanProviderStorageUrls(text, file = "") {
  const violations = [];
  for (const [index, line] of text.split("\n").entries()) {
    for (const match of line.matchAll(providerDomain)) {
      violations.push({ file, line: index + 1, domain: match[0] });
    }
  }
  return violations;
}

export function findProviderStorageUrlViolations(root = repository) {
  const files = execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  })
    .split("\0")
    .filter(Boolean);
  const violations = [];
  for (const file of files) {
    const path = resolve(root, file);
    const stat = lstatSync(path);
    // Gitlinks have no file contents; a symlink's tracked contents are its target path.
    if (stat.isDirectory()) continue;
    const text = stat.isSymbolicLink()
      ? readlinkSync(path)
      : readFileSync(path, "utf8");
    violations.push(...scanProviderStorageUrls(text, file));
  }
  return violations;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const violations = findProviderStorageUrlViolations(process.argv[2]);
  for (const { file, line } of violations) {
    console.error(`${file}:${line}: replace the provider storage URL`);
  }
  console.log(`${violations.length} provider storage URL violation(s)`);
  process.exitCode = violations.length > 0 ? 1 : 0;
}
