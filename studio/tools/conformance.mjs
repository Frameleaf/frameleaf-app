#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseJsonRejectingDuplicateKeys } from '../../scripts/frameleaf-studio-contracts.mjs';

export const AXES = ['native', 'chromium', 'firefox', 'safari', 'command', 'graph', 'preview', 'export', 'timingColor', 'authorizationFailure', 'test'];
const CATALOG_SHA256 = '74e65893486ef0f372c66e140915b8bb98ca32bb07be668efe30514b733c748b';
const SHA256 = /^[a-f0-9]{64}$/;
const NON_RENDERING_ROWS = new Set([
  'readme.projects-storage.1', 'readme.projects-storage.2', 'readme.projects-storage.3',
  'readme.projects-storage.4', 'readme.projects-storage.5',
  'module.projects', 'module.project-bundle', 'module.workspace-gate',
]);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const text = (value, label) => assert(typeof value === 'string' && value.trim(), `${label}: required text`);
const exact = (actual, expected, label) => {
  assert(Array.isArray(actual), `${label}: expected array`);
  assert.equal(new Set(actual).size, actual.length, `${label}: duplicate`);
  assert.deepEqual([...actual].sort(), [...expected].sort(), `${label}: missing or unknown`);
};

export async function loadConformance(root) {
  const files = {
    manifest: 'studio/freecut-feature-manifest.json',
    ownership: 'docs/docs/developer/frameleaf-plan/action-preservation-ledger.json',
    build: 'studio/engine-build.json',
    catalog: 'studio/conformance-fixtures.json',
    overlay: 'studio/conformance.json',
  };
  const data = {};
  for (const [key, file] of Object.entries(files)) {
    const bytes = await readFile(path.join(root, file));
    if (key === 'catalog') assert.equal(digest(bytes), CATALOG_SHA256, 'fixture catalog changed: review every constituent action before updating its pin');
    data[key] = parseJsonRejectingDuplicateKeys(bytes.toString(), file);
  }
  return data;
}

export function fixtureIds(row, axis) {
  const cases = /^(effect|transition|blend)\./.test(row.id)
    ? ['normal', 'invalid', 'animated', 'extreme', 'composed']
    : ['normal', 'invalid'];
  const axisCases = {
    command: ['lease', 'revision', 'access', 'idempotence', 'undo'],
    graph: ['save', 'reopen', 'bundle', 'unknown-fields'],
    timingColor: ['sdr', 'hdr', 'alpha', 'pts', 'audio', 'temporal-recovery'],
    authorizationFailure: ['owner', 'shared', 'viewer', 'sensitive', 'revoked', 'deleted', 'unsupported', 'cancel', 'restart', 'stale-result'],
  };
  return row.actions.flatMap((action) => [...cases, ...(axisCases[axis] ?? [])].map((scenario) => `${row.id}/${action}/${scenario}`));
}

async function artifact(root, reference) {
  text(reference?.path, 'artifact path');
  assert(SHA256.test(reference.sha256), 'artifact SHA-256 required');
  assert(!path.isAbsolute(reference.path), 'artifact path must be repository relative');
  const resolved = await realpath(path.resolve(root, reference.path));
  const relative = path.relative(await realpath(root), resolved);
  assert(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), 'artifact escapes repository');
  const bytes = await readFile(resolved);
  assert.equal(digest(bytes), reference.sha256, `artifact digest mismatch: ${reference.path}`);
  return bytes;
}

export async function validateConformance(data, root, { release = false } = {}) {
  const { manifest, ownership, build, catalog, overlay } = data;
  assert.equal(overlay.schemaVersion, 1);
  assert.equal(catalog.schemaVersion, 1);
  assert.equal(overlay.engineRevision, manifest.engineRevision);
  const ids = manifest.features.map((feature) => feature.id);
  assert.equal(ids.length, 210);
  exact(ids, [...new Set(ids)], 'manifest IDs');
  exact(overlay.rows.map((row) => row.id), ids, 'overlay IDs');
  exact(catalog.rows.map((row) => row.id), ids, 'fixture IDs');
  const owners = ownership.requirements.filter((row) => row.requirementId.startsWith('freecut:'));
  exact(owners.map((row) => row.requirementId.slice(8)), ids, 'ownership IDs');
  for (const [prefix, count] of Object.entries({ effect: 54, transition: 21, blend: 25, command: 19 })) {
    assert.equal(ids.filter((id) => id.startsWith(`${prefix}.`)).length, count);
  }
  const summary = { rows: ids.length, fixtureCases: 0, passedAxes: 0, deferredNative: 0, qualifiedRows: 0, releaseQualified: false };
  for (const row of overlay.rows) {
    const feature = manifest.features.find((entry) => entry.id === row.id);
    const fixture = catalog.rows.find((entry) => entry.id === row.id);
    assert(fixture.actions.length, `${row.id}: constituent actions required`);
    for (const action of fixture.actions) assert(/^[a-z0-9-]+$/.test(action), `${row.id}: invalid action`);
    exact(fixture.actions, [...new Set(fixture.actions)], `${row.id}: actions`);
    const requiredFixtures = fixtureIds(fixture);
    summary.fixtureCases += requiredFixtures.length;
    const owner = owners.find((entry) => entry.requirementId === `freecut:${row.id}`).owners.primary;
    assert(/^FL-\d+$/.test(owner?.jiraKey) && owner.planId, `${row.id}: unowned`);
    assert.deepEqual(row.owner, owner, `${row.id}: owner differs from preservation ledger`);
    exact(Object.keys(row.axes), AXES, `${row.id}: independent axes`);
    let qualified = true;
    for (const axis of AXES) {
      const result = row.axes[axis];
      const label = `${row.id}/${axis}`;
      assert(['not-tested', 'blocked', 'failed', 'deferred', 'passed', 'not-applicable'].includes(result?.status), `${label}: invalid status`);
      const notApplicable = result.status === 'not-applicable';
      if (notApplicable) {
        assert(['preview', 'export'].includes(axis) && NON_RENDERING_ROWS.has(row.id), `${label}: requested feature cannot be waived`);
        text(result.reason, `${label}: semantic non-rendering justification`);
      }
      if (!['passed', 'not-applicable'].includes(result.status)) {
        qualified = false;
        assert(!result.run, `${label}: nonpassing state cannot carry a passing run`);
        if (result.status !== 'not-tested') text(result.reason, `${label}: reason`);
        if (result.status === 'deferred') {
          assert.equal(axis, 'native', `${label}: only native implementation is deferred`);
          summary.deferredNative++;
        }
        continue;
      }
      const bytes = await artifact(root, result.run);
      const run = parseJsonRejectingDuplicateKeys(bytes.toString(), result.run.path);
      assert.equal(run.schemaVersion, 1, `${label}: run schema`);
      assert.equal(run.kind, 'measured-conformance', `${label}: upstream reference is not a measured run`);
      assert.equal(run.featureId, row.id, `${label}: wrong feature`);
      assert.equal(run.axis, axis, `${label}: evidence cannot imply another axis`);
      assert.equal(run.result, result.status, `${label}: failed measurement`);
      assert.equal(run.exitCode, 0, `${label}: command failed`);
      exact(run.fixtureIds, fixtureIds(fixture, notApplicable ? 'graph' : axis), `${label}: constituent fixture coverage`);
      assert.equal(run.engineRevision, manifest.engineRevision, `${label}: engine revision`);
      assert.equal(run.sourceSha256, build.sourceSha256, `${label}: adapted source`);
      assert.deepEqual(run.patches, build.patches, `${label}: patches`);
      assert(/^[a-f0-9]{40}$/.test(run.commit), `${label}: tested commit required`);
      assert(Array.isArray(run.command) && run.command.length > 0, `${label}: actual command required`);
      for (const argument of run.command) text(argument, `${label}: command argument`);
      for (const field of ['target', 'tool', 'hardware', 'parameterDomain', 'tolerances']) text(run[field], `${label}: ${field}`);
      if (['chromium', 'firefox', 'safari'].includes(axis)) assert(run.target.startsWith(`${axis}/`), `${label}: browser name/version required`);
      if (['native', 'chromium', 'firefox', 'safari'].includes(axis)) {
        assert(Array.isArray(run.controlPaths) && run.controlPaths.length > 0, `${label}: concrete controls required`);
        for (const control of run.controlPaths) text(control, `${label}: control path`);
      }
      if (axis === 'command') text(run.operation, `${label}: typed command or canonical graph operation`);
      const start = Date.parse(run.startedAt), end = Date.parse(run.finishedAt);
      assert(Number.isFinite(start) && Number.isFinite(end) && end >= start, `${label}: actual run times required`);
      const sourcePaths = manifest.familySourceInventory[feature.category] ?? feature.source.map((source) => source.path);
      exact(run.sourceReview?.paths, sourcePaths, `${label}: exposed source review`);
      exact(run.sourceReview?.actions, fixture.actions, `${label}: reviewed constituent actions`);
      text(run.sourceReview?.reviewer, `${label}: source reviewer`);
      if (['preview', 'export', 'timingColor'].includes(axis) && !notApplicable) {
        for (const field of ['frameTimeIdentity', 'inputProfiles', 'outputProfiles', 'alpha', 'audio', 'temporalRecovery']) text(run[field], `${label}: ${field}`);
      }
      assert(Array.isArray(run.artifacts) && run.artifacts.length > 0, `${label}: measured artifacts required`);
      for (const reference of run.artifacts) {
        assert.notEqual(reference.path, result.run.path, `${label}: run cannot attest itself`);
        await artifact(root, reference);
      }
      if (!notApplicable) summary.passedAxes++;
    }
    if (qualified) summary.qualifiedRows++;
  }
  summary.releaseQualified = summary.qualifiedRows === ids.length;
  if (release) assert(summary.releaseQualified, `Studio release blocked: ${ids.length - summary.qualifiedRows} rows remain unqualified`);
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert(process.argv.slice(2).every((arg) => arg === '--release'), 'Usage: node studio/tools/conformance.mjs [--release]');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  console.log(JSON.stringify(await validateConformance(await loadConformance(root), root, { release: process.argv.includes('--release') })));
}
