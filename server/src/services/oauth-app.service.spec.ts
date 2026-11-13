import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { OAuthAuthorizationCode, OAuthClient, OAuthGrant } from 'src/repositories/oauth-app.repository.js';
import { AccountEventAction, Permission, SystemMetadataKey } from 'src/enum.js';
import { OAuthAppService } from 'src/services/oauth-app.service.js';
import { clearConfigCache } from 'src/utils/config.js';
import { OAUTH_ACCESS_TTL_SECONDS, OAUTH_CODE_TTL_SECONDS } from 'src/utils/oauth-apps.js';
import { ServiceMocks, expectNoSecretsInAccountEvents, newTestService } from 'test/utils.js';

const ISSUER = 'https://photos.example.test';
const CLAUDE_REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const LOCAL_REDIRECT = 'http://127.0.0.1:4000/callback';

const verifierFor = (seed: string) => createHash('sha256').update(seed).digest('base64url') + 'abcdefghij';
const challengeOf = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');
const key = (buffer: Buffer) => buffer.toString('hex');

type Grant = OAuthGrant & { refreshTokenHash: Buffer; accessTokenHash: Buffer };

/** In-memory stand-in for the four tables, with the same take-once and rotate-once behaviour. */
class FakeOAuthAppRepository {
  clients = new Map<string, OAuthClient>();
  codes = new Map<string, OAuthAuthorizationCode>();
  grants: Grant[] = [];
  spent = new Map<string, string>();
  users = new Map<string, AuthDto['user']>();

  addClient(redirectUris: string[], name = 'Some app') {
    const client = {
      id: randomUUID(),
      name,
      redirectUris,
      logoUri: null,
      dynamic: true,
      createdById: null,
      createdAt: new Date(),
    } as unknown as OAuthClient;
    this.clients.set(client.id, client);
    return client;
  }

  getClient = vi.fn((id: string) => Promise.resolve(this.clients.get(id)));
  createClient = vi.fn((values: Partial<OAuthClient>) => {
    const client = { ...values, id: randomUUID(), createdAt: new Date(), createdById: null } as OAuthClient;
    this.clients.set(client.id, client);
    return Promise.resolve(client);
  });
  getClients = vi.fn(() =>
    Promise.resolve(
      this.clients
        .values()
        .map((client) => ({
          ...client,
          activeUsers: this.grants.filter((grant) => grant.clientId === client.id && !grant.revokedAt).length,
        }))
        .toArray(),
    ),
  );
  deleteClient = vi.fn((id: string) => {
    const client = this.clients.get(id);
    if (!client) {
      return Promise.resolve();
    }
    const userIds = [...new Set(this.grants.filter((g) => g.clientId === id && !g.revokedAt).map((g) => g.userId))];
    this.clients.delete(id);
    this.grants = this.grants.filter((grant) => grant.clientId !== id);
    return Promise.resolve({ name: client.name, userIds });
  });
  createCode = vi.fn((code: OAuthAuthorizationCode) => {
    this.codes.set(key(code.codeHash), { ...code, createdAt: new Date() } as OAuthAuthorizationCode);
    return Promise.resolve();
  });
  takeCode = vi.fn((hash: Buffer) => {
    const found = this.codes.get(key(hash));
    this.codes.delete(key(hash));
    return Promise.resolve(found);
  });
  createGrant = vi.fn((values: Grant) => {
    const grant = {
      ...values,
      id: randomUUID(),
      createdAt: new Date(),
      lastUsedAt: null,
      lastUsedVia: null,
      revokedAt: null,
    } as Grant;
    this.grants.push(grant);
    return Promise.resolve(grant);
  });
  private withClient(grant: Grant | undefined) {
    const client = grant && this.clients.get(grant.clientId);
    return grant && client
      ? {
          ...grant,
          clientName: client.name,
          clientRedirectUris: client.redirectUris,
          user: this.users.get(grant.userId),
        }
      : undefined;
  }
  getByAccessToken = vi.fn((hash: Buffer) =>
    Promise.resolve(this.withClient(this.grants.find((grant) => grant.accessTokenHash.equals(hash)))),
  );
  getByRefreshToken = vi.fn((hash: Buffer) =>
    Promise.resolve(this.withClient(this.grants.find((grant) => grant.refreshTokenHash.equals(hash)))),
  );
  getBySpentRefreshToken = vi.fn((hash: Buffer) => {
    const grantId = this.spent.get(key(hash));
    return Promise.resolve(this.withClient(this.grants.find((grant) => grant.id === grantId)));
  });
  rotate = vi.fn(
    (
      id: string,
      previous: Buffer,
      next: { refreshTokenHash: Buffer; accessTokenHash: Buffer; accessExpiresAt: Date },
    ) => {
      const grant = this.grants.find(
        (item) => item.id === id && item.refreshTokenHash.equals(previous) && !item.revokedAt,
      );
      if (!grant) {
        return Promise.resolve(false);
      }
      Object.assign(grant, next);
      this.spent.set(key(previous), id);
      return Promise.resolve(true);
    },
  );
  revoke = vi.fn((id: string, userId?: string) => {
    const grant = this.grants.find((item) => item.id === id && (!userId || item.userId === userId) && !item.revokedAt);
    if (grant) {
      grant.revokedAt = new Date() as unknown as Grant['revokedAt'];
    }
    return Promise.resolve(!!grant);
  });
  getActiveGrants = vi.fn((userId: string) =>
    Promise.resolve(
      this.grants
        .filter((grant) => grant.userId === userId && !grant.revokedAt)
        .map((grant) => this.withClient(grant)!),
    ),
  );
  recordUse = vi.fn(() => Promise.resolve());
}

const person = (name: string, isAdmin = false): AuthDto => ({
  user: {
    id: randomUUID(),
    name,
    email: `${name}@example.test`,
    isAdmin,
    quotaSizeInBytes: null,
    quotaUsageInBytes: 0,
  },
  session: { id: randomUUID(), hasElevatedPermission: true } as AuthDto['session'],
});

describe(OAuthAppService.name, () => {
  let sut: OAuthAppService;
  let mocks: ServiceMocks;
  let repo: FakeOAuthAppRepository;
  let me: AuthDto;

  const request = (client: OAuthClient, overrides: Record<string, unknown> = {}) => {
    const verifier = verifierFor(randomUUID());
    return {
      verifier,
      dto: {
        responseType: 'code',
        clientId: client.id,
        redirectUri: client.redirectUris[0],
        scope: 'library:read people:read',
        state: 'state-123',
        codeChallenge: challengeOf(verifier),
        codeChallengeMethod: 'S256',
        ...overrides,
      },
    };
  };

  /** Allow, then exchange the code: the tokens an app gets. */
  const connect = async (client: OAuthClient, overrides: Record<string, unknown> = {}) => {
    const { dto, verifier } = request(client, overrides);
    const { redirectUrl } = await sut.authorize(me, { ...dto, allow: true } as never, ISSUER);
    const code = new URL(redirectUrl).searchParams.get('code')!;
    const tokens = await sut.token(
      {
        grant_type: 'authorization_code',
        code,
        client_id: client.id,
        redirect_uri: dto.redirectUri,
        code_verifier: verifier,
      },
      ISSUER,
    );
    return { tokens, code, verifier, dto };
  };

  const oauthErrorOf = async (promise: Promise<unknown>) => {
    const error = await promise.then(() => null).catch((error_: unknown) => error_);
    expect(error).toBeInstanceOf(HttpException);
    return (error as HttpException).getResponse() as { error: string };
  };

  beforeEach(() => {
    clearConfigCache();
    ({ sut, mocks } = newTestService(OAuthAppService));
    repo = new FakeOAuthAppRepository();
    Object.assign(sut, {
      oauthAppRepository: repo,
      connectRepository: {
        validateAlbums: vi.fn().mockResolvedValue(undefined),
        availableAlbums: vi.fn().mockResolvedValue([]),
      },
    });
    mocks.crypto.randomBytesAsText.mockImplementation((bytes: number) =>
      randomBytes(bytes).toString('base64').replaceAll(/\W/g, ''),
    );
    mocks.crypto.hashSha256.mockImplementation((value: string | Buffer) => createHash('sha256').update(value).digest());
    me = person('taylor');
    repo.users.set(me.user.id, me.user);
    mocks.user.get.mockImplementation((id: string) => Promise.resolve(repo.users.get(id) as never));
  });

  describe('Connect policy', () => {
    const policy = { version: 1, readAlbumIds: [], allLibraryRead: false, writableAlbumIds: [], writeWorkspaces: [] };
    it('requires an explicit consent policy for the Connect resource', async () => {
      const client = repo.addClient([LOCAL_REDIRECT]);
      await expect(connect(client, { scope: 'library:read', resource: `${ISSUER}/api/connect` })).rejects.toThrow();
      expect(repo.grants).toHaveLength(0);
    });
    it('refuses policy on a legacy grant', async () => {
      const client = repo.addClient([LOCAL_REDIRECT]);
      await expect(connect(client, { scope: 'library:read', accessPolicy: policy })).rejects.toThrow();
    });
    it('refuses another origin masquerading as the Connect resource', async () => {
      const client = repo.addClient([LOCAL_REDIRECT]);
      await expect(
        connect(client, { scope: 'library:read', resource: 'https://other.example/api/connect', accessPolicy: policy }),
      ).rejects.toThrow();
    });
    it('never grants people access to Connect', async () => {
      const client = repo.addClient([LOCAL_REDIRECT]);
      await expect(connect(client, { resource: `${ISSUER}/api/connect`, accessPolicy: policy })).rejects.toThrow();
    });
    it('binds the consent policy through code exchange and rotating refresh', async () => {
      const client = repo.addClient([LOCAL_REDIRECT]);
      const { tokens } = await connect(client, {
        scope: 'library:read photos:upload events:read',
        resource: `${ISSUER}/api/connect`,
        accessPolicy: policy,
      });
      expect((await sut.validateAccessToken(tokens.access_token, null)).oauthApp).toMatchObject({
        accessPolicy: policy,
      });
      const next = await sut.token({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
        client_id: client.id,
      });
      expect((await sut.validateAccessToken(next.access_token, null)).oauthApp).toMatchObject({ accessPolicy: policy });
    });
    it('preserves code-approved scopes and policy when refresh asks for a subset', async () => {
      const client = repo.addClient([LOCAL_REDIRECT]);
      const { tokens } = await connect(client, {
        scope: 'library:read photos:upload events:read',
        resource: `${ISSUER}/api/connect`,
        accessPolicy: policy,
      });
      const refreshed = await sut.token({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
        client_id: client.id,
        scope: 'library:read',
      });
      expect(refreshed.scope).toBe(tokens.scope);
      expect(repo.grants[0]).toMatchObject({
        scopes: ['library:read', 'photos:upload', 'events:read'],
        accessPolicy: policy,
        frameleafAccountId: null,
      });
    });

    it('refuses policy and resource changes during refresh', async () => {
      const client = repo.addClient([LOCAL_REDIRECT]);
      const { tokens } = await connect(client, {
        scope: 'library:read',
        resource: `${ISSUER}/api/connect`,
        accessPolicy: policy,
      });
      const body = { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.id };
      await expect(sut.token({ ...body, accessPolicy: { ...policy, allLibraryRead: true } })).rejects.toThrow();
      await expect(sut.token({ ...body, resource: `${ISSUER}/api/mcp` })).rejects.toThrow();
      expect((await sut.validateAccessToken(tokens.access_token, null)).oauthApp!.accessPolicy).toEqual(policy);
    });

    it('refuses Connect-only scopes on legacy grants', async () => {
      const client = repo.addClient([LOCAL_REDIRECT]);
      for (const scope of ['photos:upload', 'boards:upload', 'events:read']) {
        for (const resource of [undefined, `${ISSUER}/api/mcp`, `${ISSUER}/api/mcp/assistant`]) {
          await expect(connect(client, { scope, resource })).rejects.toThrow();
        }
      }
    });

    it('fails closed when a Connect grant lost its policy', async () => {
      const client = repo.addClient([LOCAL_REDIRECT]);
      const { tokens } = await connect(client, { scope: 'library:read' });
      repo.grants[0].resource = `${ISSUER}/api/connect`;
      await expect(sut.validateAccessToken(tokens.access_token, null)).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  it('requires a Server licence for official authorization and refresh but accepts an offline licence', async () => {
    const client = repo.addClient([LOCAL_REDIRECT]);
    const resource = `${ISSUER}/api/mcp/assistant`;
    const overrides = { resource, scope: 'library:read' };
    const { dto } = request(client, overrides);
    await expect(sut.authorize(me, { ...dto, allow: true } as never, ISSUER)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    let licensed = true;
    mocks.systemMetadata.get.mockImplementation((key) =>
      Promise.resolve(
        key === SystemMetadataKey.FrameleafLicense && licensed
          ? ({
              key: { kind: 'server', source: 'file', claims: { lic_exp: null, exp: 0, ent: ['SUPPORTER_SERVER'] } },
            } as never)
          : null,
      ),
    );
    const { tokens } = await connect(client, overrides);
    await expect(sut.validateAccessToken(tokens.access_token, 'lan')).resolves.toMatchObject({
      oauthApp: { resource },
    });
    licensed = false;
    await expect(sut.validateAccessToken(tokens.access_token, 'lan')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(
      (
        await oauthErrorOf(
          sut.token({
            grant_type: 'refresh_token',
            client_id: client.id,
            refresh_token: tokens.refresh_token,
          }),
        )
      ).error,
    ).toBe('invalid_grant');
    await expect(connect(client)).resolves.toHaveProperty('tokens.access_token');
  });

  it('binds broker grants to the linked Frameleaf account', async () => {
    const callback = 'https://mcp.frameleaf.cloud/oauth/library/callback/chatgpt';
    const client = repo.addClient([callback], 'Untrusted client name');
    const resource = `${ISSUER}/api/mcp/assistant`;
    mocks.systemMetadata.get.mockImplementation((key) =>
      Promise.resolve(
        key === SystemMetadataKey.FrameleafLicense
          ? ({ key: { kind: 'server', claims: { lic_exp: null, exp: 0, ent: ['SUPPORTER_SERVER'] } } } as never)
          : null,
      ),
    );
    mocks.frameleafAccount.getLinkByUser.mockResolvedValue({ sub: 'cloud-account' } as never);
    const { tokens } = await connect(client, { resource, scope: 'library:read' });
    expect(tokens).toHaveProperty('frameleaf_account_id', 'cloud-account');
    await expect(sut.validateAccessToken(tokens.access_token, 'wan')).resolves.toMatchObject({
      oauthApp: { clientName: 'ChatGPT' },
    });
    mocks.frameleafAccount.getLinkByUser.mockResolvedValue({ sub: 'other-account' } as never);
    await expect(sut.validateAccessToken(tokens.access_token, 'wan')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('refuses official tokens at a different origin and stops issuing them when MCP is disabled', async () => {
    const client = repo.addClient([LOCAL_REDIRECT]);
    const resource = `${ISSUER}/api/mcp/assistant`;
    let enabled = true;
    mocks.systemMetadata.get.mockImplementation((key) =>
      Promise.resolve(
        (key === SystemMetadataKey.FrameleafLicense
          ? { key: { kind: 'server', source: 'file', claims: { lic_exp: null, exp: 0, ent: ['SUPPORTER_SERVER'] } } }
          : { connectedApps: { allowMcp: enabled, allowRegistration: true } }) as never,
      ),
    );
    expect(sut.getProtectedResourceMetadata(ISSUER, '/api/mcp/assistant')).toMatchObject({
      resource,
      scopes_supported: ['library:read'],
    });
    const { tokens } = await connect(client, { resource, scope: 'library:read' });
    const refresh = { grant_type: 'refresh_token', client_id: client.id, refresh_token: tokens.refresh_token };
    await expect(sut.token(refresh, 'https://other.example.test')).rejects.toThrow();
    enabled = false;
    await expect(sut.token(refresh, ISSUER)).rejects.toThrow();
    await expect(sut.validateAccessToken(tokens.access_token, null)).rejects.toThrow();
    enabled = true;
    await expect(sut.token(refresh, ISSUER)).resolves.toHaveProperty('access_token');
  });

  it.each([
    'https://claude.ai/api/mcp/auth_callback',
    'https://claude.com/api/mcp/auth_callback',
    'https://chatgpt.com/connector_platform_oauth_redirect',
    'https://my.home-assistant.io/redirect/oauth',
    'lightroom://net.frameleaf.connect/oauth/callback',
  ])('preserves the exact registered callback %s', async (callback) => {
    const client = repo.addClient([callback]);
    const { tokens } = await connect(client, { scope: 'library:read' });
    await expect(sut.validateAccessToken(tokens.access_token, null)).resolves.toMatchObject({
      oauthApp: { clientId: client.id },
    });
  });

  it('advertises Connect-only scopes exclusively on the Connect resource', () => {
    expect(sut.getProtectedResourceMetadata(ISSUER, '/api/mcp/assistant').scopes_supported).toEqual(['library:read']);
    for (const path of ['', '/api/mcp', '/api/mcp/assistant']) {
      const scopes = sut.getProtectedResourceMetadata(ISSUER, path).scopes_supported;
      expect(scopes).not.toContain('photos:upload');
      expect(scopes).not.toContain('boards:upload');
      expect(scopes).not.toContain('events:read');
    }
    expect(sut.getProtectedResourceMetadata(ISSUER, '/api/connect').scopes_supported).toEqual(
      expect.arrayContaining(['photos:upload', 'boards:upload', 'events:read']),
    );
  });

  it.each([null, 'other-account'])(
    'rechecks broker account binding at code exchange and refresh after link becomes %s',
    async (linkedAccount) => {
      const client = repo.addClient(['https://mcp.frameleaf.cloud/oauth/library/callback/claude']);
      const resource = `${ISSUER}/api/mcp/assistant`;
      mocks.systemMetadata.get.mockImplementation((key) =>
        Promise.resolve(
          key === SystemMetadataKey.FrameleafLicense
            ? ({ key: { kind: 'server', claims: { lic_exp: null, exp: 0, ent: ['SUPPORTER_SERVER'] } } } as never)
            : null,
        ),
      );
      mocks.frameleafAccount.getLinkByUser.mockResolvedValue({ sub: 'cloud-account' } as never);
      const { tokens } = await connect(client, { resource, scope: 'library:read' });
      const { dto, verifier } = request(client, { resource, scope: 'library:read' });
      const { redirectUrl } = await sut.authorize(me, { ...dto, allow: true } as never, ISSUER);
      mocks.frameleafAccount.getLinkByUser.mockResolvedValue(
        (linkedAccount ? { sub: linkedAccount } : undefined) as never,
      );
      await expect(
        sut.token(
          {
            grant_type: 'authorization_code',
            code: new URL(redirectUrl).searchParams.get('code'),
            client_id: client.id,
            redirect_uri: dto.redirectUri,
            code_verifier: verifier,
          },
          ISSUER,
        ),
      ).rejects.toThrow();
      await expect(
        sut.token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.id }, ISSUER),
      ).rejects.toThrow();
      expect(repo.rotate).not.toHaveBeenCalled();
      expect(repo.grants).toHaveLength(1);
    },
  );

  it('revokes only the original assistant grant using a consumed refresh after account unlink', async () => {
    const client = repo.addClient(['https://mcp.frameleaf.cloud/oauth/library/callback/chatgpt']);
    const resource = `${ISSUER}/api/mcp/assistant`;
    mocks.systemMetadata.get.mockImplementation((key) =>
      Promise.resolve(
        key === SystemMetadataKey.FrameleafLicense
          ? ({ key: { kind: 'server', claims: { lic_exp: null, exp: 0, ent: ['SUPPORTER_SERVER'] } } } as never)
          : null,
      ),
    );
    mocks.frameleafAccount.getLinkByUser.mockResolvedValue({ sub: 'cloud-account' } as never);
    const { tokens } = await connect(client, { resource, scope: 'library:read' });
    await connect(client, { resource, scope: 'library:read' });
    await sut.token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.id }, ISSUER);
    mocks.frameleafAccount.getLinkByUser.mockResolvedValue(undefined);
    await sut.revoke({ token: tokens.refresh_token, client_id: randomUUID() });
    expect(repo.grants[0].revokedAt).toBeNull();
    await sut.revoke({ token: tokens.refresh_token, client_id: client.id });
    expect(repo.grants[0].revokedAt).not.toBeNull();
    expect(repo.grants[1].revokedAt).toBeNull();
  });

  describe('authorizeRedirect', () => {
    it('opens the Allow page for a good request', async () => {
      const client = repo.addClient([CLAUDE_REDIRECT]);
      const { dto } = request(client);
      const url = await sut.authorizeRedirect(
        {
          response_type: 'code',
          client_id: client.id,
          redirect_uri: CLAUDE_REDIRECT,
          scope: dto.scope,
          state: 'abc',
          code_challenge: dto.codeChallenge,
          code_challenge_method: 'S256',
        },
        ISSUER,
      );
      expect(url.startsWith('/auth/allow-app?')).toBe(true);
      const params = new URL(url, ISSUER).searchParams;
      expect(params.get('client_id')).toBe(client.id);
      expect(params.get('state')).toBe('abc');
    });

    it('never sends an unknown app or a wrong return address anywhere but the Allow page', async () => {
      const client = repo.addClient([CLAUDE_REDIRECT]);
      for (const query of [
        { client_id: randomUUID(), redirect_uri: CLAUDE_REDIRECT },
        { client_id: 'not-a-uuid', redirect_uri: CLAUDE_REDIRECT },
        { client_id: client.id, redirect_uri: 'https://evil.example/cb' },
        { client_id: client.id, redirect_uri: `${CLAUDE_REDIRECT}/` },
      ]) {
        const url = await sut.authorizeRedirect({ response_type: 'code', ...query }, ISSUER);
        expect(url).toBe('/auth/allow-app?error=invalid_request');
      }
    });

    it('sends other faults back to the app as OAuth errors with state and iss', async () => {
      const client = repo.addClient([CLAUDE_REDIRECT]);
      const { dto } = request(client);
      const base = {
        response_type: 'code',
        client_id: client.id,
        redirect_uri: CLAUDE_REDIRECT,
        state: 's1',
        code_challenge: dto.codeChallenge,
        code_challenge_method: 'S256',
      };
      const errorOf = async (query: Record<string, unknown>) =>
        new URL(await sut.authorizeRedirect({ ...base, ...query }, ISSUER)).searchParams;

      expect((await errorOf({ response_type: 'token' })).get('error')).toBe('unsupported_response_type');
      expect((await errorOf({ code_challenge_method: 'plain' })).get('error')).toBe('invalid_request');
      expect((await errorOf({ code_challenge: undefined })).get('error')).toBe('invalid_request');
      const scope = await errorOf({ scope: 'library:read locked:read' });
      expect(scope.get('error')).toBe('invalid_scope');
      expect(scope.get('state')).toBe('s1');
      expect(scope.get('iss')).toBe(ISSUER);
    });
  });

  it('keeps original downloads outside the MCP resource and consent', async () => {
    expect(sut.getProtectedResourceMetadata(ISSUER, '/api/mcp').scopes_supported).not.toContain('library:download');
    expect(sut.getProtectedResourceMetadata(ISSUER, '').scopes_supported).toContain('library:download');
    const client = repo.addClient([CLAUDE_REDIRECT]);
    const { dto } = request(client);
    const url = await sut.authorizeRedirect(
      {
        response_type: 'code',
        client_id: client.id,
        redirect_uri: CLAUDE_REDIRECT,
        scope: 'library:read library:download',
        resource: `${ISSUER}/api/mcp`,
        code_challenge: dto.codeChallenge,
        code_challenge_method: 'S256',
      },
      ISSUER,
    );
    expect(new URL(url).searchParams.get('error')).toBe('invalid_scope');
  });

  describe('start and authorize', () => {
    it('shows a verified app by the name Frameleaf knows', async () => {
      const client = repo.addClient([CLAUDE_REDIRECT], 'Totally Claude');
      const result = await sut.start(me, request(client).dto as never);
      expect(result.client).toMatchObject({
        name: 'Claude',
        verified: true,
        maker: 'Anthropic',
        returnTo: 'claude.ai',
      });
      expect(result.scopes).toEqual(['library:read', 'people:read']);
    });

    it('shows an unchecked app by its own name', async () => {
      const client = repo.addClient(['https://photohelper.example.net/cb'], 'Photo Helper');
      const result = await sut.start(me, request(client).dto as never);
      expect(result.client).toMatchObject({ name: 'Photo Helper', verified: false, knownApp: null });
    });

    it('is only for a signed-in person, never a key, an app or a shared link', async () => {
      const client = repo.addClient([CLAUDE_REDIRECT]);
      const { dto } = request(client);
      for (const auth of [
        { user: me.user },
        { ...me, apiKey: { id: randomUUID(), permissions: [Permission.All] } },
        { ...me, oauthApp: { grantId: 'g', clientId: 'c', clientName: 'x', scopes: [], resource: null } },
        { ...me, sharedLink: {} as never },
      ]) {
        await expect(sut.start(auth as AuthDto, dto as never)).rejects.toBeInstanceOf(ForbiddenException);
      }
    });

    it('refuses scopes Frameleaf does not offer', async () => {
      const client = repo.addClient([CLAUDE_REDIRECT]);
      await expect(sut.start(me, request(client, { scope: 'library:read assistant' }).dto as never)).rejects.toThrow();
    });

    it('records Deny and makes no code', async () => {
      const client = repo.addClient([CLAUDE_REDIRECT]);
      const { redirectUrl } = await sut.authorize(me, { ...request(client).dto, allow: false } as never, ISSUER);
      const params = new URL(redirectUrl).searchParams;
      expect(params.get('error')).toBe('access_denied');
      expect(params.get('code')).toBeNull();
      expect(repo.codes.size).toBe(0);
      expect(mocks.accountEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({ action: AccountEventAction.AppDenied, subject: 'Claude', userId: me.user.id }),
      );
    });

    it('records Allow and makes a five-minute code bound to this session', async () => {
      const client = repo.addClient([CLAUDE_REDIRECT]);
      const { redirectUrl } = await sut.authorize(me, { ...request(client).dto, allow: true } as never, ISSUER);
      const params = new URL(redirectUrl).searchParams;
      expect(params.get('state')).toBe('state-123');
      expect(params.get('iss')).toBe(ISSUER);
      const [code] = repo.codes.values();
      expect(code.sessionId).toBe(me.session!.id);
      expect(new Date(code.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(OAUTH_CODE_TTL_SECONDS * 1000);
      expect(mocks.accountEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({ action: AccountEventAction.AppConnected, detail: 'library:read people:read' }),
      );
    });
  });

  describe('token: authorization_code', () => {
    it('issues an hour-long access token and a refresh token, keeping only their hashes', async () => {
      const client = repo.addClient([CLAUDE_REDIRECT]);
      const { tokens } = await connect(client);
      expect(tokens).toMatchObject({
        token_type: 'Bearer',
        expires_in: OAUTH_ACCESS_TTL_SECONDS,
        scope: 'library:read people:read',
      });
      expect(tokens.access_token.startsWith('fla_')).toBe(true);
      expect(tokens.refresh_token.startsWith('flr_')).toBe(true);
      const [grant] = repo.grants;
      expect(JSON.stringify(grant)).not.toContain(tokens.access_token);
      expect(JSON.stringify(grant)).not.toContain(tokens.refresh_token);
    });

    it('uses a code once, even when the first try is wrong', async () => {
      const client = repo.addClient([CLAUDE_REDIRECT]);
      const { dto, verifier } = request(client);
      const { redirectUrl } = await sut.authorize(me, { ...dto, allow: true } as never, ISSUER);
      const code = new URL(redirectUrl).searchParams.get('code')!;
      const body = { grant_type: 'authorization_code', code, client_id: client.id, redirect_uri: CLAUDE_REDIRECT };

      expect((await oauthErrorOf(sut.token({ ...body, code_verifier: verifierFor('wrong') }))).error).toBe(
        'invalid_grant',
      );
      expect((await oauthErrorOf(sut.token({ ...body, code_verifier: verifier }))).error).toBe('invalid_grant');
      expect(repo.grants).toHaveLength(0);
    });

    it.each([
      ['another app', { client_id: randomUUID() }],
      ['another return address', { redirect_uri: 'https://claude.ai/other' }],
      ['another resource', { resource: 'https://elsewhere.example/api/mcp' }],
      ['no verifier', { code_verifier: undefined }],
    ])('refuses %s', async (_, change) => {
      const client = repo.addClient([CLAUDE_REDIRECT]);
      const { dto, verifier } = request(client);
      const { redirectUrl } = await sut.authorize(me, { ...dto, allow: true } as never, ISSUER);
      const code = new URL(redirectUrl).searchParams.get('code')!;
      const error = await oauthErrorOf(
        sut.token({
          grant_type: 'authorization_code',
          code,
          client_id: client.id,
          redirect_uri: CLAUDE_REDIRECT,
          code_verifier: verifier,
          ...change,
        }),
      );
      expect(error.error).toBe('invalid_grant');
    });

    it('refuses an expired code', async () => {
      const client = repo.addClient([CLAUDE_REDIRECT]);
      const { dto, verifier } = request(client);
      const { redirectUrl } = await sut.authorize(me, { ...dto, allow: true } as never, ISSUER);
      const code = new URL(redirectUrl).searchParams.get('code')!;
      for (const stored of repo.codes.values()) {
        stored.expiresAt = new Date(Date.now() - 1000) as never;
      }
      const error = await oauthErrorOf(
        sut.token({
          grant_type: 'authorization_code',
          code,
          client_id: client.id,
          redirect_uri: CLAUDE_REDIRECT,
          code_verifier: verifier,
        }),
      );
      expect(error.error).toBe('invalid_grant');
    });

    it('binds the code to the loopback port the app actually used', async () => {
      const client = repo.addClient([LOCAL_REDIRECT]);
      const { dto, verifier } = request(client, { redirectUri: 'http://127.0.0.1:5123/callback' });
      const { redirectUrl } = await sut.authorize(me, { ...dto, allow: true } as never, ISSUER);
      expect(redirectUrl.startsWith('http://127.0.0.1:5123/callback?')).toBe(true);
      const code = new URL(redirectUrl).searchParams.get('code')!;
      const body = { grant_type: 'authorization_code', code, client_id: client.id, code_verifier: verifier };
      expect((await oauthErrorOf(sut.token({ ...body, redirect_uri: LOCAL_REDIRECT }))).error).toBe('invalid_grant');
    });

    it('refuses grant types other than authorization_code and refresh_token', async () => {
      for (const grant_type of ['password', 'client_credentials', 'implicit', undefined]) {
        expect((await oauthErrorOf(sut.token({ grant_type }))).error).toBe('unsupported_grant_type');
      }
    });
  });

  describe('token: refresh_token', () => {
    it('rotates both tokens', async () => {
      const client = repo.addClient([CLAUDE_REDIRECT]);
      const { tokens } = await connect(client);
      const next = await sut.token({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
        client_id: client.id,
      });
      expect(next.refresh_token).not.toBe(tokens.refresh_token);
      expect(next.access_token).not.toBe(tokens.access_token);
      await expect(sut.validateAccessToken(tokens.access_token, null)).rejects.toBeInstanceOf(UnauthorizedException);
      await expect(sut.validateAccessToken(next.access_token, null)).resolves.toBeDefined();
    });

    it('revokes the grant when a used refresh token comes back', async () => {
      const client = repo.addClient([CLAUDE_REDIRECT]);
      const { tokens } = await connect(client);
      const next = await sut.token({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
        client_id: client.id,
      });

      const error = await oauthErrorOf(
        sut.token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.id }),
      );
      expect(error.error).toBe('invalid_grant');
      expect(repo.grants[0].revokedAt).not.toBeNull();
      await expect(sut.validateAccessToken(next.access_token, null)).rejects.toBeInstanceOf(UnauthorizedException);
      expect(
        (
          await oauthErrorOf(
            sut.token({ grant_type: 'refresh_token', refresh_token: next.refresh_token, client_id: client.id }),
          )
        ).error,
      ).toBe('invalid_grant');
      expect(mocks.accountEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({ action: AccountEventAction.AppDisconnected, detail: 'token-reused' }),
      );
    });

    it('refuses another app’s refresh and a wider scope', async () => {
      const client = repo.addClient([CLAUDE_REDIRECT]);
      const { tokens } = await connect(client, { scope: 'library:read' });
      const other = repo.addClient(['https://other.example/cb']);
      expect(
        (
          await oauthErrorOf(
            sut.token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: other.id }),
          )
        ).error,
      ).toBe('invalid_grant');
      expect(
        (
          await oauthErrorOf(
            sut.token({
              grant_type: 'refresh_token',
              refresh_token: tokens.refresh_token,
              client_id: client.id,
              scope: 'library:read library:download',
            }),
          )
        ).error,
      ).toBe('invalid_scope');
    });
  });

  describe('validateAccessToken', () => {
    it('acts like a key with the scopes’ permissions, never a session (so never unlocked)', async () => {
      const client = repo.addClient([CLAUDE_REDIRECT]);
      const { tokens } = await connect(client, { scope: 'library:read' });
      const auth = await sut.validateAccessToken(tokens.access_token, 'relay');
      expect(auth.session).toBeUndefined();
      expect(auth.apiKey?.permissions).toContain(Permission.AssetRead);
      expect(auth.apiKey?.permissions).not.toContain(Permission.AssetDownload);
      expect(auth.apiKey?.permissions).not.toContain(Permission.All);
      expect(auth.oauthApp).toMatchObject({ clientName: 'Claude', scopes: ['library:read'] });
      expect(repo.recordUse).toHaveBeenCalledWith(repo.grants[0].id, 'relay');
    });

    it('fails on the next request once revoked', async () => {
      const client = repo.addClient([CLAUDE_REDIRECT]);
      const { tokens } = await connect(client);
      await sut.revokeGrant(me, repo.grants[0].id);
      await expect(sut.validateAccessToken(tokens.access_token, null)).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('fails once expired', async () => {
      const client = repo.addClient([CLAUDE_REDIRECT]);
      const { tokens } = await connect(client);
      repo.grants[0].accessExpiresAt = new Date(Date.now() - 1) as never;
      await expect(sut.validateAccessToken(tokens.access_token, null)).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('fails for an unknown token', async () => {
      await expect(sut.validateAccessToken('fla_nothing', null)).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  describe('revoke (RFC 7009)', () => {
    it('revokes the same grant with a consumed refresh token after a lost rotation response', async () => {
      const client = repo.addClient([CLAUDE_REDIRECT]);
      const { tokens } = await connect(client);
      const other = await connect(client);
      const rotated = await sut.token({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
        client_id: client.id,
      });
      await sut.revoke({ token: tokens.refresh_token, client_id: randomUUID() });
      await expect(sut.validateAccessToken(rotated.access_token, null)).resolves.toBeDefined();
      await sut.revoke({ token: tokens.refresh_token, client_id: client.id });
      await expect(sut.validateAccessToken(rotated.access_token, null)).rejects.toBeInstanceOf(UnauthorizedException);
      await expect(sut.validateAccessToken(other.tokens.access_token, null)).resolves.toBeDefined();
      await expect(
        sut.token({
          grant_type: 'refresh_token',
          refresh_token: rotated.refresh_token,
          client_id: client.id,
        }),
      ).rejects.toThrow();
      expect(mocks.accountEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({ action: AccountEventAction.AppDisconnected, detail: 'app-signed-out' }),
      );
    });

    it('allows revocation with an expired current access token', async () => {
      const client = repo.addClient([CLAUDE_REDIRECT]);
      const { tokens } = await connect(client);
      repo.grants[0].accessExpiresAt = new Date(Date.now() - 1) as never;
      await sut.revoke({ token: tokens.access_token, client_id: client.id });
      expect(repo.grants[0].revokedAt).not.toBeNull();
    });

    it('lets an app sign itself out with either token', async () => {
      const client = repo.addClient([CLAUDE_REDIRECT]);
      const { tokens } = await connect(client);
      await sut.revoke({ token: tokens.refresh_token, client_id: client.id });
      await expect(sut.validateAccessToken(tokens.access_token, null)).rejects.toBeInstanceOf(UnauthorizedException);
      expect(mocks.accountEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({ action: AccountEventAction.AppDisconnected, detail: 'app-signed-out' }),
      );
    });

    it('ignores unknown tokens and another app’s client id', async () => {
      const client = repo.addClient([CLAUDE_REDIRECT]);
      const { tokens } = await connect(client);
      await expect(sut.revoke({ token: 'fla_unknown' })).resolves.toBeUndefined();
      await sut.revoke({ token: tokens.access_token, client_id: randomUUID() });
      await expect(sut.validateAccessToken(tokens.access_token, null)).resolves.toBeDefined();
    });
  });

  describe('register (RFC 7591)', () => {
    it('registers a public client', async () => {
      const result = await sut.register({ client_name: 'Claude', redirect_uris: [CLAUDE_REDIRECT] });
      expect(result).toMatchObject({ token_endpoint_auth_method: 'none', redirect_uris: [CLAUDE_REDIRECT] });
      expect(repo.createClient).toHaveBeenCalledWith(expect.objectContaining({ dynamic: true }), expect.any(Number));
    });

    it('is refused while the administrator does not allow it', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ connectedApps: { allowRegistration: false } });
      const error = await oauthErrorOf(sut.register({ redirect_uris: [CLAUDE_REDIRECT] }));
      expect(error.error).toBe('access_denied');
      expect(repo.createClient).not.toHaveBeenCalled();
    });

    it.each([
      [{ redirect_uris: [] }, 'invalid_redirect_uri'],
      [{ redirect_uris: ['http://evil.example/cb'] }, 'invalid_redirect_uri'],
      [
        { redirect_uris: [CLAUDE_REDIRECT], token_endpoint_auth_method: 'client_secret_basic' },
        'invalid_client_metadata',
      ],
      [{ redirect_uris: [CLAUDE_REDIRECT], grant_types: ['implicit'] }, 'invalid_client_metadata'],
      [{ redirect_uris: [CLAUDE_REDIRECT], grant_types: ['password'] }, 'invalid_client_metadata'],
      [{ redirect_uris: [CLAUDE_REDIRECT], response_types: ['token'] }, 'invalid_client_metadata'],
    ])('refuses %j', async (body, code) => {
      expect((await oauthErrorOf(sut.register(body))).error).toBe(code);
    });

    it('leaves the registration endpoint out of the metadata while registration is off', async () => {
      expect(await sut.getAuthorizationServerMetadata(ISSUER)).toMatchObject({
        registration_endpoint: `${ISSUER}/api/oauth/apps/register`,
        code_challenge_methods_supported: ['S256'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
      });
      clearConfigCache();
      mocks.systemMetadata.get.mockResolvedValue({ connectedApps: { allowRegistration: false } });
      expect(await sut.getAuthorizationServerMetadata(ISSUER)).not.toHaveProperty('registration_endpoint');
    });
  });

  describe('administrator registration', () => {
    it('allows an administrator to create an unverified public client while DCR stays disabled', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ connectedApps: { allowRegistration: false } });
      const admin = person('admin', true);
      const result = await sut.createClient(admin, {
        name: 'My Zap',
        preset: 'zapier',
        redirectUris: ['https://zapier.com/dashboard/auth/oauth/return/App/'],
      });
      expect(result).toMatchObject({ name: 'My Zap', tokenEndpointAuthMethod: 'none' });
      expect(repo.clients.get(result.clientId)).toMatchObject({ dynamic: false });
      const display = (await sut.getClients()).find((item) => item.client.id === result.clientId);
      expect(display?.client.verified).toBe(false);
      await expect(sut.register({ redirect_uris: [LOCAL_REDIRECT] })).rejects.toThrow();
    });
    it('requires an administrator session and an exact allowed callback', async () => {
      const dto = { name: 'App', redirectUris: [LOCAL_REDIRECT] };
      await expect(sut.createClient(me, dto)).rejects.toThrow();
      await expect(sut.createClient({ ...person('admin', true), session: undefined }, dto)).rejects.toThrow();
      await expect(
        sut.createClient(person('admin', true), { ...dto, redirectUris: ['http://evil.example/cb'] }),
      ).rejects.toThrow();
    });
  });

  describe('grants', () => {
    it('lists only your active grants and lets you remove them', async () => {
      const client = repo.addClient([CLAUDE_REDIRECT]);
      await connect(client);
      const [grant] = await sut.getGrants(me);
      expect(grant).toMatchObject({ client: { name: 'Claude' }, scopes: ['library:read', 'people:read'] });

      const stranger = person('jamie');
      await expect(sut.revokeGrant(stranger, grant.id)).rejects.toBeInstanceOf(NotFoundException);
      await sut.revokeGrant(me, grant.id);
      expect(await sut.getGrants(me)).toEqual([]);
      expect(mocks.accountEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({ action: AccountEventAction.AppDisconnected, detail: 'removed', subject: 'Claude' }),
      );
    });

    it('cannot be listed or removed by an app itself', async () => {
      const client = repo.addClient([CLAUDE_REDIRECT]);
      const { tokens } = await connect(client);
      const auth = await sut.validateAccessToken(tokens.access_token, null);
      await expect(sut.getGrants(auth)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(sut.revokeGrant(auth, repo.grants[0].id)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('ends everyone’s access when an administrator removes the app', async () => {
      const client = repo.addClient([CLAUDE_REDIRECT]);
      const { tokens } = await connect(client);
      await sut.deleteClient(person('admin', true), client.id);
      await expect(sut.validateAccessToken(tokens.access_token, null)).rejects.toBeInstanceOf(UnauthorizedException);
      expect(mocks.accountEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({ userId: me.user.id, detail: 'app-deleted' }),
      );
    });
  });

  it('never writes a token, code or verifier to the account activity', async () => {
    const client = repo.addClient([CLAUDE_REDIRECT]);
    const { tokens, code, verifier } = await connect(client);
    const next = await sut.token({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: client.id,
    });
    await sut
      .token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.id })
      .catch(() => {});
    expectNoSecretsInAccountEvents(mocks.accountEvent.create, [
      tokens.access_token,
      tokens.refresh_token,
      next.access_token,
      next.refresh_token,
      code,
      verifier,
    ]);
  });
});
