import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const FREECUT_COMMIT = "4d62e8082c5eb387a96275bcbd323d28f6e41a62";
const FREECUT_ARCHIVE_URL =
  "https://codeload.github.com/walterlow/freecut/tar.gz/4d62e8082c5eb387a96275bcbd323d28f6e41a62";
const FREECUT_ARCHIVE_SHA256 =
  "b4224e5c219a6302586cbe2242e9e6d299dfd1878f1fcd0f2d77ea3db12a5d32";
const FREECUT_LEDGER_SHA256 =
  "a56d57c4bcd2c996c389bb7470216b185caa28de389def109bf4d86fd95e3adb";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function parseJsonRejectingDuplicateKeys(text, source = "JSON input") {
  let index = 0;
  const fail = (message) => {
    throw new SyntaxError(`${source}: ${message} at byte ${index}`);
  };
  const whitespace = () => {
    while (/\s/.test(text[index] ?? "")) index++;
  };
  const string = () => {
    if (text[index] !== '"') fail("expected string");
    const start = index++;
    while (index < text.length) {
      if (text[index] === "\\") {
        index += 2;
      } else if (text[index++] === '"') {
        return JSON.parse(text.slice(start, index));
      }
    }
    fail("unterminated string");
  };
  const value = () => {
    whitespace();
    if (text[index] === "{") {
      index++;
      whitespace();
      const keys = new Set();
      if (text[index] === "}") {
        index++;
        return;
      }
      while (index < text.length) {
        const key = string();
        if (keys.has(key)) fail(`duplicate object key ${JSON.stringify(key)}`);
        keys.add(key);
        whitespace();
        if (text[index++] !== ":") fail("expected colon");
        value();
        whitespace();
        const delimiter = text[index++];
        if (delimiter === "}") return;
        if (delimiter !== ",") fail("expected object delimiter");
        whitespace();
      }
      fail("unterminated object");
    }
    if (text[index] === "[") {
      index++;
      whitespace();
      if (text[index] === "]") {
        index++;
        return;
      }
      while (index < text.length) {
        value();
        whitespace();
        const delimiter = text[index++];
        if (delimiter === "]") return;
        if (delimiter !== ",") fail("expected array delimiter");
      }
      fail("unterminated array");
    }
    if (text[index] === '"') {
      string();
      return;
    }
    for (const literal of ["true", "false", "null"]) {
      if (text.startsWith(literal, index)) {
        index += literal.length;
        return;
      }
    }
    const number = text
      .slice(index)
      .match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u)?.[0];
    if (!number) fail("expected value");
    index += number.length;
  };
  value();
  whitespace();
  if (index !== text.length) fail("unexpected trailing content");
  return JSON.parse(text);
}

export function assertPinnedSource(provenance) {
  assert.equal(provenance.commit, FREECUT_COMMIT);
  assert.equal(provenance.repository, "https://github.com/walterlow/freecut");
  assert.equal(provenance.archiveUrl, FREECUT_ARCHIVE_URL);
  assert.equal(provenance.archiveSha256, FREECUT_ARCHIVE_SHA256);
  assert.equal(provenance.orderedFilesSha256, FREECUT_LEDGER_SHA256);
  assert.equal(provenance.license, "MIT");
  assert.equal(provenance.licensePath, "vendor/freecut/LICENSE");
  assert.deepEqual(provenance.modifications, []);
  assert.equal(provenance.files.length, 2646);
  assert.equal(new Set(provenance.files.map(({ path }) => path)).size, 2646);
  assert.ok(
    provenance.files.every(
      ({ path, sha256 }) =>
        typeof path === "string" &&
        !path.startsWith("/") &&
        !path.split("/").includes("..") &&
        /^[a-f0-9]{64}$/.test(sha256),
    ),
  );
  for (const row of provenance.files) {
    assert.deepEqual(Object.keys(row).sort(), ["path", "sha256"]);
  }
  assert.equal(digest(JSON.stringify(provenance.files)), FREECUT_LEDGER_SHA256);
}
