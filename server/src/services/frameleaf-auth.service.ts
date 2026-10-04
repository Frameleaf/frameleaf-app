import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { parse } from 'cookie';
import { timingSafeEqual } from 'node:crypto';
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
  FrameleafLinkConfirmDto,
  FrameleafLinkDto,
  FrameleafLinkResponseDto,
  FrameleafLinkRoleChange,
  FrameleafTokenExchangeDto,
  FrameleafTokenExchangeErrorCode,
} from 'src/dtos/frameleaf-auth.dto.js';
import { mapNotification } from 'src/dtos/notification.dto.js';
import { mapUserAdmin } from 'src/dtos/user.dto.js';
import { AdminAuditAction, DatabaseLock, ImmichCookie, NotificationLevel, NotificationType } from 'src/enum.js';
import { ClientTokenRejection, type OAuthConfig, type OAuthProfile } from 'src/repositories/oauth.repository.js';
import { type LoginDetails, UNVERIFIED_EMAIL_MESSAGE, emailVerificationProblem } from 'src/services/auth.service.js';
import { BaseService } from 'src/services/base.service.js';
import { HumanReadableSize } from 'src/utils/bytes.js';
import { identityDirectory, readCloudLink } from 'src/utils/frameleaf-cloud-gateway.js';
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
import { publishedLocalOrigins } from 'src/utils/public-url.js';
import { createSession } from 'src/utils/session.js';

/** How long a handoff code may be used. */
export const HANDOFF_TTL_SECONDS = 60;

const NOT_AVAILABLE_MESSAGE = 'Sign in with Frameleaf is not available on this server';
const NOT_LINKED_MESSAGE = 'This server is not linked to Frameleaf Cloud';
const LINK_CONFIRM_TTL_SECONDS = 10 * 60;
const LINK_CONFIRM_PURPOSE = 'frameleaf-link-confirm';

type PendingLink = {
  userId: string;
  sessionId: string | null;
  sub: string;
  email: string;
  role: 'admin' | 'user' | null;
  access: FrameleafAccess | null;
};

type PendingLinkConfirmation = PendingLink & { authority: string; exp: number };

/** Linking would make (or made) a non-administrator an administrator. */
const promotes = (user: { isAdmin: boolean } | undefined, role: PendingLink['role']) =>
  !!user && !user.isAdmin && role === 'admin';

const constantTimeEqual = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

const DELETED_ACCOUNT_MESSAGE =
  'The account this Frameleaf account is linked to is being removed from this server. Ask an administrator to restore it.';

/** Why a person Frameleaf vouched for cannot be signed in (the account rules of every Frameleaf sign-in). */
type SignInRefusal = 'email' | 'removed' | 'conflict' | 'setup';

const SIGN_IN_REFUSAL_CODES: Record<SignInRefusal, FrameleafTokenExchangeErrorCode> = {
  email: FrameleafTokenExchangeErrorCode.EmailUnverified,
  removed: FrameleafTokenExchangeErrorCode.AccountRemoved,
  conflict: FrameleafTokenExchangeErrorCode.AccountConflict,
  // FL-292: only the owner may become a new server's first administrator
  setup: FrameleafTokenExchangeErrorCode.NoAccess,
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
 * - Every session it creates is tagged in `public.frameleaf_session`, so a back-channel logout
 *   from the cloud ends it, and remote-access enforcement can recognise it.
 * - A Frameleaf app can exchange a server-audience token from the identity provider for a session
 *   without a browser (FL-230, `exchangeToken`), under the same account rules and session tagging.
 * - FL-235: `frameleaf_access` is recorded on every sign-in and link. It grants nothing: everyone
 *   the cloud invited gets their own regular account and library (owner decision, 2026-10-01), and
 *   sees others' media only through what is shared with them.
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
    const role = frameleafRole(profile);
    const access = frameleafAccess(profile);
    // FL-292: a server nobody administers yet (set up from the Frameleaf app) gets its first
    // administrator only from the Frameleaf account that owns it, never by creation or promotion
    const firstAdministrator = !(await this.userRepository.getAdmin());
    if (firstAdministrator) {
      const { link: cloudLink } = await readCloudLink({
        configRepository: this.configRepository,
        systemMetadataRepository: this.systemMetadataRepository,
      });
      if (role !== 'admin' || !cloudLink?.accountId || cloudLink.accountId !== profile.sub) {
        throw refuse('setup', 'This server is not set up yet: the Frameleaf account that owns it signs in first');
      }
    }

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
      // FL-235: a person invited to this server gets their own account, with the quota the
      // administrator chose for invited accounts (unlimited by default); the server's owner is never
      // capped: the owner is the link's account (its sub) when known, as GET /users/me reports it
      const { frameleafCloud } = await this.getConfig({ withCache: false });
      const { link: cloudLink, linked } = await readCloudLink({
        configRepository: this.configRepository,
        systemMetadataRepository: this.systemMetadataRepository,
      });
      const ownerAccountId = linked ? cloudLink?.accountId : undefined;
      const isOwner = ownerAccountId ? profile.sub === ownerAccountId : access === 'owner';
      const quota = isOwner ? null : (frameleafCloud.signIn?.invitedStorageQuota ?? null);
      const create = () =>
        this.createUser({
          name: typeof profile.name === 'string' && profile.name.trim() ? profile.name.trim() : email,
          email,
          isAdmin: role === 'admin',
          quotaSizeInBytes: quota === null ? null : quota * HumanReadableSize.GiB,
        });
      // FL-292: while nobody administers the server (set up from the Frameleaf app), only the account
      // that owns it may become its first administrator, one claim at a time with the other setup paths
      user = firstAdministrator
        ? await this.databaseRepository.withLock(DatabaseLock.FrameleafServerClaim, async () => {
            if (await this.userRepository.getAdmin()) {
              return create();
            }
            const created = await create();
            await this.recordAdminEvents([
              {
                userId: created.id,
                actorId: created.id,
                action: AdminAuditAction.AccountCreated,
                subject: created.name,
                detail: 'server-claimed:app-frameleaf',
              },
            ]);
            this.logger.log(`This server's owner ${email} signed in with Frameleaf and administers it`);
            return created;
          })
        : await create();
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

  /**
   * `POST oauth/frameleaf/link`: link a Frameleaf account to the signed-in local account.
   *
   * FL-218 (owner decision 2026-10-03): `frameleaf_role` is the cloud's authority, so an admin share makes the
   * linked account an administrator here. Linking applies that promotion at once (not at the next sign-in) and
   * says so (`roleChange: granted-admin`), and the other administrators are notified. With `preview` nothing is
   * linked: the response reports what linking would change and carries a short-lived `confirmToken` for
   * `POST oauth/frameleaf/link/confirm`. Demotions still apply at sign-in, never to the last administrator.
   */
  async link(auth: AuthDto, dto: FrameleafLinkDto, headers: IncomingHttpHeaders): Promise<FrameleafLinkResponseDto> {
    const config = await this.requireConfig();
    const authority = dto.preview ? await this.pendingLinkAuthority(config) : null;
    const { profile } = await this.exchange(config, dto, headers);
    const email = profile.email?.trim().toLowerCase();
    if (!email) {
      throw new BadRequestException('Frameleaf did not send an email address');
    }
    const emailProblem = emailVerificationProblem(profile);
    if (emailProblem) {
      throw new BadRequestException(emailProblem);
    }
    const claims: PendingLink = {
      userId: auth.user.id,
      sessionId: auth.session?.id ?? null,
      sub: profile.sub,
      email,
      role: frameleafRole(profile),
      access: frameleafAccess(profile),
    };
    await this.checkLinkable(auth, claims);
    if (dto.preview) {
      const user = await this.userRepository.get(auth.user.id, { withDeleted: false });
      const expiresAt = new Date(Date.now() + LINK_CONFIRM_TTL_SECONDS * 1000);
      return {
        ...mapUserAdmin(user ?? (auth.user as never)),
        linked: false,
        roleChange: promotes(user, claims.role) ? FrameleafLinkRoleChange.GrantedAdmin : FrameleafLinkRoleChange.None,
        confirmToken: await this.signPendingLink({ ...claims, authority: authority!, exp: expiresAt.getTime() }),
        confirmExpiresAt: expiresAt.toISOString(),
      };
    }
    return this.applyLink(auth, claims);
  }

  /** `POST oauth/frameleaf/link/confirm`: links what a preview reported, by its confirm token. */
  async confirmLink(auth: AuthDto, dto: FrameleafLinkConfirmDto): Promise<FrameleafLinkResponseDto> {
    const claims = await this.verifyPendingLink(dto.confirmToken);
    if (!claims || claims.userId !== auth.user.id || claims.sessionId !== (auth.session?.id ?? null)) {
      throw new BadRequestException('This link confirmation is not valid any more. Sign in with Frameleaf again.');
    }
    // Resolve account conflicts before taking the authority fence. A revoke may finish while this
    // lookup waits; the current authority is then checked again under the fence before any write.
    await this.checkLinkable(auth, claims);
    return this.databaseRepository.withLock(DatabaseLock.FrameleafLinkAuthority, async () => {
      const config = await this.requireConfig();
      if (claims.authority !== (await this.pendingLinkAuthority(config))) {
        throw new BadRequestException('This link confirmation is not valid any more. Sign in with Frameleaf again.');
      }
      await this.checkLinkable(auth, claims);
      return this.applyLink(auth, claims);
    });
  }

  private async checkLinkable(auth: AuthDto, claims: Pick<PendingLink, 'sub'>) {
    const other = await this.frameleafAccountRepository.getLinkBySub(claims.sub);
    if (other && other.userId !== auth.user.id) {
      const owner = await this.userRepository.get(other.userId, { withDeleted: false });
      throw new BadRequestException(
        owner ? 'This Frameleaf account is already linked to another account on this server' : DELETED_ACCOUNT_MESSAGE,
      );
    }
  }

  private async applyLink(auth: AuthDto, claims: PendingLink): Promise<FrameleafLinkResponseDto> {
    await this.frameleafAccountRepository.upsertLink({
      userId: auth.user.id,
      sub: claims.sub,
      email: claims.email,
      emailVerified: true,
      role: claims.role,
      autoRegistered: false,
      access: claims.access,
    });
    let user = await this.userRepository.get(auth.user.id, { withDeleted: false });
    let roleChange = FrameleafLinkRoleChange.None;
    if (user) {
      await this.auditLink(user, AdminAuditAction.FrameleafAccountLinked, claims.email);
      if (promotes(user, claims.role)) {
        const promoted = await this.applyRole(user, 'admin');
        if (promoted.isAdmin) {
          user = promoted;
          roleChange = FrameleafLinkRoleChange.GrantedAdmin;
        }
      }
    }
    this.websocketRepository.clientSend('on_frameleaf_cloud', auth.user.id, { topic: 'account' });
    return {
      ...mapUserAdmin(user ?? (auth.user as never)),
      linked: true,
      roleChange,
      confirmToken: null,
      confirmExpiresAt: null,
    };
  }

  /** A preview's claims, signed with this server's own key so a confirm cannot change them. */
  private async signPendingLink(claims: PendingLinkConfirmation): Promise<string> {
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const mac = await this.cryptoRepository.serverKeyedHash(
      identityDirectory(this.configRepository),
      LINK_CONFIRM_PURPOSE,
      payload,
    );
    return `${payload}.${mac}`;
  }

  private async verifyPendingLink(token: string): Promise<PendingLinkConfirmation | null> {
    const [payload, mac, extra] = token.split('.', 3);
    if (!payload || !mac || extra !== undefined) {
      return null;
    }
    const expected = await this.cryptoRepository.serverKeyedHash(
      identityDirectory(this.configRepository),
      LINK_CONFIRM_PURPOSE,
      payload,
    );
    if (!constantTimeEqual(mac, expected)) {
      return null;
    }
    try {
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as PendingLinkConfirmation;
      return typeof claims.exp === 'number' && claims.exp > Date.now() ? claims : null;
    } catch {
      return null;
    }
  }

  /** Bind a preview to this exact Cloud link generation without putting link credentials in the token. */
  private async pendingLinkAuthority(config: OAuthConfig): Promise<string> {
    const { cloudUrl, link, linked } = await readCloudLink({
      configRepository: this.configRepository,
      systemMetadataRepository: this.systemMetadataRepository,
    });
    if (
      !linked ||
      !link?.linkedAt ||
      link.oidc?.issuer !== config.issuerUrl ||
      link.oidc?.clientId !== config.clientId
    ) {
      throw new BadRequestException('This link confirmation is not valid any more. Sign in with Frameleaf again.');
    }
    return this.cryptoRepository.serverKeyedHash(
      identityDirectory(this.configRepository),
      LINK_CONFIRM_PURPOSE,
      JSON.stringify({
        cloudUrl,
        instanceId: link.instanceId,
        accountId: link.accountId ?? null,
        linkedAt: link.linkedAt,
        issuer: config.issuerUrl,
        clientId: config.clientId,
        scope: config.scope,
      }),
    );
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
    if (role === 'admin') {
      await this.notifyAdminsOfGrant(updated);
    }
    return updated;
  }

  /** FL-218: every other administrator sees that Frameleaf Cloud made someone an administrator here. */
  private async notifyAdminsOfGrant(user: UserAdmin) {
    const admins = await this.userRepository.getAdmins();
    for (const admin of admins) {
      if (admin.id === user.id) {
        continue;
      }
      const item = await this.notificationRepository.create({
        userId: admin.id,
        type: NotificationType.SystemMessage,
        level: NotificationLevel.Info,
        title: 'New administrator',
        description: `${user.name || user.email} became an administrator through Frameleaf Cloud`,
        data: JSON.stringify({ userId: user.id, source: 'frameleaf_role' }),
      });
      this.websocketRepository.clientSend('on_notification', admin.id, mapNotification(item));
    }
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
