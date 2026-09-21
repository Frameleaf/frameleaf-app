import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { AXES, fixtureIds, loadConformance, validateConformance } from './conformance.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const original = await loadConformance(root);

test('all immutable IDs have owners and separate unmeasured axes; release stays blocked', async () => {
  const summary = await validateConformance(original, root);
  assert.equal(summary.rows, 210);
  assert.equal(summary.passedAxes, 0);
  assert.equal(summary.deferredNative, 210);
  assert.equal(summary.releaseQualified, false);
  assert.equal(new Set(original.catalog.rows.flatMap(fixtureIds)).size, summary.fixtureCases);
  await assert.rejects(validateConformance(original, root, { release: true }), /release blocked/);
});

test('missing, duplicate, unknown, unowned and inferred rows fail', async () => {
  for (const mutate of [
    (data) => data.overlay.rows.pop(),
    (data) => data.overlay.rows.push(data.overlay.rows[0]),
    (data) => { data.overlay.rows[0].id = 'unknown'; },
    (data) => { delete data.overlay.rows[0].owner; },
    (data) => { delete data.overlay.rows[0].axes.safari; },
    (data) => { data.overlay.rows[0].axes.command = { status: 'deferred', reason: 'native deferred' }; },
    (data) => { data.overlay.rows[0].axes.preview = { status: 'not-applicable', reason: 'skip requested rendering' }; },
    (data) => { data.overlay.rows[0].axes.test = { status: 'passed', upstreamTestFiles: ['upstream.test.ts'] }; },
    (data) => data.catalog.rows.pop(),
  ]) {
    const data = structuredClone(original);
    mutate(data);
    await assert.rejects(validateConformance(data, root));
  }
});

test('a measured run binds one axis, all constituent cases, exact source and actual artifacts', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'frameleaf-conformance-test-'));
  const save = async (name, body) => {
    const bytes = typeof body === 'string' ? body : JSON.stringify(body);
    await writeFile(path.join(temporary, name), bytes);
    return { path: name, sha256: createHash('sha256').update(bytes).digest('hex') };
  };
  try {
    const data = structuredClone(original);
    const row = data.overlay.rows[0];
    const fixture = data.catalog.rows[0];
    const run = {
      schemaVersion: 1, kind: 'measured-conformance', featureId: row.id, axis: 'test',
      result: 'passed', exitCode: 0, fixtureIds: fixtureIds(fixture),
      engineRevision: data.manifest.engineRevision, sourceSha256: data.build.sourceSha256,
      patches: data.build.patches, commit: 'a'.repeat(40),
      command: ['node', 'synthetic-validator-fixture.mjs'], target: 'synthetic validator test only',
      tool: 'node test', hardware: 'synthetic test environment', parameterDomain: 'synthetic inputs', tolerances: 'exact',
      startedAt: '2026-09-21T00:00:00Z', finishedAt: '2026-09-21T00:00:01Z',
      sourceReview: { paths: data.manifest.familySourceInventory[data.manifest.features[0].category], actions: fixture.actions, reviewer: 'synthetic fixture' },
      artifacts: [await save('output.txt', 'Synthetic validator evidence; not Freecut conformance.')],
    };
    row.axes.test = { status: 'passed', run: await save('run.json', run) };
    const summary = await validateConformance(data, temporary);
    assert.equal(summary.passedAxes, 1);
    assert.equal(summary.qualifiedRows, 0);
    for (const axis of AXES.filter((axis) => axis !== 'test')) assert.notEqual(row.axes[axis].status, 'passed');
    const persistence = data.overlay.rows.find((entry) => entry.id === 'module.projects');
    const persistenceFixture = data.catalog.rows.find((entry) => entry.id === persistence.id);
    const persistenceFeature = data.manifest.features.find((entry) => entry.id === persistence.id);
    const storageRun = {
      ...run, featureId: persistence.id, axis: 'preview', result: 'not-applicable',
      fixtureIds: fixtureIds(persistenceFixture, 'graph'),
      sourceReview: { paths: persistenceFeature.source.map((source) => source.path), actions: persistenceFixture.actions, reviewer: 'synthetic fixture' },
    };
    persistence.axes.preview = { status: 'not-applicable', reason: 'Synthetic storage-only lifecycle case; no rendered output.', run: await save('storage.json', storageRun) };
    assert.equal((await validateConformance(data, temporary)).passedAxes, 1);
    delete persistence.axes.preview.reason;
    await assert.rejects(validateConformance(data, temporary), /semantic non-rendering justification/);
    persistence.axes.preview = { status: 'not-tested' };
    const mixed = data.overlay.rows.find((entry) => entry.id === 'readme.projects-storage.6');
    const mixedFixture = data.catalog.rows.find((entry) => entry.id === mixed.id);
    const mixedFeature = data.manifest.features.find((entry) => entry.id === mixed.id);
    for (const axis of ['preview', 'export']) {
      const mixedRun = {
        ...storageRun, featureId: mixed.id, axis,
        fixtureIds: fixtureIds(mixedFixture, 'graph'),
        sourceReview: { paths: data.manifest.familySourceInventory[mixedFeature.category], actions: mixedFixture.actions, reviewer: 'synthetic fixture' },
      };
      mixed.axes[axis] = { status: 'not-applicable', reason: 'Storage coverage cannot waive the thumbnail constituent.', run: await save('mixed.json', mixedRun) };
      await assert.rejects(validateConformance(data, temporary), /requested feature cannot be waived/);
      mixed.axes[axis] = { status: 'not-tested' };
    }
    for (const mutate of [
      (value) => value.fixtureIds.pop(),
      (value) => { value.axis = 'preview'; },
      (value) => { value.kind = 'upstream-test-reference'; },
      (value) => { value.sourceSha256 = '0'.repeat(64); },
      (value) => { value.exitCode = 1; },
      (value) => { delete value.startedAt; },
      (value) => { value.artifacts[0].sha256 = '0'.repeat(64); },
      (value) => { value.artifacts[0].path = '../outside'; },
      (value) => value.sourceReview.paths.pop(),
    ]) {
      const changed = structuredClone(run);
      mutate(changed);
      row.axes.test.run = await save('run.json', changed);
      await assert.rejects(validateConformance(data, temporary));
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
