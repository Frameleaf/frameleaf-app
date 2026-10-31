// Executes the real installer with offline command fixtures; no Docker or network access.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

function snapshot(filename) {
  if (
    !fs.existsSync(filename) &&
    !fs.lstatSync(filename, { throwIfNoEntry: false })
  )
    return undefined;
  const stat = fs.lstatSync(filename);
  const result = { mode: stat.mode };
  if (stat.isSymbolicLink())
    return { ...result, link: fs.readlinkSync(filename) };
  if (stat.isFile())
    return { ...result, bytes: fs.readFileSync(filename).toString("hex") };
  assert.ok(stat.isDirectory());
  return {
    ...result,
    entries: Object.fromEntries(
      fs
        .readdirSync(filename)
        .sort()
        .map((name) => [name, snapshot(path.join(filename, name))]),
    ),
  };
}

function runInstaller(parent) {
  const tools = path.join(parent, "offline-tools");
  const log = path.join(parent, "commands.log");
  fs.mkdirSync(tools);
  fs.writeFileSync(
    path.join(tools, "curl"),
    `#!/usr/bin/env bash
set -eu
printf 'curl %s\\n' "$*" >> "$INSTALL_TEST_LOG"
[[ "$1" == '-fsSL' && "$3" == '-o' && "$#" == 4 ]]
case "$2" in
  */docker-compose.yml) cp "$INSTALL_TEST_COMPOSE" "$4" ;;
  */example.env) cp "$INSTALL_TEST_ENV" "$4" ;;
  *) exit 90 ;;
esac
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(tools, "docker"),
    `#!/usr/bin/env bash
printf 'docker %s\\n' "$*" >> "$INSTALL_TEST_LOG"
[[ "$*" == 'compose' || "$*" == 'compose up --remove-orphans -d' ]]
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(tools, "hostname"),
    `#!/usr/bin/env bash
printf 'hostname %s\\n' "$*" >> "$INSTALL_TEST_LOG"
echo 127.0.0.1
`,
    { mode: 0o755 },
  );
  const result = spawnSync("bash", [path.join(__dirname, "../install.sh")], {
    cwd: parent,
    encoding: "utf8",
    timeout: 10_000,
    env: {
      ...process.env,
      PATH: `${tools}${path.delimiter}${process.env.PATH}`,
      INSTALL_TEST_LOG: log,
      INSTALL_TEST_COMPOSE: path.join(
        __dirname,
        "../docker/docker-compose.yml",
      ),
      INSTALL_TEST_ENV: path.join(__dirname, "../docker/example.env"),
    },
  });
  assert.ifError(result.error);
  return {
    ...result,
    commands: fs.existsSync(log)
      ? fs.readFileSync(log, "utf8").trim().split("\n")
      : [],
  };
}

test("the installer creates a fresh canonical installation through offline command fixtures", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "frameleaf-install-"));
  try {
    const result = runInstaller(parent);
    assert.equal(result.status, 0, result.stderr);
    const destination = path.join(parent, "frameleaf-app");
    assert.equal(
      fs.readFileSync(path.join(destination, "docker-compose.yml"), "utf8"),
      fs.readFileSync(
        path.join(__dirname, "../docker/docker-compose.yml"),
        "utf8",
      ),
    );
    const env = fs.readFileSync(path.join(destination, ".env"), "utf8");
    assert.match(env, /^DB_DATABASE_NAME=frameleaf$/m);
    assert.match(env, /^DB_DATA_LOCATION=\.\/postgres19$/m);
    assert.match(env, /^DB_PASSWORD=[A-Za-z0-9+/]+$/m);
    assert.doesNotMatch(env, /^DB_PASSWORD=postgres$/m);
    assert.deepEqual(
      result.commands.map((command) => command.split(" ")[0]),
      ["curl", "curl", "docker", "docker", "hostname"],
    );
    assert.match(result.stdout, /Frameleaf is running/);
    assert.doesNotMatch(result.stdout, /Redis/i);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("non-fresh destinations are refused before configuration, credentials or media can mutate", () => {
  for (const kind of [
    "populated",
    "empty",
    "file",
    "symlink",
    "dangling-symlink",
  ]) {
    const parent = fs.mkdtempSync(
      path.join(os.tmpdir(), "frameleaf-install-refuse-"),
    );
    try {
      const destination = path.join(parent, "frameleaf-app");
      const existing = path.join(parent, "retained-installation");
      if (kind === "file")
        fs.writeFileSync(destination, "retained destination file");
      else if (kind === "dangling-symlink")
        fs.symlinkSync(existing, destination);
      else {
        const target = kind === "symlink" ? existing : destination;
        fs.mkdirSync(target);
        if (kind !== "empty") {
          fs.writeFileSync(
            path.join(target, ".env"),
            "DB_PASSWORD=retained-secret\nDB_DATABASE_NAME=frameleaf\n",
            { mode: 0o600 },
          );
          fs.writeFileSync(
            path.join(target, "docker-compose.yml"),
            "retained Compose configuration\n",
          );
          fs.mkdirSync(path.join(target, "media"));
          fs.writeFileSync(
            path.join(target, "media", "original.jpg"),
            Buffer.from([0xff, 0xd8, 0, 1, 2, 0xff, 0xd9]),
          );
          fs.mkdirSync(path.join(target, "postgres19"));
          fs.writeFileSync(
            path.join(target, "postgres19", "PG_VERSION"),
            "19\n",
          );
          fs.writeFileSync(
            path.join(target, "postgres19", "retained-data"),
            "initialized database data\n",
          );
        }
        if (kind === "symlink") fs.symlinkSync(existing, destination);
      }
      const before = snapshot(destination);
      const retained = snapshot(existing);
      const result = runInstaller(parent);
      assert.equal(result.status, 10, `${kind}: ${result.stderr}`);
      assert.deepEqual(
        result.commands,
        [],
        `${kind}: no download, Compose or hostname command should run`,
      );
      assert.deepEqual(
        snapshot(destination),
        before,
        `${kind}: destination must remain unchanged`,
      );
      assert.deepEqual(
        snapshot(existing),
        retained,
        `${kind}: symlink target must remain unchanged`,
      );
      assert.match(result.stderr, /Fresh installation requires a new/);
      assert.match(result.stderr, /new parent directory/);
      assert.match(result.stderr, /retained \.env and Compose files/);
      assert.match(
        result.stderr,
        /do not delete its media or database directories/,
      );
      assert.doesNotMatch(result.stdout + result.stderr, /retained-secret/);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  }
});
