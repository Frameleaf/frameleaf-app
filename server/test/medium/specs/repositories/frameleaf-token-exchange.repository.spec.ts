import { Kysely, sql } from 'kysely';
import { FrameleafAccountRepository } from 'src/repositories/frameleaf-account.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { expectCanonicalTables } from 'test/fixtures/canonical-database.js';
import { newMediumService } from 'test/medium.factory.js';
import { newUuid } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

/** FL-230: the exchange tokens already used and the sign-ins Frameleaf Cloud ended (fork migration 0210). */
let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
afterAll(async () => {
  await db?.destroy();
});

const setup = () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  return { sut: ctx.get(FrameleafAccountRepository) };
};

const token = (overrides: Partial<Parameters<FrameleafAccountRepository['redeemExchangeToken']>[0]> = {}) => ({
  jti: `jti-${newUuid()}`,
  sub: `sub-${newUuid()}`,
  sid: `sid-${newUuid()}`,
  issuedAt: new Date(Date.now() - 1000),
  expiresAt: new Date(Date.now() + 60_000),
  ...overrides,
});

it('installs feature tables in the real canonical baseline', async () => {
  await expectCanonicalTables(db, ['frameleaf_exchange_token', 'frameleaf_sign_in_revocation']);
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
  const { rows } = await sql`SELECT 1 FROM public.frameleaf_exchange_token WHERE jti = ${old.jti}`.execute(db);
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

it('tells whether a sign-in was ended after a token was minted', async () => {
  const { sut } = setup();
  const sub = `sub-${newUuid()}`;
  const sid = `sid-${newUuid()}`;
  const before = new Date(Date.now() - 1000);
  await expect(sut.isSignInRevoked({ sub, sid, issuedAt: before })).resolves.toBe(false);
  await sut.revokeSignIns({ sid }, new Date(Date.now() + 60_000));
  await expect(sut.isSignInRevoked({ sub, sid, issuedAt: before })).resolves.toBe(true);
  await expect(sut.isSignInRevoked({ sub, sid: null, issuedAt: before })).resolves.toBe(false);
  await expect(sut.isSignInRevoked({ sub, sid, issuedAt: new Date(Date.now() + 1000) })).resolves.toBe(false);
});
