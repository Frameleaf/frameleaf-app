import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { AssetEditAction } from 'src/dtos/editing.dto.js';
import { AssetFileType, AssetType, JobName, JobStatus, MediaOperationStatus } from 'src/enum.js';
import { publishJobResult, queueExecution } from 'src/queue/context.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { publicationTransaction } from 'src/queue/transaction.js';
import { QUEUE_TIMING, QueueExecution } from 'src/queue/types.js';
import { AssetEditRepository } from 'src/repositories/asset-edit.repository.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { DB } from 'src/schema/index.js';
import { EditOperationTracker } from 'src/utils/edit-operation-tracker.js';
import { EditOperationEdit, editOperationCreate } from 'src/utils/edit-operation.js';
import { seedCanonicalAsset, seedCanonicalUser } from 'test/fixtures/canonical-database.js';
import { getKyselyDB } from 'test/utils.js';

describe('retained video publication under queue and operation claims', () => {
  let db: Kysely<DB>;
  beforeAll(async () => {
    db = await getKyselyDB();
  });
  afterAll(async () => {
    await db?.destroy();
  });

  const prepare = async () => {
    const user = await seedCanonicalUser(db);
    const asset = await seedCanonicalAsset(db, { ownerId: user.id, type: AssetType.Video });
    const edits = new AssetEditRepository(db);
    const result = (label: string) => ({
      masterPath: `/${asset.id}/${label}/master.mp4`,
      width: 320,
      height: 240,
      duration: 1000,
      files: [
        {
          assetId: asset.id,
          type: AssetFileType.EncodedVideo,
          path: `/${asset.id}/${label}/proxy.mp4`,
          isEdited: true,
          isProgressive: false,
          isTransparent: false,
        },
      ],
    });
    await edits.replaceAll(asset.id, [{ action: AssetEditAction.Rotate, parameters: { angle: 90 } }]);
    const previous = (await edits.getRequestedVideoVersion(asset.id))!;
    expect((await edits.publishVideoVersion(previous, result('previous'))).published).toBe(true);
    await edits.replaceAll(asset.id, [{ action: AssetEditAction.Rotate, parameters: { angle: 180 } }]);
    const candidate = (await edits.getRequestedVideoVersion(asset.id))!;
    const operations = new MediaOperationRepository(db);
    const operation = await operations.create(
      editOperationCreate({
        ownerId: user.id,
        assetId: asset.id,
        edit: EditOperationEdit.VideoEdit,
        label: 'video fixture',
        job: { name: JobName.AssetVideoEditGeneration, data: { id: asset.id, versionId: candidate.id } },
      }),
    );
    const store = new SqlQueueStore(db);
    const queue = `video-publication-${randomUUID()}`;
    const worker = randomUUID();
    await store.initialize([queue], worker);
    await store.enqueue([
      {
        queue,
        name: JobName.AssetVideoEditGeneration,
        data: { id: asset.id, versionId: candidate.id, operationId: operation.id },
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
          if (!(await edits.publishVideoVersion(candidate, result('candidate'))).published) {
            throw new Error('Video version changed before publication');
          }
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
    const files = () => db.selectFrom('asset_file').select('path').where('assetId', '=', asset.id).execute();
    return { asset, edits, previous, candidate, operations, operation, claim, commit, files, result };
  };

  it('keeps the previous projection until the version, references, job and operation commit together', async () => {
    const fixture = await prepare();
    expect(await fixture.files()).toEqual([{ path: fixture.result('previous').files[0].path }]);
    expect((await fixture.edits.getVideoVersion(fixture.asset.id, fixture.candidate.id))?.masterPath).toBeNull();
    expect(await fixture.commit()).toBe(true);
    expect(await fixture.files()).toEqual([{ path: fixture.result('candidate').files[0].path }]);
    expect((await fixture.edits.getVideoVersion(fixture.asset.id, fixture.candidate.id))?.status).toBe('ready');
    expect((await fixture.operations.getForWorker(fixture.operation.id))?.status).toBe(MediaOperationStatus.Completed);
    expect(await fixture.commit()).toBe(false);
    expect((await fixture.edits.getVideoVersion(fixture.asset.id, fixture.previous.id))?.masterPath).toBe(
      fixture.result('previous').masterPath,
    );
  });

  it.each(['expired operation', 'expired queue', 'superseded version'] as const)(
    'preserves every prior reference when publication meets an %s',
    async (fault) => {
      const fixture = await prepare();
      switch (fault) {
        case 'expired operation': {
          await sql`update media_operation set "claimExpiresAt" = now() - interval '1 second'
        where id = ${fixture.operation.id}::uuid`.execute(db);
          break;
        }
        case 'expired queue': {
          await sql`update job set "leaseExpiresAt" = now() - interval '1 second'
        where id = ${fixture.claim.id}::uuid`.execute(db);
          break;
        }
        case 'superseded version': {
          await fixture.edits.replaceAll(fixture.asset.id, []);
          // No default
          break;
        }
      }
      if (fault === 'expired queue') expect(await fixture.commit()).toBe(false);
      else
        await expect(fixture.commit()).rejects.toThrow(
          fault === 'expired operation' ? 'lost its claim' : 'changed before publication',
        );
      expect(await fixture.files()).toEqual([{ path: fixture.result('previous').files[0].path }]);
      expect((await fixture.edits.getVideoVersion(fixture.asset.id, fixture.candidate.id))?.masterPath).toBeNull();
      expect((await fixture.operations.getForWorker(fixture.operation.id))?.status).not.toBe(
        MediaOperationStatus.Completed,
      );
    },
  );
});
