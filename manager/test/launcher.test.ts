import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const image = `ghcr.io/frameleaf/frameleaf-manager@sha256:${"a".repeat(64)}`;

test("latest resolves once, verifies and runs the immutable image; unresolved or unsigned images never run", () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "frameleaf-launcher-")));
  try {
    for (const name of ["bin", "state", "media", "backups", "appdata", "docker"]) mkdirSync(path.join(root, name));
    const commands = {
      docker: `#!/bin/sh
printf 'docker %s\\n' "$*" >> "$EVENTS"
case "$1 $2" in
  'info --format') printf '%s\\n' "$MOCK_ROOT/docker" ;;
  'image inspect') printf '%s\\n' "$RESOLVED_IMAGE" ;;
esac
`,
      findmnt: `#!/bin/sh
case "$*" in *FSTYPE*) echo ext4 ;; *SOURCE*) echo /dev/sda1 ;; esac
`,
      cosign: `#!/bin/sh
printf 'cosign %s\\n' "$*" >> "$EVENTS"
exit "$VERIFY_FAIL"
`,
    };
    for (const [name, source] of Object.entries(commands)) {
      const file = path.join(root, "bin", name);
      writeFileSync(file, source);
      chmodSync(file, 0o755);
    }
    for (const [resolved, fail, expected] of [
      [image, "0", 0],
      ["", "0", 2],
      [image, "1", 1],
    ] as const) {
      const events = path.join(root, "events");
      writeFileSync(events, "");
      const result = spawnSync(
        "sh",
        [
          fileURLToPath(new URL("../launch.sh", import.meta.url)),
          "ghcr.io/frameleaf/frameleaf-manager:latest",
          ...["state", "media", "backups"].map((name) => path.join(root, name)),
          "https://server.example:9443",
          path.join(root, "appdata"),
          "127.0.0.1",
        ],
        {
          env: {
            ...process.env,
            PATH: `${root}/bin:${process.env.PATH}`,
            EVENTS: events,
            MOCK_ROOT: root,
            RESOLVED_IMAGE: resolved,
            VERIFY_FAIL: fail,
          },
          encoding: "utf8",
        },
      );
      assert.equal(result.status, expected, result.stderr);
      const log = readFileSync(events, "utf8");
      if (expected === 0) {
        assert.match(log, new RegExp(`cosign verify .*${image}`));
        assert.match(log, new RegExp(`docker run .*${image}`));
        assert.ok(log.indexOf("cosign verify") < log.indexOf("docker run"));
        assert.doesNotMatch(log, /docker run .*frameleaf-manager:latest/);
      } else assert.doesNotMatch(log, /docker run /);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
