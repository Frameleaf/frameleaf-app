import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import type { DB } from 'src/schema/index.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { RateLimitRepository } from 'src/repositories/rate-limit.repository.js';
import { canonicalDatabaseUrl } from 'test/fixtures/canonical-database.js';
import { getKyselyDB } from 'test/utils.js';

describe('direct peer admission across API workers', () => {
  let db: Kysely<DB>;
  let workers: RateLimitRepository[];
  beforeAll(async () => {
    db = await getKyselyDB();
    const { rows } = await sql<{ name: string }>`select current_database() name`.execute(db);
    const url = canonicalDatabaseUrl(process.env.IMMICH_TEST_POSTGRES_URL!, rows[0].name);
    workers = Array.from({ length: 4 }, () => {
      const config = new ConfigRepository();
      const env = config.getEnv();
      vi.spyOn(config, 'getEnv').mockReturnValue({
        ...env,
        database: {
          ...env.database,
          config: { connectionType: 'url', url },
        },
      });
      return new RateLimitRepository(config);
    });
  });
  afterAll(async () => {
    await Promise.all(workers.map((worker) => worker.onModuleDestroy()));
    await db.destroy();
  });
  it('serializes competing admissions, bounds global and owner counts, releases and expires peers', async () => {
    const owner = randomUUID();
    const ids = Array.from({ length: 20 }, () => randomUUID());
    const results = await Promise.all(ids.map((id, index) => workers[index % 4].claimDirectUploadPeer(id, owner)));
    expect(results.filter(Boolean)).toHaveLength(2);
    for (let index = 0; index < 14; index++) {
      expect(await workers[index % 4].claimDirectUploadPeer(randomUUID(), randomUUID())).toBe(true);
    }
    expect(await workers[0].claimDirectUploadPeer(randomUUID(), randomUUID())).toBe(false);
    const admitted = ids.find((_, index) => results[index])!;
    await workers[1].releaseDirectUploadPeer(admitted, randomUUID());
    expect(await workers[0].claimDirectUploadPeer(randomUUID(), owner)).toBe(false);
    await workers[1].releaseDirectUploadPeer(admitted, owner);
    expect(await workers[2].claimDirectUploadPeer(randomUUID(), owner)).toBe(true);
    await sql`UPDATE public.frameleaf_upload_lease SET expires_at = clock_timestamp() - interval '1 second'
      WHERE key like 'direct-upload-peer:%'`.execute(db);
    expect(await workers[3].claimDirectUploadPeer(randomUUID(), owner)).toBe(true);
  }, 30_000);
});
