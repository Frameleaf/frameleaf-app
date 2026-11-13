import { createMigrationProvider } from '@frameleaf/sql-tools';
import { Kysely, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import postgres from 'postgres';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { OAuthAppRepository } from 'src/repositories/oauth-app.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { requireConnectPolicy } from 'src/utils/connect-policy.js';
import { getKyselyConfig } from 'src/utils/database.js';
import { newMediumService } from 'test/medium.factory.js';

describe('Connect upgrade from the supported baseline', () => {
  const url = new URL(process.env.IMMICH_TEST_POSTGRES_URL!);
  const name = `frameleaf_connect_upgrade_${randomUUID().replaceAll('-', '')}`;
  let db: Kysely<any>;
  const admin = async (statement: string) => {
    const connection = postgres(new URL('/postgres', url).href, { max: 1 });
    try {
      await connection.unsafe(statement);
    } finally {
      await connection.end();
    }
  };
  const migrator = () =>
    new Migrator({
      db,
      migrationTableName: 'frameleaf_migrations',
      migrationLockTableName: 'frameleaf_migrations_lock',
      provider: createMigrationProvider(fileURLToPath(new URL('../../../../src/schema/migrations/', import.meta.url)), {
        import: (path) => import(pathToFileURL(path).href),
      }),
    });

  beforeAll(async () => {
    await admin(`CREATE DATABASE ${name} TEMPLATE template0`);
    db = new Kysely(getKyselyConfig({ connectionType: 'url', url: new URL(`/${name}`, url).href }));
    expect((await migrator().migrateTo('0000000000000-FrameleafBaseline')).error).toBeUndefined();
    expect((await migrator().migrateTo('1794490000000-AssetLedger')).error).toBeUndefined();
  });
  afterAll(async () => {
    await db?.destroy();
    await admin(`DROP DATABASE IF EXISTS ${name}`);
  });

  it('preserves existing grants and rejects absent policy after applying all three Connect migrations', async () => {
    const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
    const { user } = await ctx.newUser();
    const clientId = randomUUID();
    const grantId = randomUUID();
    const accessTokenHash = randomBytes(32);
    const refreshTokenHash = randomBytes(32);
    await sql`INSERT INTO oauth_client (id, name, "redirectUris")
      VALUES (${clientId}::uuid, 'Synthetic legacy client', ARRAY['https://app.example/callback'])`.execute(db);
    await sql`INSERT INTO oauth_grant (id, "userId", "clientId", scopes, "accessTokenHash", "refreshTokenHash", "accessExpiresAt")
      VALUES (${grantId}::uuid, ${user.id}::uuid, ${clientId}::uuid, ARRAY['library:read'],
        ${accessTokenHash}, ${refreshTokenHash}, now() + interval '1 hour')`.execute(db);

    const upgrade = await migrator().migrateToLatest();
    expect(upgrade.error).toBeUndefined();
    expect(upgrade.results?.map(({ migrationName }) => migrationName)).toEqual([
      '1794500000000-ConnectAccessPolicy',
      '1794510000000-ConnectMedia',
      '1794520000000-ConnectEvents',
    ]);
    const oauth = new OAuthAppRepository(db);
    const grant = await oauth.getByAccessToken(accessTokenHash);
    expect(grant).toMatchObject({
      id: grantId,
      userId: user.id,
      clientId,
      scopes: ['library:read'],
      resource: null,
      accessPolicy: null,
      policyRevision: 0,
      revokedAt: null,
    });
    const stored = await db
      .selectFrom('oauth_grant')
      .select(['accessTokenHash', 'refreshTokenHash'])
      .executeTakeFirstOrThrow();
    expect(stored).toEqual({ accessTokenHash, refreshTokenHash });
    const missingPolicyAuth = {
      user,
      oauthApp: {
        grantId,
        clientId,
        clientName: 'Synthetic client',
        scopes: ['library:read'],
        resource: 'https://library.example/api/connect',
        accessPolicy: grant!.accessPolicy,
        policyRevision: grant!.policyRevision,
      },
    };
    expect(() => requireConnectPolicy(missingPolicyAuth)).toThrow('A restricted Connect grant is required');
    expect(await db.selectFrom('connect_receipt').selectAll().execute()).toEqual([]);
    expect(await db.selectFrom('connect_event').selectAll().execute()).toEqual([]);
    expect((await migrator().migrateToLatest()).results).toEqual([]);
  });
});
