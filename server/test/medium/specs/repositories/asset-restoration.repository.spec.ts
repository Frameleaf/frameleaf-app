import { type Kysely, type Transaction, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DB } from 'src/schema/index.js';
import { AssetRestorationMode, AssetRestorationStatus } from 'src/dtos/asset-restoration.dto.js';
import {
  MediaOperationDestination,
  MediaOperationKind,
  MediaOperationStatus,
  MlDestinationKind,
  MlWorkload,
} from 'src/enum.js';
import { AssetRestorationRepository } from 'src/repositories/asset-restoration.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { type MediaOperation, MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
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
      const bind = () =>
        Promise.try(() => ({
          operation: {
            ownerId: user.id,
            kind: stage === 'preview' ? MediaOperationKind.RestorationPreview : MediaOperationKind.Restoration,
            destination: MediaOperationDestination.Local,
            label: 'Atomic admission',
            assetId: asset.id,
            revisionId: row.id,
            settings: {},
            snapshot: { assetId: asset.id, sourceChecksumHex: asset.checksum.toString('hex') },
          },
          value: null,
        }));
      const events: string[] = [];
      const stop = operations.onChange((changes) => {
        events.push(...changes.map(({ id }) => id));
      });
      const link = async (tx: Transaction<DB>, operation: MediaOperation) => {
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
          operations.createWithin(bind, async (tx, operation) => {
            await link(tx, operation);
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
        settings: {},
        snapshot: {},
      });
      const next = await operations.create({
        ownerId: user.id,
        kind,
        destination: MediaOperationDestination.Local,
        label: 'New restoration',
        settings: {},
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

describe('restoration retention', () => {
  const fixture = async () => {
    const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    return {
      user,
      asset,
      sut: new AssetRestorationRepository(db),
      locks: ctx.get(DatabaseRepository),
      operations: ctx.get(MediaOperationRepository as never) as MediaOperationRepository,
      input: {
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
      },
    };
  };
  const dispose = async ({ asset, user }: Awaited<ReturnType<typeof fixture>>) => {
    await db.deleteFrom('asset_restoration').where('assetId', '=', asset.id).execute();
    await db.deleteFrom('media_operation').where('assetId', '=', asset.id).execute();
    await db.deleteFrom('asset').where('id', '=', asset.id).execute();
    await db.deleteFrom('user').where('id', '=', user.id).execute();
  };

  it.each(['preview', 'full'] as const)('rechecks %s status and expiry in the cleanup transaction', async (stage) => {
    const f = await fixture();
    const before = stage === 'preview' ? AssetRestorationStatus.PreviewReady : AssetRestorationStatus.RestoreFailed;
    const changed = stage === 'preview' ? AssetRestorationStatus.Accepted : AssetRestorationStatus.Restoring;
    const expiry = stage === 'preview' ? 'previewExpiresAt' : 'resultExpiresAt';
    const file = stage === 'preview' ? 'previewBeforePath' : 'resultPath';
    const now = new Date();
    const row = await f.sut.create({ ...f.input, status: before, [expiry]: new Date(0), [file]: '/owned/expired.png' });
    const clear = () =>
      f.locks.withAssetMetadataLock(f.asset.id, (tx) =>
        stage === 'preview'
          ? f.sut.clearExpiredPreview(row.id, before, now, tx)
          : f.sut.clearExpiredResult(row.id, before, now, tx),
      );
    try {
      for (const patch of [
        { status: changed, [expiry]: new Date(0) },
        { status: before, [expiry]: new Date(now.getTime() + 60_000) },
        { status: before, [expiry]: null },
      ]) {
        await f.sut.update(row.id, patch);
        await expect(clear()).resolves.toBeUndefined();
        await expect(f.sut.get(row.id)).resolves.toMatchObject({ ...patch, [file]: '/owned/expired.png' });
      }
      await f.sut.update(row.id, { status: before, [expiry]: new Date(0) });
      await expect(clear()).resolves.toMatchObject({
        status: stage === 'preview' ? AssetRestorationStatus.Expired : before,
        [expiry]: null,
        [file]: null,
      });
      if (stage === 'preview') {
        await f.sut.update(row.id, {
          status: AssetRestorationStatus.Rejected,
          [expiry]: new Date(0),
          [file]: '/owned/decided.png',
        });
        await expect(f.sut.clearExpiredPreview(row.id, AssetRestorationStatus.Rejected, now)).resolves.toMatchObject({
          status: AssetRestorationStatus.Rejected,
          previewExpiresAt: null,
          previewBeforePath: null,
        });
      }
    } finally {
      await dispose(f);
    }
  });

  it('rolls back cleanup eligibility when filesystem deletion fails', async () => {
    const f = await fixture();
    const folder = await mkdtemp(path.join(tmpdir(), 'frameleaf-restoration-retention-'));
    const file = path.join(folder, 'result.png');
    await writeFile(file, 'owned result');
    const row = await f.sut.create({
      ...f.input,
      status: AssetRestorationStatus.RestoreFailed,
      resultPath: file,
      resultExpiresAt: new Date(0),
    });
    try {
      await expect(
        f.locks.withAssetMetadataLock(f.asset.id, async (tx) => {
          expect(
            await f.sut.clearExpiredResult(row.id, AssetRestorationStatus.RestoreFailed, new Date(), tx),
          ).toBeDefined();
          // unlink cannot remove a directory; the real filesystem error must roll back the SQL clear.
          await unlink(folder);
        }),
      ).rejects.toThrow();
      await expect(f.sut.get(row.id)).resolves.toMatchObject({ resultPath: file, resultExpiresAt: new Date(0) });
      expect((await f.sut.listExpiredResults(new Date(), 100)).some(({ id }) => id === row.id)).toBe(true);
      expect(await readFile(file, 'utf8')).toBe('owned result');
    } finally {
      await rm(folder, { recursive: true, force: true });
      await dispose(f);
    }
  });

  it.each(['retry', 'publication'] as const)(
    'holds %s behind deletion on another PostgreSQL connection',
    async (action) => {
      const f = await fixture();
      const root = await mkdtemp(path.join(tmpdir(), 'frameleaf-restoration-lock-'));
      const folder = path.join(root, 'work');
      const file = path.join(folder, 'output.png');
      const staged = path.join(root, 'new.png');
      await mkdir(folder);
      await writeFile(file, 'old output');
      await writeFile(staged, 'new output');
      const claimToken = randomUUID();
      const operation = await f.operations.create({
        ownerId: f.user.id,
        assetId: f.asset.id,
        kind: MediaOperationKind.RestorationPreview,
        destination: MediaOperationDestination.Local,
        label: 'Retention publication',
        settings: {},
        snapshot: {},
      });
      const before =
        action === 'retry' ? AssetRestorationStatus.RestoreFailed : AssetRestorationStatus.PreviewRendering;
      const row = await f.sut.create({
        ...f.input,
        status: before,
        ...(action === 'retry'
          ? { resultPath: file, resultExpiresAt: new Date(0) }
          : { previewOperationId: operation.id, previewBeforePath: file, previewExpiresAt: new Date(0) }),
      });
      await db
        .updateTable('media_operation')
        .set({ status: MediaOperationStatus.Validating, claimToken, claimExpiresAt: new Date(Date.now() + 60_000) })
        .where('id', '=', operation.id)
        .execute();
      const deleting = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const connection = Promise.withResolvers<number>();
      let cleanup: Promise<unknown> | undefined;
      let contender: Promise<unknown> | undefined;
      try {
        cleanup = f.locks.withAssetMetadataLock(f.asset.id, async (tx) => {
          expect(
            action === 'retry'
              ? await f.sut.clearExpiredResult(row.id, before, new Date(), tx)
              : await f.sut.clearExpiredPreview(row.id, before, new Date(), tx),
          ).toBeDefined();
          deleting.resolve();
          await release.promise;
          await rm(folder, { recursive: true, force: true });
        });
        await Promise.race([
          deleting.promise,
          cleanup.then(() => {
            throw new Error('Cleanup did not reach the filesystem barrier');
          }),
        ]);
        const publish = async (tx: Kysely<DB>) => {
          const { rows } = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(tx);
          connection.resolve(rows[0].pid);
          await sql`SELECT pg_advisory_xact_lock(-1, hashtext(${f.asset.id})::int)`.execute(tx);
          expect(
            await f.sut.transition(
              row.id,
              [before],
              action === 'retry'
                ? { status: AssetRestorationStatus.Restoring, resultExpiresAt: null }
                : {
                    status: AssetRestorationStatus.PreviewReady,
                    previewBeforePath: file,
                    previewExpiresAt: new Date(Date.now() + 60_000),
                  },
              tx,
              action === 'publication' ? { stage: 'preview', id: operation.id } : undefined,
            ),
          ).toBeDefined();
          await mkdir(folder, { recursive: true });
          await rename(staged, file);
          return true;
        };
        contender =
          action === 'retry'
            ? db.transaction().execute(publish)
            : f.operations.publishValidated(operation.id, claimToken, publish);
        const pid = await Promise.race([
          connection.promise,
          contender.then(() => {
            throw new Error('Contender did not reach the PostgreSQL lock');
          }),
        ]);
        await vi.waitFor(
          async () => {
            const { rows } = await sql<{
              blocked: boolean;
            }>`SELECT cardinality(pg_blocking_pids(${pid}::int)) > 0 AS blocked`.execute(db);
            expect(rows[0].blocked).toBe(true);
          },
          { timeout: 5000, interval: 25 },
        );
        expect(await readFile(file, 'utf8')).toBe('old output');
        release.resolve();
        await cleanup;
        expect(await contender).toBe(action === 'retry' ? true : 'completed');
        expect(await readFile(file, 'utf8')).toBe('new output');
      } finally {
        release.resolve();
        await Promise.allSettled([cleanup, contender]);
        await rm(root, { recursive: true, force: true });
        await dispose(f);
      }
    },
  );
});
