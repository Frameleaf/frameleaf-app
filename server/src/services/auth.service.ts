import { BadRequestException, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { parse } from 'cookie';
import { DateTime } from 'luxon';
import { IncomingHttpHeaders } from 'node:http';
import {
  FRAMELEAF_MOBILE_REDIRECT,
  FRAMELEAF_MOBILE_REDIRECT_PATH,
  LOGIN_DUMMY_HASH,
  LOGIN_URL,
  MOBILE_REDIRECT,
  SALT_ROUNDS,
} from 'src/constants.js';
import { AuthSharedLink, AuthUser, UserAdmin } from 'src/database.js';
import {
  AuthDto,
  AuthStatusResponseDto,
  ChangePasswordDto,
  LoginCredentialDto,
  LogoutResponseDto,
  OAuthBackchannelLogoutDto,
  OAuthCallbackDto,
  OAuthConfigDto,
  PinCodeChangeDto,
  PinCodeResetDto,
  PinCodeSetupDto,
  SessionUnlockDto,
  SignUpDto,
} from 'src/dtos/auth.dto.js';
import { UserAdminResponseDto, mapUserAdmin } from 'src/dtos/user.dto.js';
import { AuthType, ImmichCookie, ImmichHeader, ImmichQuery, JobName, Permission } from 'src/enum.js';
import { OAuthProfile } from 'src/repositories/oauth.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { isGranted } from 'src/utils/access.js';
import { HumanReadableSize } from 'src/utils/bytes.js';
import { frameleafOAuthConfig, logoutTokenAudiences } from 'src/utils/frameleaf-sign-in.js';
import { HiddenContentFilter, hasHiddenContentFilter } from 'src/utils/hidden-content.js';
import { getPreferences } from 'src/utils/preferences.js';
import { generateProfileImage } from 'src/utils/profile-image.js';
import { getUserAgentDetails } from 'src/utils/request.js';
import { createSession } from 'src/utils/session.js';

export interface LoginDetails {
  isSecure: boolean;
  clientIp: string;
  deviceType: string;
  deviceOS: string;
  appVersion: string | null;
}

interface ClaimOptions<T> {
  key: string;
  default: T;
  isValid: (value: unknown) => boolean;
}

const ELEVATED_SESSION_DURATION_MINUTES = 60;
const ELEVATED_SESSION_REFRESH_THRESHOLD_MINUTES = 5;

// SECURITY (security.md M5): exponential backoff for PIN unlock attempts.
// The PIN is only 6 digits (~10^6 keyspace), so without throttling an attacker
// with a stolen session token can brute-force the full space in minutes.
// Track failed attempts per user in-process. State resets on process restart,
// which is conservative — fewer false lockouts at the cost of bypass via
// process kill (only available to admins).
const PIN_FAILURE_THRESHOLDS = [
  { attempts: 5, lockoutMs: 60 * 1000 }, // 5 failures -> 1 minute
  { attempts: 10, lockoutMs: 60 * 60 * 1000 }, // 10 failures -> 1 hour
  { attempts: 15, lockoutMs: 24 * 60 * 60 * 1000 }, // 15 failures -> 24 hours
];
const PIN_FAILURE_RESET_MS = 30 * 60 * 1000; // failures expire after 30 min of inactivity

type PinAttemptState = { failureCount: number; lastFailureAt: number; lockedUntil: number };
const pinAttemptsByUser = new Map<string, PinAttemptState>();

function lookupPinLockoutMs(failureCount: number): number {
  let lockout = 0;
  for (const tier of PIN_FAILURE_THRESHOLDS) {
    if (failureCount >= tier.attempts) {
      lockout = tier.lockoutMs;
    }
  }
  return lockout;
}

export type ValidateRequest = {
  headers: IncomingHttpHeaders;
  queryParams: Record<string, string>;
  metadata: {
    sharedLinkRoute: boolean;
    adminRoute: boolean;
    /** `false` explicitly means no permission is required, which otherwise defaults to `all` */
    permission?: Permission | false;
    uri: string;
    /** FL-34: `false` leaves an elevated session's PIN expiry as it is (a status read). */
    refreshElevation?: boolean;
  };
};

const FRAMELEAF_CALLBACK = /frameleaf-auth:\/+oauth-callback/;

/** FL-158: the refusal for an email the identity provider has not verified (every provider). */
export const UNVERIFIED_EMAIL_MESSAGE =
  'This email address has not been verified by the sign-in provider, so it cannot be used to sign in here';
const LEGACY_MOBILE_REDIRECT_PATH = /\/oauth\/mobile-redirect\/?$/;

/**
 * The HTTP address that forwards an OAuth callback to the Frameleaf app, derived from the
 * configured Immich mobile redirect (FL-131).
 *
 * The override exists because some identity providers only accept `https` callbacks. The Immich
 * app's callback is replaced by the configured `…/oauth/mobile-redirect`; the Frameleaf app's by
 * the sibling `…/oauth/frameleaf-mobile-redirect` on the same server, so the provider hands each
 * app back its own callback and neither app is opened for the other's sign-in.
 *
 * Only an override that is this server's `…/oauth/mobile-redirect` has a known sibling. Any other
 * address may not be this server at all, so there is nothing safe to derive, and the Frameleaf
 * callback is refused with setup guidance instead of being sent somewhere else.
 */
const frameleafRedirectUri = (mobileRedirectUri: string): string => {
  let url: URL | undefined;
  try {
    url = new URL(mobileRedirectUri);
  } catch {
    url = undefined;
  }
  if (!url || !LEGACY_MOBILE_REDIRECT_PATH.test(url.pathname)) {
    throw new BadRequestException(
      "Frameleaf app sign-in needs the mobile redirect override to be this server's " +
        '/api/oauth/mobile-redirect address, with /api/oauth/frameleaf-mobile-redirect also registered ' +
        'as a redirect URI with the identity provider',
    );
  }
  url.pathname = url.pathname.replace(LEGACY_MOBILE_REDIRECT_PATH, () => FRAMELEAF_MOBILE_REDIRECT_PATH);
  url.search = '';
  url.hash = '';
  return url.href;
};

@Injectable()
export class AuthService extends BaseService {
  async login(dto: LoginCredentialDto, details: LoginDetails) {
    const config = await this.getConfig({ withCache: false });
    if (!config.passwordLogin.enabled) {
      throw new UnauthorizedException('Password login has been disabled');
    }

    const user = await this.userRepository.getByEmail(dto.email, { withPassword: true });
    // Always run bcrypt so response time is constant regardless of whether the email
    // is registered, preventing timing-based user enumeration.
    const isAuthenticated = this.cryptoRepository.compareBcrypt(dto.password, user?.password ?? LOGIN_DUMMY_HASH);

    if (!user || !user.password || !isAuthenticated) {
      this.logger.warn(`Failed login attempt for user ${dto.email} from ip address ${details.clientIp}`);
      throw new UnauthorizedException('Incorrect email or password');
    }

    return this.createLoginResponse(user, details);
  }

  async logout(auth: AuthDto, authType: AuthType): Promise<LogoutResponseDto> {
    let oauthBearerToken: string | undefined;
    if (auth.session) {
      const session = await this.sessionRepository.get(auth.session.id);
      oauthBearerToken = session?.oauthBearerToken ?? undefined;
      await this.sessionRepository.delete(auth.session.id);
      await this.eventRepository.emit('SessionDelete', { sessionId: auth.session.id });
    }

    return {
      successful: true,
      redirectUri: await this.getLogoutEndpoint(authType, oauthBearerToken),
    };
  }

  async backchannelLogout(dto: OAuthBackchannelLogoutDto): Promise<void> {
    // FL-158: a logout token for this server's Frameleaf client (`aud` = instance id) ends the
    // sessions Sign in with Frameleaf created; any other goes to the administrator's own provider.
    if (await this.frameleafBackchannelLogout(dto.logout_token)) {
      return;
    }

    const { oauth } = await this.getConfig({ withCache: false });
    if (!oauth.enabled) {
      throw new BadRequestException('Received backchannel logout request but OAuth is not enabled');
    }

    let claims;
    try {
      claims = await this.oauthRepository.validateLogoutToken(oauth, dto.logout_token);
    } catch (error: Error | any) {
      this.logger.error(`Error backchannel logout: ${error.message}`);
      this.logger.error(error);

      throw new BadRequestException('Error backchannel logout: token validation failed');
    }

    if (!claims) {
      throw new BadRequestException('Invalid logout token: no claims found');
    }

    if (!claims.sub && !claims.sid) {
      throw new BadRequestException('Invalid logout token: it must contain either a sub or a sid claim');
    }

    const deletedSessionIds = await this.sessionRepository.invalidateOAuth({
      oauthSid: claims.sid,
      oauthId: claims.sub,
    });

    for (const sessionId of deletedSessionIds) {
      await this.eventRepository.emit('SessionDelete', { sessionId });
    }
  }

  /** Returns whether the token was Frameleaf's (and was handled). */
  private async frameleafBackchannelLogout(logoutToken: string): Promise<boolean> {
    const config = await frameleafOAuthConfig(
      {
        configRepository: this.configRepository,
        databaseRepository: this.databaseRepository,
        systemMetadataRepository: this.systemMetadataRepository,
        instanceIdentityRepository: this.instanceIdentityRepository,
        frameleafCloudRepository: this.frameleafCloudRepository,
      },
      await this.getConfig({ withCache: false }),
    );
    if (!config || !logoutTokenAudiences(logoutToken).includes(config.clientId)) {
      return false;
    }

    let claims;
    try {
      claims = await this.oauthRepository.validateLogoutToken(config, logoutToken);
    } catch (error: Error | any) {
      this.logger.error(`Error in Frameleaf back-channel logout: ${error.message}`);
      throw new BadRequestException('Error backchannel logout: token validation failed');
    }
    if (!claims?.sub && !claims?.sid) {
      throw new BadRequestException('Invalid logout token: it must contain either a sub or a sid claim');
    }

    const tagged = await this.frameleafAccountRepository.findSessions({ sid: claims.sid, sub: claims.sub });
    for (const { sessionId } of tagged) {
      await this.sessionRepository.delete(sessionId);
      await this.eventRepository.emit('SessionDelete', { sessionId });
    }
    await this.frameleafAccountRepository.deleteSessions(tagged.map(({ sessionId }) => sessionId));
    return true;
  }

  async changePassword(auth: AuthDto, dto: ChangePasswordDto): Promise<UserAdminResponseDto> {
    const { password, newPassword } = dto;
    const user = await this.userRepository.getForChangePassword(auth.user.id);
    const isValid = this.validateSecret(password, user.password);
    if (!isValid) {
      throw new BadRequestException('Wrong password');
    }

    const hashedPassword = await this.cryptoRepository.hashBcrypt(newPassword, SALT_ROUNDS);

    const updatedUser = await this.userRepository.update(user.id, {
      password: hashedPassword,
      shouldChangePassword: false,
    });

    await this.eventRepository.emit('AuthChangePassword', {
      userId: user.id,
      currentSessionId: auth.session?.id,
      invalidateSessions: dto.invalidateSessions,
    });

    return mapUserAdmin(updatedUser);
  }

  async setupPinCode(auth: AuthDto, { pinCode }: PinCodeSetupDto) {
    const user = await this.userRepository.getForPinCode(auth.user.id);
    if (!user) {
      throw new UnauthorizedException();
    }

    if (user.pinCode) {
      throw new BadRequestException('User already has a PIN code');
    }

    const hashed = await this.cryptoRepository.hashBcrypt(pinCode, SALT_ROUNDS);
    await this.userRepository.update(auth.user.id, { pinCode: hashed });
  }

  async resetPinCode(auth: AuthDto, dto: PinCodeResetDto) {
    const user = await this.userRepository.getForPinCode(auth.user.id);
    this.validatePinCode(user, dto);

    await this.userRepository.update(auth.user.id, { pinCode: null });
    await this.sessionRepository.lockAll(auth.user.id);
    // FL-34: every open tab of every session of this account drops what it unlocked
    this.websocketRepository.clientSend('on_session_lock', auth.user.id);
  }

  async changePinCode(auth: AuthDto, dto: PinCodeChangeDto) {
    const user = await this.userRepository.getForPinCode(auth.user.id);
    this.validatePinCode(user, dto);

    const hashed = await this.cryptoRepository.hashBcrypt(dto.newPinCode, SALT_ROUNDS);
    await this.userRepository.update(auth.user.id, { pinCode: hashed });
    // FL-34: an elevation granted by the old PIN ends with it, in every session of the account
    await this.sessionRepository.lockAll(auth.user.id);
    this.websocketRepository.clientSend('on_session_lock', auth.user.id);
  }

  private validatePinCode(
    user: { pinCode: string | null; password: string | null },
    dto: { pinCode?: string; password?: string },
  ) {
    if (!user.pinCode) {
      throw new BadRequestException('User does not have a PIN code');
    }

    if (dto.password) {
      if (!this.validateSecret(dto.password, user.password)) {
        throw new BadRequestException('Wrong password');
      }
    } else if (dto.pinCode) {
      if (!this.validateSecret(dto.pinCode, user.pinCode)) {
        throw new BadRequestException('Wrong PIN code');
      }
    } else {
      throw new BadRequestException('Either password or pinCode is required');
    }
  }

  async adminSignUp(dto: SignUpDto): Promise<UserAdminResponseDto> {
    const admin = await this.createUser({
      isAdmin: true,
      email: dto.email,
      name: dto.name,
      password: dto.password,
      storageLabel: 'admin',
    });

    return mapUserAdmin(admin);
  }

  async authenticate({ headers, queryParams, metadata }: ValidateRequest): Promise<AuthDto> {
    const authDto = await this.validate({ headers, queryParams }, metadata.refreshElevation !== false);
    const { adminRoute, sharedLinkRoute, uri } = metadata;
    const requestedPermission = metadata.permission ?? Permission.All;

    if (!authDto.user.isAdmin && adminRoute) {
      this.logger.warn(`Denied access to admin only route: ${uri}`);
      throw new ForbiddenException('Forbidden');
    }

    if (authDto.sharedLink && !sharedLinkRoute) {
      this.logger.warn(`Denied access to non-shared route: ${uri}`);
      throw new ForbiddenException('Forbidden');
    }

    if (
      authDto.apiKey &&
      requestedPermission !== false &&
      !isGranted({ requested: [requestedPermission], current: authDto.apiKey.permissions })
    ) {
      throw new ForbiddenException(`Missing required permission: ${requestedPermission}`);
    }

    // FL-34: sensitive media is hidden by its lock record (`src/utils/locked.ts`), which every read
    // applies, so it is no longer part of this per-session filter: anything hidden while locked is in
    // the Locked view. The filter keeps the owner's own suppressed people, tags and pets.
    const hiddenContent = await this.getHiddenContentFilter(authDto, false);
    if (hasHiddenContentFilter(hiddenContent)) {
      authDto.suppressedContent = hiddenContent;
    }

    if (hasHiddenContentFilter(hiddenContent) && !authDto.session?.hasElevatedPermission) {
      authDto.hiddenContent = hiddenContent;
      authDto.hideNsfwAssets = true;
    }

    return authDto;
  }

  private async getHiddenContentFilter(auth: AuthDto, includeNsfw: boolean): Promise<HiddenContentFilter> {
    const metadata = (await this.userRepository.getMetadata(auth.user.id)) ?? [];
    const suppression = getPreferences(metadata).privacy.suppression;

    return {
      userId: auth.user.id,
      includeNsfw,
      tagIds: suppression.tagIds,
      personIds: suppression.personIds,
      petIds: suppression.petIds,
      scope: suppression.scope,
    };
  }

  private async validate(
    { headers, queryParams }: Omit<ValidateRequest, 'metadata'>,
    refreshElevation = true,
  ): Promise<AuthDto> {
    const shareKey = (headers[ImmichHeader.SharedLinkKey] || queryParams[ImmichQuery.SharedLinkKey]) as string;
    const shareSlug = (headers[ImmichHeader.SharedLinkSlug] || queryParams[ImmichQuery.SharedLinkSlug]) as string;
    const session = (headers[ImmichHeader.UserToken] ||
      headers[ImmichHeader.SessionToken] ||
      queryParams[ImmichQuery.SessionKey] ||
      this.getBearerToken(headers) ||
      this.getCookieToken(headers)) as string;
    const apiKey = (headers[ImmichHeader.ApiKey] || queryParams[ImmichQuery.ApiKey]) as string;

    if (shareKey) {
      return this.validateSharedLinkKey(shareKey);
    }

    if (shareSlug) {
      return this.validateSharedLinkSlug(shareSlug);
    }

    if (session) {
      return this.validateSession(session, headers, refreshElevation);
    }

    if (apiKey) {
      return this.validateApiKey(apiKey);
    }

    throw new UnauthorizedException('Authentication required');
  }

  getMobileRedirect(url: string) {
    return `${MOBILE_REDIRECT}?${url.split('?', 2)[1] || ''}`;
  }

  /** The Frameleaf app's counterpart of {@link getMobileRedirect} (FL-131). */
  getFrameleafMobileRedirect(url: string) {
    return `${FRAMELEAF_MOBILE_REDIRECT}?${url.split('?', 2)[1] || ''}`;
  }

  async authorize(dto: OAuthConfigDto) {
    const { oauth } = await this.getConfig({ withCache: false });

    if (!oauth.enabled) {
      throw new BadRequestException('OAuth is not enabled');
    }

    return await this.oauthRepository.authorize(
      oauth,
      this.resolveRedirectUri(oauth, dto.redirectUri),
      dto.state,
      dto.codeChallenge,
    );
  }

  async callback(dto: OAuthCallbackDto, headers: IncomingHttpHeaders, loginDetails: LoginDetails) {
    const { oauth } = await this.getConfig({ withCache: false });
    if (!oauth.enabled) {
      throw new BadRequestException('OAuth is not enabled');
    }

    const expectedState = dto.state ?? this.getCookieOauthState(headers);
    if (!expectedState?.length) {
      throw new BadRequestException('OAuth state is missing');
    }

    const codeVerifier = dto.codeVerifier ?? this.getCookieCodeVerifier(headers);
    if (!codeVerifier?.length) {
      throw new BadRequestException('OAuth code verifier is missing');
    }

    const url = this.resolveRedirectUri(oauth, dto.url);
    const {
      profile,
      sid: oauthSid,
      idToken: oauthBearerToken,
    } = await this.oauthRepository.getProfileAndOAuthSid(oauth, url, expectedState, codeVerifier);
    const normalizedEmail = profile.email ? profile.email.trim().toLowerCase() : undefined;
    const { autoRegister, defaultStorageQuota, storageLabelClaim, storageQuotaClaim, roleClaim } = oauth;
    this.logger.debug(`Logging in with OAuth: ${JSON.stringify(profile)}`);
    let user: UserAdmin | undefined = await this.userRepository.getByOAuthId(profile.sub);

    // FL-158: an email is used to find or create an account only when the provider verified it
    const emailVerified = profile.email_verified === true;

    // link by email
    if (!user && normalizedEmail) {
      const emailUser = await this.userRepository.getByEmail(normalizedEmail);
      if (emailUser) {
        if (!emailVerified) {
          this.logger.warn(`OAuth login refused: ${normalizedEmail} is not verified by the provider`);
          throw new BadRequestException(UNVERIFIED_EMAIL_MESSAGE);
        }
        if (emailUser.oauthId) {
          this.logger.debug('OAuth login conflict: email already linked to different account');
          throw new BadRequestException('OAuth authentication failed');
        }
        user = await this.userRepository.update(emailUser.id, { oauthId: profile.sub });
      }
    }

    const role = this.getRoleClaim(profile, roleClaim);
    const isAdmin = role === 'admin';

    if (user && role && isAdmin !== user.isAdmin) {
      user = await this.userRepository.update(user.id, { isAdmin });
    }

    // register new user
    if (!user) {
      if (!autoRegister) {
        this.logger.warn(
          `Unable to register ${profile.sub}/${normalizedEmail || '(no email)'}. User does not exist and auto registering is disabled. To enable set OAuth Auto Register to true in admin settings.`,
        );
        throw new BadRequestException('OAuth authentication failed');
      }

      if (!normalizedEmail) {
        throw new BadRequestException('OAuth profile does not have an email address');
      }

      if (!emailVerified) {
        this.logger.warn(`OAuth registration refused: ${normalizedEmail} is not verified by the provider`);
        throw new BadRequestException(UNVERIFIED_EMAIL_MESSAGE);
      }

      this.logger.log(`Registering new user: ${profile.sub}/${normalizedEmail}`);

      const storageLabel = this.getClaim(profile, {
        key: storageLabelClaim,
        default: '',
        isValid: (value: unknown): value is string => typeof value === 'string',
      });
      const storageQuota = this.getClaim(profile, {
        key: storageQuotaClaim,
        default: defaultStorageQuota,
        isValid: (value: unknown) => Number(value) >= 0,
      });

      user = await this.createUser({
        name:
          profile.name ||
          `${profile.given_name || ''} ${profile.family_name || ''}`.trim() ||
          profile.preferred_username ||
          normalizedEmail,
        email: normalizedEmail,
        oauthId: profile.sub,
        quotaSizeInBytes: storageQuota === null ? null : storageQuota * HumanReadableSize.GiB,
        storageLabel: storageLabel || null,
        isAdmin,
      });
    }

    if (!user.profileImagePath && profile.picture) {
      await this.syncProfilePicture(user, profile.picture);
    }

    return this.createLoginResponse(user, loginDetails, oauthSid, oauthBearerToken);
  }

  private async syncProfilePicture(user: UserAdmin, url: string) {
    try {
      const oldPath = user.profileImagePath;
      const data = await this.oauthRepository.getProfilePicture(url);

      const config = await this.getConfig({ withCache: true });
      const profileImagePath = await generateProfileImage(
        { media: this.mediaRepository, crypto: this.cryptoRepository, storageCore: this.storageCore },
        config,
        user.id,
        Buffer.from(data),
      );

      // a picture from the identity provider is not copied from a photo (FL-53)
      await this.userRepository.update(user.id, {
        profileImagePath,
        profileImageAssetId: null,
        profileChangedAt: new Date(),
      });

      if (oldPath) {
        await this.jobRepository.queue({ name: JobName.FileDelete, data: { files: [oldPath] } });
      }
    } catch (error: Error | any) {
      this.logger.warn(`Unable to sync oauth profile picture: ${error}\n${error?.stack}`);
    }
  }

  async link(auth: AuthDto, dto: OAuthCallbackDto, headers: IncomingHttpHeaders): Promise<UserAdminResponseDto> {
    const expectedState = dto.state ?? this.getCookieOauthState(headers);
    if (!expectedState?.length) {
      throw new BadRequestException('OAuth state is missing');
    }

    const codeVerifier = dto.codeVerifier ?? this.getCookieCodeVerifier(headers);
    if (!codeVerifier?.length) {
      throw new BadRequestException('OAuth code verifier is missing');
    }

    const { oauth } = await this.getConfig({ withCache: false });
    const {
      profile: { sub: oauthId },
      sid,
      idToken,
    } = await this.oauthRepository.getProfileAndOAuthSid(oauth, dto.url, expectedState, codeVerifier);
    const duplicate = await this.userRepository.getByOAuthId(oauthId);
    if (duplicate && duplicate.id !== auth.user.id) {
      this.logger.warn(`OAuth link account failed: sub is already linked to another user (${duplicate.email}).`);
      throw new BadRequestException('This OAuth account has already been linked to another user.');
    }

    if (auth.session && (sid || idToken)) {
      await this.sessionRepository.update(auth.session.id, {
        oauthSid: sid,
        oauthBearerToken: idToken,
      });
    }

    const user = await this.userRepository.update(auth.user.id, { oauthId });
    return mapUserAdmin(user);
  }

  async unlink(auth: AuthDto): Promise<UserAdminResponseDto> {
    if (auth.session) {
      await this.sessionRepository.update(auth.session.id, { oauthSid: null, oauthBearerToken: null });
    }

    const user = await this.userRepository.update(auth.user.id, { oauthId: null });
    return mapUserAdmin(user);
  }

  private async getLogoutEndpoint(authType: AuthType, oauthBearerToken?: string | null): Promise<string> {
    if (authType !== AuthType.OAuth) {
      return LOGIN_URL;
    }

    const config = await this.getConfig({ withCache: false });
    if (!config.oauth.enabled) {
      return LOGIN_URL;
    }

    const endSessionEndpoint =
      config.oauth.endSessionEndpoint || (await this.oauthRepository.getLogoutEndpoint(config.oauth));

    if (!endSessionEndpoint) {
      return LOGIN_URL;
    }

    const url = new URL(endSessionEndpoint);

    if (oauthBearerToken) {
      url.searchParams.set('id_token_hint', oauthBearerToken);
    }

    return url.href;
  }

  private getBearerToken(headers: IncomingHttpHeaders): string | null {
    const [type, token] = (headers.authorization || '').split(' ', 2);
    if (type.toLowerCase() === 'bearer') {
      return token;
    }

    return null;
  }

  private getCookieToken(headers: IncomingHttpHeaders): string | null {
    const cookies = parse(headers.cookie || '');
    return cookies[ImmichCookie.AccessToken] || null;
  }

  private getCookieOauthState(headers: IncomingHttpHeaders): string | null {
    const cookies = parse(headers.cookie || '');
    return cookies[ImmichCookie.OAuthState] || null;
  }

  private getCookieCodeVerifier(headers: IncomingHttpHeaders): string | null {
    const cookies = parse(headers.cookie || '');
    return cookies[ImmichCookie.OAuthCodeVerifier] || null;
  }

  async validateSharedLinkKey(key: string | string[]): Promise<AuthDto> {
    key = Array.isArray(key) ? key[0] : key;

    const bytes = Buffer.from(key, key.length === 100 ? 'hex' : 'base64url');
    const sharedLink = await this.sharedLinkRepository.getByKey(bytes);
    if (!this.isValidSharedLink(sharedLink)) {
      throw this.invalidSharedLink(sharedLink, 'Invalid share key');
    }

    return { user: sharedLink.user, sharedLink };
  }

  async validateSharedLinkSlug(slug: string | string[]): Promise<AuthDto> {
    slug = Array.isArray(slug) ? slug[0] : slug;

    const sharedLink = await this.sharedLinkRepository.getBySlug(slug);
    if (!this.isValidSharedLink(sharedLink)) {
      throw this.invalidSharedLink(sharedLink, 'Invalid share slug');
    }

    return { user: sharedLink.user, sharedLink };
  }

  /**
   * The same 401 and message for every unusable link, as official clients expect. A link that only
   * ran out of time also says so (`reason: 'expired'`), so the public viewer can show the prototype's
   * expired state instead of "not available"; nothing about the link or its owner is included.
   */
  private invalidSharedLink(sharedLink: (AuthSharedLink & { user: AuthUser | null }) | undefined, message: string) {
    const expired = !!sharedLink?.user && !!sharedLink.expiresAt && new Date(sharedLink.expiresAt) <= new Date();
    return expired
      ? new UnauthorizedException({ message, error: 'Unauthorized', statusCode: 401, reason: 'expired' })
      : new UnauthorizedException(message);
  }

  private isValidSharedLink(
    sharedLink?: AuthSharedLink & { user: AuthUser | null },
  ): sharedLink is AuthSharedLink & { user: AuthUser } {
    return !!sharedLink?.user && (!sharedLink.expiresAt || new Date(sharedLink.expiresAt) > new Date());
  }

  private async validateApiKey(key: string): Promise<AuthDto> {
    const hashed = this.cryptoRepository.hashSha256(key);
    const apiKey = await this.apiKeyRepository.getKey(hashed);
    if (apiKey?.user) {
      return {
        user: apiKey.user,
        apiKey,
      };
    }

    throw new UnauthorizedException('Invalid API key');
  }

  private validateSecret(inputSecret: string, existingHash?: string | null): boolean {
    if (!existingHash) {
      return false;
    }

    return this.cryptoRepository.compareBcrypt(inputSecret, existingHash);
  }

  private async validateSession(
    token: string,
    headers: IncomingHttpHeaders,
    refreshElevation = true,
  ): Promise<AuthDto> {
    const hashed = this.cryptoRepository.hashSha256(token);
    const session = await this.sessionRepository.getByToken(hashed);
    if (session?.user) {
      const { appVersion, deviceOS, deviceType } = getUserAgentDetails(headers);
      const now = DateTime.now();
      const updatedAt = DateTime.fromJSDate(session.updatedAt);
      const diff = now.diff(updatedAt, ['hours']);
      if (diff.hours > 1 || appVersion !== session.appVersion) {
        await this.sessionRepository.update(session.id, {
          id: session.id,
          updatedAt: new Date(),
          appVersion,
          deviceOS,
          deviceType,
        });
      }

      // Pin check
      let hasElevatedPermission = false;

      if (session.pinExpiresAt) {
        const pinExpiresAt = DateTime.fromJSDate(session.pinExpiresAt);
        hasElevatedPermission = pinExpiresAt > now;

        if (
          refreshElevation &&
          hasElevatedPermission &&
          now.plus({ minutes: ELEVATED_SESSION_REFRESH_THRESHOLD_MINUTES }) > pinExpiresAt
        ) {
          // FL-34: conditional, so a lock that lands after the read above is never reversed; if the
          // refresh finds the session locked, this request is not elevated either
          hasElevatedPermission = await this.sessionRepository.refreshPinExpiry(
            session.id,
            DateTime.now().plus({ minutes: ELEVATED_SESSION_DURATION_MINUTES }).toJSDate(),
          );
          if (!hasElevatedPermission) {
            // A concurrent lock leaves a valid ordinary session, but a concurrent revocation or expiry
            // must reject the request instead of granting ordinary access from the stale read above.
            const current = await this.sessionRepository.getByToken(hashed);
            if (!current?.user) {
              throw new UnauthorizedException('Invalid user token');
            }
          }
        }
      }

      return {
        user: session.user,
        session: {
          id: session.id,
          hasElevatedPermission,
        },
      };
    }

    throw new UnauthorizedException('Invalid user token');
  }

  async unlockSession(auth: AuthDto, dto: SessionUnlockDto): Promise<void> {
    if (!auth.session) {
      throw new BadRequestException('This endpoint can only be used with a session token');
    }

    // Throttle PIN brute-force per user (security.md M5).
    const now = Date.now();
    const state = pinAttemptsByUser.get(auth.user.id);
    if (state && state.lockedUntil > now) {
      const retryAfterSec = Math.ceil((state.lockedUntil - now) / 1000);
      throw new UnauthorizedException(`Too many failed PIN attempts. Try again in ${retryAfterSec} seconds.`);
    }

    const user = await this.userRepository.getForPinCode(auth.user.id);
    try {
      this.validatePinCode(user, { pinCode: dto.pinCode });
    } catch (error) {
      // Record failure and apply backoff. Failures expire after a quiet window.
      const prev =
        state && now - state.lastFailureAt < PIN_FAILURE_RESET_MS
          ? state
          : { failureCount: 0, lastFailureAt: 0, lockedUntil: 0 };
      const failureCount = prev.failureCount + 1;
      const lockoutMs = lookupPinLockoutMs(failureCount);
      pinAttemptsByUser.set(auth.user.id, {
        failureCount,
        lastFailureAt: now,
        lockedUntil: lockoutMs > 0 ? now + lockoutMs : 0,
      });
      throw error;
    }

    // Successful unlock — reset the per-user counter.
    pinAttemptsByUser.delete(auth.user.id);

    // FL-34: conditional on the credentials just checked, so a PIN or password change that lands
    // in between (and locked every session) is not undone by this unlock
    const elevated = await this.sessionRepository.elevate(
      auth.session.id,
      auth.user.id,
      user,
      DateTime.now().plus({ minutes: ELEVATED_SESSION_DURATION_MINUTES }).toJSDate(),
    );
    if (!elevated) {
      throw new UnauthorizedException('Your PIN or password changed; unlock again');
    }
  }

  async lockSession(auth: AuthDto): Promise<void> {
    if (!auth.session) {
      throw new BadRequestException('This endpoint can only be used with a session token');
    }

    await this.sessionRepository.update(auth.session.id, { pinExpiresAt: null });
    // FL-34: only once the lock is stored; the session's other tabs drop what it unlocked
    this.websocketRepository.clientSend('on_session_lock', auth.session.id);
  }

  private async createLoginResponse(
    user: UserAdmin,
    loginDetails: LoginDetails,
    oauthSid?: string,
    oauthBearerToken?: string,
  ) {
    const { response } = await createSession(
      { sessionRepository: this.sessionRepository, cryptoRepository: this.cryptoRepository },
      user,
      loginDetails,
      { sid: oauthSid, bearerToken: oauthBearerToken },
    );
    return response;
  }

  private getClaim<T>(profile: OAuthProfile, options: ClaimOptions<T>): T {
    const value = profile[options.key as keyof OAuthProfile];
    return options.isValid(value) ? (value as T) : options.default;
  }

  private getRoleClaim(profile: OAuthProfile, roleClaim: string): 'admin' | 'user' | undefined {
    const value = profile[roleClaim as keyof OAuthProfile];
    const roles = Array.isArray(value) ? value : [value];
    const isRole = (role: string) => roles.includes(role);

    if (isRole('admin')) {
      return 'admin';
    }
    if (isRole('user')) {
      return 'user';
    }
  }

  private resolveRedirectUri(
    { mobileRedirectUri, mobileOverrideEnabled }: { mobileRedirectUri: string; mobileOverrideEnabled: boolean },
    url: string,
  ) {
    if (mobileOverrideEnabled && mobileRedirectUri) {
      return url
        .replace(/app\.immich:\/+oauth-callback/, () => mobileRedirectUri)
        .replace(FRAMELEAF_CALLBACK, () => frameleafRedirectUri(mobileRedirectUri));
    }
    return url;
  }

  async getAuthStatus(auth: AuthDto): Promise<AuthStatusResponseDto> {
    const user = await this.userRepository.getForPinCode(auth.user.id);
    if (!user) {
      throw new UnauthorizedException();
    }

    const session = auth.session ? await this.sessionRepository.get(auth.session.id) : undefined;

    return {
      pinCode: !!user.pinCode,
      password: !!user.password,
      isElevated: !!auth.session?.hasElevatedPermission,
      expiresAt: session?.expiresAt?.toISOString(),
      pinExpiresAt: session?.pinExpiresAt?.toISOString(),
    };
  }
}
