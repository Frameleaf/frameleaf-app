// Executes the real installer with offline command fixtures; no Docker or network access.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
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

const SERVER_DIGEST = "a".repeat(64);
const ML_DIGEST = "b".repeat(64);
const sha256 = (file) =>
  crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const attested = (
  compose = path.join(__dirname, "../docker/docker-compose.yml"),
) => ({
  "docker-compose.yml": `sha256:${sha256(compose)}`,
  "example.env": `sha256:${sha256(path.join(__dirname, "../docker/example.env"))}`,
});

function runInstaller(parent, overrides = {}) {
  const tools = path.join(parent, "offline-tools");
  const log = path.join(parent, "commands.log");
  fs.mkdirSync(tools);
  const compose = path.join(__dirname, "../docker/docker-compose.yml");
  const env = path.join(__dirname, "../docker/example.env");
  // The release publishes SHA256SUMS beside its files; the installer refuses a download that does not match it.
  const sums = path.join(tools, "SHA256SUMS");
  fs.writeFileSync(
    sums,
    [
      [compose, "docker-compose.yml"],
      [env, "example.env"],
    ]
      .map(
        ([file, name]) =>
          `${crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")}  ${name}\n`,
      )
      .join(""),
  );
  fs.writeFileSync(
    path.join(tools, "curl"),
    `#!/usr/bin/env bash
set -eu
printf 'curl %s\\n' "$*" >> "$INSTALL_TEST_LOG"
[[ "$1" == '-fsSL' && "$3" == '-o' && "$#" == 4 ]]
case "$2" in
  */docker-compose.yml) cp "$INSTALL_TEST_COMPOSE" "$4" ;;
  */example.env) cp "$INSTALL_TEST_ENV" "$4" ;;
  */SHA256SUMS) cp "$INSTALL_TEST_SUMS" "$4" ;;
  *) exit 90 ;;
esac
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(tools, "docker"),
    `#!/usr/bin/env bash
printf 'docker %s\\n' "$*" >> "$INSTALL_TEST_LOG"
case "$*" in
  'compose pull --quiet frameleaf-server frameleaf-machine-learning') exit 0 ;;
  'compose config --images frameleaf-server') echo ghcr.io/frameleaf/frameleaf-server:latest; exit 0 ;;
  'compose config --images frameleaf-machine-learning') echo ghcr.io/frameleaf/frameleaf-machine-learning:latest; exit 0 ;;
  'image inspect '*frameleaf-server:latest) echo "ghcr.io/frameleaf/frameleaf-server@sha256:$INSTALL_TEST_SERVER_DIGEST"; exit 0 ;;
  'image inspect '*frameleaf-machine-learning:latest) echo "ghcr.io/frameleaf/frameleaf-machine-learning@sha256:$INSTALL_TEST_ML_DIGEST"; exit 0 ;;
esac
[[ "$*" == 'compose' || "$*" == 'compose up --remove-orphans -d' ]]
`,
    { mode: 0o755 },
  );
  // Frameleaf's signatures as cosign reports them: the digests in INSTALL_TEST_SIGNED verify, and the server
  // image's release manifest names the assets in INSTALL_TEST_ATTESTED.
  fs.writeFileSync(
    path.join(tools, "cosign"),
    `#!/usr/bin/env bash
printf 'cosign %s\\n' "$1" >> "$INSTALL_TEST_LOG"
[[ "$2" == '--key' && -s "$3" ]] || exit 91
digest="\${@: -1}"
[[ " $INSTALL_TEST_SIGNED " == *" \${digest##*@sha256:} "* ]] || exit 1
if [[ "$1" == verify-attestation ]]; then
  payload=$(printf '{"_type":"https://in-toto.io/Statement/v0.1","predicate":{"assets":%s}}' "$INSTALL_TEST_ATTESTED" | base64 | tr -d '\\n')
  printf '{"payload":"%s","payloadType":"application/vnd.in-toto+json"}\\n' "$payload"
fi
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
      INSTALL_TEST_COMPOSE: compose,
      INSTALL_TEST_ENV: env,
      INSTALL_TEST_SUMS: sums,
      INSTALL_TEST_SERVER_DIGEST: SERVER_DIGEST,
      INSTALL_TEST_ML_DIGEST: ML_DIGEST,
      INSTALL_TEST_SIGNED: `${SERVER_DIGEST} ${ML_DIGEST}`,
      INSTALL_TEST_ATTESTED: JSON.stringify(attested()),
      // The machine running the tests may have cosign; each test chooses.
      FRAMELEAF_COSIGN: "frameleaf-test-no-cosign",
      ...overrides,
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
      ["curl", "curl", "curl", "docker", "docker", "hostname"],
    );
    assert.match(result.stdout, /Frameleaf is running/);
    assert.doesNotMatch(result.stdout, /Redis/i);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("a selected release downloads that release's files and pins its image tag in .env", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "frameleaf-install-"));
  try {
    const result = runInstaller(parent, {
      FRAMELEAF_RELEASE: "frameleaf-v1.2.3",
    });
    assert.equal(result.status, 0, result.stderr);
    const env = fs.readFileSync(
      path.join(parent, "frameleaf-app", ".env"),
      "utf8",
    );
    assert.match(env, /^FRAMELEAF_VERSION=frameleaf-v1\.2\.3$/m);
    assert.doesNotMatch(env, /^FRAMELEAF_VERSION=latest$/m);
    assert.doesNotMatch(env, /^DB_PASSWORD=postgres$/m);
    for (const command of result.commands.filter((line) =>
      line.startsWith("curl "),
    ))
      assert.match(command, /releases\/download\/frameleaf-v1\.2\.3\//);
    assert.match(result.stdout, /Frameleaf is running/);
    // Without a selection the example's latest tag is kept.
    const unpinned = fs.mkdtempSync(
      path.join(os.tmpdir(), "frameleaf-install-"),
    );
    try {
      assert.equal(runInstaller(unpinned).status, 0);
      assert.match(
        fs.readFileSync(path.join(unpinned, "frameleaf-app", ".env"), "utf8"),
        /^FRAMELEAF_VERSION=latest$/m,
      );
    } finally {
      fs.rmSync(unpinned, { recursive: true, force: true });
    }
    const invalid = fs.mkdtempSync(
      path.join(os.tmpdir(), "frameleaf-install-"),
    );
    try {
      const refused = runInstaller(invalid, { FRAMELEAF_RELEASE: "1.2.3" });
      assert.equal(refused.status, 16);
      assert.deepEqual(refused.commands, []);
    } finally {
      fs.rmSync(invalid, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("a download that does not match the release checksums is never started", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "frameleaf-install-"));
  try {
    const tampered = path.join(parent, "tampered-compose.yml");
    fs.writeFileSync(tampered, "services: {}\n");
    const result = runInstaller(parent, { INSTALL_TEST_COMPOSE: tampered });
    assert.equal(result.status, 18, result.stderr);
    assert.match(result.stderr, /does not match the release checksum/);
    assert.deepEqual(
      result.commands.map((command) => command.split(" ")[0]),
      ["curl", "curl", "curl"],
    );
    assert.doesNotMatch(result.stdout, /Frameleaf is running/);
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

test("with cosign, the images must carry Frameleaf's signature and the release manifest must name the downloads", () => {
  const signedRun = (overrides) => {
    const parent = fs.mkdtempSync(
      path.join(os.tmpdir(), "frameleaf-install-signed-"),
    );
    try {
      return runInstaller(parent, { FRAMELEAF_COSIGN: "cosign", ...overrides });
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  };
  const good = signedRun({});
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stdout, /signed by Frameleaf/);
  assert.deepEqual(
    good.commands.filter((line) => line.startsWith("cosign")),
    ["cosign verify", "cosign verify-attestation", "cosign verify"],
  );
  assert.ok(good.commands.includes("docker compose up --remove-orphans -d"));

  const other = fs.mkdtempSync(path.join(os.tmpdir(), "frameleaf-other-"));
  try {
    const tampered = path.join(other, "docker-compose.yml");
    fs.writeFileSync(tampered, "services: {}\n");
    const refused = signedRun({
      INSTALL_TEST_ATTESTED: JSON.stringify(attested(tampered)),
    });
    assert.equal(refused.status, 20, refused.stderr);
    assert.match(
      refused.stderr,
      /does not name these docker-compose.yml and example.env files/,
    );
    assert.ok(
      !refused.commands.includes("docker compose up --remove-orphans -d"),
    );
  } finally {
    fs.rmSync(other, { recursive: true, force: true });
  }

  const unsigned = signedRun({ INSTALL_TEST_SIGNED: SERVER_DIGEST });
  assert.equal(unsigned.status, 20, unsigned.stderr);
  assert.match(
    unsigned.stderr,
    /frameleaf-machine-learning@sha256:b+ does not carry Frameleaf's signature/,
  );
  assert.ok(
    !unsigned.commands.includes("docker compose up --remove-orphans -d"),
  );
});

test("without cosign the install goes on with a warning, unless signatures are required", () => {
  const parent = fs.mkdtempSync(
    path.join(os.tmpdir(), "frameleaf-install-unsigned-"),
  );
  const required = fs.mkdtempSync(
    path.join(os.tmpdir(), "frameleaf-install-unsigned-"),
  );
  try {
    const warned = runInstaller(parent);
    assert.equal(warned.status, 0, warned.stderr);
    assert.match(warned.stderr, /cosign is not installed/);
    const refused = runInstaller(required, {
      FRAMELEAF_REQUIRE_SIGNATURES: "1",
    });
    assert.equal(refused.status, 20, refused.stderr);
    assert.ok(
      !refused.commands.some((line) => line.startsWith("docker compose up")),
    );
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
    fs.rmSync(required, { recursive: true, force: true });
  }
});

test("the installer carries the repository's signing keys", () => {
  const script = fs.readFileSync(path.join(__dirname, "../install.sh"), "utf8");
  for (const name of ["cosign.pub", "cosign-previous.pub"])
    assert.ok(
      script.includes(
        fs.readFileSync(path.join(__dirname, "..", name), "utf8").trim(),
      ),
      `install.sh does not carry ${name}`,
    );
});
