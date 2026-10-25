import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import {
  AssetStatus,
  MediaOperationDestination,
  MediaOperationKind,
  StudioPreviewQuality,
  StudioPreviewStatus,
} from 'src/enum.js';
import { AssetLocalEffectRepository } from 'src/repositories/asset-local-effect.repository.js';
import { DerivativePrivacyRepository } from 'src/repositories/derivative-privacy.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { StudioPreviewRepository } from 'src/repositories/studio-preview.repository.js';
import { StudioProjectRepository } from 'src/repositories/studio-project.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { bindSourceReference } from 'test/fixtures/source-reference.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = () => {
  const { ctx } = newMediumService(BaseService, { database: defaultDatabase, real: [], mock: [LoggingRepository] });
  return { ctx, sut: new StudioPreviewRepository(defaultDatabase, new DerivativePrivacyRepository(defaultDatabase)) };
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});
afterAll(async () => defaultDatabase?.destroy());

afterEach(async () => {
  await defaultDatabase.deleteFrom('studio_preview_frame').execute();
});

describe(StudioPreviewRepository.name, () => {
  const frame = (ownerId: string, projectId: string, cacheKey: string, expiresAt: Date | null = null) => ({
    ownerId,
    projectId,
    revisionDigest: 'digest-a',
    projectRevision: 1,
    grantToken: 'grant',
    grantSessionId: 'session',
    cacheKey,
    timeNumerator: '1001' as never,
    timeDenominator: '30000' as never,
    quality: StudioPreviewQuality.Draft,
    viewportWidth: 960,
    viewportHeight: 540,
    operationId: null,
    seekGeneration: '0' as never,
    framePath: null,
    contentType: null,
    sizeInBytes: null,
    frameChecksum: null,
    framePts: null,
    framePtsTimebase: null,
    toneMapped: false,
    errorCode: null,
    readyAt: null,
    expiresAt,
  });

  it.each([
    'unchanged',
    'resource-version',
    'expired-session',
    'expired-during-publication',
    'trash-restore',
    'missing-binding',
  ] as const)('rechecks the saved reference admission at preview publication: %s', async (change) => {
    const { ctx } = setup();
    const db = defaultDatabase;
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    const bound = await bindSourceReference(db, asset);
    const sourceEpochs = await AssetLocalEffectRepository.sourceEpochs(db, [asset.id]);
    const { project } = await new StudioProjectRepository(db).createWithRevision({
      ownerId: user.id,
      name: 'Reference preview',
      revision: { authorId: user.id, envelope: {}, digest: 'digest-a', graphBytes: 2, summary: {}, requestKey: null },
    });
    const operation = await new MediaOperationRepository(db).create({
      ownerId: user.id,
      kind: MediaOperationKind.StudioPreview,
      destination: MediaOperationDestination.Local,
      label: 'Reference preview',
      snapshot: { kind: 'studio-preview', sourceEpochs },
      settings: {},
    });
    const privacy = new DerivativePrivacyRepository(db);
    const sut = new StudioPreviewRepository(db, privacy);
    const input = { ...frame(user.id, project.id, randomUUID()), operationId: operation.id };
    const { frame: pending } = await sut.upsert(input);
    const source = await db
      .selectFrom('photo_source')
      .innerJoin('photo_source_run', 'photo_source_run.sourceId', 'photo_source.id')
      .select('photoSessionId')
      .where('photo_source_run.id', '=', bound.resource.runId)
      .executeTakeFirstOrThrow();
    switch (change) {
      case 'resource-version': {
        await db
          .updateTable('photo_source_resource')
          .set({ version: 'e'.repeat(64) })
          .where('id', '=', bound.resource.id)
          .execute();
        break;
      }
      case 'expired-session': {
        await db
          .updateTable('session')
          .set({ expiresAt: new Date(0) })
          .where('id', '=', source.photoSessionId)
          .execute();
        break;
      }
      case 'missing-binding': {
        await db
          .updateTable('media_operation')
          .set({ snapshot: { kind: 'studio-preview', sourceEpochs: [] } })
          .where('id', '=', operation.id)
          .execute();
        break;
      }
      case 'trash-restore': {
        await db.transaction().execute(async (trx) => {
          await trx
            .updateTable('asset')
            .set({ status: AssetStatus.Trashed, deletedAt: new Date() })
            .where('id', '=', asset.id)
            .execute();
          await new AssetLocalEffectRepository(trx).append(trx, user.id, randomUUID(), {
            origin: { kind: 'trash' },
            assets: [{ assetId: asset.id, status: AssetStatus.Trashed, revoke: true }],
            stacks: [],
          });
          await trx
            .updateTable('asset')
            .set({ status: AssetStatus.Active, deletedAt: null })
            .where('id', '=', asset.id)
            .execute();
          await new AssetLocalEffectRepository(trx).append(trx, user.id, randomUUID(), {
            origin: { kind: 'restore', decisionId: randomUUID() },
            assets: [{ assetId: asset.id, status: AssetStatus.Active, revoke: false }],
            stacks: [],
          });
        });
        break;
      }
      case 'expired-during-publication': {
        await db
          .updateTable('session')
          .set({ expiresAt: new Date(Date.now() + 500) })
          .where('id', '=', source.photoSessionId)
          .execute();
        const lock = privacy.lockSharedAccess.bind(privacy);
        vi.spyOn(privacy, 'lockSharedAccess').mockImplementationOnce(async (...args) => {
          await sql`SELECT pg_sleep(0.6)`.execute(args[0]);
          return lock(...args);
        });
        break;
      }
      // No default
    }
    const published = sut.publish(
      pending.id,
      pending.revisionDigest,
      {
        framePath: '/frames/reference.png',
        contentType: 'image/png',
        sizeInBytes: 1,
        frameChecksum: null,
        framePts: null,
        framePtsTimebase: null,
        toneMapped: false,
        readyAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      },
      {
        ownerId: user.id,
        operationId: operation.id,
        grantToken: input.grantToken,
        grantSessionId: input.grantSessionId,
        assetIds: [asset.id],
      },
    );
    if (change === 'unchanged') await expect(published).resolves.toBe(true);
    else await expect(published).rejects.toThrow('studio_source_admission_changed');
    expect(await sut.getForOwner(pending.id, user.id)).toMatchObject({
      status: change === 'unchanged' ? StudioPreviewStatus.Ready : StudioPreviewStatus.Pending,
      framePath: change === 'unchanged' ? '/frames/reference.png' : null,
    });
  });

  it('lists the live frames of projects, optionally for one account (FL-90)', async () => {
    const { ctx, sut } = setup();
    const { user: owner } = await ctx.newUser();
    const { user: reviewer } = await ctx.newUser();
    const { frame: mine } = await sut.upsert(frame(owner.id, 'project-1', 'k1'));
    const { frame: theirs } = await sut.upsert(frame(reviewer.id, 'project-1', 'k2'));
    const { frame: gone } = await sut.upsert(frame(owner.id, 'project-1', 'k3'));
    await sut.evict([gone.id]);
    await sut.upsert(frame(owner.id, 'project-2', 'k4'));

    const live = await sut.listLiveForProjects(['project-1']);
    expect(live.map((row) => row.id).toSorted()).toEqual([mine.id, theirs.id].toSorted());
    expect((await sut.listLiveForProjects(['project-1'], reviewer.id)).map((row) => row.id)).toEqual([theirs.id]);
    expect(await sut.listLiveForProjects([])).toEqual([]);
  });

  it('lists expired ready frames and old superseded or failed frames for the retention sweep (FL-96)', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const { project } = await ctx.get(StudioProjectRepository).createWithRevision({
      ownerId: user.id,
      name: 'Preview retention',
      revision: { authorId: user.id, envelope: {}, digest: 'digest-a', graphBytes: 2, summary: {}, requestKey: null },
    });
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 60_000);
    const { frame: expired } = await sut.upsert(frame(user.id, project.id, 'k1', past));
    const { frame: fresh } = await sut.upsert(frame(user.id, project.id, 'k2', future));
    const { frame: failed } = await sut.upsert(frame(user.id, project.id, 'k3'));
    for (const row of [expired, fresh]) {
      await sut.publish(
        row.id,
        'digest-a',
        {
          framePath: `/frames/${row.id}.png`,
          contentType: 'image/png',
          sizeInBytes: 1,
          frameChecksum: null,
          framePts: null,
          framePtsTimebase: null,
          toneMapped: false,
          readyAt: new Date(),
          expiresAt: row.id === expired.id ? past : future,
        },
        { ownerId: user.id, operationId: null, grantToken: 'grant', grantSessionId: 'session', assetIds: [] },
      );
    }
    await defaultDatabase
      .updateTable('studio_preview_frame')
      .set({ status: StudioPreviewStatus.Failed, errorCode: 'gpu_lost' })
      .where('id', '=', failed.id)
      .execute();

    const now = new Date();
    const retiredNow = await sut.listRetired(now, new Date(now.getTime() - 3_600_000), 100);
    expect(retiredNow.map((row) => row.id)).toEqual([expired.id]);

    const later = await sut.listRetired(now, new Date(now.getTime() + 1000), 100);
    expect(later.map((row) => row.id).toSorted()).toEqual([expired.id, failed.id].toSorted());
    expect(later.find((row) => row.id === fresh.id)).toBeUndefined();
  });
});
