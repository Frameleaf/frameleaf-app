const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { load } = require("js-yaml");
const { buildManager } = require("./build-manager.cjs");
const { TYPE, IMAGE } = require("../../.github/verify-manager-release.cjs");

test("NAS Manager packages authenticate the component, both architectures and exact workflow before writing", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "manager-nas-"));
  const file = path.join(directory, "manager-manifest.json");
  const sourceCommit = "a".repeat(40),
    digest = `sha256:${"b".repeat(64)}`;
  const manifest = {
    schemaVersion: 1,
    component: "frameleaf-manager",
    repository: "Frameleaf/frameleaf-app",
    tag: "manager-v0.1.0",
    sourceCommit,
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
  const build = {
    head_sha: sourceCommit,
    head_branch: "master/frameleaf-implementation",
    head_repository: { full_name: "Frameleaf/frameleaf-app" },
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "success",
    path: ".github/workflows/manager.yml",
    run_attempt: 1,
  };
  const run = (program, args) => {
    assert.equal(program, "cosign");
    assert.equal(args.at(-1), manifest.image);
    if (args[0] === "verify") return "[]";
    assert.equal(args[0], "verify-attestation");
    return JSON.stringify({
      payload: Buffer.from(
        JSON.stringify({
          predicateType: TYPE,
          subject: [{ name: IMAGE, digest: { sha256: digest.slice(7) } }],
          predicate: manifest,
        }),
      ).toString("base64"),
    });
  };
  const request = async (endpoint) => {
    assert.equal(endpoint, "actions/runs/123");
    return build;
  };
  try {
    await fs.writeFile(file, JSON.stringify(manifest));
    const output = path.join(directory, "valid");
    await buildManager(file, output, { run, request });
    manifest.installers = {
      schemaVersion: 1,
      sourceCommit,
      tag: manifest.tag,
      image: manifest.image,
      files: ["frameleaf-manager.xml", "frameleaf-manager.compose.yaml"].map(
        (name) => ({ name, sha256: "0".repeat(64) }),
      ),
    };
    await fs.writeFile(file, JSON.stringify(manifest));
    const staleOutput = path.join(directory, "stale-authenticated-templates");
    await assert.rejects(
      buildManager(file, staleOutput, { run, request }),
      /installer/i,
    );
    await assert.rejects(fs.stat(staleOutput), { code: "ENOENT" });
    delete manifest.installers;
    await fs.writeFile(file, JSON.stringify(manifest));
    const xml = await fs.readFile(
      path.join(output, "unraid/templates/frameleaf-manager.xml"),
      "utf8",
    );
    assert(xml.includes(`<Repository>${manifest.image}</Repository>`));
    assert(xml.includes("MANAGER_PLATFORM"));
    assert(
      xml.includes(
        'Target="/run/frameleaf-host/unraid-autostart" Default="" Mode="rw"',
      ),
    );
    assert(xml.includes('Target="MANAGER_UNRAID_AUTOSTART" Default=""'));
    assert(!xml.includes("latest"));
    const compose = load(
      await fs.readFile(
        path.join(output, "truenas/frameleaf-manager.compose.yaml"),
        "utf8",
      ),
    );
    assert.deepEqual(Object.keys(compose.services), ["manager"]);
    assert.equal(compose.services.manager.image, manifest.image);
    assert.equal(compose.services.manager.privileged, undefined);
    for (const bind of compose.services.manager.volumes.filter((bind) =>
      bind.source.startsWith("/mnt/"),
    ))
      assert.equal(bind.source, bind.target);
    assert(
      !compose.services.manager.volumes.some((bind) =>
        bind.target.startsWith("/var/lib/postgresql"),
      ),
    );
    assert.deepEqual(await fs.readdir(output), [
      "manager-manifest.json",
      "truenas",
      "unraid",
    ]);
    for (const head_branch of ["fork/main", "aj/frameleaf-manager-release"]) {
      const admitted = path.join(directory, head_branch.replaceAll("/", "-"));
      await buildManager(file, admitted, {
        run,
        request: async () => ({ ...build, head_branch }),
      });
      assert.equal(
        JSON.parse(
          await fs.readFile(
            path.join(admitted, "manager-manifest.json"),
            "utf8",
          ),
        ).image,
        manifest.image,
      );
    }
    let count = 0;
    for (const mutation of [
      (value) => {
        value.image = `${IMAGE}:latest`;
      },
      (value) => {
        value.architectures.pop();
      },
      (value) => {
        value.architectures[0].smoke = "failed";
      },
      (value) => {
        value.architectures[1].sourceCommit = "d".repeat(40);
      },
      (value) => {
        value.architectures[1].runAttempt = "2";
      },
      (value) => {
        value.component = "frameleaf-server";
      },
      (value) => {
        value.tag = "frameleaf-v3.1.0-1";
      },
      (value) => {
        value.buildRun = "https://github.com/other/repo/actions/runs/123";
      },
    ]) {
      const changed = structuredClone(manifest);
      mutation(changed);
      await fs.writeFile(file, JSON.stringify(changed));
      const refused = path.join(directory, `refused-${count++}`);
      await assert.rejects(buildManager(file, refused, { run, request }));
      await assert.rejects(fs.stat(refused), { code: "ENOENT" });
    }
    await fs.writeFile(file, JSON.stringify(manifest));
    for (const patch of [
      { conclusion: "failure" },
      { path: ".github/workflows/cli.yml" },
      { head_sha: "e".repeat(40) },
      { head_branch: "aj/unreviewed" },
      { head_branch: "aj/frameleaf-manager-release-unreviewed" },
      { head_repository: { full_name: "other/frameleaf-app" } },
      { run_attempt: 2 },
    ]) {
      const refused = path.join(directory, `refused-${count++}`);
      await assert.rejects(
        buildManager(file, refused, {
          run,
          request: async () => ({ ...build, ...patch }),
        }),
      );
      await assert.rejects(fs.stat(refused), { code: "ENOENT" });
    }
    const refused = path.join(directory, "unsigned");
    await assert.rejects(
      buildManager(file, refused, {
        run: () => {
          throw new Error("unsigned");
        },
        request,
      }),
      /unsigned/,
    );
    await assert.rejects(fs.stat(refused), { code: "ENOENT" });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
