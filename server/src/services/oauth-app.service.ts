import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { AuthUser } from 'src/database.js';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { FrameleafVia } from 'src/utils/frameleaf-sign-in.js';
import {
  OAuthAppAdminClientDto,
  OAuthAppAuthorizeDto,
  OAuthAppAuthorizeResponseDto,
  OAuthAppAuthorizeStartDto,
  OAuthAppAuthorizeStartResponseDto,
  OAuthAppClientDto,
  OAuthAppGrantDto,
} from 'src/dtos/oauth-app.dto.js';
import { AccountEventAction, SystemMetadataKey } from 'src/enum.js';
import { toAccountEventVia } from 'src/repositories/account-event.repository.js';
import { OAuthAppRepository, OAuthClient } from 'src/repositories/oauth-app.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { isCodeChallenge, verifierMatches } from 'src/utils/browser-extension-sign-in.js';
import { remoteEntitlement } from 'src/utils/frameleaf-remote-access.js';
import {
  ASSISTANT_MCP_PATH,
  MCP_PATH,
  OAUTH_ACCESS_TOKEN_PREFIX,
  OAUTH_ACCESS_TTL_SECONDS,
  OAUTH_CODE_TTL_SECONDS,
  OAUTH_DYNAMIC_CLIENT_LIMIT,
  OAUTH_REFRESH_TOKEN_PREFIX,
  OAUTH_SCOPES_SUPPORTED,
  OAUTH_USE_RECORD_INTERVAL_MS,
  assistantBrokerName,
  checkRegisteredRedirectUri,
  checkResource,
  cleanClientName,
  isAssistantResource,
  matchRedirectUri,
  oauthReturnAddress,
  parseScopes,
  redirectDisplay,
  scopePermissions,
  verifiedApp,
} from 'src/utils/oauth-apps.js';

const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

/** The web page the authorization endpoint sends people to (FL-860 builds it). */
export const ALLOW_APP_PAGE = '/auth/allow-app';

/** An OAuth error response (RFC 6749 §5.2): `{ error, error_description }`. */
export const oauthError = (error: string, description: string, status = HttpStatus.BAD_REQUEST) =>
  new HttpException({ error, error_description: description, message: description, statusCode: status }, status);

/** A refusal of the Allow page's request, with a code the page shows as "This request can’t be used". */
const requestError = (code: string, message: string) =>
  new BadRequestException({ message, error: 'Bad Request', statusCode: 400, code });

type AuthorizeParams = {
  responseType?: unknown;
  clientId?: unknown;
  redirectUri?: unknown;
  scope?: unknown;
  state?: unknown;
  codeChallenge?: unknown;
  codeChallengeMethod?: unknown;
  resource?: unknown;
};

type CheckedRequest = {
  client: OAuthClient;
  redirectUri: string;
  scopes: string[];
  state: string | undefined;
  codeChallenge: string;
  resource: string | null;
};

/** The parts of an authorization request that must be right before anything is sent back to the app. */
type RequestFault =
  { target: false } | { target: true; redirectUri: string; state?: string; error: string; description: string };

export type OAuthTokenResponse = {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
  frameleaf_account_id?: string;
};

const text = (value: unknown) => (typeof value === 'string' ? value : undefined);

/**
 * FL-803 (E3-03): Frameleaf's OAuth 2.1 authorization server for connected apps, such as an AI
 * assistant's connector or Home Assistant. It generalises Save to Frameleaf's sign-in (FL-655):
 *
 * - Authorization code with PKCE (S256 only); no implicit or password grant, no client secrets.
 * - Return addresses match exactly what the app registered (a loopback address may use any port).
 * - The code is single-use, five minutes, bound to the app, person, session, return address,
 *   challenge, scopes and resource. Access tokens last an hour; refresh tokens rotate on every use
 *   and a used one presented again revokes the grant. Only SHA-256 hashes of any of them are kept.
 * - Scopes map onto existing permissions (`OAUTH_APP_SCOPES`); Locked is never a scope, app tokens
 *   have no session (so are never unlocked) and never reach admin routes.
 * - Consent, denial, use, revocation and token reuse are written to the account activity (FL-808).
 * - Apps may register themselves (RFC 7591) only while an administrator allows it.
 *
 * Threat model: FL-780.
 */
@Injectable()
export class OAuthAppService extends BaseService {
  @Inject(OAuthAppRepository)
  private oauthAppRepository!: OAuthAppRepository;

  /** Use is recorded at most once an hour per grant and process. */
  private usesRecorded = new Map<string, number>();

  async assistantAvailable() {
    const { connectedApps } = await this.getConfig({ withCache: false });
    const licence = await this.systemMetadataRepository.get(SystemMetadataKey.FrameleafLicense);
    return connectedApps.allowMcp !== false && remoteEntitlement(licence).direct;
  }

  private brokerForClient(redirectUris: string[]) {
    return redirectUris.length === 1 ? assistantBrokerName(redirectUris[0]) : undefined;
  }

  /**
   * `GET oauth/apps/authorize`: where the browser goes. A request whose app or return address is
   * wrong is never sent back to that address; the Allow page says it can't be used. Any other fault
   * goes back to the app as an OAuth error. A good request opens the Allow page with its parameters.
   */
  async authorizeRedirect(query: Record<string, unknown>, issuer: string): Promise<string> {
    const params: AuthorizeParams = {
      responseType: query.response_type,
      clientId: query.client_id,
      redirectUri: query.redirect_uri,
      scope: query.scope,
      state: query.state,
      codeChallenge: query.code_challenge,
      codeChallengeMethod: query.code_challenge_method,
      resource: query.resource,
    };
    const checked = await this.checkRequest(params, issuer);
    if ('fault' in checked) {
      const fault = checked.fault;
      if (!fault.target) {
        return `${ALLOW_APP_PAGE}?${new URLSearchParams({ error: 'invalid_request' })}`;
      }
      return oauthReturnAddress(fault.redirectUri, {
        error: fault.error,
        error_description: fault.description,
        state: fault.state,
        iss: issuer,
      });
    }
    const forward = new URLSearchParams();
    for (const [key, value] of Object.entries({
      response_type: 'code',
      client_id: checked.client.id,
      redirect_uri: checked.redirectUri,
      scope: checked.scopes.join(' '),
      state: checked.state,
      code_challenge: checked.codeChallenge,
      code_challenge_method: 'S256',
      resource: checked.resource ?? undefined,
    })) {
      if (value !== undefined) {
        forward.set(key, value);
      }
    }
    return `${ALLOW_APP_PAGE}?${forward}`;
  }

  /** `POST oauth/apps/authorize/start`: what the Allow page shows for a request. */
  async start(
    auth: AuthDto,
    dto: OAuthAppAuthorizeStartDto,
    issuer?: string,
  ): Promise<OAuthAppAuthorizeStartResponseDto> {
    const checked = await this.checkPage(auth, dto, issuer);
    return { client: this.mapClient(checked.client, checked.redirectUri), scopes: checked.scopes };
  }

  /**
   * `POST oauth/apps/authorize`: Allow or Deny, by a signed-in person (a session, never a key or an
   * app). Allow makes the single-use code; Deny makes nothing. Either is in the account activity.
   */
  async authorize(auth: AuthDto, dto: OAuthAppAuthorizeDto, issuer: string): Promise<OAuthAppAuthorizeResponseDto> {
    const checked = await this.checkPage(auth, dto, issuer);
    const name = this.mapClient(checked.client, checked.redirectUri).name;
    if (!dto.allow) {
      await this.recordAccountEvent({
        userId: auth.user.id,
        sessionId: auth.session!.id,
        action: AccountEventAction.AppDenied,
        subject: name,
      });
      return {
        redirectUrl: oauthReturnAddress(checked.redirectUri, {
          error: 'access_denied',
          state: checked.state,
          iss: issuer,
        }),
      };
    }
    const code = this.cryptoRepository.randomBytesAsText(32);
    await this.oauthAppRepository.createCode({
      codeHash: this.cryptoRepository.hashSha256(code),
      clientId: checked.client.id,
      userId: auth.user.id,
      sessionId: auth.session!.id,
      redirectUri: checked.redirectUri,
      codeChallenge: checked.codeChallenge,
      scopes: checked.scopes,
      resource: checked.resource,
      frameleafAccountId: checked.frameleafAccountId,
      expiresAt: new Date(Date.now() + OAUTH_CODE_TTL_SECONDS * 1000),
    });
    await this.recordAccountEvent({
      userId: auth.user.id,
      sessionId: auth.session!.id,
      action: AccountEventAction.AppConnected,
      subject: name,
      detail: checked.scopes.join(' '),
    });
    return { redirectUrl: oauthReturnAddress(checked.redirectUri, { code, state: checked.state, iss: issuer }) };
  }

  /** `POST oauth/apps/token`: the token endpoint (RFC 6749 §3.2), for public clients. */
  async token(body: Record<string, unknown>, issuer?: string): Promise<OAuthTokenResponse> {
    switch (body.grant_type) {
      case 'authorization_code': {
        return this.exchangeCode(body, issuer);
      }
      case 'refresh_token': {
        return this.refresh(body, issuer);
      }
      default: {
        throw oauthError('unsupported_grant_type', 'Only authorization_code and refresh_token are supported');
      }
    }
  }

  /**
   * `POST oauth/apps/revoke` (RFC 7009): an app signs itself out with its access or refresh token,
   * which revokes the whole grant. Unknown tokens are not an error, so nothing can be learned.
   */
  async revoke(body: Record<string, unknown>): Promise<void> {
    const token = text(body.token);
    if (!token) {
      throw oauthError('invalid_request', 'The token to revoke is missing');
    }
    const hash = this.cryptoRepository.hashSha256(token);
    const grant = token.startsWith(OAUTH_ACCESS_TOKEN_PREFIX)
      ? await this.oauthAppRepository.getByAccessToken(hash)
      : token.startsWith(OAUTH_REFRESH_TOKEN_PREFIX)
        ? await this.oauthAppRepository.getByRefreshToken(hash)
        : undefined;
    const clientId = text(body.client_id);
    if (!grant || (clientId !== undefined && clientId !== grant.clientId)) {
      return;
    }
    if (await this.oauthAppRepository.revoke(grant.id)) {
      await this.recordAccountEvent({
        userId: grant.userId,
        action: AccountEventAction.AppDisconnected,
        subject: this.clientName(grant.clientName, grant.clientRedirectUris),
        detail: 'app-signed-out',
      });
    }
  }

  /**
   * `POST oauth/apps/register` (RFC 7591): an app registers itself, as AI assistants do when a
   * person adds Frameleaf. Only while the administrator allows it; registering grants nothing.
   */
  async register(body: Record<string, unknown>) {
    const { connectedApps } = await this.getConfig({ withCache: true });
    if (!connectedApps.allowRegistration) {
      throw oauthError(
        'access_denied',
        'This server doesn’t let new apps register themselves. Ask its administrator.',
        HttpStatus.FORBIDDEN,
      );
    }
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10) {
      throw oauthError('invalid_redirect_uri', 'Give one to ten return addresses');
    }
    const redirectUris = uris.map((uri) => checkRegisteredRedirectUri(uri));
    if (redirectUris.includes(null)) {
      throw oauthError(
        'invalid_redirect_uri',
        'Return addresses must be https, or http on 127.0.0.1, [::1] or localhost, with no fragment',
      );
    }
    const method = body.token_endpoint_auth_method;
    if (method !== undefined && method !== 'none') {
      throw oauthError(
        'invalid_client_metadata',
        'Only public clients (token_endpoint_auth_method none) are supported',
      );
    }
    const grantTypes = body.grant_types ?? ['authorization_code', 'refresh_token'];
    const responseTypes = body.response_types ?? ['code'];
    if (
      !Array.isArray(grantTypes) ||
      grantTypes.some((type) => !(type === 'authorization_code' || type === 'refresh_token')) ||
      !Array.isArray(responseTypes) ||
      responseTypes.some((type) => type !== 'code')
    ) {
      throw oauthError('invalid_client_metadata', 'Only the authorization_code and refresh_token grants are supported');
    }
    const logo = checkRegisteredRedirectUri(body.logo_uri);
    const client = await this.oauthAppRepository.createClient(
      {
        name: cleanClientName(body.client_name) ?? 'Unnamed app',
        redirectUris: redirectUris as string[],
        logoUri: logo?.startsWith('https://') ? logo : null,
        dynamic: true,
      },
      OAUTH_DYNAMIC_CLIENT_LIMIT,
    );
    if (!client) {
      throw oauthError(
        'temporarily_unavailable',
        'Too many apps are registered on this server right now',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    this.logger.log(`An app registered itself as a connected app: ${client.id}`);
    return {
      client_id: client.id,
      client_id_issued_at: Math.floor(new Date(client.createdAt).getTime() / 1000),
      client_name: client.name,
      redirect_uris: client.redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: OAUTH_SCOPES_SUPPORTED.join(' '),
    };
  }

  /** RFC 8414 authorization server metadata. */
  async getAuthorizationServerMetadata(issuer: string) {
    const { connectedApps } = await this.getConfig({ withCache: true });
    return {
      issuer,
      authorization_endpoint: `${issuer}/api/oauth/apps/authorize`,
      token_endpoint: `${issuer}/api/oauth/apps/token`,
      revocation_endpoint: `${issuer}/api/oauth/apps/revoke`,
      ...(connectedApps.allowRegistration && { registration_endpoint: `${issuer}/api/oauth/apps/register` }),
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
      scopes_supported: OAUTH_SCOPES_SUPPORTED,
      authorization_response_iss_parameter_supported: true,
    };
  }

  /** RFC 9728 protected resource metadata for this server's API (or a path under it, such as /api/mcp). */
  getProtectedResourceMetadata(issuer: string, path: string) {
    return {
      resource: `${issuer}${path}`,
      authorization_servers: [issuer],
      scopes_supported:
        path === ASSISTANT_MCP_PATH
          ? ['library:read']
          : path === MCP_PATH
            ? OAUTH_SCOPES_SUPPORTED.filter((scope) => scope !== 'library:download')
            : OAUTH_SCOPES_SUPPORTED,
      bearer_methods_supported: ['header'],
      resource_name: 'Frameleaf',
    };
  }

  /**
   * An app's access token, checked for every request (`AuthService`). Revoked or expired grants
   * fail at once. The result looks like an API key with the scopes' permissions, plus `oauthApp`.
   */
  async validateAccessToken(token: string, via: FrameleafVia | null | undefined): Promise<AuthDto> {
    const grant = await this.oauthAppRepository.getByAccessToken(this.cryptoRepository.hashSha256(token));
    const active = this.requireActiveGrant(grant);
    if (
      isAssistantResource(active.resource) &&
      (!(await this.assistantAvailable()) ||
        !(await this.assistantAccountMatches(active.userId, active.frameleafAccountId)))
    ) {
      throw new UnauthorizedException();
    }
    void this.recordUse(
      active.id,
      active.userId,
      active.lastUsedAt,
      via,
      active.clientName,
      active.clientRedirectUris,
      active.scopes,
    );
    return this.mapActiveGrant(active);
  }

  async validatePreviewGrant(grantId: string): Promise<AuthDto> {
    return this.mapActiveGrant(this.requireActiveGrant(await this.oauthAppRepository.getByGrantId(grantId)));
  }

  private requireActiveGrant(grant: Awaited<ReturnType<OAuthAppRepository['getByAccessToken']>>) {
    if (
      !grant?.user ||
      grant.revokedAt ||
      new Date(grant.accessExpiresAt).getTime() <= Date.now() ||
      OAUTH_SCOPES_SUPPORTED.every((scope) => !grant.scopes.includes(scope))
    ) {
      throw new UnauthorizedException({
        message: 'This app’s access has ended. Connect the app again.',
        error: 'invalid_token',
        statusCode: 401,
      });
    }
    return grant;
  }

  private mapActiveGrant(grant: ReturnType<OAuthAppService['requireActiveGrant']>): AuthDto {
    return {
      user: grant.user as AuthUser,
      apiKey: { id: grant.id, permissions: scopePermissions(grant.scopes) },
      oauthApp: {
        grantId: grant.id,
        clientId: grant.clientId,
        clientName: this.clientName(grant.clientName, grant.clientRedirectUris),
        scopes: grant.scopes,
        resource: grant.resource,
      },
    };
  }

  /** `GET oauth/apps/grants`: your connected apps. */
  async getGrants(auth: AuthDto): Promise<OAuthAppGrantDto[]> {
    this.requirePerson(auth);
    const grants = await this.oauthAppRepository.getActiveGrants(auth.user.id);
    return grants.map((grant) => ({
      id: grant.id,
      client: this.mapClient(
        { id: grant.clientId, name: grant.clientName, redirectUris: grant.clientRedirectUris },
        grant.clientRedirectUris[0],
      ),
      scopes: grant.scopes,
      createdAt: new Date(grant.createdAt).toISOString(),
      lastUsedAt: grant.lastUsedAt ? new Date(grant.lastUsedAt).toISOString() : null,
      lastUsedVia: grant.lastUsedVia,
    }));
  }

  /** `DELETE oauth/apps/grants/{id}`: Remove access. The app's tokens stop working on its next request. */
  async revokeGrant(auth: AuthDto, id: string): Promise<void> {
    this.requirePerson(auth);
    const grant = UUID.test(id)
      ? (await this.oauthAppRepository.getActiveGrants(auth.user.id)).find((item) => item.id === id)
      : undefined;
    if (!grant || !(await this.oauthAppRepository.revoke(id, auth.user.id))) {
      throw new NotFoundException('This app is no longer connected');
    }
    await this.recordAccountEvent({
      userId: auth.user.id,
      sessionId: auth.session?.id ?? null,
      action: AccountEventAction.AppDisconnected,
      subject: this.clientName(grant.clientName, grant.clientRedirectUris),
      detail: 'removed',
    });
  }

  /** `GET admin/oauth/apps`: every registered app, for administrators. */
  async getClients(): Promise<OAuthAppAdminClientDto[]> {
    const clients = await this.oauthAppRepository.getClients();
    return clients.map((client) => ({
      client: this.mapClient(client, client.redirectUris[0]),
      selfRegistered: client.dynamic,
      createdAt: new Date(client.createdAt).toISOString(),
      activeUsers: Number(client.activeUsers ?? 0),
    }));
  }

  /** `DELETE admin/oauth/apps/{id}`: removes an app and every grant to it; each person sees it in their activity. */
  async deleteClient(auth: AuthDto, id: string): Promise<void> {
    const client = UUID.test(id) ? await this.oauthAppRepository.getClient(id) : undefined;
    const deleted = client && (await this.oauthAppRepository.deleteClient(id));
    if (!client || !deleted) {
      throw new NotFoundException('App not found');
    }
    const name = this.clientName(client.name, client.redirectUris);
    for (const userId of deleted.userIds) {
      await this.recordAccountEvent({
        userId,
        action: AccountEventAction.AppDisconnected,
        subject: name,
        detail: 'app-deleted',
      });
    }
    this.logger.log(`Connected app ${client.id} removed by ${auth.user.id}`);
  }

  private async exchangeCode(body: Record<string, unknown>, issuer?: string): Promise<OAuthTokenResponse> {
    const code = text(body.code);
    if (!code || code.length > 200) {
      throw oauthError('invalid_request', 'The code is missing');
    }
    const found = await this.oauthAppRepository.takeCode(this.cryptoRepository.hashSha256(code));
    const invalid = oauthError('invalid_grant', 'This code can’t be used. Connect the app again.');
    if (!found) {
      throw invalid;
    }
    if (new Date(found.expiresAt).getTime() <= Date.now()) {
      throw oauthError('invalid_grant', 'This code has expired. Connect the app again.');
    }
    const resource = body.resource === undefined ? found.resource : checkResource(body.resource);
    if (
      text(body.client_id) !== found.clientId ||
      text(body.redirect_uri) !== found.redirectUri ||
      !verifierMatches(text(body.code_verifier) ?? '', found.codeChallenge) ||
      resource !== found.resource
    ) {
      throw invalid;
    }
    const client = await this.oauthAppRepository.getClient(found.clientId);
    const user = await this.userRepository.get(found.userId, { withDeleted: false });
    if (!client || !user || !matchRedirectUri(client.redirectUris, found.redirectUri)) {
      throw invalid;
    }
    if (
      isAssistantResource(found.resource) &&
      (found.resource !== `${issuer}${ASSISTANT_MCP_PATH}` ||
        !(await this.assistantAvailable()) ||
        !(await this.assistantAccountMatches(found.userId, found.frameleafAccountId)))
    ) {
      throw invalid;
    }
    const tokens = this.newTokens();
    await this.oauthAppRepository.createGrant({
      userId: user.id,
      clientId: client.id,
      scopes: found.scopes,
      resource: found.resource,
      frameleafAccountId: found.frameleafAccountId,
      refreshTokenHash: this.cryptoRepository.hashSha256(tokens.refresh_token),
      accessTokenHash: this.cryptoRepository.hashSha256(tokens.access_token),
      accessExpiresAt: tokens.expiresAt,
    });
    return {
      ...this.tokenResponse(tokens, found.scopes),
      ...(found.frameleafAccountId && { frameleaf_account_id: found.frameleafAccountId }),
    };
  }

  private async refresh(body: Record<string, unknown>, issuer?: string): Promise<OAuthTokenResponse> {
    const token = text(body.refresh_token);
    if (!token || token.length > 200) {
      throw oauthError('invalid_request', 'The refresh token is missing');
    }
    const hash = this.cryptoRepository.hashSha256(token);
    const invalid = oauthError('invalid_grant', 'This app’s access has ended. Connect the app again.');
    const grant = await this.oauthAppRepository.getByRefreshToken(hash);
    if (!grant) {
      // a refresh token that was already used: a copy of it leaked, so the whole grant ends
      const spent = await this.oauthAppRepository.getBySpentRefreshToken(hash);
      if (spent && (await this.oauthAppRepository.revoke(spent.id))) {
        this.logger.warn(`A used refresh token came back; revoked connected app grant ${spent.id}`);
        await this.recordAccountEvent({
          userId: spent.userId,
          action: AccountEventAction.AppDisconnected,
          subject: this.clientName(spent.clientName, spent.clientRedirectUris),
          detail: 'token-reused',
        });
      }
      throw invalid;
    }
    if (grant.revokedAt || text(body.client_id) !== grant.clientId) {
      throw invalid;
    }
    if (
      isAssistantResource(grant.resource) &&
      (grant.resource !== `${issuer}${ASSISTANT_MCP_PATH}` ||
        !(await this.assistantAvailable()) ||
        (body.resource !== undefined && checkResource(body.resource) !== grant.resource) ||
        !(await this.userRepository.get(grant.userId, { withDeleted: false })) ||
        !(await this.assistantAccountMatches(grant.userId, grant.frameleafAccountId)))
    ) {
      throw invalid;
    }
    if (body.scope !== undefined) {
      const { scopes, unknown } = parseScopes(body.scope);
      if (unknown.length > 0 || scopes.some((scope) => !grant.scopes.includes(scope))) {
        throw oauthError('invalid_scope', 'An app can’t widen its access when it refreshes');
      }
    }
    const tokens = this.newTokens();
    const rotated = await this.oauthAppRepository.rotate(grant.id, hash, {
      refreshTokenHash: this.cryptoRepository.hashSha256(tokens.refresh_token),
      accessTokenHash: this.cryptoRepository.hashSha256(tokens.access_token),
      accessExpiresAt: tokens.expiresAt,
    });
    if (!rotated) {
      // another refresh with the same token won the race: treat this one as the reuse it looks like
      if (await this.oauthAppRepository.revoke(grant.id)) {
        await this.recordAccountEvent({
          userId: grant.userId,
          action: AccountEventAction.AppDisconnected,
          subject: this.clientName(grant.clientName, grant.clientRedirectUris),
          detail: 'token-reused',
        });
      }
      throw invalid;
    }
    return this.tokenResponse(tokens, grant.scopes);
  }

  private newTokens() {
    return {
      access_token: OAUTH_ACCESS_TOKEN_PREFIX + this.cryptoRepository.randomBytesAsText(32),
      refresh_token: OAUTH_REFRESH_TOKEN_PREFIX + this.cryptoRepository.randomBytesAsText(32),
      expiresAt: new Date(Date.now() + OAUTH_ACCESS_TTL_SECONDS * 1000),
    };
  }

  private tokenResponse(tokens: ReturnType<OAuthAppService['newTokens']>, scopes: string[]): OAuthTokenResponse {
    return {
      access_token: tokens.access_token,
      token_type: 'Bearer',
      expires_in: OAUTH_ACCESS_TTL_SECONDS,
      refresh_token: tokens.refresh_token,
      scope: scopes.join(' '),
    };
  }

  private async recordUse(
    grantId: string,
    userId: string,
    lastUsedAt: unknown,
    via: FrameleafVia | null | undefined,
    clientName: string,
    redirectUris: string[],
    scopes: string[],
  ) {
    const now = Date.now();
    const last = Math.max(
      lastUsedAt ? new Date(lastUsedAt as string).getTime() : 0,
      this.usesRecorded.get(grantId) ?? 0,
    );
    if (now - last < OAUTH_USE_RECORD_INTERVAL_MS) {
      return;
    }
    this.usesRecorded.set(grantId, now);
    try {
      await this.oauthAppRepository.recordUse(grantId, toAccountEventVia(via));
      await this.recordAccountEvent({
        userId,
        action: AccountEventAction.AppUsed,
        subject: this.clientName(clientName, redirectUris),
        detail: scopes.join(' '),
      });
    } catch (error) {
      this.logger.warn(`Could not record when a connected app was last used: ${error}`);
    }
  }

  /** The Allow page's checks: a signed-in person and a request with nothing wrong in it. */
  private async checkPage(
    auth: AuthDto,
    dto: OAuthAppAuthorizeStartDto,
    issuer?: string,
  ): Promise<CheckedRequest & { frameleafAccountId: string | null }> {
    this.requireSession(auth);
    const checked = await this.checkRequest(dto, issuer);
    if ('fault' in checked) {
      const fault = checked.fault;
      throw fault.target
        ? requestError(fault.error, fault.description)
        : requestError('invalid_request', 'This request didn’t come from the app the way Frameleaf expects');
    }
    let frameleafAccountId: string | null = null;
    if (isAssistantResource(checked.resource) && this.brokerForClient(checked.client.redirectUris)) {
      const link = await this.frameleafAccountRepository.getLinkByUser(auth.user.id);
      if (!link) {
        throw requestError('access_denied', 'Sign in with Frameleaf to connect a marketplace assistant');
      }
      frameleafAccountId = link.sub;
    }
    return { ...checked, frameleafAccountId };
  }

  private async assistantAccountMatches(userId: string, expected: string | null) {
    return expected === null || (await this.frameleafAccountRepository.getLinkByUser(userId))?.sub === expected;
  }

  private async checkRequest(
    params: AuthorizeParams,
    issuer?: string,
  ): Promise<CheckedRequest | { fault: RequestFault }> {
    const clientId = text(params.clientId);
    const client = clientId && UUID.test(clientId) ? await this.oauthAppRepository.getClient(clientId) : undefined;
    const redirectUri = client ? matchRedirectUri(client.redirectUris, params.redirectUri) : null;
    if (!client || !redirectUri) {
      return { fault: { target: false } };
    }
    const state = text(params.state);
    const fault = (error: string, description: string) => ({
      fault: { target: true as const, redirectUri, state, error, description },
    });
    if (params.state !== undefined && (state === undefined || state.length > 2048)) {
      return fault('invalid_request', 'The state is not valid');
    }
    if (params.responseType !== 'code') {
      return fault('unsupported_response_type', 'Only the authorization code flow is supported');
    }
    const challenge = text(params.codeChallenge);
    if (params.codeChallengeMethod !== 'S256' || !challenge || !isCodeChallenge(challenge)) {
      return fault('invalid_request', 'PKCE with code_challenge_method S256 is required');
    }
    const { scopes, unknown } = parseScopes(params.scope);
    if (unknown.length > 0 || scopes.length === 0) {
      return fault('invalid_scope', `Frameleaf doesn’t offer: ${unknown.join(' ').slice(0, 200)}`);
    }
    const resource = checkResource(params.resource);
    if (resource === false) {
      return fault('invalid_target', 'The resource is not a valid address');
    }
    if (isAssistantResource(resource)) {
      if (!issuer?.startsWith('https://') || resource !== `${issuer}${ASSISTANT_MCP_PATH}`) {
        return fault('invalid_target', 'The assistant resource must use this Library’s HTTPS address');
      }
      if (scopes.length !== 1 || scopes[0] !== 'library:read') {
        return fault('invalid_scope', 'The assistant resource supports library:read');
      }
      if (client.redirectUris.some((uri) => assistantBrokerName(uri)) && !this.brokerForClient(client.redirectUris)) {
        return fault('invalid_request', 'The marketplace assistant must register its own return address');
      }
      if (!(await this.assistantAvailable())) {
        return fault('access_denied', 'Official assistant access requires a Server licence and enabled MCP');
      }
    }
    if (resource && new URL(resource).pathname === MCP_PATH && scopes.includes('library:download')) {
      return fault('invalid_scope', 'MCP apps can’t download original files');
    }
    return { client, redirectUri, scopes, state, codeChallenge: challenge, resource };
  }

  /** Only a signed-in person allows an app: a session, never an API key, an app or a shared link. */
  private requireSession(auth: AuthDto) {
    if (!auth.session || auth.apiKey || auth.oauthApp || auth.sharedLink) {
      throw new ForbiddenException('Sign in to Frameleaf in this browser to allow an app');
    }
  }

  /** Connected apps are managed by the person (or their API key), never by an app itself. */
  private requirePerson(auth: AuthDto) {
    if (auth.oauthApp || auth.sharedLink) {
      throw new ForbiddenException('Connected apps can only be managed by you');
    }
  }

  private clientName(name: string, redirectUris: string[]) {
    return this.brokerForClient(redirectUris) ?? verifiedApp(redirectUris)?.name ?? name;
  }

  private mapClient(
    client: Pick<OAuthClient, 'id' | 'name' | 'redirectUris'>,
    redirectUri: string | undefined,
  ): OAuthAppClientDto {
    const broker = this.brokerForClient(client.redirectUris);
    const known = verifiedApp(client.redirectUris);
    return {
      id: client.id,
      name: broker ?? known?.name ?? client.name,
      verified: !!(broker || known),
      maker: broker === 'ChatGPT' ? 'OpenAI' : broker === 'Claude' ? 'Anthropic' : (known?.maker ?? null),
      knownApp: broker === 'ChatGPT' ? 'chatgpt' : broker === 'Claude' ? 'claude' : (known?.key ?? null),
      returnTo: redirectUri ? redirectDisplay(redirectUri) : '',
    };
  }
}
