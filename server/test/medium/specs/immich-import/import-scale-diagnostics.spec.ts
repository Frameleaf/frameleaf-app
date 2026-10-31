import { type QueryId, RawNode, ValueNode } from 'kysely';
import { createImportScaleDiagnostics } from 'test/medium/import-scale-diagnostics.js';

it.each([
  ['select s.id, s."runId", s."sourceKind" from job_selection s where s.queue = ', 'select-source'],
  ['select i.*, s."safeToRetry", s.sensitive from job_run_item i where i."selectionId" = ', 'select-page'],
  ['update job_run_item i set "jobId"=owner."jobId",state= case when ', 'owner-link'],
  ['update job_run_item i set "jobId" = source."jobId", state = j.state where ', 'membership-link'],
])('identifies the bounded feeder statement %s without logging its parameters', async (statement, phase) => {
  const output: string[] = [];
  let clock = 0;
  const diagnostics = createImportScaleDiagnostics(
    true,
    (line) => {
      output.push(line);
    },
    () => clock,
  );
  const queryId = {} as QueryId;
  const privateValue = 'synthetic-parameter-must-not-be-logged';
  await diagnostics.run('share-feed', async () => {
    diagnostics.plugin.transformQuery({
      queryId,
      node: RawNode.create([statement, ''], [ValueNode.create(privateValue)]),
    });
    clock = 10_500;
    await diagnostics.plugin.transformResult({ queryId, result: { rows: [] } });
    diagnostics.snapshot();
  });
  const receipt = JSON.parse(output.at(-1)!.slice('import-scale-phase '.length));
  expect(receipt.queries[phase]).toEqual({ completed: 1, totalMs: 10_500, maxMs: 10_500 });
  expect(receipt.unmatchedTransforms).toEqual([]);
  expect(output.join('')).not.toContain(privateValue);
});

it('reports an unfinished feeder statement when the test times out', async () => {
  const output: string[] = [];
  const diagnostics = createImportScaleDiagnostics(
    true,
    (line) => {
      output.push(line);
    },
    () => 100,
  );
  await diagnostics.run('share-feed', () => {
    diagnostics.plugin.transformQuery({
      queryId: {} as QueryId,
      node: RawNode.create(['update job_run_item i set "jobId" = source."jobId", state = j.state'], []),
    });
    diagnostics.snapshot();
    const receipt = JSON.parse(output.at(-1)!.slice('import-scale-phase '.length));
    expect(receipt.unmatchedTransforms).toEqual([{ phase: 'membership-link', elapsedMs: 0 }]);
    return Promise.resolve();
  });
});
