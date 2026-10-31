import { Kysely, sql } from 'kysely';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { ClassificationRepository } from 'src/repositories/classification.repository.js';
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

it.each(['commit', 'rollback'] as const)(
  'waits for an uncertain rule insert to %s before compensating its album',
  async (outcome) => {
    const { ctx } = newMediumService(BaseService, { database: db, real: [AlbumRepository], mock: [LoggingRepository] });
    const { user } = await ctx.newUser();
    const { album } = await ctx.newAlbum({ ownerId: user.id });
    const held = Promise.withResolvers<number>();
    const release = Promise.withResolvers<void>();
    const rollback = new Error('insert failed');
    const insertion = db.transaction().execute(async (tx) => {
      await new ClassificationRepository(tx).createRule({ ownerId: user.id, albumId: album.id });
      held.resolve((await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(tx)).rows[0].pid);
      await release.promise;
      if (outcome === 'rollback') throw rollback;
    });
    const inserted = insertion.catch((error: unknown) => error);
    let cleanup: Promise<void> | undefined;
    try {
      const pid = await Promise.race([
        held.promise,
        inserted.then(() => {
          throw new Error('Insert did not acquire its foreign-key lock');
        }),
      ]);
      cleanup = new AlbumRepository(db).deleteFailedClassificationAlbum(album.id, user.id);
      const cleaned = cleanup.catch((error: unknown) => error);
      await vi.waitFor(
        async () => {
          const { rows } = await sql<{ waiting: boolean }>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
          WHERE datname=current_database() AND ${pid}=ANY(pg_blocking_pids(pid))) AS waiting`.execute(db);
          expect(rows[0].waiting).toBe(true);
        },
        { timeout: 5000 },
      );
      release.resolve();
      expect(await inserted).toBe(outcome === 'rollback' ? rollback : undefined);
      expect(await cleaned).toBeUndefined();
      const albums = await db.selectFrom('album').select('id').where('id', '=', album.id).execute();
      const rules = await db.selectFrom('classification_rule').select('id').where('albumId', '=', album.id).execute();
      expect(albums).toHaveLength(outcome === 'commit' ? 1 : 0);
      expect(rules).toHaveLength(outcome === 'commit' ? 1 : 0);
    } finally {
      release.resolve();
      await Promise.allSettled([insertion, ...(cleanup ? [cleanup] : [])]);
    }
  },
);
