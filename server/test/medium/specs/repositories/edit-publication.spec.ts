import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { AssetDevelopRevisionStatus } from 'src/dtos/asset-develop.dto.js';
import { JobName, JobStatus, MediaOperationStatus } from 'src/enum.js';
import { publishJobResult, queueExecution } from 'src/queue/context.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { publicationTransaction } from 'src/queue/transaction.js';
import { QUEUE_TIMING, QueueExecution } from 'src/queue/types.js';
import { AssetDevelopRepository } from 'src/repositories/asset-develop.repository.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { DB } from 'src/schema/index.js';
import { defaultDevelopRecipe } from 'src/utils/develop-recipe.js';
import { EditOperationTracker } from 'src/utils/edit-operation-tracker.js';
import { EditOperationEdit, editOperationCreate } from 'src/utils/edit-operation.js';
import { seedCanonicalAsset, seedCanonicalUser } from 'test/fixtures/canonical-database.js';
import { getKyselyDB } from 'test/utils.js';

describe('queue and edit publication atomicity', () => {
  let db: Kysely<DB>;
  beforeAll(async () => {
    db = await getKyselyDB();
  });
  afterAll(async () => {
    await db?.destroy();
  });

  const prepare = async () => {
    const user = await seedCanonicalUser(db);
    const asset = await seedCanonicalAsset(db, { ownerId: user.id });
    const revisions = new AssetDevelopRepository(db);
    const input = {
      ownerId: user.id,
      assetId: asset.id,
      recipe: defaultDevelopRecipe(),
      recipeVersion: 1,
      label: null,
    };
    const previous = await revisions.create({
      ...input,
      status: AssetDevelopRevisionStatus.Rendered,
      masterPath: '/previous-master',
    });
    await revisions.setCurrent(asset.id, previous.id);
    const candidate = await revisions.create({ ...input, status: AssetDevelopRevisionStatus.Rendering });
    const operations = new MediaOperationRepository(db);
    const operation = await operations.create(
      editOperationCreate({
        ownerId: user.id,
        assetId: asset.id,
        edit: EditOperationEdit.PhotoVersion,
        label: 'test image',
        revisionId: candidate.id,
        job: { name: JobName.AssetDevelopRender, data: { id: candidate.id } },
      }),
    );
    const store = new SqlQueueStore(db);
    const queue = `edit-${randomUUID()}`;
    const worker = randomUUID();
    await store.initialize([queue], worker);
    await store.enqueue([
      {
        queue,
        name: JobName.AssetDevelopRender,
        data: { id: candidate.id, operationId: operation.id },
        safeToRetry: false,
        sensitive: false,
        deadlineMs: QUEUE_TIMING.opaqueDeadline,
      },
    ]);
    const [claim] = await store.claim(queue, worker);
    const context: QueueExecution = {
      claim,
      signal: new AbortController().signal,
      progress: vi.fn(),
      progressUnits: 0,
      buffering: false,
      adoptions: [],
      followups: [],
    };
    const tracker = new EditOperationTracker(operations, {} as never, { log: vi.fn(), warn: vi.fn(), error: vi.fn() });
    await queueExecution.run(context, () =>
      tracker.execute(operation.id, async () => {
        await publishJobResult(async () => {
          await revisions.update(candidate.id, {
            status: AssetDevelopRevisionStatus.Rendered,
            masterPath: '/attempt/master',
          });
          await revisions.setCurrent(asset.id, candidate.id);
        });
        return JobStatus.Success;
      }),
    );
    const commit = () =>
      store.complete(claim, [], (tx) =>
        publicationTransaction.run(tx, () =>
          queueExecution.run(context, async () => {
            for (const adopt of context.adoptions) await adopt(tx);
          }),
        ),
      );
    return { user, asset, revisions, previous, candidate, operations, operation, store, claim, context, commit };
  };

  it('keeps the previous version until both claims and all references commit; observations follow the commit', async () => {
    const fixture = await prepare();
    const { operations, operation, revisions, candidate, asset, previous, context } = fixture;
    expect((await revisions.getCurrent(asset.id))?.id).toBe(previous.id);
    expect((await revisions.get(candidate.id))?.masterPath).toBeNull();
    expect((await operations.getForWorker(operation.id))?.status).toBe(MediaOperationStatus.Validating);
    const notices = vi.fn();
    operations.onChange(notices);
    expect(await fixture.commit()).toBe(true);
    expect(notices).not.toHaveBeenCalled();
    expect((await revisions.getCurrent(asset.id))?.id).toBe(candidate.id);
    expect((await operations.getForWorker(operation.id))?.status).toBe(MediaOperationStatus.Completed);
    for (const notify of context.afterCommit ?? []) await notify();
    expect(notices).toHaveBeenCalledTimes(1);
    expect(await fixture.commit()).toBe(false);
  });

  it.each(['cancel', 'expired operation', 'expired queue'] as const)(
    'rejects %s before acceptance without replacing the last good version',
    async (fault) => {
      const fixture = await prepare();
      const { operations, operation, revisions, candidate, asset, previous, claim, user } = fixture;
      switch (fault) {
        case 'cancel': {
          await operations.requestCancel(operation.id, user.id);
          break;
        }
        case 'expired operation': {
          await sql`update media_operation set "claimExpiresAt" = now() - interval '1 second' where id = ${operation.id}::uuid`.execute(
            db,
          );
          break;
        }
        case 'expired queue': {
          await sql`update job set "leaseExpiresAt" = now() - interval '1 second' where id = ${claim.id}::uuid`.execute(
            db,
          );
          break;
        }
      }
      if (fault === 'expired queue') expect(await fixture.commit()).toBe(false);
      else await expect(fixture.commit()).rejects.toThrow('lost its claim');
      expect((await revisions.getCurrent(asset.id))?.id).toBe(previous.id);
      expect((await revisions.get(candidate.id))?.masterPath).toBeNull();
      expect((await operations.getForWorker(operation.id))?.status).not.toBe(MediaOperationStatus.Completed);
    },
  );
});
