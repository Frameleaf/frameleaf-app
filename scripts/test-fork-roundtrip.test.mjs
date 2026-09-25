import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const source = readFileSync(
  new URL("./test-fork-roundtrip.sh", import.meta.url),
  "utf8",
);
const start = source.match(/^start_fork\(\) \{[\s\S]*?^\}/m)?.[0];
const interrupt = source.match(/^interrupt_fork\(\) \{[\s\S]*?^\}/m)?.[0] ?? "";
const checkpoints = [
  ...source.matchAll(
    /^[ \t]*(?:compose kill -s SIGKILL fork-server|interrupt_fork)\n[ \t]*start_fork$/gm,
  ),
];
assert.ok(start, "startup helper is present");
assert.equal(
  checkpoints.length,
  2,
  "both durable interruption checkpoints are covered",
);

function run(checkpoint, failure = "") {
  return spawnSync(
    "bash",
    [
      "-c",
      `
set -Eeuo pipefail
exited=false
started=false
compose() {
  case "$*" in
    'ps -a -q fork-server') echo original-container ;;
    'kill -s SIGKILL fork-server')
      echo kill >&2
      [[ "$FAILURE" != kill ]] || return 23
      # The kill request returned, but the daemon still reports the old process running.
      ;;
    'up -d fork-server')
      echo up >&2
      if [[ "$exited" == true ]]; then started=true; fi
      ;;
    *) return 90 ;;
  esac
}
docker() {
  [[ "$*" == 'wait original-container' ]] || return 91
  echo wait >&2
  [[ "$FAILURE" != wait ]] || return 24
  exited=true
  echo 137
}
wait_healthy() {
  echo health >&2
  [[ "$started" == true ]] || return 33
}
${start}
${interrupt}
${checkpoint}
`,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, FAILURE: failure },
      timeout: 5000,
    },
  );
}

for (const [index, checkpoint] of checkpoints.entries()) {
  test(`interruption ${index + 1} waits for daemon exit before starting again`, () => {
    const result = run(checkpoint[0]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "kill\nwait\nup\nhealth\n");
  });
}

for (const [failure, status, output] of [
  ["kill", 23, "kill\n"],
  ["wait", 24, "kill\nwait\n"],
]) {
  test(`does not restart when ${failure} fails`, () => {
    const result = run(checkpoints[0][0], failure);
    assert.equal(result.status, status, result.stderr);
    assert.equal(result.stderr, output);
  });
}

const pulls = source.match(/^pulled=false[\s\S]*?(?=^official_digest=)/m)?.[0];
assert.ok(pulls, "image pulls finish before official digest verification");

for (const [failures, attempts, status] of [
  [0, 1, 0],
  [2, 3, 0],
  [5, 5, 1],
]) {
  test(`pulls all remote services with ${failures} transient failures`, () => {
    const result = spawnSync(
      "bash",
      [
        "-c",
        `
set -Eeuo pipefail
attempts=0
compose() {
  [[ "$*" == 'pull official-server database redis' ]] || return 90
  attempts=$((attempts + 1))
  echo "pull $attempts"
  [[ "$attempts" -gt "$FAILURES" ]]
}
docker() { echo 'unguarded direct pull'; return 91; }
sleep() { echo "sleep $1"; }
${pulls}
echo ready
`,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          FAILURES: String(failures),
          OFFICIAL_IMMICH_TAG: "v3.1.0",
        },
        timeout: 5000,
      },
    );
    assert.equal(result.status, status, result.stderr);
    assert.deepEqual(
      result.stdout.match(/^pull \d+$/gm),
      Array.from({ length: attempts }, (_, index) => `pull ${index + 1}`),
    );
    assert.deepEqual(
      result.stdout.match(/^sleep \d+$/gm) ?? [],
      Array.from(
        { length: attempts - 1 },
        (_, index) => `sleep ${(index + 1) * 15}`,
      ),
    );
    assert.equal(result.stdout.includes("ready"), status === 0);
  });
}

// FL-44 (FN-304): the proof records the exact candidate commit and image and the certified official image.
const functionSource = (name) => {
  const body = source.match(
    new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, "m"),
  )?.[0];
  assert.ok(body, `${name} is present`);
  return body;
};
const evidenceFunctions = [
  "resolve_candidate_commit",
  "resolve_candidate_image",
  "write_evidence",
]
  .map(functionSource)
  .join("\n");
const sha = "0123456789abcdef0123456789abcdef01234567";
const imageId = `sha256:${"a".repeat(64)}`;

function evidence({
  dirtyTree = "",
  allowDirty = "",
  revision = sha,
  id = imageId,
  gitFails = false,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fork-roundtrip-evidence-"));
  const result = spawnSync(
    "bash",
    [
      "-c",
      `
set -Eeuo pipefail
ROOT=/repo
EVIDENCE_DIR="$DIR"
EVIDENCE_FILE="$DIR/fork-roundtrip-chained.json"
CANDIDATE_IMAGE='immich-fork-roundtrip:local'
selected_lane=chained
OFFICIAL_IMMICH_TAG=v3.1.0
official_digest="ghcr.io/immich-app/immich-server@sha256:${"b".repeat(64)}"
official_image_id="sha256:${"c".repeat(64)}"
official_architecture=amd64
expected_official_core_digest="${"d".repeat(64)}"
git() {
  [[ "$GIT_FAILS" != true ]] || return 128
  case "$*" in
    '-C /repo rev-parse --verify HEAD') echo ${sha} ;;
    "-C /repo status --porcelain -- . :(exclude).cache") printf '%s' "$DIRTY_TREE" ;;
    *) echo "unexpected git $*" >&2; return 90 ;;
  esac
}
docker() {
  case "$*" in
    *'{{.Id}}'*) echo "$IMAGE_ID" ;;
    *'org.opencontainers.image.revision'*) echo "$REVISION" ;;
    *'{{json .RepoDigests}}'*) echo '[]' ;;
    *) echo "unexpected docker $*" >&2; return 91 ;;
  esac
}
${evidenceFunctions}
resolve_candidate_commit
resolve_candidate_image
write_evidence passed
cat "$EVIDENCE_FILE"
`,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        DIR: dir,
        DIRTY_TREE: dirtyTree,
        FORK_ROUNDTRIP_ALLOW_DIRTY: allowDirty,
        GIT_FAILS: String(gitFails),
        IMAGE_ID: id,
        REVISION: revision,
      },
      timeout: 5000,
    },
  );
  rmSync(dir, { recursive: true, force: true });
  return result;
}

test("records the clean candidate commit, its image and the certified official image", () => {
  const result = evidence();
  assert.equal(result.status, 0, result.stderr);
  const recorded = JSON.parse(result.stdout.slice(result.stdout.indexOf("{")));
  assert.equal(recorded.status, "passed");
  assert.deepEqual(recorded.candidate, {
    commit: sha,
    dirty: false,
    image: "immich-fork-roundtrip:local",
    imageId,
    repoDigests: [],
  });
  assert.equal(recorded.official.tag, "v3.1.0");
  assert.match(
    recorded.official.repoDigest,
    /^ghcr\.io\/immich-app\/immich-server@sha256:[0-9a-f]{64}$/,
  );
  assert.match(recorded.official.imageId, /^sha256:[0-9a-f]{64}$/);
});

test("refuses a dirty candidate tree unless explicitly allowed, and then records it as dirty", () => {
  const refused = evidence({ dirtyTree: " M server/src/main.ts\n" });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /uncommitted changes/);

  const allowed = evidence({
    dirtyTree: " M server/src/main.ts\n",
    allowDirty: "true",
  });
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(
    JSON.parse(allowed.stdout.slice(allowed.stdout.indexOf("{"))).candidate
      .dirty,
    true,
  );
});

test("fails when the candidate commit cannot be determined", () => {
  const result = evidence({ gitFails: true });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Cannot determine the candidate git commit/);
});

test("fails when the built image is not the candidate's or has no image id", () => {
  const other = evidence({ revision: "f".repeat(40) });
  assert.notEqual(other.status, 0);
  assert.match(other.stderr, /not 0123456789abcdef/);

  const missing = evidence({ id: "" });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /Candidate image id is not a digest/);
});

test("the chained lane resets its volumes once and runs every leg on them", () => {
  const chained = source.match(
    /^if \[\[ "\$selected_lane" == all \|\| "\$selected_lane" == official-v3\.1\.0-to-fork-to-official-v3\.1\.0-to-fork \]\]; then[\s\S]*?^fi$/m,
  )?.[0];
  assert.ok(chained, "chained lane is present");
  assert.equal(chained.match(/^reset_lane$/gm)?.length, 1);
  const order = [
    "phase origin-seed",
    "phase chain-fork-seed",
    "handoff_to_official",
    "phase chain-official",
    "return_to_fork",
    "phase chain-fork-return",
  ].map((step) => chained.indexOf(step));
  assert.ok(
    order.every((index) => index >= 0),
    `every leg runs: ${order}`,
  );
  assert.deepEqual(
    [...order].sort((a, b) => a - b),
    order,
  );
});
