import { WorkflowTrigger } from '@frameleaf/plugin-sdk';
import { randomUUID } from 'node:crypto';
import { Kysely } from 'kysely';
import { AssetVisibility } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { WorkflowRepository } from 'src/repositories/workflow.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { toDefinition } from 'src/utils/workflow-definition.js';
import { workflowDefinitionHash } from 'src/utils/workflow-source.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let database: Kysely<DB>;
beforeAll(async () => {
  database = await getKyselyDB();
});
const setup = () => newMediumService(BaseService, { database, real: [WorkflowRepository], mock: [LoggingRepository] });

describe('durable workflow selections', () => {
  it('freezes every eligible owned match beyond a search page and coalesces concurrent runs', async () => {
    const { ctx } = setup();
    const repository = ctx.get(WorkflowRepository);
    const { user } = await ctx.newUser();
    const { user: other } = await ctx.newUser();
    for (let index = 0; index < 260; index++) await ctx.newAsset({ ownerId: user.id });
    await ctx.newAsset({ ownerId: other.id });
    await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Locked });
    await ctx.newAsset({ ownerId: user.id, deletedAt: new Date() });
    const definition = toDefinition({ trigger: 'AssetChanged', source: { filter: {} }, steps: [] });
    const workflow = await repository.create(
      { ownerId: user.id, trigger: WorkflowTrigger.AssetChanged, enabled: true },
      definition,
      [],
    );
    const input = {
      workflowId: workflow.id,
      ownerId: user.id,
      definition,
      source: { filter: {} },
      definitionSha256: workflowDefinitionHash(definition),
      reason: 'manual' as const,
      snapshotAt: new Date(),
    };
    const [first, second] = await Promise.all([repository.createBatch(input), repository.createBatch(input)]);
    expect(first.id).toBe(second.id);
    expect(first.total).toBe(260);
    expect(first.source).toEqual({ filter: {} });
    expect(first.definition).toEqual(definition);
    const restarted = new WorkflowRepository(database);
    expect((await restarted.getBatches(workflow.id))[0]?.total).toBe(260);
    await repository.update(workflow.id, { enabled: false });
    expect(await repository.nextBatchItem(first.id)).toBeUndefined();
    expect((await restarted.getBatches(workflow.id))[0]?.status).toBe('cancelled');
  }, 30000);
  it('refuses a definition changed between source preparation and atomic snapshot capture', async () => {
    const { ctx } = setup();
    const repository = ctx.get(WorkflowRepository);
    const { user } = await ctx.newUser();
    const definition = toDefinition({ trigger: 'AssetChanged', source: { filter: {} }, steps: [] });
    const workflow = await repository.create(
      { ownerId: user.id, trigger: WorkflowTrigger.AssetChanged, enabled: true },
      definition,
      [],
    );
    await repository.update(workflow.id, { enabled: false });
    await expect(
      repository.createBatch({
        workflowId: workflow.id,
        ownerId: user.id,
        definition,
        source: { filter: {} },
        definitionSha256: workflowDefinitionHash(definition),
        reason: 'manual',
        snapshotAt: new Date(),
      }),
    ).rejects.toThrow();
  });
  it('persists a retry checkpoint and retains active steps during cleanup', async () => {
    const { ctx } = setup();
    const repository = ctx.get(WorkflowRepository);
    const { user } = await ctx.newUser();
    await ctx.newAsset({ ownerId: user.id });
    const definition = toDefinition({ trigger: 'AssetChanged', source: { filter: {} }, steps: [] });
    const workflow = await repository.create(
      { ownerId: user.id, trigger: WorkflowTrigger.AssetChanged, enabled: true },
      definition,
      [],
    );
    const batch = await repository.createBatch({
      workflowId: workflow.id,
      ownerId: user.id,
      definition,
      source: { filter: {} },
      definitionSha256: workflowDefinitionHash(definition),
      reason: 'manual',
      snapshotAt: new Date(),
    });
    const item = (await repository.nextBatchItem(batch.id))!;
    const stepId = randomUUID();
    await repository.completeStep({ executionId: item.id, workflowId: workflow.id, stepId, halted: false });
    await repository.retryBatchItem(batch.id, item.id, stepId);
    expect(await new WorkflowRepository(database).nextBatchItem(batch.id)).toMatchObject({
      id: item.id,
      attempt: 1,
      fromStepId: stepId,
    });
    await repository.deleteCompletedStepsBefore(new Date(Date.now() + 1000));
    expect((await repository.getCompletedSteps(item.id)).has(stepId)).toBe(true);
  });
});

it('accepts plugin-owned state into the active snapshot without accepting an intervening edit', async () => {
  const { ctx } = setup();
  const repository = ctx.get(WorkflowRepository);
  const { user } = await ctx.newUser();
  const definition = toDefinition({
    trigger: 'AssetChanged',
    source: { filter: {} },
    steps: [{ method: 'plugin#stateful', config: { count: 0 } }],
  });
  const workflow = await repository.create(
    { ownerId: user.id, trigger: WorkflowTrigger.AssetChanged, enabled: true },
    definition,
    [],
  );
  const hash = workflowDefinitionHash(definition);
  const batch = await repository.createBatch({
    workflowId: workflow.id,
    ownerId: user.id,
    definition,
    source: { filter: {} },
    definitionSha256: hash,
    reason: 'manual',
    snapshotAt: new Date(),
  });
  await repository.updateStepConfig(
    workflow.id,
    definition.steps[0]!.id,
    { count: 1 },
    { batchId: batch.id, expectedHash: hash },
  );
  expect((await repository.getBatches(workflow.id))[0]?.definition.steps[0]?.config).toEqual({ count: 1 });
  await repository.update(workflow.id, { enabled: false });
  await expect(
    repository.updateStepConfig(
      workflow.id,
      definition.steps[0]!.id,
      { count: 2 },
      { batchId: batch.id, expectedHash: hash },
    ),
  ).rejects.toThrow();
});

it('admits a workflow and asset once across sibling jobs in the same causal chain, while allowing its retry', async () => {
  const { ctx } = setup();
  const repository = ctx.get(WorkflowRepository);
  const { user } = await ctx.newUser();
  const definition = toDefinition({ trigger: 'AssetChanged', source: { filter: {} }, steps: [] });
  const workflow = await repository.create(
    { ownerId: user.id, trigger: WorkflowTrigger.AssetChanged, enabled: true },
    definition,
    [],
  );
  const chainId = randomUUID(),
    assetId = randomUUID(),
    runId = randomUUID();
  expect(await repository.claimCausation(chainId, workflow.id, assetId, runId)).toBe(true);
  expect(await repository.claimCausation(chainId, workflow.id, assetId, runId)).toBe(true);
  expect(await repository.claimCausation(chainId, workflow.id, assetId, randomUUID())).toBe(false);
  expect(await repository.claimCausation(randomUUID(), workflow.id, assetId, randomUUID())).toBe(true);
});
