import assert from 'node:assert/strict';
import test from 'node:test';
import { createImportScaleDiagnostics } from '../server/test/medium/import-scale-diagnostics.ts';

const raw = (statement) => ({ kind: 'RawNode', sqlFragments: [statement], parameters: ['private-value'] });

test('records an unfinished phase and unmatched transform without leaking SQL or parameters', async () => {
  let time = 0;
  const lines = [];
  const diagnostics = createImportScaleDiagnostics(
    true,
    (line) => lines.push(line),
    () => time,
  );
  const queryId = {};
  const node = raw('update frameleaf_immich_import_work w set dispatched_at = private-value');
  let release;
  const pending = diagnostics.run('dispatch', () => new Promise((resolve) => (release = resolve)));
  assert.equal(diagnostics.plugin.transformQuery({ node, queryId }), node);
  time = 60_000;
  diagnostics.snapshot();
  assert.ok(lines.length > 0, 'an unfinished operation must emit progress before completion');
  const snapshot = JSON.parse(lines.at(-1).slice('import-scale-phase '.length));
  assert.equal(snapshot.event, 'test-failed');
  assert.equal(snapshot.phase, 'dispatch');
  assert.equal(snapshot.phaseMs, 60_000);
  assert.deepEqual(snapshot.unmatchedTransforms, [{ phase: 'acknowledgement', elapsedMs: 60_000 }]);
  assert.equal(lines.join('').includes('private-value'), false);
  release(7);
  assert.equal(await pending, 7);
});

test('splits each share/feed visit and retains query completion totals', async () => {
  let time = 0;
  const lines = [];
  const diagnostics = createImportScaleDiagnostics(
    true,
    (line) => lines.push(line),
    () => time,
  );
  const queryId = {};
  const result = { rows: [{ secret: 'private-result' }] };
  await diagnostics.run('share-feed', async () => {
    time = 12;
    diagnostics.plugin.transformQuery({ node: raw('select paused, "manifestFilling" from job_queue'), queryId });
    time = 19;
    assert.equal(await diagnostics.plugin.transformResult({ result, queryId }), result);
  });
  assert.ok(lines.length > 0, 'a visit must emit its share and feed phases');
  const records = lines.map((line) => JSON.parse(line.slice('import-scale-phase '.length)));
  assert.ok(
    records.some(
      (event) => event.event === 'phase-end' && event.phase === 'share' && event.phaseMs === 12 && event.visit === 1,
    ),
  );
  assert.ok(
    records.some(
      (event) => event.event === 'phase-end' && event.phase === 'feed' && event.phaseMs === 7 && event.visit === 1,
    ),
  );
  assert.equal(records.at(-1).queries.other.completed, 1);
  assert.equal(records.at(-1).queries.other.totalMs, 7);
  assert.equal(lines.join('').includes('private-result'), false);
});

test('does not change failures, emits nothing when disabled, and bounds repeated query output', async () => {
  const failure = new Error('private-error');
  const lines = [];
  const disabled = createImportScaleDiagnostics(false, (line) => lines.push(line));
  await assert.rejects(
    disabled.run('seed', async () => {
      throw failure;
    }),
    (error) => error === failure,
  );
  disabled.snapshot();
  assert.deepEqual(lines, []);
  const enabled = createImportScaleDiagnostics(
    true,
    (line) => lines.push(line),
    () => 0,
  );
  await assert.rejects(
    enabled.run('seed', async () => {
      throw failure;
    }),
    (error) => error === failure,
  );
  for (let index = 0; index < 1000; index++) {
    const queryId = {};
    enabled.plugin.transformQuery({ node: raw('insert into job_run_item("runId") select private-value'), queryId });
    await enabled.plugin.transformResult({ result: { rows: [] }, queryId });
  }
  enabled.snapshot();
  assert.ok(lines.length > 0, 'enabled diagnostics must emit progress');
  assert.ok(lines.length <= 258);
  assert.equal(JSON.parse(lines.at(-1).slice('import-scale-phase '.length)).event, 'test-failed');
  assert.equal(JSON.parse(lines.at(-1).slice('import-scale-phase '.length)).truncated, true);
  assert.equal(lines.join('').includes('private-error'), false);
});

// A classifier regression must not hide the two final dispatch boundaries.
test('labels capture, retained audit and enumeration SQL without inspecting parameters', async () => {
  const lines = [];
  const diagnostics = createImportScaleDiagnostics(
    true,
    (line) => lines.push(line),
    () => 1,
  );
  for (const [statement, phase] of [
    ['insert into job_run_item("runId", "itemKey") select private-value', 'capture'],
    [
      'select 1 from frameleaf_immich_import_work w\n    where w.dispatched_at is null or not private-value limit 1',
      'retained-audit',
    ],
    ['update job_run set "enumerationDone" = true where id = private-value', 'finish-enumeration'],
  ]) {
    const queryId = {};
    diagnostics.plugin.transformQuery({ node: raw(statement), queryId });
    const record = JSON.parse(lines.at(-1).slice('import-scale-phase '.length));
    assert.equal(record.unmatchedTransforms.at(-1).phase, phase);
    await diagnostics.plugin.transformResult({ result: { rows: [] }, queryId });
  }
  assert.equal(lines.join('').includes('private-value'), false);
});

test('aggregates acknowledgement pages without logging each page', async () => {
  const lines = [];
  const diagnostics = createImportScaleDiagnostics(
    true,
    (line) => lines.push(line),
    () => 1,
  );
  for (let page = 0; page < 51; page++) {
    const queryId = {};
    diagnostics.plugin.transformQuery({
      node: raw('update frameleaf_immich_import_work w set dispatched_at = now()'),
      queryId,
    });
    await diagnostics.plugin.transformResult({ result: { rows: [] }, queryId });
  }
  assert.equal(lines.length, 3);
  diagnostics.snapshot();
  const record = JSON.parse(lines.at(-1).slice('import-scale-phase '.length));
  assert.equal(record.queries.acknowledgement.completed, 51);
  assert.deepEqual(record.unmatchedTransforms, []);
});

test('embedding five structured selection nodes creates no unmatched SQL observations', () => {
  const lines = [];
  const diagnostics = createImportScaleDiagnostics(
    true,
    (line) => lines.push(line),
    () => 60_000,
  );
  for (let selection = 0; selection < 5; selection++) {
    const node = { kind: 'SelectQueryNode', from: 'private-table' };
    assert.equal(diagnostics.plugin.transformQuery({ node, queryId: {} }), node);
  }
  diagnostics.snapshot();
  const record = JSON.parse(lines.at(-1).slice('import-scale-phase '.length));
  assert.deepEqual(record.unmatchedTransforms, []);
  assert.equal(lines.join('').includes('private-table'), false);
});

test('an unmatched raw transform is reported without claiming a pending SQL execution', () => {
  const lines = [];
  const diagnostics = createImportScaleDiagnostics(
    true,
    (line) => lines.push(line),
    () => 1,
  );
  diagnostics.plugin.transformQuery({ node: raw('select private-value'), queryId: {} });
  diagnostics.snapshot();
  const record = JSON.parse(lines.at(-1).slice('import-scale-phase '.length));
  assert.equal('pending' in record, false);
  assert.deepEqual(record.unmatchedTransforms, [{ phase: 'other', elapsedMs: 0 }]);
});
