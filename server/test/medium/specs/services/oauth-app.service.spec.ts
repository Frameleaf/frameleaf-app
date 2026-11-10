import { Kysely } from 'kysely';
import { createHash } from 'node:crypto';
import { AccountEventAction } from 'src/enum.js';
import { AccountEventRepository } from 'src/repositories/account-event.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { OAuthAppRepository } from 'src/repositories/oauth-app.repository.js';
import { SessionRepository } from 'src/repositories/session.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { OAuthAppService } from 'src/services/oauth-app.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { mockEnvData } from 'test/repositories/config.repository.mock.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

/** FL-803: connected apps against a real database: hashes only, single-use codes, rotation and revocation. */

let database: Kysely<DB>;

const ISSUER = 'https://photos.example.test';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const verifier = 'v'.repeat(50);
const codeChallenge = createHash('sha256').update(verifier).digest('base64url');
const sha = (value: string) => createHash('sha256').update(value).digest();

const setup = () => {
  const { sut, ctx } = newMediumService(OAuthAppService, {
    database,
    real: [AccountEventRepository, CryptoRepository, SessionRepository, SystemMetadataRepository, UserRepository],
    mock: [ConfigRepository, LoggingRepository],
  });
  ctx.getMock(ConfigRepository).getEnv.mockReturnValue(mockEnvData({}));
  Object.assign(sut, { oauthAppRepository: new OAuthAppRepository(database) });
  const signedIn = async () => {
    const { user } = await ctx.newUser();
    const { session } = await ctx.newSession({ userId: user.id });
    return factory.auth({ user, session });
  };
  const connect = async () => {
    const auth = await signedIn();
    const client = await sut.register({ client_name: 'Claude', redirect_uris: [REDIRECT] });
    const dto = {
      responseType: 'code',
      clientId: client.client_id,
      redirectUri: REDIRECT,
      scope: 'library:read',
      state: 'state-1',
      codeChallenge,
      codeChallengeMethod: 'S256',
    };
    const { redirectUrl } = await sut.authorize(auth, { ...dto, allow: true }, ISSUER);
    const code = new URL(redirectUrl).searchParams.get('code')!;
    const tokens = await sut.token({
      grant_type: 'authorization_code',
      code,
      client_id: client.client_id,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    });
    return { auth, client, code, tokens };
  };
  return { sut, ctx, signedIn, connect };
};

beforeAll(async () => {
  database = await getKyselyDB();
});

describe(`${OAuthAppService.name} (database)`, () => {
  it('keeps only hashes, uses a code once and lets the token in', async () => {
    const { sut, connect } = setup();
    const { auth, client, code, tokens } = await connect();

    const grants = await database.selectFrom('oauth_grant').selectAll().where('userId', '=', auth.user.id).execute();
    expect(grants).toHaveLength(1);
    expect(grants[0].accessTokenHash).toEqual(sha(tokens.access_token));
    expect(grants[0].refreshTokenHash).toEqual(sha(tokens.refresh_token));
    expect(
      await database.selectFrom('oauth_authorization_code').where('clientId', '=', client.client_id).execute(),
    ).toEqual([]);
    await expect(
      sut.token({
        grant_type: 'authorization_code',
        code,
        client_id: client.client_id,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
      }),
    ).rejects.toThrow();

    const app = await sut.validateAccessToken(tokens.access_token, 'lan');
    expect(app.user.id).toBe(auth.user.id);
    expect(app.session).toBeUndefined();
  });

  it('rotates refresh tokens and revokes the grant when a used one comes back', async () => {
    const { sut, connect } = setup();
    const { auth, client, tokens } = await connect();
    const next = await sut.token({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: client.client_id,
    });
    await expect(sut.validateAccessToken(next.access_token, null)).resolves.toBeDefined();

    await expect(
      sut.token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id }),
    ).rejects.toThrow();
    await expect(sut.validateAccessToken(next.access_token, null)).rejects.toThrow();

    const events = await database
      .selectFrom('account_event')
      .select(['action', 'detail'])
      .where('userId', '=', auth.user.id)
      .execute();
    expect(events).toEqual(
      expect.arrayContaining([
        { action: AccountEventAction.AppConnected, detail: 'library:read' },
        { action: AccountEventAction.AppDisconnected, detail: 'token-reused' },
      ]),
    );
  });

  it('removes access at once and lists only active apps', async () => {
    const { sut, connect } = setup();
    const { auth, tokens } = await connect();
    const [grant] = await sut.getGrants(auth);
    expect(grant.client).toMatchObject({ name: 'Claude', verified: true });

    await sut.revokeGrant(auth, grant.id);
    await expect(sut.validateAccessToken(tokens.access_token, null)).rejects.toThrow();
    expect(await sut.getGrants(auth)).toEqual([]);
  });

  it('drops codes when the session that allowed them signs out', async () => {
    const { sut, ctx, signedIn } = setup();
    const auth = await signedIn();
    const client = await sut.register({ client_name: 'App', redirect_uris: ['https://app.example/cb'] });
    await sut.authorize(
      auth,
      {
        responseType: 'code',
        clientId: client.client_id,
        redirectUri: 'https://app.example/cb',
        codeChallenge,
        codeChallengeMethod: 'S256',
        allow: true,
      },
      ISSUER,
    );
    expect(
      await database.selectFrom('oauth_authorization_code').where('userId', '=', auth.user.id).execute(),
    ).toHaveLength(1);
    await ctx.get(SessionRepository).delete(auth.session!.id);
    expect(await database.selectFrom('oauth_authorization_code').where('userId', '=', auth.user.id).execute()).toEqual(
      [],
    );
  });

  it('removing an app ends every grant to it', async () => {
    const { sut, connect } = setup();
    const { client, tokens } = await connect();
    const admin = factory.auth({ user: { isAdmin: true } });
    await sut.deleteClient(admin, client.client_id);
    await expect(sut.validateAccessToken(tokens.access_token, null)).rejects.toThrow();
    expect(await database.selectFrom('oauth_grant').where('clientId', '=', client.client_id).execute()).toEqual([]);
  });
});
