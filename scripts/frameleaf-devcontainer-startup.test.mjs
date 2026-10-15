import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function startup(kind, failure, missingDirectory = false) {
  const directory = mkdtempSync(join(tmpdir(), "frameleaf-startup-"));
  try {
    const bin = join(directory, "bin");
    mkdirSync(bin);
    for (const folder of ["server", "web"]) {
      if (!missingDirectory) mkdirSync(join(directory, folder));
    }
    const commands = join(directory, "commands");
    writeFileSync(commands, "");
    writeFileSync(
      join(bin, "pnpm"),
      `#!/bin/bash
printf '%s\\n' "$*" >> "$TEST_COMMAND_LOG"
count=$(wc -l < "$TEST_COMMAND_LOG")
if [ "$count" -eq "$TEST_FAILURE" ]; then exit 17; fi
case "$*" in *exec*) kill -TERM "$PPID"; exit 23;; esac
`,
      { mode: 0o755 },
    );
    writeFileSync(join(bin, "curl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    // Substitute only the container mount and common adapter; package/network operations stay stubbed.
    const common = join(directory, "common.sh");
    writeFileSync(
      common,
      `export IMMICH_WORKSPACE="$TEST_WORKSPACE"\nlog() { :; }\nrun_cmd() { "$@"; }\n`,
    );
    const source = readFileSync(
      join(root, `.devcontainer/server/container-start-${kind}.sh`),
      "utf8",
    ).replace(
      "source /immich-devcontainer/container-common.sh",
      'source "$TEST_COMMON"',
    );
    const result = spawnSync("bash", ["-c", source], {
      encoding: "utf8",
      timeout: 3000,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        TEST_COMMON: common,
        TEST_WORKSPACE: directory,
        TEST_COMMAND_LOG: commands,
        TEST_FAILURE: String(failure),
      },
    });
    assert.equal(result.error, undefined);
    return {
      result,
      commands: readFileSync(commands, "utf8").trim().split("\n"),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

// shortcut: handles whole-line comments; use a JSONC parser if the fixture gains inline or block comments.
const config = JSON.parse(
  readFileSync(join(root, ".devcontainer/devcontainer.json"), "utf8").replace(
    /^\s*\/\/.*$/gm,
    "",
  ),
);
for (const task of config.customizations.vscode.settings.tasks.tasks.filter(
  ({ command }) => command.includes("container-start-"),
)) {
  test(`${task.label} preserves startup failure and tolerates an absent mount`, () => {
    const directory = mkdtempSync(join(tmpdir(), "frameleaf-task-"));
    try {
      const script = join(directory, "startup.sh");
      writeFileSync(script, "#!/bin/sh\nexit 17\n", { mode: 0o755 });
      const command = task.command.replaceAll(
        /\/immich-devcontainer\/container-start-[a-z]+\.sh/g,
        script,
      );
      assert.equal(
        spawnSync("bash", ["-c", command], { timeout: 3000 }).status,
        17,
      );
      rmSync(script);
      assert.equal(
        spawnSync("bash", ["-c", command], { timeout: 3000 }).status,
        0,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

for (const [kind, steps] of [
  ["backend", 1],
  ["frontend", 5],
]) {
  for (let failure = 1; failure <= steps; failure++) {
    test(`${kind} stops at failed preparation step ${failure}`, () => {
      const { result, commands } = startup(kind, failure);
      assert.equal(result.status, 17);
      assert.equal(commands.length, failure);
      assert.ok(commands.every((command) => !command.includes("exec")));
    });
  }
  test(`${kind} refuses startup outside its workspace`, () => {
    const { result, commands } = startup(kind, 0, true);
    assert.equal(result.status, 1);
    assert.ok(commands.every((command) => !command.includes("exec")));
  });
}
