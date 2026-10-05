import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const { verifyNasCertification, NAS_ATTESTATION_TYPE } = require('../../.github/verify-release-bundle.cjs');
const { hash, SOURCE, REPOSITORY } = require('../../.github/frameleaf-release.cjs');

test('a selected migration family still requires an exact signed report and successful trusted qualification', async () => {
  const server = 'ghcr.io/frameleaf/frameleaf-server@sha256:' + 'a'.repeat(64);
  const postgres = 'ghcr.io/frameleaf/frameleaf-postgres:14@sha256:' + 'b'.repeat(64);
  const sourceCommit = 'a'.repeat(40),
    reportCommit = 'b'.repeat(40);
  const release = {
    tag: 'frameleaf-v3.2.0-1',
    sourceCommit,
    certifiedBuildRun: SOURCE + '/actions/runs/1',
    images: [{ image: 'ghcr.io/frameleaf/frameleaf-server', digest: 'sha256:' + 'a'.repeat(64), suffix: '' }],
    dependencies: [{ reference: postgres, digest: 'sha256:' + 'b'.repeat(64) }],
  };
  const nas = {
    ...release,
    schemaVersion: 1,
    images: { server, postgres },
    migration: { officialImmich: ['v3.1.0'], priorFrameleaf: [] },
  };
  const report = {
    schemaVersion: 1,
    environment: 'sanitized-production-shaped',
    sourceVersion: 'v3.1.0',
    targetServer: server,
    targetPostgres: postgres,
    sourceCommit,
    run: SOURCE + '/actions/runs/2',
    sourcePostgres: { major: 14, extensions: [{ name: 'vector', version: '0.8.1' }] },
    checks: { preflight: 'passed', backupRestore: 'passed', migration: 'passed', rollback: 'passed' },
  };
  const body = JSON.stringify(report);
  const receipts = {
    officialImmich: [
      {
        version: 'v3.1.0',
        evidence: { commit: reportCommit, path: 'packaging/nas/qualification/manager-import.json', digest: hash(body) },
      },
    ],
  };
  const request = async (endpoint: string) => {
    if (endpoint.startsWith('contents/')) return { encoding: 'base64', content: Buffer.from(body).toString('base64') };
    if (endpoint === 'actions/runs/2')
      return {
        head_sha: sourceCommit,
        head_branch: 'fork/main',
        head_repository: { full_name: REPOSITORY },
        event: 'push',
        status: 'completed',
        conclusion: 'success',
        path: '.github/workflows/nas-qualification.yml',
      };
    if (endpoint === 'actions/runs/2/jobs?filter=latest&per_page=100')
      return {
        total_count: 1,
        jobs: [
          {
            name: 'NAS qualification (officialImmich, v3.1.0)',
            conclusion: 'success',
            steps: ['Preflight', 'Backup and restore', 'Migration', 'Rollback'].map((name) => ({
              name,
              conclusion: 'success',
            })),
          },
        ],
      };
    throw new Error('Unexpected verification request');
  };
  const run = () =>
    JSON.stringify({
      payload: Buffer.from(
        JSON.stringify({
          predicateType: NAS_ATTESTATION_TYPE,
          predicate: report,
          subject: [{ name: 'ghcr.io/frameleaf/frameleaf-server', digest: { sha256: 'a'.repeat(64) } }],
        }),
      ).toString('base64'),
    });
  const options = { request, run, families: ['officialImmich'] };
  const result = await verifyNasCertification(nas, release, receipts, options);
  assert.deepEqual(result, [{ family: 'officialImmich', version: 'v3.1.0', report }]);
  // NAS callers retain their original both-family requirement.
  await assert.rejects(verifyNasCertification(nas, release, receipts, { request, run }), /priorFrameleaf/);
  for (const families of [[], ['anything'], ['officialImmich', 'officialImmich']])
    await assert.rejects(verifyNasCertification(nas, release, receipts, { ...options, families }), /migration family/);
  await assert.rejects(verifyNasCertification(nas, release, { officialImmich: [] }, options), /receipts differ/);
  await assert.rejects(
    verifyNasCertification(nas, release, receipts, {
      ...options,
      run: () => {
        throw new Error('signature refused');
      },
    }),
    /signature refused/,
  );
  await assert.rejects(
    verifyNasCertification(nas, release, receipts, {
      ...options,
      request: async (endpoint: string) =>
        endpoint.includes('/jobs?') ? { total_count: 0, jobs: [] } : request(endpoint),
    }),
    /successful migration qualification steps/,
  );
});
