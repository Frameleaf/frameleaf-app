const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { load } = require("js-yaml");
const {
  assembleManagerInstallers,
  renderManagerInstallers,
  validateInstallerBinding,
} = require("./manager-installers.cjs");
const { buildManager } = require("./build-manager.cjs");
const {
  verifyManagerInstallers,
} = require("../../.github/verify-manager-installers.cjs");
const { TYPE, IMAGE } = require("../../.github/verify-manager-release.cjs");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("signed NAS bytes refuse stale templates, altered downloads and contradictory bindings", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "manager-binding-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "manager-manifest.json");
  const sourceCommit = "a".repeat(40),
    digest = "sha256:" + "b".repeat(64);
  const manifest = {
    schemaVersion: 1,
    component: "frameleaf-manager",
    repository: "Frameleaf/frameleaf-app",
    sourceCommit,
    tag: "manager-v0.1.0",
    image: `${IMAGE}@${digest}`,
    buildRun: "https://github.com/Frameleaf/frameleaf-app/actions/runs/123",
    architectures: ["amd64", "arm64"].map((architecture) => ({
      architecture,
      sourceCommit,
      repository: "Frameleaf/frameleaf-app",
      runId: "123",
      runAttempt: "1",
      digest,
      configDigest: digest,
      archiveSha256: "c".repeat(64),
      rootfsDiffIds: [digest],
      smoke: "passed",
    })),
  };
  await fs.writeFile(file, JSON.stringify(manifest));
  assembleManagerInstallers(file, dir);
  const signed = JSON.parse(await fs.readFile(file));
  const request = async () => ({
    head_sha: sourceCommit,
    head_branch: "master/frameleaf-implementation",
    head_repository: { full_name: "Frameleaf/frameleaf-app" },
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "success",
    path: ".github/workflows/manager.yml",
    run_attempt: 1,
  });
  const run = (program, args) => {
    assert.equal(program, "cosign");
    assert.equal(args.at(-1), signed.image);
    if (args[0] === "verify") return "[]";
    assert.equal(args[0], "verify-attestation");
    return JSON.stringify({
      payload: Buffer.from(
        JSON.stringify({
          predicateType: TYPE,
          subject: [{ name: IMAGE, digest: { sha256: digest.slice(7) } }],
          predicate: signed,
        }),
      ).toString("base64"),
    });
  };
  const verification = { run, request };
  assert.deepEqual(
    await verifyManagerInstallers(file, dir, verification),
    signed,
  );
  await buildManager(file, path.join(dir, "catalog"), verification);
  for (const asset of renderManagerInstallers(signed)) {
    assert.equal(
      sha(await fs.readFile(path.join(dir, asset.name))),
      signed.installers.files.find((f) => f.name === asset.name).sha256,
    );
    assert.deepEqual(
      await fs.readFile(path.join(dir, "catalog", asset.destination)),
      asset.bytes,
    );
    const bytes = await fs.readFile(path.join(dir, asset.name));
    await fs.writeFile(
      path.join(dir, asset.name),
      Buffer.concat([bytes, Buffer.from(" ")]),
    );
    await fs.writeFile(
      path.join(dir, "SHA256SUMS"),
      `${sha(await fs.readFile(path.join(dir, asset.name)))}  ${asset.name}\n`,
    );
    await assert.rejects(
      verifyManagerInstallers(file, dir, verification),
      /installer bytes/,
    );
    await fs.unlink(path.join(dir, asset.name));
    await assert.rejects(verifyManagerInstallers(file, dir, verification), {
      code: "ENOENT",
    });
    await fs.symlink(file, path.join(dir, asset.name));
    await assert.rejects(verifyManagerInstallers(file, dir, verification));
    await fs.unlink(path.join(dir, asset.name));
    await fs.writeFile(path.join(dir, asset.name), bytes);
  }
  const changes = [
    (b) => b.files.pop(),
    (b) => (b.files[1].name = b.files[0].name),
    (b) => (b.files[0].name = "../frameleaf-manager.xml"),
    (b) => (b.files[0].name = "unexpected.xml"),
    (b) => (b.files[0].sha256 = "bad"),
    (b) => (b.sourceCommit = "d".repeat(40)),
    (b) => (b.tag = "manager-v0.2.0"),
    (b) => (b.image = `${IMAGE}:latest`),
    (b) => (b.schemaVersion = 2),
  ];
  for (const change of changes) {
    const altered = structuredClone(signed);
    change(altered.installers);
    assert.throws(() => validateInstallerBinding(altered));
  }
  const tampered = structuredClone(signed);
  tampered.installers.files[0].sha256 = "0".repeat(64);
  await fs.writeFile(file, JSON.stringify(tampered));
  await assert.rejects(verifyManagerInstallers(file, dir, verification));
  await assert.rejects(
    buildManager(file, path.join(dir, "tampered-output"), verification),
  );
  await assert.rejects(fs.stat(path.join(dir, "tampered-output")), {
    code: "ENOENT",
  });
  await fs.writeFile(file, JSON.stringify(signed));
  await assert.rejects(
    verifyManagerInstallers(file, dir, {
      run,
      request: async () => ({ ...(await request()), status: "in_progress" }),
    }),
    /not trusted/,
  );
  const legacy = structuredClone(signed);
  delete legacy.installers;
  assert.throws(() => validateInstallerBinding(legacy), /binding required/);
  await fs.writeFile(file, JSON.stringify(legacy));
  const legacyRun = (program, args) =>
    args[0] === "verify"
      ? "[]"
      : JSON.stringify({
          payload: Buffer.from(
            JSON.stringify({
              predicateType: TYPE,
              subject: [{ name: IMAGE, digest: { sha256: digest.slice(7) } }],
              predicate: legacy,
            }),
          ).toString("base64"),
        });
  await assert.rejects(
    verifyManagerInstallers(file, dir, { run: legacyRun, request }),
    /binding required/,
  );
  const invalid = structuredClone(legacy);
  invalid.image = `${IMAGE}:latest`;
  await fs.writeFile(file, JSON.stringify(invalid));
  const invalidOutput = path.join(dir, "invalid-producer-output");
  assert.throws(() => assembleManagerInstallers(file, invalidOutput));
  await assert.rejects(fs.stat(invalidOutput), { code: "ENOENT" });
});

test("actual release-upload failure stops all latest alias actions", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "manager-alias-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const workflow = load(
    await fs.readFile(
      path.join(__dirname, "../../.github/workflows/manager.yml"),
      "utf8",
    ),
  );
  const steps = workflow.jobs.publish.steps;
  const assembly = steps.find((step) =>
    step.run?.includes("node packaging/nas/manager-installers.cjs"),
  ).run;
  assert(
    assembly.indexOf("node packaging/nas/manager-installers.cjs") <
      assembly.indexOf("cosign attest"),
  );
  const release = steps.find(
    (step) =>
      step.name ===
      "Create the component release and latest aliases after signature and provenance",
  ).run;
  const bin = path.join(dir, "bin");
  await fs.mkdir(bin);
  const log = path.join(dir, "calls");
  for (const [name, script] of [
    ["git", 'if [ "$1" = rev-parse ]; then echo "$SOURCE_SHA"; fi'],
    ["gh", 'echo "$*" >> "$CALL_LOG"; exit 42'],
    ["oras", 'echo "ORAS $*" >> "$CALL_LOG"'],
    ["sha256sum", 'exec /usr/bin/shasum -a 256 "$@"'],
  ])
    await fs.writeFile(path.join(bin, name), "#!/bin/sh\n" + script + "\n", {
      mode: 0o700,
    });
  for (const name of [
    "manager-manifest.json",
    "frameleaf-manager.xml",
    "frameleaf-manager.compose.yaml",
  ])
    await fs.writeFile(path.join(dir, name), "controlled fixture");
  assert.throws(() =>
    execFileSync("bash", ["-c", release], {
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        RUNNER_TEMP: dir,
        GITHUB_REF: "controlled-ref",
        GITHUB_REPOSITORY: "Frameleaf/frameleaf-app",
        SOURCE_SHA: "a".repeat(40),
        RELEASE_TAG: "manager-v0.1.0",
        DIGEST: "sha256:" + "b".repeat(64),
        CALL_LOG: log,
      },
      stdio: "pipe",
    }),
  );
  const calls = await fs.readFile(log, "utf8");
  assert(calls.startsWith("release create "));
  assert(
    calls.includes("frameleaf-manager.xml") &&
      calls.includes("frameleaf-manager.compose.yaml"),
  );
  assert(
    !calls.includes("ORAS") &&
      !calls.includes("git/refs") &&
      !calls.includes("git/ref/"),
  );
});
