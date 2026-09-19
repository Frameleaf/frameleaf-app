import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
    /^(?:compose kill -s SIGKILL fork-server|interrupt_fork)\nstart_fork$/gm,
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
