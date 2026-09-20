import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildReport,
  classifyPath,
  normalizeRemoteIdentity,
  parsePorcelain,
} from "./frameleaf-baseline-inventory.mjs";

test("parses ordinary, untracked, and renamed porcelain records", () => {
  const parsed = parsePorcelain(
    Buffer.from(" M tracked.txt\0?? local.txt\0R  new.txt\0old.txt\0"),
  );
  assert.deepEqual(parsed, [
    {
      filePath: "tracked.txt",
      indexStatus: " ",
      originalPath: null,
      worktreeStatus: "M",
    },
    {
      filePath: "local.txt",
      indexStatus: "?",
      originalPath: null,
      worktreeStatus: "?",
    },
    {
      filePath: "new.txt",
      indexStatus: "R",
      originalPath: "old.txt",
      worktreeStatus: " ",
    },
  ]);
});

test("normalizes remote identities without retaining credential material", () => {
  assert.equal(
    normalizeRemoteIdentity(
      "https://user:secret@example.com/repository.git?token=secret#credential",
    ),
    "https://example.com/repository.git",
  );
  assert.equal(
    normalizeRemoteIdentity(
      "ssh://user:secret@example.com:2222/repository.git?token=secret#credential",
    ),
    "ssh://example.com:2222/repository.git",
  );
  assert.equal(
    normalizeRemoteIdentity("git@github.com:Frameleaf/frameleaf-app.git"),
    "github.com:Frameleaf/frameleaf-app.git",
  );
  assert.equal(
    normalizeRemoteIdentity("user:secret@example.com:repository.git?token=secret"),
    "example.com:repository.git",
  );
  assert.equal(
    normalizeRemoteIdentity("ext::sh -c 'send-secret'"),
    "ext::[redacted]",
  );
  assert.equal(
    normalizeRemoteIdentity("unsupported@transport/path#secret"),
    "[unsupported-remote]",
  );
});

test("classifies workstream, git state, and conservative review state", () => {
  assert.deepEqual(classifyPath("server/src/a.ts", " ", "M"), {
    gitState: "modified",
    reviewState: "unreviewed-local-change",
    workstream: "server",
  });
  assert.deepEqual(classifyPath("studio/evidence/proof.json", "?", "?"), {
    gitState: "untracked",
    reviewState: "local-evidence",
    workstream: "studio",
  });
  assert.deepEqual(
    classifyPath("machine-learning/x/__pycache__/x.pyc", "?", "?"),
    {
      gitState: "untracked",
      reviewState: "generated-local-artifact",
      workstream: "machine-learning",
    },
  );
});

test("builds a complete hashed inventory against an accepted commit", () => {
  const repository = mkdtempSync(path.join(tmpdir(), "frameleaf-inventory-"));
  try {
    execFileSync("git", ["-C", repository, "init", "--initial-branch=main"]);
    execFileSync("git", ["-C", repository, "config", "user.name", "Test"]);
    execFileSync("git", [
      "-C",
      repository,
      "config",
      "user.email",
      "test@example.com",
    ]);
    mkdirSync(path.join(repository, "server", "src"), { recursive: true });
    writeFileSync(
      path.join(repository, "server", "src", "tracked.ts"),
      "one\n",
    );
    execFileSync("git", ["-C", repository, "add", "."]);
    execFileSync("git", ["-C", repository, "commit", "-m", "baseline"]);
    execFileSync("git", [
      "-C",
      repository,
      "remote",
      "add",
      "origin",
      "https://user:secret@example.com/repository.git",
    ]);
    const baseline = execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    writeFileSync(
      path.join(repository, "server", "src", "tracked.ts"),
      "two\n",
    );
    writeFileSync(path.join(repository, "server", "src", "new.ts"), "new\n");

    const report = buildReport({
      acceptedBaseline: baseline,
      sourceRepository: repository,
    });
    assert.equal(report.summary.entryCount, 2);
    assert.equal(report.summary.pathCount, 2);
    assert.deepEqual(report.summary.byGitState, { modified: 1, untracked: 1 });
    assert.ok(
      report.entries.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256)),
    );
    assert.equal(report.acceptedBaseline.commit, baseline);
    assert.deepEqual(report.source.remotes, [
      {
        fetchIdentities: ["https://example.com/repository.git"],
        name: "origin",
        pushIdentities: ["https://example.com/repository.git"],
      },
    ]);
  } finally {
    rmSync(repository, { force: true, recursive: true });
  }
});

test("records a deterministic dirty gitlink state instead of reading its directory", () => {
  const parent = mkdtempSync(path.join(tmpdir(), "frameleaf-parent-"));
  const child = mkdtempSync(path.join(tmpdir(), "frameleaf-child-"));
  try {
    for (const repository of [parent, child]) {
      execFileSync("git", ["-C", repository, "init", "--initial-branch=main"]);
      execFileSync("git", ["-C", repository, "config", "user.name", "Test"]);
      execFileSync("git", ["-C", repository, "config", "user.email", "test@example.com"]);
    }
    writeFileSync(path.join(child, "tracked.txt"), "baseline\n");
    execFileSync("git", ["-C", child, "add", "."]);
    execFileSync("git", ["-C", child, "commit", "-m", "child baseline"]);
    execFileSync("git", [
      "-c",
      "protocol.file.allow=always",
      "-C",
      parent,
      "submodule",
      "add",
      child,
      "modules/example",
    ]);
    execFileSync("git", ["-C", parent, "commit", "-am", "parent baseline"]);
    const baseline = execFileSync("git", ["-C", parent, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    writeFileSync(path.join(parent, "modules/example/tracked.txt"), "dirty\n");

    const first = buildReport({ acceptedBaseline: baseline, sourceRepository: parent });
    const second = buildReport({ acceptedBaseline: baseline, sourceRepository: parent });
    assert.equal(first.entries.length, 1);
    assert.deepEqual(first.entries, second.entries);
    assert.equal(first.entries[0].filePath, "modules/example");
    assert.equal(first.entries[0].targetType, "gitlink");
    assert.equal(first.entries[0].gitlinkState.indexCommit.length, 40);
    assert.equal(first.entries[0].gitlinkState.headCommit.length, 40);
    assert.ok(first.entries[0].gitlinkState.nestedDiffBytes > 0);
    assert.match(first.entries[0].gitlinkState.nestedDiffSha256, /^[a-f0-9]{64}$/);
    assert.ok(first.entries[0].gitlinkState.nestedStatusBytes > 0);
    assert.match(first.entries[0].gitlinkState.nestedStatusSha256, /^[a-f0-9]{64}$/);
    assert.equal(first.entries[0].gitlinkState.nestedUntrackedCount, 0);
    assert.match(first.entries[0].gitlinkState.nestedUntrackedSha256, /^[a-f0-9]{64}$/);
  } finally {
    rmSync(parent, { force: true, recursive: true });
    rmSync(child, { force: true, recursive: true });
  }
});
