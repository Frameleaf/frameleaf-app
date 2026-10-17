import { NotFoundException } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { AssetUploadResourceRepository } from 'src/repositories/asset-upload-resource.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
afterAll(async () => {
  await db.destroy();
});
afterEach(() => vi.useRealTimers());

it.each(['receiving', 'published'] as const)(
  'rechecks expiry after a real owner-lock wait, retaining published recovery: %s',
  async (state) => {
    const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
    const { user } = await ctx.newUser();
    const uploads = new AssetUploadResourceRepository(db);
    const resource = await uploads.create(randomUUID(), user.id, {
      checksum: Buffer.alloc(32),
      contentType: 'image/jpeg',
      size: 4,
      metadata: { filename: 'expiry.jpg', fileCreatedAt: new Date(), fileModifiedAt: new Date() },
    });
    await db.updateTable('asset_upload_resource').set({ state }).where('id', '=', resource.id).execute();
    const held = Promise.withResolvers<number>();
    const release = Promise.withResolvers<void>();
    const blocker = db.transaction().execute(async (tx) => {
      await tx.selectFrom('user').select('id').where('id', '=', user.id).forUpdate().executeTakeFirstOrThrow();
      held.resolve((await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(tx)).rows[0].pid);
      await release.promise;
    });
    let operation: Promise<unknown> | undefined;
    try {
      const pid = await Promise.race([
        held.promise,
        blocker.then(() => {
          throw new Error('Owner lock unavailable');
        }),
      ]);
      const write = vi.fn().mockResolvedValue('written');
      operation = uploads.locked(resource.id, user.id, write, true);
      const settled = operation.then((value) => ({ value })).catch((error: unknown) => ({ error }));
      await vi.waitFor(
        async () => {
          const { rows } = await sql<{ waiting: boolean }>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
          WHERE datname=current_database() AND ${pid}=ANY(pg_blocking_pids(pid))) AS waiting`.execute(db);
          expect(rows[0].waiting).toBe(true);
        },
        { timeout: 5000 },
      );
      // Advance only the application's wall clock after PostgreSQL confirms the actual lock wait.
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(resource.expiresAt).getTime() + 1);
      release.resolve();
      await blocker;
      if (state === 'published') {
        expect(await settled).toEqual({ value: 'written' });
        expect(write).toHaveBeenCalledOnce();
      } else {
        expect(await settled).toEqual({ error: expect.any(NotFoundException) });
        expect(write).not.toHaveBeenCalled();
      }
    } finally {
      release.resolve();
      await Promise.allSettled([blocker, ...(operation ? [operation] : [])]);
    }
  },
);
