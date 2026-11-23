#!/usr/bin/env node
// FL-1764: chooses which suites a Test run needs. When unsure it always answers "run everything".
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// The app suites read each other's files (server specs read web and manager, web specs read server
// fixtures and design), so a change skips them only when none of them can see it. Anything else,
// including a folder added later, runs them all.
const NO_APP_SUITE =
  /^(?:[^/]+\.md$|docs\/(?!package\.json$)|\.github\/(?!actions\/|package\.json$|workflows\/(?:test|frameleaf-cloud-consumers|development-validation)\.yml$))/;

export const needsAppSuites = (files) =>
  files.length === 0 || files.some((file) => !NO_APP_SUITE.test(file));

// A development-validation dispatch skips every suite, so it says nothing about this commit.
const ranSuites = (run) => {
  if (run.trigger_event !== "workflow_dispatch") {
    return true;
  }
  try {
    const selected = JSON.parse(run.event_payload).inputs
      ?.development_validation;
    return selected !== true && selected !== "true";
  } catch {
    return false;
  }
};

// Only earlier runs count: a later hourly run queued behind this one must not make it stand down.
export const alreadyCovered = (runs, runId, sha) => {
  const self = runs.find((run) => String(run.id) === String(runId));
  return (
    self !== undefined &&
    runs.some(
      (run) =>
        run.id < self.id &&
        run.commit_sha === sha &&
        run.workflow_id === "test.yml" &&
        run.status !== "cancelled" &&
        !String(run.event).startsWith("pull_request") &&
        ranSuites(run),
    )
  );
};

const scheduledSkipReason = async (env) => {
  const api = `${env.GITHUB_SERVER_URL}/api/v1/repos/${env.GITHUB_REPOSITORY}`;
  const get = async (path) => {
    const response = await fetch(`${api}/${path}`, {
      headers: { Authorization: `token ${env.CI_PLAN_TOKEN}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`${path}: HTTP ${response.status}`);
    }
    return response.json();
  };
  const branch = await get("branches/main");
  if (branch.commit.id !== env.GITHUB_SHA) {
    return "main has moved on";
  }
  const { workflow_runs: runs } = await get(
    `actions/runs?workflow_id=test.yml&head_sha=${env.GITHUB_SHA}&limit=50`,
  );
  return alreadyCovered(runs, env.GITHUB_RUN_ID, env.GITHUB_SHA)
    ? "this commit was already tested"
    : "";
};

export const planRun = async (env, changedFiles) => {
  const everything = { checks: true, app: true };
  try {
    if (env.EVENT_NAME === "schedule") {
      const reason = await scheduledSkipReason(env);
      return reason
        ? { checks: false, app: false, reason }
        : { ...everything, reason: "new commit on main" };
    }
    if (env.EVENT_NAME?.startsWith("pull_request")) {
      if (!/^[0-9a-f]{40}$/.test(env.BASE_SHA ?? "")) {
        return { ...everything, reason: "no pull request base" };
      }
      const app = needsAppSuites(changedFiles(env.BASE_SHA));
      return {
        checks: true,
        app,
        reason: app ? "app files changed" : "no app suite can see this change",
      };
    }
    return { ...everything, reason: env.EVENT_NAME };
  } catch (error) {
    return { ...everything, reason: `could not decide (${error.message})` };
  }
};

const gitChangedFiles = (base) =>
  execFileSync(
    "git",
    ["diff", "--name-only", "--no-renames", `${base}...HEAD`],
    { encoding: "utf8" },
  )
    .split("\n")
    .filter(Boolean);

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const { checks, app, reason } = await planRun(process.env, gitChangedFiles);
  console.log(`checks=${checks} app=${app}: ${reason}`);
  appendFileSync(process.env.GITHUB_OUTPUT, `checks=${checks}\napp=${app}\n`);
}
