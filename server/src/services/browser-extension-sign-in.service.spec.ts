import { BadRequestException, ForbiddenException, HttpException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import {
  BrowserExtensionSignInAuthorizeDto,
  BrowserExtensionSignInExchangeDto,
} from 'src/dtos/browser-extension-sign-in.dto.js';
import { Permission, SystemMetadataKey } from 'src/enum.js';
import {
  BrowserExtensionAccessGrant,
  BrowserExtensionSignInCode,
  BrowserExtensionSignInRepository,
} from 'src/repositories/browser-extension-sign-in.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { BrowserExtensionSignInService } from 'src/services/browser-extension-sign-in.service.js';
import { automock } from 'test/utils.js';

const REDIRECT = 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/';
const OTHER_REDIRECT = 'https://ponmlkjihgfedcbaponmlkjihgfedcba.chromiumapp.org/';

const verifierFor = (seed: string) => createHash('sha256').update(seed).digest('base64url') + 'abcdefghij';
const challengeOf = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

/** An in-memory stand-in for the code and access tables, with the same take-once behaviour. */
class FakeSignInRepository {
  codes = new Map<string, BrowserExtensionSignInCode>();
  accesses: Array<BrowserExtensionAccessGrant & { apiKeyId: string }> = [];

  createCode(code: Omit<BrowserExtensionSignInCode, 'createdAt'>) {
    this.codes.set(code.codeHash.toString('hex'), { ...code, createdAt: new Date() } as BrowserExtensionSignInCode);
    return Promise.resolve();
  }
  takeCode(codeHash: Buffer) {
    const found = this.codes.get(codeHash.toString('hex'));
    this.codes.delete(codeHash.toString('hex'));
    return Promise.resolve(found);
  }
  getAccess(userId: string, client: string, redirectOrigin: string) {
    const found = this.accesses.find(
      (access) => access.userId === userId && access.client === client && access.redirectOrigin === redirectOrigin,
    );
    return Promise.resolve(found && { apiKeyId: found.apiKeyId, name: found.name });
  }
  replaceAccess(grant: BrowserExtensionAccessGrant) {
    this.accesses = this.accesses.filter(
      (access) =>
        !(
          access.userId === grant.userId &&
          access.client === grant.client &&
          access.redirectOrigin === grant.redirectOrigin
        ),
    );
    const apiKeyId = randomUUID();
    this.accesses.push({ ...grant, apiKeyId });
    return Promise.resolve({ id: apiKeyId, name: grant.name });
  }
  removeAccess(userId: string, apiKeyId: string) {
    const before = this.accesses.length;
    this.accesses = this.accesses.filter((access) => !(access.userId === userId && access.apiKeyId === apiKeyId));
    return Promise.resolve(this.accesses.length < before);
  }
}

const person = (name: string): AuthDto => {
  const id = randomUUID();
  return {
    user: { id, name, email: `${name}@example.test`, isAdmin: false, quotaSizeInBytes: null, quotaUsageInBytes: 0 },
    session: { id: randomUUID() } as AuthDto['session'],
  };
};

const makeServer = (serverId: string, repository = new FakeSignInRepository()) => {
  const system = automock(SystemMetadataRepository, { args: [{}] });
  system.get.mockImplementation(
    (key) =>
      Promise.resolve(
        key === SystemMetadataKey.FrameleafServerId ? { id: serverId, createdAt: '' } : undefined,
      ) as never,
  );
  const users = automock(UserRepository, { args: [{}] });
  const known = new Set<string>();
  users.get.mockImplementation((id: string) => Promise.resolve(known.has(id) ? ({ id } as never) : undefined));
  const service = new BrowserExtensionSignInService(
    repository as unknown as BrowserExtensionSignInRepository,
    new CryptoRepository(),
    system,
    users,
  );
  return { service, repository, users, known };
};

const request = (verifier: string, overrides: Partial<BrowserExtensionSignInAuthorizeDto> = {}) =>
  BrowserExtensionSignInAuthorizeDto.schema.parse({
    redirectUri: REDIRECT,
    codeChallenge: challengeOf(verifier),
    codeChallengeMethod: 'S256',
    state: 'state-0123456789abcdef',
    client: 'chrome',
    allow: true,
    ...overrides,
  });

const codeFrom = (redirectUrl: string) => new URL(redirectUrl).searchParams.get('code')!;

const exchange = (code: string, codeVerifier: string, redirectUri = REDIRECT) =>
  BrowserExtensionSignInExchangeDto.schema.parse({ code, codeVerifier, redirectUri });

const refusal = async (promise: Promise<unknown>) => {
  const error: unknown = await promise.then(() => null).catch((error_: unknown) => error_);
  expect(error).toBeInstanceOf(HttpException);
  return (error as HttpException).getResponse() as { code: string };
};

describe(BrowserExtensionSignInService.name, () => {
  const verifier = verifierFor('taylor');
  let server: ReturnType<typeof makeServer>;
  let taylor: AuthDto;

  beforeEach(() => {
    vi.useRealTimers();
    server = makeServer('server-a');
    taylor = person('taylor');
    server.known.add(taylor.user.id);
  });

  it('says it can sign in from the browser', () => {
    expect(server.service.info()).toEqual({ version: 1 });
  });

  it('allows, then exchanges the code once for an access that can only save and list', async () => {
    const { redirectUrl } = await server.service.authorize(taylor, request(verifier));
    const url = new URL(redirectUrl);
    expect(url.origin + url.pathname).toBe(REDIRECT);
    expect(url.searchParams.get('state')).toBe('state-0123456789abcdef');

    const result = await server.service.exchange(exchange(codeFrom(redirectUrl), verifier));

    expect(result).toEqual({
      secret: expect.any(String),
      apiKeyId: expect.any(String),
      name: 'Save to Frameleaf · Chrome',
      userId: taylor.user.id,
      serverId: 'server-a',
    });
    expect(server.repository.accesses).toEqual([
      expect.objectContaining({
        userId: taylor.user.id,
        client: 'chrome',
        redirectOrigin: new URL(REDIRECT).origin,
        name: 'Save to Frameleaf · Chrome',
        permissions: [Permission.CaptureCreate, Permission.CaptureCatalogRead],
        key: createHash('sha256').update(result.secret).digest(),
      }),
    ]);
  });

  it('keeps only the hash of a code, never the code itself', async () => {
    const { redirectUrl } = await server.service.authorize(taylor, request(verifier));
    const code = codeFrom(redirectUrl);
    const [stored] = server.repository.codes.values();
    expect(stored.codeHash).toEqual(createHash('sha256').update(code).digest());
    expect(JSON.stringify(stored)).not.toContain(code);
    expect(stored).toEqual(
      expect.objectContaining({ userId: taylor.user.id, sessionId: taylor.session!.id, redirectUri: REDIRECT }),
    );
    expect(new Date(stored.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(5 * 60 * 1000);
  });

  it('names the access for Edge', async () => {
    const { redirectUrl } = await server.service.authorize(taylor, request(verifier, { client: 'edge' }));
    await expect(server.service.exchange(exchange(codeFrom(redirectUrl), verifier))).resolves.toEqual(
      expect.objectContaining({ name: 'Save to Frameleaf · Edge' }),
    );
  });

  it('refuses a replayed code', async () => {
    const { redirectUrl } = await server.service.authorize(taylor, request(verifier));
    const code = codeFrom(redirectUrl);
    await server.service.exchange(exchange(code, verifier));

    await expect(refusal(server.service.exchange(exchange(code, verifier)))).resolves.toEqual(
      expect.objectContaining({ code: 'invalid' }),
    );
    expect(server.repository.accesses).toHaveLength(1);
  });

  it('refuses an expired code, and says signing in again will help', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-29T10:00:00Z') });
    const { redirectUrl } = await server.service.authorize(taylor, request(verifier));
    vi.setSystemTime(new Date('2026-10-29T10:05:01Z'));

    await expect(refusal(server.service.exchange(exchange(codeFrom(redirectUrl), verifier)))).resolves.toEqual(
      expect.objectContaining({ code: 'expired' }),
    );
    expect(server.repository.accesses).toEqual([]);
  });

  it('refuses a wrong verifier, and the code is used up by the attempt', async () => {
    const { redirectUrl } = await server.service.authorize(taylor, request(verifier));
    const code = codeFrom(redirectUrl);

    await expect(refusal(server.service.exchange(exchange(code, verifierFor('guess'))))).resolves.toEqual(
      expect.objectContaining({ code: 'invalid' }),
    );
    await expect(refusal(server.service.exchange(exchange(code, verifier)))).resolves.toEqual(
      expect.objectContaining({ code: 'invalid' }),
    );
    expect(server.repository.accesses).toEqual([]);
  });

  it('refuses a different return address at the exchange', async () => {
    const { redirectUrl } = await server.service.authorize(taylor, request(verifier));

    await expect(
      refusal(server.service.exchange(exchange(codeFrom(redirectUrl), verifier, OTHER_REDIRECT))),
    ).resolves.toEqual(expect.objectContaining({ code: 'invalid' }));
    expect(server.repository.accesses).toEqual([]);
  });

  it.each([
    ['a web page', 'https://evil.example/'],
    ['plain http', REDIRECT.replace('https:', 'http:')],
    ['a look-alike host', 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org.evil.example/'],
    ['an id with letters past p', 'https://abcdefghijklmnopabcdefghijklmnoz.chromiumapp.org/'],
    ['an id of the wrong length', 'https://abcdefghijklmnop.chromiumapp.org/'],
    ['a port', 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org:8443/'],
    ['a query', 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/?next=https://evil.example'],
    ['a user name', 'https://me@abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/'],
  ])('refuses to allow a return address that is %s', async (_, redirectUri) => {
    await expect(server.service.authorize(taylor, request(verifier, { redirectUri }))).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(server.service.start(taylor, request(verifier, { redirectUri }))).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(server.repository.codes.size).toBe(0);
  });

  it('refuses a challenge that is not S256', async () => {
    await expect(
      server.service.authorize(taylor, request(verifier, { codeChallenge: 'plain' })),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(() => request(verifier, { codeChallengeMethod: 'plain' as 'S256' })).toThrow();
  });

  it('refuses a forged approval without a signed-in session', async () => {
    const forged: AuthDto = { user: taylor.user };
    await expect(server.service.authorize(forged, request(verifier))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(server.service.start(forged, request(verifier))).rejects.toBeInstanceOf(ForbiddenException);

    const withKey: AuthDto = {
      ...taylor,
      apiKey: { id: randomUUID(), permissions: [Permission.All] },
    };
    await expect(server.service.authorize(withKey, request(verifier))).rejects.toBeInstanceOf(ForbiddenException);
    expect(server.repository.codes.size).toBe(0);
  });

  it('refuses a code made on another server', async () => {
    const { redirectUrl } = await server.service.authorize(taylor, request(verifier));
    const code = codeFrom(redirectUrl);

    // another server never saw the code
    const other = makeServer('server-b');
    other.known.add(taylor.user.id);
    await expect(refusal(other.service.exchange(exchange(code, verifier)))).resolves.toEqual(
      expect.objectContaining({ code: 'invalid' }),
    );

    // and a copied database on another server does not accept it either
    const copy = makeServer('server-b', server.repository);
    copy.known.add(taylor.user.id);
    await expect(refusal(copy.service.exchange(exchange(code, verifier)))).resolves.toEqual(
      expect.objectContaining({ code: 'invalid' }),
    );
    expect(server.repository.accesses).toEqual([]);
  });

  it('binds a code to the person who allowed it', async () => {
    const sam = person('sam');
    server.known.add(sam.user.id);
    const samVerifier = verifierFor('sam');
    await server.service.authorize(sam, request(samVerifier));
    const { redirectUrl } = await server.service.authorize(taylor, request(verifier));

    // Sam's extension, holding Sam's verifier, cannot use Taylor's code
    await expect(refusal(server.service.exchange(exchange(codeFrom(redirectUrl), samVerifier)))).resolves.toEqual(
      expect.objectContaining({ code: 'invalid' }),
    );
    expect(server.repository.accesses).toEqual([]);

    // and Taylor's code only ever becomes Taylor's access
    const again = await server.service.authorize(taylor, request(verifier));
    const result = await server.service.exchange(exchange(codeFrom(again.redirectUrl), verifier));
    expect(result.userId).toBe(taylor.user.id);
    expect(server.repository.accesses.map((access) => access.userId)).toEqual([taylor.user.id]);
  });

  it('refuses a code whose account was removed', async () => {
    const { redirectUrl } = await server.service.authorize(taylor, request(verifier));
    server.known.delete(taylor.user.id);

    await expect(refusal(server.service.exchange(exchange(codeFrom(redirectUrl), verifier)))).resolves.toEqual(
      expect.objectContaining({ code: 'invalid' }),
    );
  });

  it('makes nothing when the flow is cancelled, and tells the extension', async () => {
    const { redirectUrl } = await server.service.authorize(taylor, request(verifier, { allow: false }));

    const url = new URL(redirectUrl);
    expect(url.origin + url.pathname).toBe(REDIRECT);
    expect(url.searchParams.get('error')).toBe('access_denied');
    expect(url.searchParams.get('state')).toBe('state-0123456789abcdef');
    expect(url.searchParams.has('code')).toBe(false);
    expect(server.repository.codes.size).toBe(0);
    expect(server.repository.accesses).toEqual([]);
  });

  it('asks Allow once per browser: a second sign-in replaces the access', async () => {
    await expect(server.service.start(taylor, request(verifier))).resolves.toEqual({
      accessName: 'Save to Frameleaf · Chrome',
      alreadyAllowed: false,
    });
    const first = await server.service.authorize(taylor, request(verifier));
    await server.service.exchange(exchange(codeFrom(first.redirectUrl), verifier));

    await expect(server.service.start(taylor, request(verifier))).resolves.toEqual(
      expect.objectContaining({ alreadyAllowed: true }),
    );
    // another extension in the same browser is asked again
    await expect(server.service.start(taylor, request(verifier, { redirectUri: OTHER_REDIRECT }))).resolves.toEqual(
      expect.objectContaining({ alreadyAllowed: false }),
    );

    const second = await server.service.authorize(taylor, request(verifier));
    await server.service.exchange(exchange(codeFrom(second.redirectUrl), verifier));
    expect(server.repository.accesses).toHaveLength(1);
  });

  it('signs out only its own access', async () => {
    const { redirectUrl } = await server.service.authorize(taylor, request(verifier));
    const { apiKeyId } = await server.service.exchange(exchange(codeFrom(redirectUrl), verifier));

    await expect(server.service.signOut({ ...taylor, session: undefined })).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      server.service.signOut({ user: taylor.user, apiKey: { id: randomUUID(), permissions: [Permission.All] } }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(server.repository.accesses).toHaveLength(1);

    await server.service.signOut({
      user: taylor.user,
      apiKey: { id: apiKeyId, permissions: [Permission.CaptureCreate, Permission.CaptureCatalogRead] },
    });
    expect(server.repository.accesses).toEqual([]);
  });
});
