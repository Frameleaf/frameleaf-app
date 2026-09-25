import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { parse } from 'cookie';
import type { IncomingHttpHeaders } from 'node:http';
import type { UserAdmin } from 'src/database.js';
import type { AuthDto, OAuthCallbackDto, OAuthConfigDto } from 'src/dtos/auth.dto.js';
import type { ArgOf } from 'src/repositories/event.repository.js';
import type { OAuthConfig } from 'src/repositories/oauth.repository.js';
import { OnEvent } from 'src/decorators.js';
import {
  FrameleafAccountLinkResponseDto,
  FrameleafHandoffRedeemDto,
  FrameleafHandoffResponseDto,
} from 'src/dtos/frameleaf-auth.dto.js';
import { UserAdminResponseDto, mapUserAdmin } from 'src/dtos/user.dto.js';
import { AdminAuditAction, ImmichCookie } from 'src/enum.js';
import { type LoginDetails, UNVERIFIED_EMAIL_MESSAGE } from 'src/services/auth.service.js';
import { BaseService } from 'src/services/base.service.js';
import {
  frameleafCallbackUrl,
  frameleafOAuthConfig,
  frameleafRedirectUri,
  frameleafRole,
} from 'src/utils/frameleaf-sign-in.js';
import { createSession } from 'src/utils/session.js';

/** How long a handoff code may be used. */
export const HANDOFF_TTL_SECONDS = 60;

const NOT_AVAILABLE_MESSAGE = 'Sign in with Frameleaf is not available on this server';

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
    const email = profile.email?.trim().toLowerCase();
    if (profile.email_verified !== true || !email) {
      throw new BadRequestException(UNVERIFIED_EMAIL_MESSAGE);
    }
    const role = frameleafRole(profile);

    let user: UserAdmin | undefined;
    let link = await this.frameleafAccountRepository.getLinkBySub(profile.sub);
    if (link) {
      user = await this.userRepository.get(link.userId, { withDeleted: false });
    }
    if (!user) {
      // an account here with the same verified email is linked to this Frameleaf account
      const existing = await this.userRepository.getByEmail(email);
      if (existing) {
        const other = await this.frameleafAccountRepository.getLinkByUser(existing.id);
        if (other && other.sub !== profile.sub) {
          throw new BadRequestException('This account is already linked to another Frameleaf account');
        }
        user = existing;
        link = await this.frameleafAccountRepository.upsertLink({
          userId: user.id,
          sub: profile.sub,
          email,
          emailVerified: true,
          role,
          autoRegistered: false,
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
      link = await this.frameleafAccountRepository.upsertLink({
        userId: user.id,
        sub: profile.sub,
        email,
        emailVerified: true,
        role,
        autoRegistered: true,
      });
      await this.auditLink(user, AdminAuditAction.FrameleafAccountLinked, email);
    }
    if (link?.autoRegistered && role && user.isAdmin !== (role === 'admin')) {
      user = await this.userRepository.update(user.id, { isAdmin: role === 'admin' });
    }
    await this.frameleafAccountRepository.touchLink(user.id, { email, emailVerified: true, role });

    const { session, response } = await createSession(
      { sessionRepository: this.sessionRepository, cryptoRepository: this.cryptoRepository },
      user,
      loginDetails,
      { sid, bearerToken: idToken },
    );
    await this.frameleafAccountRepository.tagSession({
      sessionId: session.id,
      userId: user.id,
      sid: sid ?? null,
      sub: profile.sub,
      authTime: typeof profile.auth_time === 'number' ? new Date(profile.auth_time * 1000) : null,
    });
    return response;
  }

  /**
   * `POST oauth/frameleaf/handoff`: a single-use code that signs this person in on another address of
   * this server (for example from the relay address to the home address). Only a session Frameleaf
   * created can hand itself over.
   */
  async createHandoff(auth: AuthDto): Promise<FrameleafHandoffResponseDto> {
    if (!auth.session) {
      throw new BadRequestException('Only a signed-in session can be handed over');
    }
    const tagged = await this.frameleafAccountRepository.getSession(auth.session.id);
    if (!tagged) {
      throw new BadRequestException('Only a Sign in with Frameleaf session can be handed over');
    }
    const code = this.cryptoRepository.randomBytesAsText(32);
    const expiresAt = new Date(Date.now() + HANDOFF_TTL_SECONDS * 1000);
    await this.frameleafAccountRepository.setHandoff(auth.session.id, this.hashCode(code), expiresAt);
    return { code, expiresAt: expiresAt.toISOString() };
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
    if (profile.email_verified !== true || !email) {
      throw new BadRequestException(UNVERIFIED_EMAIL_MESSAGE);
    }
    const other = await this.frameleafAccountRepository.getLinkBySub(profile.sub);
    if (other && other.userId !== auth.user.id) {
      throw new BadRequestException('This Frameleaf account is already linked to another account on this server');
    }
    await this.frameleafAccountRepository.upsertLink({
      userId: auth.user.id,
      sub: profile.sub,
      email,
      emailVerified: true,
      role: frameleafRole(profile),
      autoRegistered: false,
    });
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
    const sessions = (await this.frameleafAccountRepository.findSessions({ sub: removed.sub })).filter(
      ({ sessionId }) => sessionId !== auth.session?.id,
    );
    await this.endSessions(sessions.map(({ sessionId }) => sessionId));
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

  private async config() {
    const systemConfig = await this.getConfig({ withCache: false });
    return frameleafOAuthConfig(
      {
        configRepository: this.configRepository,
        databaseRepository: this.databaseRepository,
        systemMetadataRepository: this.systemMetadataRepository,
        instanceIdentityRepository: this.instanceIdentityRepository,
        frameleafCloudRepository: this.frameleafCloudRepository,
      },
      systemConfig,
    );
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
