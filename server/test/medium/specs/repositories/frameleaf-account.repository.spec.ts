import { Kysely } from 'kysely';
import { FrameleafAccountRepository } from 'src/repositories/frameleaf-account.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { expectCanonicalTables } from 'test/fixtures/canonical-database.js';
import { newMediumService } from 'test/medium.factory.js';
import { newUuid } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

/** FL-158: Frameleaf account links and the sessions Sign in with Frameleaf created (fork tables). */
let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
afterAll(async () => {
  await db?.destroy();
});

const setup = () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  return { ctx, sut: ctx.get(FrameleafAccountRepository) };
};

const link = (userId: string, sub: string) => ({
  userId,
  sub,
  email: `${sub}@example.test`,
  emailVerified: true,
  role: 'user' as const,
  autoRegistered: false,
});

it('installs feature tables in the real canonical baseline', async () => {
  await expectCanonicalTables(db, ['frameleaf_account_link', 'frameleaf_session']);
});

it('links one Frameleaf account to one local account, keeps linkedAt for the same account', async () => {
  const { ctx, sut } = setup();
  const { user } = await ctx.newUser();
  const { user: other } = await ctx.newUser();
  const sub = `sub-${newUuid()}`;

  const first = await sut.upsertLink(link(user.id, sub));
  const again = await sut.upsertLink({ ...link(user.id, sub), role: 'admin' });
  expect(again.linkedAt).toEqual(first.linkedAt);
  expect(again.role).toBe('admin');
  await expect(sut.getLinkBySub(sub)).resolves.toMatchObject({ userId: user.id });
  await expect(sut.upsertLink(link(other.id, sub))).rejects.toThrow(/frameleaf_account_link_sub_unique/);
  await expect(sut.upsertLink({ ...link(other.id, `sub-${newUuid()}`), role: 'owner' as never })).rejects.toThrow();

  await sut.touchLink(user.id, { email: 'new@example.test', emailVerified: true, role: 'user' });
  await expect(sut.getLinkByUser(user.id)).resolves.toMatchObject({
    email: 'new@example.test',
    lastSignInAt: expect.any(Date),
  });
  await expect(sut.deleteLink(user.id)).resolves.toMatchObject({ sub });
  await expect(sut.getLinkByUser(user.id)).resolves.toBeUndefined();
});

it('finds tagged sessions by sid or sub and hands a code over once', async () => {
  const { ctx, sut } = setup();
  const { user } = await ctx.newUser();
  const { session } = await ctx.newSession({ userId: user.id });
  const sid = `sid-${newUuid()}`;
  const sub = `sub-${newUuid()}`;

  await sut.tagSession({ sessionId: session.id, userId: user.id, sid, sub, authTime: new Date() });
  await expect(sut.findSessions({ sid })).resolves.toEqual([expect.objectContaining({ sessionId: session.id })]);
  await expect(sut.findSessions({ sub })).resolves.toEqual([expect.objectContaining({ sessionId: session.id })]);
  await expect(sut.findSessions({})).resolves.toEqual([]);

  const code = newUuid().replaceAll('-', '');
  await sut.setHandoff(session.id, code, new Date(Date.now() + 60_000));
  await expect(sut.takeHandoff(code)).resolves.toMatchObject({ sessionId: session.id, handoffCodeHash: code });
  await expect(sut.takeHandoff(code)).resolves.toBeUndefined();

  await sut.deleteSessions([session.id]);
  await expect(sut.getSession(session.id)).resolves.toBeUndefined();
});

it('records the access Frameleaf Cloud gives each account on this server (FL-235)', async () => {
  const { ctx, sut } = setup();
  const { user: owner } = await ctx.newUser();
  const { user: invited } = await ctx.newUser();

  await sut.upsertLink({ ...link(owner.id, `sub-${newUuid()}`), access: 'owner' });
  await sut.upsertLink({ ...link(invited.id, `sub-${newUuid()}`), access: 'viewer' });
  await expect(sut.getLinkByUser(owner.id)).resolves.toMatchObject({ access: 'owner' });
  await expect(sut.getLinkByUser(invited.id)).resolves.toMatchObject({ access: 'viewer' });

  // every sign-in records the latest access
  await sut.touchLink(invited.id, { email: 'v@example.test', emailVerified: true, role: 'user', access: 'editor' });
  await expect(sut.getLinkByUser(invited.id)).resolves.toMatchObject({ access: 'editor' });
  // a sign-in without the claim keeps the recorded access
  await sut.touchLink(invited.id, { email: 'v@example.test', emailVerified: true, role: 'user', access: null });
  await expect(sut.getLinkByUser(invited.id)).resolves.toMatchObject({ access: 'editor' });
  await expect(sut.upsertLink({ ...link(newUuid(), `sub-${newUuid()}`), access: 'root' as never })).rejects.toThrow(
    /frameleaf_account_link_access_check/,
  );
});
