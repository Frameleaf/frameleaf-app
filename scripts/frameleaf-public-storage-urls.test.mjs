import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  findProviderStorageUrlViolations,
  scanProviderStorageUrls,
} from "./frameleaf-public-storage-urls.mjs";

const provider = ["wasa", "bi"].join("");
const storageHost = `s3.eu-central-2.${provider}sys.test`;
const upstreamUrl = `https://${storageHost}/bucket?secret=fixture-only-secret`;
const scanner = fileURLToPath(
  new URL("./frameleaf-public-storage-urls.mjs", import.meta.url),
);

function temporaryRepository(t) {
  const root = mkdtempSync(join(tmpdir(), "frameleaf-public-storage-urls-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet", root]);
  return root;
}

test("detects provider domains across regions, test suffixes, case and URL formats", () => {
  const domains = [
    `s3.eu-central-1.${provider}sys.com`,
    storageHost,
    `s3.us-east-1.${provider}sys.net`,
    `bucket.s3.${provider}sys.co.uk`,
    `${provider}.com`,
    `docs.${provider}.com`,
    `S3.EU-CENTRAL-2.${provider.toUpperCase()}SYS.COM`,
  ];
  const text = domains
    .map((domain, index) =>
      index % 2 ? domain : `"https:\\/\\/${domain}/bucket"`,
    )
    .join("\n");
  assert.deepEqual(
    scanProviderStorageUrls(text, "fixture.json"),
    domains.map((domain, index) => ({
      file: "fixture.json",
      line: index + 1,
      domain,
    })),
  );
  assert.equal(scanProviderStorageUrls(upstreamUrl).length, 1);
  assert.equal(scanProviderStorageUrls(upstreamUrl).length, 1);
});

test("allows provider names, neutral examples and domains belonging to other hosts", () => {
  const text = [
    "Wasabi and other providers support S3-compatible storage.",
    provider,
    `${provider}sys`,
    "https://s3.eu-central-2.storage.example",
    "https://s3.eu-central-1.backup.frameleaf.cloud",
    `https://not-${provider}.com`,
    `https://${provider}.com.storage.example`,
    `https://${provider}systems.example`,
  ].join("\n");
  assert.deepEqual(scanProviderStorageUrls(text), []);
});

test("scans all tracked contents, including ignored generated and binary artifacts", (t) => {
  const root = temporaryRepository(t);
  mkdirSync(join(root, "generated"));
  writeFileSync(join(root, ".gitignore"), "generated/\n");
  const files = [
    "generated/client.js.map",
    "fixture without extension",
    "generated/binary\nfixture.bin",
  ];
  for (const file of files) {
    writeFileSync(
      join(root, file),
      Buffer.concat([Buffer.from([0]), Buffer.from(`header\n${upstreamUrl}`)]),
    );
  }
  writeFileSync(join(root, "untracked.txt"), upstreamUrl);
  execFileSync("git", ["add", "--force", "--", ".gitignore", ...files], {
    cwd: root,
  });
  assert.deepEqual(
    findProviderStorageUrlViolations(root),
    files.toSorted().map((file) => ({ file, line: 2, domain: storageHost })),
  );
});

test("scans symlink targets without following links outside the tracked tree", (t) => {
  const root = temporaryRepository(t);
  writeFileSync(join(root, "untracked.txt"), upstreamUrl);
  symlinkSync("untracked.txt", join(root, "local-link"));
  symlinkSync(upstreamUrl, join(root, "provider-link"));
  execFileSync("git", ["add", "--", "local-link", "provider-link"], {
    cwd: root,
  });
  assert.deepEqual(findProviderStorageUrlViolations(root), [
    { file: "provider-link", line: 1, domain: storageHost },
  ]);
});

test("the CLI fails on reintroduction without printing provider text or secrets", (t) => {
  const root = temporaryRepository(t);
  writeFileSync(join(root, "tracked.txt"), "Wasabi supports S3 storage.\n");
  execFileSync("git", ["add", "--", "tracked.txt"], { cwd: root });
  const run = () =>
    spawnSync(process.execPath, [scanner, root], { encoding: "utf8" });
  const clean = run();
  assert.equal(clean.status, 0, clean.stderr);
  writeFileSync(join(root, "tracked.txt"), `example\n${upstreamUrl}`);
  const failure = run();
  assert.equal(failure.status, 1, failure.stderr);
  assert.match(failure.stderr, /tracked\.txt:2:/);
  assert.match(failure.stdout, /1 provider storage URL violation/);
  assert.ok(!failure.stderr.includes(storageHost));
  assert.ok(!failure.stderr.includes("fixture-only-secret"));
});

test("the guard and its constructed regression samples do not match themselves", () => {
  for (const path of [scanner, fileURLToPath(import.meta.url)]) {
    assert.deepEqual(scanProviderStorageUrls(readFileSync(path, "utf8")), []);
  }
});
