// FL-1678: release evidence from Forgejo runs, read through the GitHub-shaped adapter.
const assert = require("node:assert/strict");
const test = require("node:test");
const {
  forgejoAsGithub,
  githubJobNames,
  requireTestQualification,
  trustedRun,
} = require("./frameleaf-release.cjs");

// Job names of a real Forgejo Test run on main (790152846c), in Forgejo's matrix naming.
const forgejoNames = require("./forgejo-test-jobs.fixture.json");
const source = require("node:fs").readFileSync(
  require("node:path").join(__dirname, "frameleaf-release.cjs"),
  "utf8",
);
const required = JSON.parse(
  /const REQUIRED_TEST_JOBS = Object\.freeze\((\[[\s\S]*?\])\);/
    .exec(source)[1]
    .replace(/,\s*\]$/, "]"),
);
const sha = "a".repeat(40);

function forgejoFixture(status = () => "success") {
  const jobs = forgejoNames.map((name, index) => ({
    id: 500 + index,
    run_id: 65,
    attempt: 1,
    name,
    status: status(name),
  }));
  const run = {
    id: 65,
    commit_sha: sha,
    prettyref: "main",
    trigger_event: "push",
    status: jobs.some((job) => job.status === "failure")
      ? "failure"
      : "success",
    workflow_id: "test.yml",
    updated: "2026-11-17T13:42:48-07:00",
    html_url:
      "https://code.heroapps.ca/Frameleaf/frameleaf-app/actions/runs/62",
  };
  const request = async (endpoint) => {
    if (
      endpoint === `actions/runs?workflow_id=test.yml&head_sha=${sha}&limit=50`
    )
      return { total_count: 1, workflow_runs: [run] };
    if (endpoint === "actions/runs/65") return run;
    if (endpoint === "actions/runs/65/jobs") return jobs;
    throw new Error(`Unexpected Forgejo endpoint: ${endpoint}`);
  };
  return { run, jobs, request };
}

test("Forgejo matrix members map one to one onto every required GitHub job name", () => {
  const jobs = forgejoNames.map((name) => ({ name }));
  const names = githubJobNames(jobs, required);
  assert.equal(names.size, required.length);
  assert.deepEqual(new Set(names.values()), new Set(required));
});

test("a matrix group with a missing member maps none of its lanes", () => {
  const jobs = forgejoNames
    .filter((name) => name !== "Server Lane-3")
    .map((name) => ({ name }));
  const mapped = [...githubJobNames(jobs, required).values()];
  assert.equal(
    mapped.filter((name) => name.startsWith("Server Lane (")).length,
    0,
  );
});

test("a Forgejo run reads as a trusted GitHub run", async () => {
  const { request } = forgejoFixture();
  const run = await forgejoAsGithub("actions/runs/65", request);
  assert.ok(trustedRun(run, sha, ".github/workflows/test.yml"));
  assert.equal(run.run_attempt, 1);
  const running = await forgejoAsGithub("actions/runs/65", async (endpoint) =>
    endpoint === "actions/runs/65"
      ? { ...(await request(endpoint)), status: "running" }
      : request(endpoint),
  );
  assert.equal(trustedRun(running, sha, ".github/workflows/test.yml"), false);
});

test("Test qualification on Forgejo passes every lane but the Windows one it has no runner for", async (t) => {
  t.after(() => delete process.env.GITHUB_SERVER_URL);
  process.env.GITHUB_SERVER_URL = "https://code.heroapps.ca";
  const { request } = forgejoFixture((name) =>
    name === "Unit Test CLI (Windows)" ? "skipped" : "success",
  );
  const evidence = await requireTestQualification(sha, (endpoint) =>
    forgejoAsGithub(endpoint, request),
  );
  assert.equal(evidence.runId, 65);
  assert.equal(evidence.jobs.length, required.length - 1);
});

test("Test qualification on Forgejo refuses a failed lane", async (t) => {
  t.after(() => delete process.env.GITHUB_SERVER_URL);
  process.env.GITHUB_SERVER_URL = "https://code.heroapps.ca";
  const { request } = forgejoFixture((name) =>
    name === "Server Lane-2" ? "failure" : "success",
  );
  await assert.rejects(
    requireTestQualification(sha, (endpoint) =>
      forgejoAsGithub(endpoint, request),
    ),
    /Test qualification/,
  );
});

test("off Forgejo, the Windows lane is still required", async () => {
  delete process.env.GITHUB_SERVER_URL;
  const { request } = forgejoFixture((name) =>
    name === "Unit Test CLI (Windows)" ? "skipped" : "success",
  );
  await assert.rejects(
    requireTestQualification(sha, (endpoint) =>
      forgejoAsGithub(endpoint, request),
    ),
    /Unit Test CLI \(Windows\)/,
  );
});
