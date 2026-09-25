import { Kysely, sql } from 'kysely';
import { getCatalogEvidence } from 'src/fork-schema/catalog.js';
import manifest from 'src/fork-schema/manifests/fork-v2-catalog.json' with { type: 'json' };
import * as links from 'src/fork-schema/migrations/0000000000201-FrameleafAccountLinks.js';
import * as sessions from 'src/fork-schema/migrations/0000000000202-FrameleafSessions.js';
import { FrameleafAccountRepository } from 'src/repositories/frameleaf-account.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { newUuid } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

/** FL-158: Frameleaf account links and the sessions Sign in with Frameleaf created (fork tables). */
let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
  await sql`UPDATE immich_fork.state SET phase='dual-write' WHERE id=1`.execute(db);
});
afterAll(async () => {
  await db?.destroy();
});

const setup = () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  return { ctx, sut: ctx.get(FrameleafAccountRepository) };
};

const isOurs = (entry: { identity: string }) =>
  entry.identity.startsWith('immich_fork.frameleaf_account_link') ||
  entry.identity.startsWith('immich_fork.frameleaf_session');

const link = (userId: string, sub: string) => ({
  userId,
  sub,
  email: `${sub}@example.test`,
  emailVerified: true,
  role: 'user' as const,
  autoRegistered: false,
});

it('matches the private catalog and rolls back without modifying the official catalog', async () => {
  const before = await getCatalogEvidence(db);
  for (const kind of ['tables', 'columns', 'constraints', 'indexes'] as const) {
    expect(before[kind].filter((entry) => isOurs(entry))).toEqual(manifest[kind].filter((entry) => isOurs(entry)));
  }
  await sessions.down(db);
  await links.down(db);
  await links.up(db);
  await sessions.up(db);
  const after = await getCatalogEvidence(db);
  for (const kind of ['tables', 'columns', 'constraints', 'indexes', 'functions', 'triggers'] as const) {
    expect(after[kind].filter((entry) => entry.identity.startsWith('public.'))).toEqual(
      before[kind].filter((entry) => entry.identity.startsWith('public.')),
    );
    expect(after[kind].filter((entry) => isOurs(entry))).toEqual(before[kind].filter((entry) => isOurs(entry)));
  }
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

it('refuses writes while the server is being handed over', async () => {
  const { ctx, sut } = setup();
  const { user } = await ctx.newUser();
  await sql`UPDATE immich_fork.state SET phase='inactive' WHERE id=1`.execute(db);
  try {
    await expect(sut.upsertLink(link(user.id, `sub-${newUuid()}`))).rejects.toThrow(/handed over/);
  } finally {
    await sql`UPDATE immich_fork.state SET phase='dual-write' WHERE id=1`.execute(db);
  }
});
