import type { Kysely } from 'kysely';
import { AssetRestorationMode, AssetRestorationStatus } from 'src/dtos/asset-restoration.dto.js';
import { MediaOperationDestination, MediaOperationKind, MlDestinationKind, MlWorkload } from 'src/enum.js';
import { AssetRestorationRepository } from 'src/repositories/asset-restoration.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import type { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
afterAll(async () => {
  await db?.destroy();
});

describe('restoration operation ownership', () => {
  it('discards the latest published paths and refuses stale selection without clearing a valid playback choice', async () => {
    const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    const sut = new AssetRestorationRepository(db);
    const input = {
      assetId: asset.id,
      ownerId: user.id,
      mode: AssetRestorationMode.Faithful,
      workload: MlWorkload.RestorationFaithful,
      destinationKind: MlDestinationKind.Local,
      destinationName: 'Local',
      sourceType: 'image',
      sourceChecksum: asset.checksum,
      sourceWidth: 100,
      sourceHeight: 100,
      previewRegion: { x: 0, y: 0, w: 1, h: 1 },
    };
    const kept = await sut.create({ ...input, status: AssetRestorationStatus.Restored, resultPath: '/kept.png' });
    const candidate = await sut.create({ ...input, status: AssetRestorationStatus.Restoring });
    try {
      const observed = await sut.get(candidate.id);
      expect(observed?.resultPath).toBeNull();
      await sut.update(candidate.id, {
        status: AssetRestorationStatus.Restored,
        resultPath: '/latest.png',
        resultPreviewPath: '/latest-preview.jpg',
      });
      await sut.setCurrent(asset.id, candidate.id);

      await expect(sut.discard(candidate.id)).resolves.toMatchObject({
        resultPath: '/latest.png',
        resultPreviewPath: '/latest-preview.jpg',
        isCurrent: true,
      });
      await expect(sut.get(candidate.id)).resolves.toMatchObject({
        status: AssetRestorationStatus.Discarded,
        resultPath: null,
        resultPreviewPath: null,
        isCurrent: false,
      });

      await sut.setCurrent(asset.id, kept.id);
      await expect(sut.setCurrent(asset.id, candidate.id)).rejects.toThrow('Only a finished restoration');
      await expect(sut.getCurrent(asset.id)).resolves.toMatchObject({ id: kept.id });
      await expect(sut.discard(candidate.id)).resolves.toBeUndefined();
      for (const resultPath of [null, '']) {
        await sut.update(candidate.id, { status: AssetRestorationStatus.Restored, resultPath });
        await expect(sut.setCurrent(asset.id, candidate.id)).rejects.toThrow('Only a finished restoration');
        await expect(sut.getCurrent(asset.id)).resolves.toMatchObject({ id: kept.id });
      }
    } finally {
      await db.deleteFrom('asset_restoration').where('id', 'in', [kept.id, candidate.id]).execute();
      await db.deleteFrom('asset').where('id', '=', asset.id).execute();
      await db.deleteFrom('user').where('id', '=', user.id).execute();
    }
  });

  it.each(['preview', 'full'] as const)(
    'commits %s admission with its operation link or rolls both back',
    async (stage) => {
      const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const sut = new AssetRestorationRepository(db);
      const operations = ctx.get(MediaOperationRepository as never) as MediaOperationRepository;
      const before = stage === 'preview' ? AssetRestorationStatus.PreviewQueued : AssetRestorationStatus.PreviewReady;
      const after = stage === 'preview' ? AssetRestorationStatus.PreviewQueued : AssetRestorationStatus.Accepted;
      const column = stage === 'preview' ? 'previewOperationId' : 'fullOperationId';
      const row = await sut.create({
        assetId: asset.id,
        ownerId: user.id,
        status: before,
        mode: AssetRestorationMode.Faithful,
        workload: MlWorkload.RestorationFaithful,
        destinationKind: MlDestinationKind.Local,
        destinationName: 'Local',
        sourceType: 'image',
        sourceChecksum: asset.checksum,
        sourceWidth: 100,
        sourceHeight: 100,
        previewRegion: { x: 0, y: 0, w: 1, h: 1 },
      });
      const bind = async () => ({
        operation: {
          ownerId: user.id,
          kind: stage === 'preview' ? MediaOperationKind.RestorationPreview : MediaOperationKind.Restoration,
          destination: MediaOperationDestination.Local,
          label: 'Atomic admission',
          assetId: asset.id,
          revisionId: row.id,
          snapshot: { assetId: asset.id, sourceChecksumHex: asset.checksum.toString('hex') },
        },
        value: null,
      });
      const events: string[] = [];
      const stop = operations.onChange((changes) => events.push(...changes.map(({ id }) => id)));
      const link: Parameters<MediaOperationRepository['createWithin']>[1] = async (tx, operation) => {
        await expect(
          sut.transition(
            row.id,
            [before],
            { status: after, [column]: operation.id },
            tx,
            stage === 'preview' ? { stage, id: null } : undefined,
          ),
        ).resolves.toBeDefined();
        expect(events).toEqual([]);
      };
      try {
        await expect(
          operations.createWithin(bind, async (tx, operation, value) => {
            await link(tx, operation, value);
            throw new Error('operation link failed');
          }),
        ).rejects.toThrow('operation link failed');
        expect(await db.selectFrom('media_operation').select('id').where('ownerId', '=', user.id).execute()).toEqual(
          [],
        );
        await expect(sut.get(row.id)).resolves.toMatchObject({ status: before, [column]: null });
        expect(events).toEqual([]);

        const admitted = await operations.createWithin(bind, link);
        expect(events).toEqual([admitted.operation.id]);
        await expect(sut.get(row.id)).resolves.toMatchObject({ status: after, [column]: admitted.operation.id });
      } finally {
        stop();
        await db.deleteFrom('asset_restoration').where('id', '=', row.id).execute();
        await db.deleteFrom('media_operation').where('ownerId', '=', user.id).execute();
        await db.deleteFrom('asset').where('id', '=', asset.id).execute();
        await db.deleteFrom('user').where('id', '=', user.id).execute();
      }
    },
  );

  it.each(['preview', 'full'] as const)(
    'guards %s stage writes by the current operation in PostgreSQL',
    async (stage) => {
      const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const sut = new AssetRestorationRepository(db);
      const operations = ctx.get(MediaOperationRepository as never) as MediaOperationRepository;
      const kind = stage === 'preview' ? MediaOperationKind.RestorationPreview : MediaOperationKind.Restoration;
      const old = await operations.create({
        ownerId: user.id,
        kind,
        destination: MediaOperationDestination.Local,
        label: 'Old restoration',
        snapshot: {},
      });
      const next = await operations.create({
        ownerId: user.id,
        kind,
        destination: MediaOperationDestination.Local,
        label: 'New restoration',
        snapshot: {},
      });
      const running = stage === 'preview' ? AssetRestorationStatus.PreviewRendering : AssetRestorationStatus.Restoring;
      const done = stage === 'preview' ? AssetRestorationStatus.PreviewReady : AssetRestorationStatus.Restored;
      const column = stage === 'preview' ? 'previewOperationId' : 'fullOperationId';
      const row = await sut.create({
        assetId: asset.id,
        ownerId: user.id,
        status: running,
        mode: AssetRestorationMode.Faithful,
        workload: MlWorkload.RestorationFaithful,
        destinationKind: MlDestinationKind.Local,
        destinationName: 'Local',
        sourceType: 'image',
        sourceChecksum: asset.checksum,
        sourceWidth: 100,
        sourceHeight: 100,
        previewRegion: { x: 0, y: 0, w: 1, h: 1 },
      });
      try {
        // Initial preview admission can win before its API call records the operation link.
        await expect(
          sut.transition(row.id, [running], { status: running, [column]: old.id }, undefined, { stage, id: null }),
        ).resolves.toMatchObject({ [column]: old.id });
        const observed = await sut.get(row.id);
        await sut.update(row.id, { [column]: next.id, error: 'new operation state' });

        await expect(
          sut.transition(row.id, [running], { status: done, error: null }, undefined, { stage, id: observed![column] }),
        ).resolves.toBeUndefined();
        await expect(
          sut.transition(row.id, [running], { status: done }, undefined, { stage, id: null }),
        ).resolves.toBeUndefined();
        await expect(sut.get(row.id)).resolves.toMatchObject({
          status: running,
          [column]: next.id,
          error: 'new operation state',
        });

        await db.transaction().execute(async (tx) => {
          await expect(
            sut.transition(row.id, [running], { status: done, error: null }, tx, { stage, id: next.id }),
          ).resolves.toMatchObject({ status: done, [column]: next.id });
        });
        // Owner decisions keep the existing status-only transition contract.
        await expect(sut.transition(row.id, [done], { status: running })).resolves.toMatchObject({ status: running });
      } finally {
        await db.deleteFrom('asset_restoration').where('id', '=', row.id).execute();
        await db.deleteFrom('media_operation').where('id', 'in', [old.id, next.id]).execute();
        await db.deleteFrom('asset').where('id', '=', asset.id).execute();
        await db.deleteFrom('user').where('id', '=', user.id).execute();
      }
    },
  );
});
