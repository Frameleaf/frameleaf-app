// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Frameleaf.
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import {
  cancelPlan,
  issueKeys,
  jiraClient,
  syncRelease,
} from "./jira-release.mjs";

const repositories = {
  "Frameleaf/frameleaf-app": { product: "Library", projects: ["FL"] },
  "Frameleaf/frameleaf-cloud": { product: "Cloud", projects: ["FC"] },
  "Frameleaf/swift-app": { product: "iOS", projects: ["FL", "FIOS"] },
  "Frameleaf/kotlin-app": { product: "Android", projects: ["FL"] },
};
export function validatePlanRequest(run, event) {
  assert(
    run.path === ".github/workflows/jira-plan-request.yml" &&
      run.event === "pull_request" &&
      run.conclusion === "success" &&
      run.status === "completed",
    "Unexpected plan request workflow",
  );
  assert(
    run.head_repository?.full_name === run.repository?.full_name,
    "Fork request is not trusted",
  );
  assert(
    Number.isSafeInteger(event.number) &&
      run.pull_requests.some((pr) => pr.number === event.number),
    "Request is not associated with this PR",
  );
}
export function planChanges(repository, event, pr) {
  const config = repositories[repository];
  assert(
    config && pr.base.repo.full_name === repository,
    "Unexpected repository",
  );
  assert(pr.number === event.number, "PR identity mismatch");
  if (pr.head.repo?.full_name !== repository) return null;
  const keys = issueKeys(pr.title, config.projects);
  const oldKeys = issueKeys(event.changes?.title?.from || "", config.projects);
  const version = pr.milestone?.title.match(
    /^release: ([A-Za-z0-9][A-Za-z0-9.+_() -]{0,150})$/,
  )?.[1];
  const active = version && (pr.state === "open" || pr.merged);
  const planKey = `${repository}#${pr.number}`;
  return {
    config,
    planKey,
    remove: [...new Set([...oldKeys, ...keys])].filter(
      (key) => !active || !keys.includes(key),
    ),
    receipt: active
      ? {
          mode: "planned",
          version,
          issueKeys: keys,
          planKey,
          evidenceUrl: `https://github.com/${repository}/pull/${pr.number}`,
        }
      : null,
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const trigger = JSON.parse(
      readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"),
    );
    const repo = process.env.GITHUB_REPOSITORY;
    assert(repositories[repo], "Unexpected repository");
    const api = async (path) => {
      const response = await fetch(
        `https://api.github.com/repos/${repo}/${path}`,
        {
          headers: {
            Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
            Accept: "application/vnd.github+json",
          },
          redirect: "error",
          signal: AbortSignal.timeout(30000),
        },
      );
      assert(
        response.ok,
        `Cannot read GitHub metadata: HTTP ${response.status}`,
      );
      return response.json();
    };
    let event;
    if (process.env.GITHUB_EVENT_NAME === "workflow_dispatch") {
      event = { number: Number(trigger.inputs.pr_number) };
    } else {
      assert(
        Number.isSafeInteger(trigger.workflow_run?.id),
        "Missing plan request run",
      );
      const run = await api(`actions/runs/${trigger.workflow_run.id}`);
      assert.equal(run.repository.full_name, repo, "Foreign plan request");
      assert.equal(
        run.run_attempt,
        trigger.workflow_run.run_attempt,
        "Plan request was rerun",
      );
      const name = `jira-plan-request-${run.run_attempt}`;
      const artifacts = await api(
        `actions/runs/${run.id}/artifacts?per_page=100`,
      );
      const matches = artifacts.artifacts.filter((a) => a.name === name);
      assert(
        matches.length === 1 &&
          !matches[0].expired &&
          matches[0].size_in_bytes < 1024 * 1024,
        "Missing or invalid plan request artifact",
      );
      const directory = mkdtempSync(join(tmpdir(), "jira-plan-"));
      try {
        execFileSync(
          "gh",
          [
            "run",
            "download",
            String(run.id),
            "--repo",
            repo,
            "--name",
            name,
            "--dir",
            directory,
          ],
          {
            env: { ...process.env, GH_TOKEN: process.env.GITHUB_TOKEN },
            stdio: "pipe",
          },
        );
        const path = join(directory, "plan-event.json");
        assert(statSync(path).size < 65536, "Plan request exceeds limit");
        event = JSON.parse(readFileSync(path, "utf8"));
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
      validatePlanRequest(run, event);
    }
    assert(
      Number.isSafeInteger(event.number) && event.number > 0,
      "Invalid PR number",
    );
    const change = planChanges(repo, event, await api(`pulls/${event.number}`));
    if (change) {
      const options = { product: change.config.product, request: jiraClient() };
      if (change.receipt)
        console.log(JSON.stringify(await syncRelease(change.receipt, options)));
      await cancelPlan(change.remove, change.planKey, options);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
