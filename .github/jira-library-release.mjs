// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { appendFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const repository = 'Frameleaf/frameleaf-app';
const source = `https://github.com/${repository}`;
const shaPattern = /^[a-f0-9]{40}$/;
const tagPattern = /^frameleaf-v\d+\.\d+\.\d+$/;

async function listAll(request, path, field) {
  const values = [];
  for (let page = 1; ; page++) {
    const response = await request(`${path}?per_page=100&page=${page}`);
    const items = field ? response[field] : response;
    assert(Array.isArray(items), `Invalid GitHub ${path} response`);
    values.push(...items);
    if (items.length < 100) return values;
  }
}

function timestamp(value) {
  const result = Date.parse(value);
  assert(Number.isFinite(result), 'Missing or invalid release/run timestamp');
  return result;
}

async function releaseManifest(release, request) {
  const assets = release.assets?.filter((asset) => asset.name === 'release-manifest.json');
  assert.equal(assets?.length, 1, `Missing or ambiguous manifest for ${release.tag_name}`);
  assert(Number.isSafeInteger(assets[0].id), 'Invalid release asset ID');
  const manifest = await request(`releases/assets/${assets[0].id}`, true);
  assert.equal(manifest.schemaVersion, 3, 'Unsupported Library release manifest');
  assert.equal(manifest.repository, repository, 'Foreign release manifest');
  assert.equal(manifest.tag, release.tag_name, 'Release manifest tag differs');
  assert(shaPattern.test(manifest.sourceCommit), 'Invalid release source commit');
  const commit = await request(`commits/${encodeURIComponent(release.tag_name)}`);
  assert.equal(commit.sha, manifest.sourceCommit, 'Release tag and manifest source differ');
  return manifest;
}

export async function libraryReceipt({ runId, request, baselineSha, collectIssueKeys }) {
  assert(/^\d+$/.test(String(runId)), 'A production deployment run ID is required');
  const run = await request(`actions/runs/${runId}`);
  assert.equal(String(run.id), String(runId), 'Deployment run ID differs');
  assert.equal(run.repository?.full_name, repository, 'Foreign deployment repository');
  assert.equal(run.head_repository?.full_name, repository, 'Foreign deployment source');
  assert.equal(run.path, '.github/workflows/deploy-production.yml', 'Not a production deployment');
  assert.equal(run.event, 'workflow_dispatch', 'Unexpected deployment trigger');
  assert.equal(run.head_branch, 'main', 'Deployment must run from main');
  assert.equal(run.status, 'completed', 'Deployment is not complete');
  assert.equal(run.conclusion, 'success', 'Deployment did not succeed');
  assert(Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0, 'Missing deployment attempt');
  const jobs = await listAll(request, `actions/runs/${runId}/attempts/${run.run_attempt}/jobs`, 'jobs');
  const promotion = jobs.filter((job) => job.name === 'Promote, sign and publish');
  if (!promotion.length || promotion.every((job) => job.conclusion === 'skipped')) return null;
  assert.equal(promotion.length, 1, 'Ambiguous production promotion job');
  assert.equal(promotion[0].status, 'completed', 'Promotion is not complete');
  assert.equal(promotion[0].conclusion, 'success', 'Promotion did not succeed');

  const started = timestamp(run.run_started_at);
  const finished = timestamp(run.updated_at);
  const releases = (await listAll(request, 'releases')).filter(
    (release) => !release.draft && !release.prerelease && tagPattern.test(release.tag_name),
  );
  const matches = [];
  for (const release of releases) {
    const published = timestamp(release.published_at);
    if (published < started || published > finished) continue;
    const manifest = await releaseManifest(release, request);
    if (manifest.deploymentRun === `${source}/actions/runs/${runId}`) matches.push({ release, manifest });
  }
  // An idempotent deploy or a rerun can succeed without publishing a new release.
  if (!matches.length) return null;
  assert.equal(matches.length, 1, 'Multiple releases claim the same deployment');
  const { release, manifest } = matches[0];
  const previous = releases
    .filter((candidate) => timestamp(candidate.published_at) < timestamp(release.published_at))
    .sort((a, b) => timestamp(b.published_at) - timestamp(a.published_at))[0];
  const previousSha = previous ? (await releaseManifest(previous, request)).sourceCommit : baselineSha;
  assert(shaPattern.test(previousSha ?? ''), 'First Library release requires JIRA_RELEASE_BASE_SHA');
  const issueKeys = await collectIssueKeys(previousSha, manifest.sourceCommit);
  // A rerun begun during evidence collection must not reuse a superseded successful attempt.
  const current = await request(`actions/runs/${runId}`);
  assert.equal(current.run_attempt, run.run_attempt, 'Deployment attempt changed');
  assert.equal(current.status, 'completed', 'Deployment status changed');
  assert.equal(current.conclusion, 'success', 'Deployment conclusion changed');
  return {
    version: release.tag_name.slice('frameleaf-v'.length),
    sourceSha: manifest.sourceCommit,
    previousSha,
    evidenceUrl: `${source}/releases/tag/${release.tag_name}`,
    releasedAt: release.published_at,
    issueKeys,
    channel: 'library-release',
    mode: 'shipped',
  };
}

async function main() {
  assert.equal(process.env.GITHUB_REPOSITORY, repository, 'Foreign repository');
  assert(process.env.GITHUB_TOKEN, 'Missing GITHUB_TOKEN');
  const [runId, output] = process.argv.slice(2);
  assert(output, 'Receipt output file is required');
  const { gitIssueKeys } = await import('./jira-release.mjs');
  const allowed = (process.env.JIRA_ALLOWED_PROJECTS ?? 'FL').split(',').map((key) => key.trim());
  const receipt = await libraryReceipt({
    runId,
    baselineSha: process.env.JIRA_RELEASE_BASE_SHA,
    request: async (path, asset = false) => {
      const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, {
        headers: {
          Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
          Accept: asset ? 'application/octet-stream' : 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
      assert(response.ok, `GitHub request failed (${response.status}): ${path}`);
      return response.json();
    },
    collectIssueKeys: (base, head) => gitIssueKeys(base, head, allowed),
  });
  if (receipt) await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `shipped=${Boolean(receipt)}\n`);
  console.log(receipt ? `Verified Library ${receipt.version} shipment.` : 'No new Library shipment from this run.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
