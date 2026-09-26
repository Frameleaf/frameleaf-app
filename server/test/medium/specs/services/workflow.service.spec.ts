import { WorkflowTrigger } from '@immich/plugin-sdk';
import { Kysely, sql } from 'kysely';
import { WorkflowResult, WorkflowRunErrorCode, WorkflowType } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PluginRepository } from 'src/repositories/plugin.repository.js';
import { WorkflowRepository } from 'src/repositories/workflow.repository.js';
import { DB } from 'src/schema/index.js';
import { WorkflowService } from 'src/services/workflow.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  return newMediumService(WorkflowService, {
    database: db || defaultDatabase,
    real: [WorkflowRepository, PluginRepository, AccessRepository],
    mock: [LoggingRepository],
  });
};

const wasmBytes = Buffer.from('random-wasm-bytes');
const sha256hash = Buffer.from('some-manifest-hash');

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(WorkflowService.name, () => {
  let testPluginId: string;

  beforeAll(async () => {
    const { ctx } = setup();
    // Create a test plugin with methods and actions once for all tests
    const pluginRepo = ctx.get(PluginRepository);
    const result = await pluginRepo.upsert(
      {
        enabled: true,
        name: 'test-core-plugin',
        title: 'Test Core Plugin',
        description: 'A test core plugin for workflow tests',
        author: 'Test Author',
        version: '1.0.0',
        templates: [],
        wasmBytes,
        sha256hash,
      },
      [
        {
          name: 'test-filter',
          title: 'Test Filter',
          description: 'A test filter',
          types: [WorkflowType.AssetV1],
          schema: undefined,
        },
        {
          name: 'test-action',
          title: 'Test Action',
          description: 'A test action',
          types: [WorkflowType.AssetV1],
          schema: undefined,
        },
      ],
    );

    testPluginId = result.id;
  });

  afterAll(async () => {
    await defaultDatabase.deleteFrom('plugin').where('id', '=', testPluginId).execute();
  });

  describe('create', () => {
    it('should create a workflow', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();

      const auth = factory.auth({ user });

      const workflow = await sut.create(auth, {
        trigger: WorkflowTrigger.AssetCreate,
        name: 'test-workflow',
        description: 'A test workflow',
        enabled: true,
      });

      expect(workflow).toMatchObject({
        id: expect.any(String),
        trigger: WorkflowTrigger.AssetCreate,
        name: 'test-workflow',
        description: 'A test workflow',
        enabled: true,
      });
    });
  });

  describe('definitions (FL-82)', () => {
    it('stores an imported definition with an unknown method paused and reads it back unchanged', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });

      const created = await sut.create(auth, {
        trigger: WorkflowTrigger.AssetCreate,
        name: 'imported',
        enabled: false,
        extra: { source: 'elsewhere' },
        steps: [
          { method: 'test-core-plugin#test-filter', config: { keep: ['a'] } },
          { method: 'missing-plugin#gone', config: { threshold: 3 }, enabled: false, extra: { note: 'kept' } },
          { method: 'test-core-plugin#test-action', config: null },
        ],
      });

      const read = await sut.get(auth, created.id);
      expect(read.extra).toEqual({ source: 'elsewhere' });
      expect(read.steps.map(({ method, config, enabled, extra }) => ({ method, config, enabled, extra }))).toEqual([
        { method: 'test-core-plugin#test-filter', config: { keep: ['a'] }, enabled: true, extra: {} },
        { method: 'missing-plugin#gone', config: { threshold: 3 }, enabled: false, extra: { note: 'kept' } },
        { method: 'test-core-plugin#test-action', config: null, enabled: true, extra: {} },
      ]);
      expect(read.issues).toEqual([expect.objectContaining({ step: 1, code: 'method_unavailable' })]);

      // only installed steps are runnable, at their definition positions
      const runnable = await defaultDatabase
        .selectFrom('workflow_step')
        .select(['id', 'order'])
        .where('workflowId', '=', created.id)
        .orderBy('order')
        .execute();
      expect(runnable).toEqual([
        { id: read.steps[0].id, order: 0 },
        { id: read.steps[2].id, order: 2 },
      ]);

      await expect(sut.update(auth, created.id, { enabled: true })).rejects.toThrow(/unavailable/);
      expect((await sut.get(auth, created.id)).enabled).toBe(false);
    });

    it('keeps a step whose runnable row a plugin upgrade deleted, and never runs without it', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });

      const created = await sut.create(auth, {
        trigger: WorkflowTrigger.AssetCreate,
        enabled: true,
        steps: [{ method: 'test-core-plugin#test-filter', config: null }],
      });
      // what pruning a method does to the shared step table
      await defaultDatabase.deleteFrom('workflow_step').where('workflowId', '=', created.id).execute();

      const read = await sut.get(auth, created.id);
      expect(read.steps).toHaveLength(1);
      const run = await ctx.get(WorkflowRepository).getForWorkflowRun(created.id);
      expect(run?.steps).toEqual([]);
      expect(run?.definition?.steps).toHaveLength(1);
    });

    it('records the attempt and failure of a logged run', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const created = await sut.create(auth, { trigger: WorkflowTrigger.AssetCreate, enabled: false, logging: true });
      const runId = '00000000-0000-4000-8000-000000000123';

      await ctx.get(WorkflowRepository).log({
        workflowId: created.id,
        runId,
        result: WorkflowResult.Error,
        attempt: 1,
        errorCode: WorkflowRunErrorCode.StepFailed,
        error: 'plugin failed',
      });

      const [entry] = await sut.getLogs(auth, created.id, { limit: 10 });
      expect(entry).toMatchObject({ runId, attempt: 1, errorCode: 'step_failed', error: 'plugin failed' });
      expect(await ctx.get(WorkflowRepository).getLatestRunAttempt(created.id, runId)).toMatchObject({ attempt: 1 });

      await sut.update(auth, created.id, { logging: false });
      const details = await defaultDatabase
        .selectFrom('workflow_log_detail')
        .selectAll()
        .where('workflowId', '=', created.id)
        .execute();
      expect(details).toEqual([]);
    });

    it('keeps the steps a queued run completed, once each, until they are old or the workflow goes (FL-179)', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const created = await sut.create(auth, { trigger: WorkflowTrigger.AssetCreate, enabled: false });
      const repository = ctx.get(WorkflowRepository);
      const executionId = '00000000-0000-4000-8000-000000000179';
      const otherExecutionId = '00000000-0000-4000-8000-000000000180';
      const filterStep = '00000000-0000-4000-8000-000000000001';
      const actionStep = '00000000-0000-4000-8000-000000000002';

      await repository.completeStep({ executionId, workflowId: created.id, stepId: filterStep, halted: false });
      // a replay that records the same step again changes nothing
      await repository.completeStep({ executionId, workflowId: created.id, stepId: filterStep, halted: false });
      await repository.completeStep({ executionId, workflowId: created.id, stepId: actionStep, halted: true });

      await expect(repository.getCompletedSteps(executionId)).resolves.toEqual(
        new Map([
          [filterStep, { halted: false }],
          [actionStep, { halted: true }],
        ]),
      );
      // a retry is queued with its own execution id, and starts with nothing completed
      await expect(repository.getCompletedSteps(otherExecutionId)).resolves.toEqual(new Map());

      await expect(repository.deleteCompletedStepsBefore(new Date(Date.now() - 60_000))).resolves.toBe(0);
      await expect(repository.getCompletedSteps(executionId)).resolves.toHaveProperty('size', 2);

      await repository.completeStep({
        executionId: otherExecutionId,
        workflowId: created.id,
        stepId: filterStep,
        halted: false,
      });
      await expect(repository.deleteCompletedStepsBefore(new Date(Date.now() + 60_000))).resolves.toBe(3);
      await expect(repository.getCompletedSteps(executionId)).resolves.toEqual(new Map());

      await repository.completeStep({ executionId, workflowId: created.id, stepId: filterStep, halted: false });
      await sut.delete(auth, created.id);
      await expect(repository.getCompletedSteps(executionId)).resolves.toEqual(new Map());
    });

    it('records and skips nothing on a database without the step table, and checks again when reset (FL-179)', async () => {
      // a database past its handoff cutover does not receive new Frameleaf public migrations
      const database = await getKyselyDB();
      await sql`DROP TABLE workflow_run_step`.execute(database);
      const { sut, ctx } = setup(database);
      const { user } = await ctx.newUser();
      const created = await sut.create(factory.auth({ user }), {
        trigger: WorkflowTrigger.AssetCreate,
        enabled: false,
      });
      const repository = ctx.get(WorkflowRepository);
      const executionId = '00000000-0000-4000-8000-000000000181';
      const stepId = '00000000-0000-4000-8000-000000000003';

      await expect(repository.hasRunStepTable()).resolves.toBe(false);
      await expect(
        repository.completeStep({ executionId, workflowId: created.id, stepId, halted: false }),
      ).resolves.toBeUndefined();
      await expect(repository.getCompletedSteps(executionId)).resolves.toEqual(new Map());
      await expect(repository.deleteCompletedStepsBefore(new Date())).resolves.toBe(0);

      // the table appears (a later migration): cached as missing until checked again
      await sql`CREATE TABLE workflow_run_step (
        "executionId" uuid NOT NULL, "stepId" uuid NOT NULL, "workflowId" uuid NOT NULL,
        halted boolean NOT NULL DEFAULT false, "createdAt" timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY ("executionId", "stepId"))`.execute(database);
      await expect(repository.hasRunStepTable()).resolves.toBe(false);
      repository.resetRunStepTable();
      await expect(repository.hasRunStepTable()).resolves.toBe(true);
      await repository.completeStep({ executionId, workflowId: created.id, stepId, halted: false });
      await expect(repository.getCompletedSteps(executionId)).resolves.toEqual(new Map([[stepId, { halted: false }]]));
    });
  });

  describe('getAll', () => {
    it('should return all workflows for a user', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });

      const workflow1 = await sut.create(auth, {
        trigger: WorkflowTrigger.AssetCreate,
        name: 'workflow-1',
        description: 'First workflow',
        enabled: true,
      });

      const workflow2 = await sut.create(auth, {
        trigger: WorkflowTrigger.AssetCreate,
        name: 'workflow-2',
        description: 'Second workflow',
        enabled: false,
      });

      const workflows = await sut.search(auth, {});

      expect(workflows).toHaveLength(2);
      expect(workflows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: workflow1.id, name: 'workflow-1' }),
          expect.objectContaining({ id: workflow2.id, name: 'workflow-2' }),
        ]),
      );
    });

    it('should return empty array when user has no workflows', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });

      const workflows = await sut.search(auth, {});

      expect(workflows).toEqual([]);
    });

    it('should not return workflows from other users', async () => {
      const { sut, ctx } = setup();
      const { user: user1 } = await ctx.newUser();
      const { user: user2 } = await ctx.newUser();
      const auth1 = factory.auth({ user: user1 });
      const auth2 = factory.auth({ user: user2 });

      await sut.create(auth1, {
        trigger: WorkflowTrigger.AssetCreate,
        name: 'user1-workflow',
        description: 'User 1 workflow',
        enabled: true,
      });

      const user2Workflows = await sut.search(auth2, {});

      expect(user2Workflows).toEqual([]);
    });
  });
});
