import { Kysely } from 'kysely';
import { createHash } from 'node:crypto';
import { BrowserExtensionSignInAuthorizeDto } from 'src/dtos/browser-extension-sign-in.dto.js';
import { Permission } from 'src/enum.js';
import { ApiKeyRepository } from 'src/repositories/api-key.repository.js';
import { BrowserExtensionSignInRepository } from 'src/repositories/browser-extension-sign-in.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { SessionRepository } from 'src/repositories/session.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { ApiKeyService } from 'src/services/api-key.service.js';
import { BrowserExtensionSignInService } from 'src/services/browser-extension-sign-in.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

let database: Kysely<DB>;

const REDIRECT = 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/';
const verifier = 'v'.repeat(50);
const codeChallenge = createHash('sha256').update(verifier).digest('base64url');
const allow = (overrides: Partial<BrowserExtensionSignInAuthorizeDto> = {}) =>
  BrowserExtensionSignInAuthorizeDto.schema.parse({
    redirectUri: REDIRECT,
    codeChallenge,
    codeChallengeMethod: 'S256',
    state: 'state-0123456789abcdef',
    client: 'chrome',
    installationId: 'installation-one-0123',
    allow: true,
    ...overrides,
  });
const codeOf = (redirectUrl: string) => new URL(redirectUrl).searchParams.get('code')!;

const setup = () => {
  const { sut: keys, ctx } = newMediumService(ApiKeyService, {
    database,
    real: [ApiKeyRepository, CryptoRepository, SessionRepository, SystemMetadataRepository, UserRepository],
    mock: [LoggingRepository],
  });
  const sut = new BrowserExtensionSignInService(
    new BrowserExtensionSignInRepository(database),
    new CryptoRepository(),
    new SystemMetadataRepository(database),
    new UserRepository(database),
  );
  const signedIn = async () => {
    const { user } = await ctx.newUser();
    const { session } = await ctx.newSession({ userId: user.id });
    return factory.auth({ user, session });
  };
  return { sut, keys, ctx, signedIn };
};

beforeAll(async () => {
  database = await getKyselyDB();
});

describe(`${BrowserExtensionSignInService.name} (database)`, () => {
  it('stores only the code’s hash, uses it once, and lists the access in API keys', async () => {
    const { sut, keys, signedIn } = setup();
    const auth = await signedIn();
    const { redirectUrl } = await sut.authorize(auth, allow());
    const code = codeOf(redirectUrl);

    const stored = await database.selectFrom('browser_extension_sign_in_code').selectAll().execute();
    const mine = stored.filter((row) => row.userId === auth.user.id);
    expect(mine).toHaveLength(1);
    expect(mine[0].codeHash).toEqual(createHash('sha256').update(code).digest());
    expect(mine[0].sessionId).toBe(auth.session!.id);

    const result = await sut.exchange({ code, codeVerifier: verifier, redirectUri: REDIRECT });
    await expect(sut.exchange({ code, codeVerifier: verifier, redirectUri: REDIRECT })).rejects.toThrow(
      'This sign-in can’t be used',
    );

    const listed = await keys.getAll(auth);
    expect(listed).toEqual([
      expect.objectContaining({
        id: result.apiKeyId,
        name: 'Save to Frameleaf · Chrome',
        designPermissions: [Permission.CaptureCreate, Permission.CaptureCatalogRead],
        permissions: [],
        signedInFrom: 'chrome',
      }),
    ]);
    // the new key reaches the server like any other key
    const hashed = createHash('sha256').update(result.secret).digest();
    await expect(new ApiKeyRepository(database).getKey(hashed)).resolves.toEqual(
      expect.objectContaining({ id: result.apiKeyId }),
    );
    // it has no value to replace
    await expect(keys.rotate(auth, result.apiKeyId)).rejects.toThrow('can only be removed');
  });

  it('replaces the access on a second sign-in and asks Allow only once', async () => {
    const { sut, keys, signedIn } = setup();
    const auth = await signedIn();
    await expect(sut.start(auth, allow())).resolves.toEqual(expect.objectContaining({ alreadyAllowed: false }));

    const first = await sut.authorize(auth, allow());
    const one = await sut.exchange({ code: codeOf(first.redirectUrl), codeVerifier: verifier, redirectUri: REDIRECT });
    await expect(sut.start(auth, allow())).resolves.toEqual(expect.objectContaining({ alreadyAllowed: true }));

    const second = await sut.authorize(auth, allow());
    const two = await sut.exchange({ code: codeOf(second.redirectUrl), codeVerifier: verifier, redirectUri: REDIRECT });

    expect((await keys.getAll(auth)).map((key) => key.id)).toEqual([two.apiKeyId]);
    expect(two.apiKeyId).not.toBe(one.apiKeyId);
  });

  it('keeps each installation’s access apart', async () => {
    const { sut, keys, signedIn } = setup();
    const auth = await signedIn();
    const first = await sut.authorize(auth, allow());
    const one = await sut.exchange({ code: codeOf(first.redirectUrl), codeVerifier: verifier, redirectUri: REDIRECT });
    const second = await sut.authorize(auth, allow({ installationId: 'installation-two-4567' }));
    const two = await sut.exchange({ code: codeOf(second.redirectUrl), codeVerifier: verifier, redirectUri: REDIRECT });

    expect((await keys.getAll(auth)).map((key) => key.id).toSorted()).toEqual([one.apiKeyId, two.apiKeyId].toSorted());
    const stored = await database
      .selectFrom('browser_extension_access')
      .select(['apiKeyId', 'installationId'])
      .where('userId', '=', auth.user.id)
      .execute();
    expect(stored).toEqual(
      expect.arrayContaining([
        { apiKeyId: one.apiKeyId, installationId: 'installation-one-0123' },
        { apiKeyId: two.apiKeyId, installationId: 'installation-two-4567' },
      ]),
    );
  });

  it('removing the key in API keys removes the access, and sign out removes it too', async () => {
    const { sut, keys, signedIn } = setup();
    const auth = await signedIn();
    const first = await sut.authorize(auth, allow());
    const { apiKeyId } = await sut.exchange({
      code: codeOf(first.redirectUrl),
      codeVerifier: verifier,
      redirectUri: REDIRECT,
    });

    await keys.delete(auth, apiKeyId);
    await expect(sut.start(auth, allow())).resolves.toEqual(expect.objectContaining({ alreadyAllowed: false }));

    const again = await sut.authorize(auth, allow({ client: 'edge' }));
    const edge = await sut.exchange({ code: codeOf(again.redirectUrl), codeVerifier: verifier, redirectUri: REDIRECT });
    expect(edge.name).toBe('Save to Frameleaf · Edge');
    await sut.signOut({ user: auth.user, apiKey: { id: edge.apiKeyId, permissions: [Permission.CaptureCreate] } });
    await expect(keys.getAll(auth)).resolves.toEqual([]);
  });

  it('signing the session out removes its unused code', async () => {
    const { sut, signedIn } = setup();
    const auth = await signedIn();
    const { redirectUrl } = await sut.authorize(auth, allow());
    await new SessionRepository(database).delete(auth.session!.id);

    await expect(
      sut.exchange({ code: codeOf(redirectUrl), codeVerifier: verifier, redirectUri: REDIRECT }),
    ).rejects.toThrow('This sign-in can’t be used');
  });
});
