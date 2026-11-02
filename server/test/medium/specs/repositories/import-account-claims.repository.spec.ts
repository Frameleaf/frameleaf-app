import { Kysely, sql } from 'kysely';
import { createHash } from 'node:crypto';
import { SharedLinkType } from 'src/enum.js';
import { ApiKeyRepository } from 'src/repositories/api-key.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { SessionRepository } from 'src/repositories/session.repository.js';
import { SharedLinkRepository } from 'src/repositories/shared-link.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { down, up } from 'src/schema/migrations/2100000003042-ImportAccountClaims.js';
import { BaseService } from 'src/services/base.service.js';
import { SessionFactory } from 'test/factories/session.factory.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
afterAll(async () => {
  await db?.destroy();
});
const digest = (value: string) => createHash('sha256').update(value).digest();
const fixture = async () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser({
    importClaimPending: true,
    password: 'source-password',
    oauthId: 'source-subject',
  });
  const repository = new UserRepository(db);
  const hash = digest(user.id);
  await repository.setPasswordLink(user.id, user.email, hash, new Date(Date.now() + 60_000));
  return { user, repository, hash };
};

it('refuses stale sessions, API keys and public links while the owner is unclaimed', async () => {
  const { user } = await fixture();
  const session = SessionFactory.create({ userId: user.id, token: digest(user.id + 'session') });
  await db.insertInto('session').values(session).execute();
  const key = digest(user.id + 'key');
  await db.insertInto('api_key').values({ userId: user.id, key, name: 'stale', permissions: [] }).execute();
  const link = digest(user.id + 'link');
  await db
    .insertInto('shared_link')
    .values({ userId: user.id, key: link, type: SharedLinkType.Individual, allowUpload: false })
    .execute();
  await expect(new SessionRepository(db).getByToken(session.token)).resolves.toMatchObject({ user: null });
  await expect(new ApiKeyRepository(db).getKey(key)).resolves.toMatchObject({ user: null });
  await expect(new SharedLinkRepository(db).getByKey(link)).resolves.toBeUndefined();
  await expect(
    new SessionRepository(db).create(SessionFactory.create({ userId: user.id }), 'source-password'),
  ).rejects.toThrow();
});

it('claims once under concurrent redemption and removes all stale authentication atomically', async () => {
  const { user, repository, hash } = await fixture();
  await db
    .insertInto('session')
    .values(SessionFactory.create({ userId: user.id, token: digest(user.id + 'session') }))
    .execute();
  await db
    .insertInto('api_key')
    .values({ userId: user.id, key: digest(user.id), name: 'stale', permissions: [] })
    .execute();
  await sql`INSERT INTO public.frameleaf_account_link ("userId", sub, email) VALUES (${user.id}::uuid, ${user.id}, ${user.email})`.execute(
    db,
  );
  const staleLink = digest(user.id + 'stale-public-link');
  await db
    .insertInto('shared_link')
    .values({ userId: user.id, key: staleLink, slug: user.id, type: SharedLinkType.Individual, allowUpload: false })
    .execute();
  const results = await Promise.all([
    repository.redeemImportedAccountClaim(hash, 'new-password'),
    repository.redeemImportedAccountClaim(hash, 'new-password'),
  ]);
  expect(results.filter(Boolean)).toEqual([{ id: user.id, email: user.email }]);
  await expect(new SharedLinkRepository(db).getByKey(staleLink)).resolves.toBeUndefined();
  await expect(new SharedLinkRepository(db).getBySlug(user.id)).resolves.toBeUndefined();
  await expect(repository.redeemImportedAccountClaim(hash, 'again')).resolves.toBeUndefined();
  await expect(
    db
      .selectFrom('user')
      .select(['importClaimPending', 'password', 'oauthId', 'pinCode', 'passwordLinkHash'])
      .where('id', '=', user.id)
      .executeTakeFirstOrThrow(),
  ).resolves.toEqual({
    importClaimPending: false,
    password: 'new-password',
    oauthId: null,
    pinCode: null,
    passwordLinkHash: null,
  });
  for (const table of ['session', 'api_key'] as const) {
    expect(await db.selectFrom(table).select('id').where('userId', '=', user.id).execute()).toEqual([]);
  }
  expect(
    (await sql`SELECT * FROM public.frameleaf_account_link WHERE "userId"=${user.id}::uuid`.execute(db)).rows,
  ).toEqual([]);
});

it('never activates an expired claim or lets ordinary password reset activate an imported owner', async () => {
  const { user, repository, hash } = await fixture();
  await expect(repository.redeemPasswordLink(hash, 'bypass')).resolves.toBeUndefined();
  await db
    .updateTable('user')
    .set({ passwordLinkExpiresAt: new Date(Date.now() - 1) })
    .where('id', '=', user.id)
    .execute();
  await expect(repository.redeemImportedAccountClaim(hash, 'expired')).resolves.toBeUndefined();
  await expect(repository.get(user.id, {})).resolves.toMatchObject({ importClaimPending: true });
});

it('rechecks expiry after waiting for the account row lock', async () => {
  const { user, repository, hash } = await fixture();
  let claim: ReturnType<UserRepository['redeemImportedAccountClaim']> | undefined;
  await db.transaction().execute(async (tx) => {
    await tx
      .updateTable('user')
      .set({ passwordLinkExpiresAt: sql<Date>`clock_timestamp() + interval '150 milliseconds'` })
      .where('id', '=', user.id)
      .execute();
    claim = repository.redeemImportedAccountClaim(hash, 'too-late');
    await sql`SELECT pg_sleep(0.3)`.execute(tx);
  });
  await expect(claim).resolves.toBeUndefined();
  await expect(repository.get(user.id, {})).resolves.toMatchObject({ importClaimPending: true });
});

it('binds issuance to the destination email and invalidates the claim when it changes', async () => {
  const { user, repository, hash } = await fixture();
  await repository.update(user.id, { email: user.email });
  await expect(repository.getByPasswordLink(hash)).resolves.toMatchObject({ id: user.id });
  const email = `changed-${user.email}`;
  await repository.update(user.id, { email });
  await expect(repository.getByPasswordLink(hash)).resolves.toBeUndefined();
  await expect(
    repository.setPasswordLink(user.id, user.email, hash, new Date(Date.now() + 60_000)),
  ).resolves.toBeUndefined();
  await expect(repository.setPasswordLink(user.id, email, hash, new Date(Date.now() + 60_000))).resolves.toEqual({
    id: user.id,
  });
});

it('rolls activation and password back if stale credential cleanup fails', async () => {
  const { user, repository, hash } = await fixture();
  await db
    .insertInto('api_key')
    .values({ userId: user.id, key: digest(user.id), name: 'stale', permissions: [] })
    .execute();
  await sql`CREATE FUNCTION public.reject_import_claim_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic cleanup failure'; END $$`.execute(
    db,
  );
  await sql`CREATE TRIGGER reject_import_claim_cleanup BEFORE DELETE ON public.api_key FOR EACH ROW EXECUTE FUNCTION public.reject_import_claim_cleanup()`.execute(
    db,
  );
  try {
    await expect(repository.redeemImportedAccountClaim(hash, 'new-password')).rejects.toThrow(
      'synthetic cleanup failure',
    );
    await expect(
      db
        .selectFrom('user')
        .select(['importClaimPending', 'password'])
        .where('id', '=', user.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ importClaimPending: true, password: 'source-password' });
    await expect(repository.getByPasswordLink(hash)).resolves.toMatchObject({ id: user.id });
    expect(await db.selectFrom('api_key').select('id').where('userId', '=', user.id).execute()).toHaveLength(1);
  } finally {
    await sql`DROP TRIGGER reject_import_claim_cleanup ON public.api_key`.execute(db);
    await sql`DROP FUNCTION public.reject_import_claim_cleanup()`.execute(db);
  }
});

it('refuses a downgrade that would reactivate unclaimed owners and defaults existing accounts to active', async () => {
  const isolated = await getKyselyDB();
  try {
    const { ctx } = newMediumService(BaseService, { database: isolated, real: [], mock: [LoggingRepository] });
    const { user } = await ctx.newUser({ importClaimPending: true });
    await expect(down(isolated)).rejects.toThrow('Imported accounts still require secure claims');
    await expect(
      isolated.selectFrom('user').select('importClaimPending').where('id', '=', user.id).executeTakeFirstOrThrow(),
    ).resolves.toEqual({ importClaimPending: true });
    await isolated.updateTable('user').set({ importClaimPending: false }).where('id', '=', user.id).execute();
    await down(isolated);
    const absent =
      await sql`SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='user' AND column_name='importClaimPending'`.execute(
        isolated,
      );
    expect(absent.rows).toEqual([]);
    await up(isolated);
    await expect(
      isolated.selectFrom('user').select('importClaimPending').where('id', '=', user.id).executeTakeFirstOrThrow(),
    ).resolves.toEqual({ importClaimPending: false });
  } finally {
    await isolated.destroy();
  }
});
