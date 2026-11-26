"use strict";
// FL-1765: the mirror resumes, shares work between tags of one digest, and waits out a rate limit.
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const script = path.join(__dirname, "mirror-release-images.sh");
const digest = `sha256:${"a".repeat(64)}`;
const child = `sha256:${"b".repeat(64)}`;

const tool = `#!/usr/bin/env bash
state="$STATE"
echo "$(basename "$0") $*" >> "$state/calls"
args="$*"
limited() { [[ -f "$state/limit" ]] && rm "$state/limit" && { echo "TOOMANYREQUESTS: pull rate limit" >&2; exit 1; }; return 0; }
case "$(basename "$0") $1" in
  "oras login"|"cosign login") cat >/dev/null ;;
  "oras resolve")
    ref="\${@: -1}"
    if [[ "$ref" == ghcr.io/* ]]; then echo "${digest}"
    elif [[ -f "$state/tag-$(echo "$ref" | tr '/:' '__')" ]]; then echo "${digest}"
    else echo "not found" >&2; exit 1; fi ;;
  "oras manifest") echo '{"manifests":[{"digest":"${child}"}]}' ;;
  "oras cp") limited; touch "$state/tag-$(echo "\${@: -1}" | tr '/:' '__')" ;;
  "oras tag")
    repository="\${@: -2:1}"; touch "$state/tag-$(echo "\${repository%@*}:\${@: -1}" | tr '/:' '__')" ;;
  "cosign sign")
    ref="\${@: -1}"; touch "$state/signed-$(echo "\${ref%@*}" | tr '/:' '__')" ;;
  "cosign verify")
    ref="\${@: -1}"
    [[ -f "$state/signed-$(echo "\${ref%@*}" | tr '/:' '__')" ]] || { echo "no signatures found" >&2; exit 1; } ;;
esac
`;

const setup = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mirror-"));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  for (const name of ["oras", "cosign"]) {
    fs.writeFileSync(path.join(bin, name), tool, { mode: 0o755 });
  }
  return { root, bin };
};
const run = ({ root, bin }, refs) =>
  spawnSync("bash", [script, ...refs], {
    cwd: root,
    encoding: "utf8",
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      STATE: root,
      GHCR_USERNAME: "u",
      GH_PUBLISH_TOKEN: "t",
      DOCKERHUB_USERNAME: "hub",
      DOCKERHUB_TOKEN: "t",
      FORGEJO_REGISTRY: "lan:3300",
      FORGEJO_USERNAME: "u",
      FORGEJO_TOKEN: "t",
      COSIGN_PRIVATE_KEY: "k",
      COSIGN_PASSWORD: "p",
      MIRROR_RATE_LIMIT_WAIT: "0",
      MIRROR_SIGNATURE_WAIT: "0",
    },
  });
const calls = ({ root }, name) =>
  fs
    .readFileSync(path.join(root, "calls"), "utf8")
    .split("\n")
    .filter((line) => line.startsWith(name)).length;
const refs = [
  "frameleaf-server:v1",
  "frameleaf-server:release",
  "frameleaf-server:latest",
];

test("tags of one digest cost one copy and one signature per registry", () => {
  const context = setup();
  const result = run(context, refs);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(calls(context, "oras cp"), 2);
  assert.equal(calls(context, "oras tag"), 4);
  assert.equal(calls(context, "cosign sign"), 2);
  assert.equal((result.stdout.match(/\(signed\)/g) ?? []).length, 6);
});

test("a second run copies and signs nothing", () => {
  const context = setup();
  assert.equal(run(context, refs).status, 0);
  fs.rmSync(path.join(context.root, "calls"));
  const result = run(context, refs);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(calls(context, "oras cp"), 0);
  assert.equal(calls(context, "oras tag"), 0);
  assert.equal(calls(context, "cosign sign"), 0);
});

test("a rate limit is waited out instead of failing the mirror", () => {
  const context = setup();
  fs.writeFileSync(path.join(context.root, "limit"), "");
  const result = run(context, ["frameleaf-server:v1"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /rate limit/i);
  assert.equal(calls(context, "oras cp"), 3);
});
