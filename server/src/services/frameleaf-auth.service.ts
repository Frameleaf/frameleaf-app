import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { parse } from 'cookie';
import type { JWTPayload } from 'jose';
import type { IncomingHttpHeaders } from 'node:http';
import type { UserAdmin } from 'src/database.js';
import type { AuthDto, OAuthCallbackDto, OAuthConfigDto } from 'src/dtos/auth.dto.js';
import type { ArgOf } from 'src/repositories/event.repository.js';
import { OnEvent } from 'src/decorators.js';
import {
  FrameleafAccountLinkResponseDto,
  FrameleafHandoffCreateDto,
  FrameleafHandoffRedeemDto,
  FrameleafHandoffResponseDto,
  FrameleafTokenExchangeDto,
  FrameleafTokenExchangeErrorCode,
} from 'src/dtos/frameleaf-auth.dto.js';
import { UserAdminResponseDto, mapUserAdmin } from 'src/dtos/user.dto.js';
import { AdminAuditAction, DatabaseLock, ImmichCookie } from 'src/enum.js';
import { ClientTokenRejection, type OAuthConfig, type OAuthProfile } from 'src/repositories/oauth.repository.js';
import { type LoginDetails, UNVERIFIED_EMAIL_MESSAGE, emailVerificationProblem } from 'src/services/auth.service.js';
import { BaseService } from 'src/services/base.service.js';
import { readCloudLink } from 'src/utils/frameleaf-cloud-gateway.js';
import {
  FRAMELEAF_EXCHANGE_CLOCK_TOLERANCE_SECONDS,
  FRAMELEAF_EXCHANGE_TOKEN_MAX_AGE_SECONDS,
  FRAMELEAF_EXCHANGE_TOKEN_TYPE,
  type FrameleafAccess,
  frameleafAccess,
  frameleafCallbackUrl,
  frameleafOAuthConfig,
  frameleafRedirectUri,
  frameleafRole,
  hasInstanceAccess,
} from 'src/utils/frameleaf-sign-in.js';
import { grantViewerScope } from 'src/utils/frameleaf-viewer.js';
import { publishedLocalOrigins } from 'src/utils/public-url.js';
import { createSession } from 'src/utils/session.js';

/** How long a handoff code may be used. */
export const HANDOFF_TTL_SECONDS = 60;

const NOT_AVAILABLE_MESSAGE = 'Sign in with Frameleaf is not available on this server';
const NOT_LINKED_MESSAGE = 'This server is not linked to Frameleaf Cloud';
const DELETED_ACCOUNT_MESSAGE =
  'The account this Frameleaf account is linked to is being removed from this server. Ask an administrator to restore it.';

/** Why a person Frameleaf vouched for cannot be signed in (the account rules of every Frameleaf sign-in). */
type SignInRefusal = 'email' | 'removed' | 'conflict';

const SIGN_IN_REFUSAL_CODES: Record<SignInRefusal, FrameleafTokenExchangeErrorCode> = {
  email: FrameleafTokenExchangeErrorCode.EmailUnverified,
  removed: FrameleafTokenExchangeErrorCode.AccountRemoved,
  conflict: FrameleafTokenExchangeErrorCode.AccountConflict,
};

const EXCHANGE_REFUSALS: Record<
  FrameleafTokenExchangeErrorCode,
  { status: HttpStatus.BAD_REQUEST | HttpStatus.UNAUTHORIZED | HttpStatus.FORBIDDEN; message: string }
> = {
  [FrameleafTokenExchangeErrorCode.NotLinked]: { status: HttpStatus.BAD_REQUEST, message: NOT_LINKED_MESSAGE },
  [FrameleafTokenExchangeErrorCode.SignInOff]: { status: HttpStatus.BAD_REQUEST, message: NOT_AVAILABLE_MESSAGE },
  [FrameleafTokenExchangeErrorCode.NoAccess]: {
    status: HttpStatus.FORBIDDEN,
    message: 'Your Frameleaf account does not have access to this server',
  },
  [FrameleafTokenExchangeErrorCode.WrongAudience]: {
    status: HttpStatus.UNAUTHORIZED,
    message: 'This sign-in is for another server',
  },
  [FrameleafTokenExchangeErrorCode.Expired]: {
    status: HttpStatus.UNAUTHORIZED,
    message: 'This sign-in has expired. Try again.',
  },
  [FrameleafTokenExchangeErrorCode.Replayed]: {
    status: HttpStatus.UNAUTHORIZED,
    message: 'This sign-in was already used. Try again.',
  },
  [FrameleafTokenExchangeErrorCode.Invalid]: {
    status: HttpStatus.UNAUTHORIZED,
    message: 'This is not a Frameleaf sign-in for this server',
  },
  [FrameleafTokenExchangeErrorCode.EmailUnverified]: {
    status: HttpStatus.BAD_REQUEST,
    message: UNVERIFIED_EMAIL_MESSAGE,
  },
  [FrameleafTokenExchangeErrorCode.AccountRemoved]: {
    status: HttpStatus.BAD_REQUEST,
    message: DELETED_ACCOUNT_MESSAGE,
  },
  [FrameleafTokenExchangeErrorCode.AccountConflict]: {
    status: HttpStatus.BAD_REQUEST,
    message: 'This account is already linked to another Frameleaf account',
  },
};

const ERROR_NAMES = {
  [HttpStatus.BAD_REQUEST]: 'Bad Request',
  [HttpStatus.UNAUTHORIZED]: 'Unauthorized',
  [HttpStatus.FORBIDDEN]: 'Forbidden',
} as const;

/** FL-230: a token exchange refusal, with the code the app explains it by. */
const exchangeRefusal = (code: FrameleafTokenExchangeErrorCode) => {
  const { status, message } = EXCHANGE_REFUSALS[code];
  return new HttpException({ message, error: ERROR_NAMES[status], statusCode: status, code }, status);
};

/**
 * Sign in with Frameleaf (FL-158, CLD-005): the second OpenID Connect provider slot.
 *
 * - The provider is Frameleaf Cloud's identity service for this server's link, configured at
 *   runtime (`frameleafOAuthConfig`); the administrator's own provider (`oauth.*`) is untouched and
 *   keeps working beside it.
 * - The cloud decides who may reach this server (`instance-access`) and is the access authority for
 *   remote people: an account it authorizes is created here on first sign-in, with
 *   `frameleaf_role` as its role. A verified email is required before an existing account is
 *   linked by email or a new one is created.
 * - Every session it creates is tagged in `immich_fork.frameleaf_session`, so a back-channel logout
 *   from the cloud ends it, and remote-access enforcement can recognise it.
 * - A Frameleaf app can exchange a server-audience token from the identity provider for a session
 *   without a browser (FL-230, `exchangeToken`), under the same account rules and session tagging.
 * - FL-235: `frameleaf_access` is recorded on every sign-in and link. A `viewer` is never an
 *   administrator and is held to reading (`src/utils/frameleaf-viewer.ts`); when an account becomes
 *   a viewer (or is invited again after its access was revoked) it is given its scope.
 */
@Injectable()
export class FrameleafAuthService extends BaseService {
  /** `POST oauth/frameleaf/authorize`: the authorization URL for a registered callback. */
  async authorize(dto: OAuthConfigDto) {
    const config = await this.requireConfig();
    const redirectUri = frameleafRedirectUri(dto.redirectUri);
    if (!redirectUri) {
      throw new BadRequestException('This address is not registered for Sign in with Frameleaf');
    }
    return this.oauthRepository.authorize(config, redirectUri, dto.state, dto.codeChallenge);
  }

  /** `POST oauth/frameleaf/callback`: finish a sign-in and create a tagged session. */
  async callback(dto: OAuthCallbackDto, headers: IncomingHttpHeaders, loginDetails: LoginDetails) {
    const config = await this.requireConfig();
    const { profile, sid, idToken } = await this.exchange(config, dto, headers);
    return this.signIn(profile, loginDetails, { sid, bearerToken: idToken });
  }

  /**
   * `POST oauth/frameleaf/exchange` (FL-230, NAPI-006): a native app that holds a Frameleaf account
   * session presents a server-audience token the identity provider minted for this server (OAuth
   * token exchange, after the same `instance-access` checks as a browser sign-in) and gets a session
   * here without a browser:
   *
   * - verified like a Sign in with Frameleaf ID token: the linked issuer's JWKS and advertised
   *   algorithms, `iss`, `aud` = this server's client id, `exp`; plus `typ` `frameleaf-exchange+jwt`,
   *   at most two minutes old, a `jti` and the instance-access claims;
   * - used once (`jti`), and refused when minted before Frameleaf Cloud ended this account's or
   *   Frameleaf session's sign-ins (back-channel logout);
   * - the browser flow's account matching and linking, role, and a session tagged as a Frameleaf
   *   session, so back-channel logout, unlinking and access removal end it like a browser one.
   *
   * Every refusal carries a `FrameleafTokenExchangeErrorCode`.
   */
  async exchangeToken(dto: FrameleafTokenExchangeDto, loginDetails: LoginDetails) {
    const config = await this.config();
    if (!config) {
      const { linked } = await readCloudLink({
        configRepository: this.configRepository,
        systemMetadataRepository: this.systemMetadataRepository,
      });
      throw exchangeRefusal(
        linked ? FrameleafTokenExchangeErrorCode.SignInOff : FrameleafTokenExchangeErrorCode.NotLinked,
      );
    }

    let claims: JWTPayload;
    try {
      claims = await this.oauthRepository.verifyClientToken(config, dto.token, {
        typ: FRAMELEAF_EXCHANGE_TOKEN_TYPE,
        maxTokenAgeSeconds: FRAMELEAF_EXCHANGE_TOKEN_MAX_AGE_SECONDS,
        clockToleranceSeconds: FRAMELEAF_EXCHANGE_CLOCK_TOLERANCE_SECONDS,
        requiredClaims: ['iss', 'aud', 'sub', 'iat', 'exp', 'jti'],
      });
    } catch (error) {
      this.logger.warn(`Refused a Frameleaf token exchange: ${error}`);
      if (error instanceof ClientTokenRejection && error.reason === 'unavailable') {
        throw new ServiceUnavailableException('Sign in with Frameleaf could not reach Frameleaf. Try again.');
      }
      const reason = error instanceof ClientTokenRejection ? error.reason : 'invalid';
      throw exchangeRefusal(
        reason === 'expired'
          ? FrameleafTokenExchangeErrorCode.Expired
          : reason === 'audience'
            ? FrameleafTokenExchangeErrorCode.WrongAudience
            : FrameleafTokenExchangeErrorCode.Invalid,
      );
    }
    const { sub, jti, iat, exp } = claims as Required<Pick<JWTPayload, 'sub' | 'jti' | 'iat' | 'exp'>>;
    if (!sub || !jti) {
      throw exchangeRefusal(FrameleafTokenExchangeErrorCode.Invalid);
    }
    if (!hasInstanceAccess(claims)) {
      throw exchangeRefusal(FrameleafTokenExchangeErrorCode.NoAccess);
    }

    const sid = typeof claims.sid === 'string' ? claims.sid : null;
    const tolerance = FRAMELEAF_EXCHANGE_CLOCK_TOLERANCE_SECONDS;
    const redeemed = await this.frameleafAccountRepository.redeemExchangeToken({
      jti,
      sub,
      sid,
      // a revocation within the clock tolerance of the mint counts as after it
      issuedAt: new Date((iat - tolerance) * 1000),
      // after this the token is refused as expired anyway
      expiresAt: new Date((Math.min(exp, iat + FRAMELEAF_EXCHANGE_TOKEN_MAX_AGE_SECONDS) + tolerance) * 1000),
    });
    if (redeemed === 'revoked') {
      throw exchangeRefusal(FrameleafTokenExchangeErrorCode.NoAccess);
    }
    if (redeemed === 'replayed') {
      this.logger.warn(`Refused a Frameleaf exchange token that was already used`);
      throw exchangeRefusal(FrameleafTokenExchangeErrorCode.Replayed);
    }

    return this.signIn(
      claims as OAuthProfile,
      loginDetails,
      { sid: sid ?? undefined },
      (refusal) => exchangeRefusal(SIGN_IN_REFUSAL_CODES[refusal]),
      async (sessionId) => {
        // A back-channel logout records the revocation before it looks for tagged sessions, so a
        // logout that raced this sign-in either finds this session or is seen here.
        const revoked = await this.frameleafAccountRepository.isSignInRevoked({
          sub,
          sid,
          issuedAt: new Date((iat - tolerance) * 1000),
        });
        if (revoked) {
          await this.endSessions([sessionId]);
          throw exchangeRefusal(FrameleafTokenExchangeErrorCode.NoAccess);
        }
      },
    );
  }

  /**
   * Sign a person Frameleaf vouched for in: the account linked to their Frameleaf account, else an
   * account here with the same verified email (linked now), else a new account Frameleaf Cloud
   * authorized; `frameleaf_role` applied; a session tagged as a Frameleaf session.
   */
  private async signIn(
    profile: OAuthProfile,
    loginDetails: LoginDetails,
    oauth: { sid?: string; bearerToken?: string },
    refuse: (refusal: SignInRefusal, message: string) => Error = (_refusal, message) =>
      new BadRequestException(message),
    afterTag?: (sessionId: string) => Promise<void>,
  ) {
    const { sid } = oauth;
    const email = profile.email?.trim().toLowerCase();
    if (!email) {
      throw refuse('email', 'Frameleaf did not send an email address');
    }
    const emailProblem = emailVerificationProblem(profile);
    if (emailProblem) {
      throw refuse('email', emailProblem);
    }
    const access = frameleafAccess(profile);
    // FL-235: a viewer is never an administrator, whatever frameleaf_role says
    const role = access === 'viewer' ? 'user' : frameleafRole(profile);

    let user: UserAdmin | undefined;
    const link = await this.frameleafAccountRepository.getLinkBySub(profile.sub);
    if (link) {
      user = await this.userRepository.get(link.userId, { withDeleted: false });
      if (!user) {
        // the linked account is in the trash (scheduled for removal): never create a second one
        throw refuse('removed', DELETED_ACCOUNT_MESSAGE);
      }
    }
    if (!user) {
      // an account here with the same verified email is linked to this Frameleaf account
      const existing = await this.userRepository.getByEmail(email);
      if (existing) {
        const other = await this.frameleafAccountRepository.getLinkByUser(existing.id);
        if (other && other.sub !== profile.sub) {
          throw refuse('conflict', 'This account is already linked to another Frameleaf account');
        }
        user = existing;
        await this.frameleafAccountRepository.upsertLink({
          userId: user.id,
          sub: profile.sub,
          email,
          emailVerified: true,
          role,
          autoRegistered: false,
          access,
        });
        await this.auditLink(user, AdminAuditAction.FrameleafAccountLinked, email);
      }
    }
    if (!user) {
      // Frameleaf Cloud authorized this person for this server: it is the access authority
      this.logger.log(`Creating the account ${email} for a Frameleaf sign-in`);
      user = await this.createUser({
        name: typeof profile.name === 'string' && profile.name.trim() ? profile.name.trim() : email,
        email,
        isAdmin: role === 'admin',
      });
      await this.frameleafAccountRepository.upsertLink({
        userId: user.id,
        sub: profile.sub,
        email,
        emailVerified: true,
        role,
        autoRegistered: true,
        access,
      });
      await this.auditLink(user, AdminAuditAction.FrameleafAccountLinked, email);
    }
    if (role && user.isAdmin !== (role === 'admin')) {
      user = await this.applyRole(user, role);
    }
    await this.frameleafAccountRepository.touchLink(user.id, { email, emailVerified: true, role, access });
    await this.grantViewerScopeIfDue(user.id, link?.userId === user.id ? link : undefined, access);

    const { session, response } = await createSession(
      { sessionRepository: this.sessionRepository, cryptoRepository: this.cryptoRepository },
      user,
      loginDetails,
      oauth,
    );
    await this.frameleafAccountRepository.tagSession({
      sessionId: session.id,
      userId: user.id,
      sid: sid ?? null,
      sub: profile.sub,
      authTime: typeof profile.auth_time === 'number' ? new Date(profile.auth_time * 1000) : null,
    });
    await afterTag?.(session.id);
    return response;
  }

  /**
   * `POST oauth/frameleaf/handoff`: a single-use code that signs this person in on another address of
   * this server (for example from the relay address to the home address). Only a session Frameleaf
   * created can hand itself over.
   */
  async createHandoff(auth: AuthDto, dto: FrameleafHandoffCreateDto = {}): Promise<FrameleafHandoffResponseDto> {
    if (!auth.session) {
      throw new BadRequestException('Only a signed-in session can be handed over');
    }
    // FL-167: a return address must be a home address this server published, never anywhere else
    let returnTo: string | null = null;
    if (dto.returnTo !== undefined) {
      let origin: string | null;
      try {
        const url = new URL(dto.returnTo);
        origin = url.protocol === 'https:' && !url.username && !url.password ? url.origin : null;
      } catch {
        origin = null;
      }
      const config = await this.getConfig({ withCache: false });
      const published = await publishedLocalOrigins(config.frameleafCloud.remoteAccess, {
        configRepository: this.configRepository,
        systemMetadataRepository: this.systemMetadataRepository,
      });
      if (!origin || !published.includes(origin)) {
        throw new BadRequestException('This address is not one of this server’s home addresses');
      }
      returnTo = origin;
    }
    const tagged = await this.frameleafAccountRepository.getSession(auth.session.id);
    const link = tagged ? await this.frameleafAccountRepository.getLinkByUser(auth.user.id) : undefined;
    if (!tagged || link?.sub !== tagged.sub) {
      throw new BadRequestException('Only a Sign in with Frameleaf session can be handed over');
    }
    const code = this.cryptoRepository.randomBytesAsText(32);
    const expiresAt = new Date(Date.now() + HANDOFF_TTL_SECONDS * 1000);
    await this.frameleafAccountRepository.setHandoff(auth.session.id, this.hashCode(code), expiresAt);
    return {
      code,
      expiresAt: expiresAt.toISOString(),
      // in the fragment: never sent to a server, never in a log or a Referer
      url: returnTo ? `${returnTo}/auth/login#frameleafHandoff=${encodeURIComponent(code)}` : null,
    };
  }

  /** `POST oauth/frameleaf/handoff/redeem`: exchange a handoff code for a new, tagged session. */
  async redeemHandoff(dto: FrameleafHandoffRedeemDto, loginDetails: LoginDetails) {
    const parent = await this.frameleafAccountRepository.takeHandoff(this.hashCode(dto.code));
    if (!parent || !parent.handoffExpiresAt || new Date(parent.handoffExpiresAt).getTime() < Date.now()) {
      throw new UnauthorizedException('This sign-in code is not valid any more');
    }
    const parentSession = await this.sessionRepository.get(parent.sessionId);
    const user = parentSession ? await this.userRepository.get(parent.userId, { withDeleted: false }) : undefined;
    if (!user) {
      throw new UnauthorizedException('This sign-in code is not valid any more');
    }
    const { session, response } = await createSession(
      { sessionRepository: this.sessionRepository, cryptoRepository: this.cryptoRepository },
      user,
      loginDetails,
      { sid: parent.sid ?? undefined },
    );
    await this.frameleafAccountRepository.tagSession({
      sessionId: session.id,
      userId: user.id,
      sid: parent.sid,
      sub: parent.sub,
      authTime: parent.authTime,
    });
    return response;
  }

  /** `GET oauth/frameleaf/link`: this person's Frameleaf account link. */
  async getLink(auth: AuthDto): Promise<FrameleafAccountLinkResponseDto> {
    const available = !!(await this.config());
    const link = await this.frameleafAccountRepository.getLinkByUser(auth.user.id);
    return {
      available,
      linked: !!link,
      email: link?.email ?? null,
      linkedAt: link ? new Date(link.linkedAt).toISOString() : null,
      lastSignInAt: link?.lastSignInAt ? new Date(link.lastSignInAt).toISOString() : null,
    };
  }

  /** `POST oauth/frameleaf/link`: link a Frameleaf account to the signed-in local account. */
  async link(auth: AuthDto, dto: OAuthCallbackDto, headers: IncomingHttpHeaders): Promise<UserAdminResponseDto> {
    const config = await this.requireConfig();
    const { profile } = await this.exchange(config, dto, headers);
    const email = profile.email?.trim().toLowerCase();
    if (!email) {
      throw new BadRequestException('Frameleaf did not send an email address');
    }
    const emailProblem = emailVerificationProblem(profile);
    if (emailProblem) {
      throw new BadRequestException(emailProblem);
    }
    const other = await this.frameleafAccountRepository.getLinkBySub(profile.sub);
    if (other && other.userId !== auth.user.id) {
      const owner = await this.userRepository.get(other.userId, { withDeleted: false });
      throw new BadRequestException(
        owner ? 'This Frameleaf account is already linked to another account on this server' : DELETED_ACCOUNT_MESSAGE,
      );
    }
    const previous = await this.frameleafAccountRepository.getLinkByUser(auth.user.id);
    const access = frameleafAccess(profile);
    await this.frameleafAccountRepository.upsertLink({
      userId: auth.user.id,
      sub: profile.sub,
      email,
      emailVerified: true,
      role: access === 'viewer' ? 'user' : frameleafRole(profile),
      autoRegistered: false,
      access,
    });
    await this.grantViewerScopeIfDue(auth.user.id, previous, access);
    const user = await this.userRepository.get(auth.user.id, { withDeleted: false });
    if (user) {
      await this.auditLink(user, AdminAuditAction.FrameleafAccountLinked, email);
    }
    this.websocketRepository.clientSend('on_frameleaf_cloud', auth.user.id, { topic: 'account' });
    return mapUserAdmin(user ?? (auth.user as never));
  }

  /**
   * `DELETE oauth/frameleaf/link`: unlink this person's Frameleaf account. Their other Sign in with
   * Frameleaf sessions end; this session and their local sign-in are unchanged.
   */
  async unlink(auth: AuthDto): Promise<void> {
    const removed = await this.frameleafAccountRepository.deleteLink(auth.user.id);
    if (!removed) {
      return;
    }
    const sessionIds = (await this.frameleafAccountRepository.findSessions({ sub: removed.sub })).map(
      ({ sessionId }) => sessionId,
    );
    // the other Frameleaf sessions end; this one stays signed in but is no longer a Frameleaf session
    await this.endSessions(sessionIds.filter((sessionId) => sessionId !== auth.session?.id));
    await this.frameleafAccountRepository.deleteSessions(sessionIds);
    const user = await this.userRepository.get(auth.user.id, { withDeleted: false });
    if (user) {
      await this.auditLink(user, AdminAuditAction.FrameleafAccountUnlinked, removed.email);
    }
    this.websocketRepository.clientSend('on_frameleaf_cloud', auth.user.id, { topic: 'account' });
  }

  /**
   * FL-235: an account that becomes a viewer, or a viewer invited again after its access was revoked,
   * is given its scope (the server owner's library). A viewer that keeps its scope keeps whatever the
   * library owners chose since.
   */
  private async grantViewerScopeIfDue(
    userId: string,
    previous: { access?: FrameleafAccess | null; scopeGrantedAt?: Date | null } | undefined,
    access: FrameleafAccess | null,
  ) {
    if (access !== 'viewer' || (previous?.access === 'viewer' && previous.scopeGrantedAt)) {
      return;
    }
    const granted = await grantViewerScope(this.viewerAccess, userId);
    if (granted.length > 0) {
      this.logger.log(`Shared the server owner’s library with the viewer ${userId}`);
    }
  }

  /** A removed account takes its Frameleaf link with it (the fork table has no foreign key). */
  @OnEvent({ name: 'UserDelete' })
  async onUserDelete({ id }: ArgOf<'UserDelete'>) {
    try {
      await this.frameleafAccountRepository.deleteLink(id);
    } catch (error) {
      this.logger.warn(`Could not remove the Frameleaf account link of a removed account: ${error}`);
    }
  }

  /** End sessions (and their tags), telling open clients they were signed out. */
  private async endSessions(sessionIds: string[]) {
    for (const sessionId of sessionIds) {
      await this.sessionRepository.delete(sessionId);
      await this.eventRepository.emit('SessionDelete', { sessionId });
    }
    await this.frameleafAccountRepository.deleteSessions(sessionIds);
  }

  private async exchange(config: OAuthConfig, dto: OAuthCallbackDto, headers: IncomingHttpHeaders) {
    const cookies = parse(headers.cookie || '');
    const expectedState = dto.state ?? cookies[ImmichCookie.OAuthState];
    if (!expectedState?.length) {
      throw new BadRequestException('OAuth state is missing');
    }
    const codeVerifier = dto.codeVerifier ?? cookies[ImmichCookie.OAuthCodeVerifier];
    if (!codeVerifier?.length) {
      throw new BadRequestException('OAuth code verifier is missing');
    }
    try {
      return await this.oauthRepository.getProfileAndOAuthSid(
        config,
        frameleafCallbackUrl(dto.url),
        expectedState,
        codeVerifier,
      );
    } catch (error) {
      this.logger.warn(`Sign in with Frameleaf failed: ${error}`);
      throw new UnauthorizedException('Sign in with Frameleaf did not finish. Try again.');
    }
  }

  /**
   * FL-177 (as-built decision #32): `frameleaf_role` is applied on every sign-in, to every linked
   * account, so a person the cloud demotes loses administration here at their next sign-in. The one
   * exception keeps the server manageable: the last administrator is never demoted this way; the
   * change is logged for the administrators to settle by hand.
   */
  private async applyRole(user: UserAdmin, role: 'admin' | 'user'): Promise<UserAdmin> {
    // counting the other active administrators and demoting are one step (FL-177 review): two
    // sign-ins at once can never both see the other and leave the server without an administrator
    const updated = await this.databaseRepository.withLock(DatabaseLock.FrameleafRoleChange, async () => {
      if (role === 'user') {
        const admins = await this.userRepository.getAdmins();
        if (admins.every((admin) => admin.id === user.id)) {
          this.logger.warn(
            `Frameleaf asked for ${user.email} to stop administering this server, but they are its only administrator; they stay one`,
          );
          return null;
        }
      }
      return this.userRepository.update(user.id, { isAdmin: role === 'admin' });
    });
    if (!updated) {
      return user;
    }
    // the change comes from Frameleaf Cloud, not from a person on this server
    await this.recordAdminEvents([
      {
        userId: updated.id,
        actorId: null,
        action: role === 'admin' ? AdminAuditAction.AdminGranted : AdminAuditAction.AdminRevoked,
        subject: updated.name,
        detail: 'frameleaf_role',
      },
    ]);
    return updated;
  }

  private async config() {
    return frameleafOAuthConfig({
      configRepository: this.configRepository,
      databaseRepository: this.databaseRepository,
      systemMetadataRepository: this.systemMetadataRepository,
      instanceIdentityRepository: this.instanceIdentityRepository,
      frameleafCloudRepository: this.frameleafCloudRepository,
    });
  }

  private async requireConfig() {
    const config = await this.config();
    if (!config) {
      throw new BadRequestException(NOT_AVAILABLE_MESSAGE);
    }
    return config;
  }

  /** Handoff codes are stored only as their SHA-256, hex encoded. */
  private hashCode(code: string) {
    return this.cryptoRepository.hashSha256(code).toString('hex');
  }

  private async auditLink(user: { id: string; name: string }, action: AdminAuditAction, detail: string) {
    await this.recordAdminEvents([{ userId: user.id, actorId: user.id, action, subject: user.name, detail }]);
  }
}
