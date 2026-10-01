import { Kysely, sql } from 'kysely';
import { getCatalogEvidence } from 'src/fork-schema/catalog.js';
import manifest from 'src/fork-schema/manifests/fork-v2-catalog.json' with { type: 'json' };
import * as exchange from 'src/fork-schema/migrations/0000000000210-FrameleafTokenExchange.js';
import { FrameleafAccountRepository } from 'src/repositories/frameleaf-account.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { newUuid } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

/** FL-230: the exchange tokens already used and the sign-ins Frameleaf Cloud ended (fork migration 0210). */
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
  return { sut: ctx.get(FrameleafAccountRepository) };
};

const isOurs = (entry: { identity: string }) =>
  entry.identity.startsWith('immich_fork.frameleaf_exchange_token') ||
  entry.identity.startsWith('immich_fork.frameleaf_sign_in_revocation');

const token = (overrides: Partial<Parameters<FrameleafAccountRepository['redeemExchangeToken']>[0]> = {}) => ({
  jti: `jti-${newUuid()}`,
  sub: `sub-${newUuid()}`,
  sid: `sid-${newUuid()}`,
  issuedAt: new Date(Date.now() - 1000),
  expiresAt: new Date(Date.now() + 60_000),
  ...overrides,
});

it('matches the private catalog and rolls back without modifying the official catalog', async () => {
  const before = await getCatalogEvidence(db);
  for (const kind of ['tables', 'columns', 'constraints', 'indexes'] as const) {
    const ours = before[kind].filter((entry) => isOurs(entry));
    expect(ours.length).toBeGreaterThan(0);
    expect(ours).toEqual(manifest[kind].filter((entry) => isOurs(entry)));
  }
  await exchange.down(db);
  await exchange.up(db);
  const after = await getCatalogEvidence(db);
  for (const kind of ['tables', 'columns', 'constraints', 'indexes', 'functions', 'triggers'] as const) {
    expect(after[kind].filter((entry) => entry.identity.startsWith('public.'))).toEqual(
      before[kind].filter((entry) => entry.identity.startsWith('public.')),
    );
    expect(after[kind].filter((entry) => isOurs(entry))).toEqual(before[kind].filter((entry) => isOurs(entry)));
  }
});

it('takes an exchange token once, even when two copies arrive together', async () => {
  const { sut } = setup();
  const first = token();
  await expect(sut.redeemExchangeToken(first)).resolves.toBe('ok');
  await expect(sut.redeemExchangeToken(first)).resolves.toBe('replayed');

  const second = token();
  const results = await Promise.all([sut.redeemExchangeToken(second), sut.redeemExchangeToken(second)]);
  expect(results.toSorted()).toEqual(['ok', 'replayed']);
});

it('forgets a token once it could no longer be accepted', async () => {
  const { sut } = setup();
  const old = token({ expiresAt: new Date(Date.now() - 1000) });
  await expect(sut.redeemExchangeToken(old)).resolves.toBe('ok');
  // the next redemption sweeps expired rows; the token itself is refused as expired before it gets here
  await sut.redeemExchangeToken(token());
  const { rows } = await sql`SELECT 1 FROM immich_fork.frameleaf_exchange_token WHERE jti = ${old.jti}`.execute(db);
  expect(rows).toHaveLength(0);
});

it('refuses tokens minted before a sign-out of their account or Frameleaf session, until they expire', async () => {
  const { sut } = setup();
  const sub = `sub-${newUuid()}`;
  const sid = `sid-${newUuid()}`;
  const before = new Date(Date.now() - 1000);
  await sut.revokeSignIns({ sub }, new Date(Date.now() + 60_000));
  await expect(sut.redeemExchangeToken(token({ sub, issuedAt: before }))).resolves.toBe('revoked');
  // minted after the sign-out: a new share, for example
  await expect(sut.redeemExchangeToken(token({ sub, issuedAt: new Date(Date.now() + 1000) }))).resolves.toBe('ok');
  // another account is not affected
  await expect(sut.redeemExchangeToken(token({ issuedAt: before }))).resolves.toBe('ok');

  await sut.revokeSignIns({ sid }, new Date(Date.now() + 60_000));
  await expect(sut.redeemExchangeToken(token({ sid, issuedAt: before }))).resolves.toBe('revoked');
  await expect(sut.redeemExchangeToken(token({ sid: null, issuedAt: before }))).resolves.toBe('ok');

  const lapsed = `sub-${newUuid()}`;
  await sut.revokeSignIns({ sub: lapsed }, new Date(Date.now() - 1000));
  await expect(sut.redeemExchangeToken(token({ sub: lapsed, issuedAt: before }))).resolves.toBe('ok');
  await expect(sut.revokeSignIns({}, new Date())).resolves.toBeUndefined();
});

it('refuses writes while the server is being handed over', async () => {
  const { sut } = setup();
  await sql`UPDATE immich_fork.state SET phase='inactive' WHERE id=1`.execute(db);
  try {
    await expect(sut.redeemExchangeToken(token())).rejects.toThrow(/handed over/);
    await expect(sut.revokeSignIns({ sub: 'someone' }, new Date())).rejects.toThrow(/handed over/);
  } finally {
    await sql`UPDATE immich_fork.state SET phase='dual-write' WHERE id=1`.execute(db);
  }
});
