import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { parseCookie as parse } from 'cookie';
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
import { AuthSession, AuthSharedLink, AuthUser, UserAdmin } from 'src/database.js';
import {
  AuthDto,
  AuthOAuthApp,
  AuthStatusResponseDto,
  ChangePasswordDto,
  LoginCredentialDto,
  LoginResponseDto,
  LoginTwoFactorDto,
  LogoutResponseDto,
  OAuthBackchannelLogoutDto,
  OAuthCallbackDto,
  OAuthConfigDto,
  PasswordLinkCheckDto,
  PasswordLinkCheckResponseDto,
  PasswordLinkRedeemDto,
  PinCodeChangeDto,
  PinCodeResetDto,
  PinCodeSetupDto,
  SessionUnlockDto,
  SignUpDto,
  StepUpDto,
  TwoFactorCodeDto,
  TwoFactorPasswordDto,
  TwoFactorProofDto,
  TwoFactorRecoveryCodesResponseDto,
  TwoFactorSetupResponseDto,
  mapLoginResponse,
} from 'src/dtos/auth.dto.js';
import { UserAdminResponseDto, mapUserAdmin } from 'src/dtos/user.dto.js';
import {
  AccountEventAction,
  AdminAuditAction,
  AuthCookie,
  AuthType,
  DatabaseLock,
  JobName,
  Permission,
  RequestHeader,
  RequestQuery,
  SystemMetadataKey,
} from 'src/enum.js';
import { toAccountEventVia, toIpPrefix } from 'src/repositories/account-event.repository.js';
import { OAuthProfile } from 'src/repositories/oauth.repository.js';
import { PasskeyRepository } from 'src/repositories/passkey.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { LockedEncryptionService } from 'src/services/locked-encryption.service.js';
import { OAuthAppService } from 'src/services/oauth-app.service.js';
import { SignInSecurityService } from 'src/services/sign-in-security.service.js';
import { isGranted } from 'src/utils/access.js';
import { DecimalSize } from 'src/utils/bytes.js';
import { CONFIRMATION_REQUIRED, sessionIsConfirmedRecently } from 'src/utils/confirmed-recently.js';
import { identityDirectory, readCloudLink } from 'src/utils/frameleaf-cloud-gateway.js';
import { mailSealKey, openMailSecret, sealMailSecret } from 'src/utils/frameleaf-mail.js';
import { type SetupClient, whileClaimable } from 'src/utils/frameleaf-setup-gate.js';
import {
  FRAMELEAF_EXCHANGE_CLOCK_TOLERANCE_SECONDS,
  FRAMELEAF_EXCHANGE_TOKEN_MAX_AGE_SECONDS,
  type FrameleafVia,
  claimsFrameleafVia,
  frameleafLogoutUrl,
  frameleafOAuthConfig,
  frameleafVia,
  isRemoteVia,
  logoutTokenAudiences,
} from 'src/utils/frameleaf-sign-in.js';
import { HiddenContentFilter, hasHiddenContentFilter } from 'src/utils/hidden-content.js';
import { lockedKeys } from 'src/utils/locked-key-holder.js';
import { MCP_PATH, isOAuthAccessToken } from 'src/utils/oauth-apps.js';
import { getPreferences, relockMinutesOf } from 'src/utils/preferences.js';
import { generateProfileImage } from 'src/utils/profile-image.js';
import { getUserAgentDetails } from 'src/utils/request.js';
import { checkSecret } from 'src/utils/secret-attempts.js';
import { VERIFICATION_CAPABILITY, createSession, withCapabilities } from 'src/utils/session.js';
import { requireSharedLinkUnlocked } from 'src/utils/shared-link.js';
import { DEFAULT_SIGN_IN_REQUIREMENT, evaluateSession } from 'src/utils/sign-in-policy.js';
import {
  type ServerMac,
  TWO_FACTOR_CHALLENGE_SECONDS,
  TWO_FACTOR_TRUST_DAYS,
  hashRecoveryCode,
  matchTotp,
  newRecoveryCodes,
  newTotpSecret,
  otpauthUri,
  peekToken,
  signToken,
  verifyToken,
} from 'src/utils/two-factor.js';
import {
  VERIFICATION_TRANSACTION_SECONDS,
  type VerificationMethod,
  twoFactorSetupRequired,
  verificationRequired,
} from 'src/utils/verification-required.js';
import { allowedOrigins, requestHosts, websocketOriginAllowed } from 'src/utils/websocket-origin.js';

const UUID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const TWO_FACTOR_WRONG_CODE = 'That code didn’t work. Check your authenticator app and try again.';
const TWO_FACTOR_WRONG_RECOVERY_CODE = 'That recovery code didn’t work, or it was already used.';
const TWO_FACTOR_EXPIRED = 'This sign-in expired. Enter your password again.';

type TwoFactorChallenge = { sub: string; rem: boolean; exp: number };
type TwoFactorTrust = { sub: string; en: number; exp: number };
const epochSeconds = (date: Date) => Math.floor(date.getTime() / 1000);
/** Exactly one of an authenticator code or a recovery code. */
const requireOneSecondFactor = (dto: { code?: string; recoveryCode?: string }) => {
  if (Boolean(dto.code) === Boolean(dto.recoveryCode)) {
    throw new BadRequestException('Enter either the code from your authenticator app or a recovery code');
  }
};

export interface LoginDetails {
  isSecure: boolean;
  clientIp: string;
  securityClientIp?: string;
  deviceType: string;
  deviceOS: string;
  browserFamily?: string;
  deviceOSFamily?: string;
  appVersion: string | null;
  /** FL-161: how the request arrived, as the edge worker vouched for it (absent or null: not vouched for). */
  via?: FrameleafVia | null;
  /** Unified sign-in: what the client says it can do (`verification`), from the request header and body. */
  capabilities?: string[];
}

/** FL-808: the device, via and address prefix of a sign-in, for the account activity log. */
export const loginEventDetails = (details: LoginDetails) => ({
  deviceType: details.deviceType || null,
  deviceOS: details.deviceOS || null,
  via: toAccountEventVia(details.via),
  ipPrefix: toIpPrefix(details.securityClientIp ?? details.clientIp),
});

/** FL-808: how a session was started, the `signed-in` detail. */
type SignInMethod = 'password' | 'two-factor' | 'oauth';

interface ClaimOptions<T> {
  key: string;
  default: T;
  isValid: (value: unknown) => boolean;
}

const ELEVATED_SESSION_DURATION_MINUTES = 60;
const ELEVATED_SESSION_REFRESH_THRESHOLD_MINUTES = 5;

/** FL-367: API key uses recorded by this process, so "last used" is written at most every few minutes. */
const API_KEY_USE_INTERVAL_MS = 5 * 60 * 1000;
const apiKeyUseRecorded = new Map<string, number>();

export type ValidateRequest = {
  headers: IncomingHttpHeaders;
  queryParams: Record<string, string>;
  metadata: {
    sharedLinkRoute: boolean;
    /** Only the landing challenge and password login may skip the shared-link unlock cookie. */
    sharedLinkPassword?: boolean;
    adminRoute: boolean;
    /** `false` explicitly means no permission is required, which otherwise defaults to `all` */
    permission?: Permission | false;
    uri: string;
    /** FL-34: `false` leaves an elevated session's PIN expiry as it is (a status read). */
    refreshElevation?: boolean;
    /** FL-161: how the request arrived; `relay` and `wan` require a Frameleaf sign-in. */
    via?: FrameleafVia | null;
    /** FL-161: signing out, which any valid session may do through remote access. */
    remoteSignInExempt?: boolean;
  };
};

/** FL-161: the error code of a remote-access request that is not signed in with Frameleaf. */
export const FRAMELEAF_SIGN_IN_REQUIRED = 'frameleaf_sign_in_required';
export const FRAMELEAF_SIGN_IN_REQUIRED_MESSAGE =
  'Away from home, sign in with your Frameleaf account to use this server';
/** FL-793: a password sign-in from a client that cannot show the two-step code step. */
export const TWO_FACTOR_REQUIRED = 'two_factor_required';
export const TWO_FACTOR_REQUIRED_MESSAGE =
  'This account uses two-step sign-in. Update the Frameleaf app, or sign in with your Frameleaf account.';
/** FL-161: the error code of an original, archive or database backup refused over the relay. */
export const RELAY_ORIGINALS_REFUSED = 'frameleaf_relay_originals_refused';
export const RELAY_ORIGINALS_REFUSED_MESSAGE =
  'Originals, archives and database backups are not available through the Frameleaf relay. Download them at home, or ask your administrator to allow them.';

const frameleafSignInRequired = () =>
  new ForbiddenException({
    message: FRAMELEAF_SIGN_IN_REQUIRED_MESSAGE,
    error: 'Forbidden',
    statusCode: 403,
    code: FRAMELEAF_SIGN_IN_REQUIRED,
  });

/** The state a `verification_required` transaction stands for (signed, 10 minutes). */
type VerificationTransaction = { k: 'session'; sid: string; sub: string; exp: number };

/** Routes a person needs to set up their authenticator, open to a session that must set it up first. */
const SETUP_ROUTES = /\/auth\/(two-factor|status|logout)/;

const FRAMELEAF_CALLBACK = /frameleaf-auth:\/+oauth-callback/;

/** FL-158: the refusal for an email the identity provider has not verified (every provider). */
export const UNVERIFIED_EMAIL_MESSAGE =
  'This email address has not been verified by the sign-in provider, so it cannot be used to sign in here';
/** FL-158: the refusal when the provider sends no `email_verified` claim at all. */
export const MISSING_EMAIL_VERIFIED_MESSAGE =
  'The sign-in provider did not say whether this email address is verified, so it cannot be used to find or create an account here. Ask your administrator to map the email_verified claim in the provider.';

/**
 * FL-158: whether the provider verified the profile's email. `true` and the string `"true"` (some
 * providers send claims as strings) count; anything else, including a missing claim, does not.
 * Returns the refusal to give, or null when the email may be used.
 */
export const emailVerificationProblem = (profile: { email_verified?: unknown }): string | null => {
  const value = profile.email_verified;
  if (value === true || value === 'true') {
    return null;
  }
  return value === undefined || value === null ? MISSING_EMAIL_VERIFIED_MESSAGE : UNVERIFIED_EMAIL_MESSAGE;
};
const LEGACY_MOBILE_REDIRECT_PATH = /\/oauth\/mobile-redirect\/?$/;

/**
 * The HTTP address that forwards an OAuth callback to the Frameleaf app when the mobile redirect
 * override is on (FL-131), for identity providers that only accept `https` callbacks.
 *
 * The documented override is this server's `…/oauth/frameleaf-mobile-redirect`, used as is. An older
 * `…/oauth/mobile-redirect` override still maps to its `frameleaf-mobile-redirect` sibling on the same
 * server. Any other address may not be this server at all, so the Frameleaf callback is refused with
 * setup guidance instead of being sent somewhere else.
 */
const frameleafRedirectUri = (mobileRedirectUri: string): string => {
  let url: URL | undefined;
  try {
    url = new URL(mobileRedirectUri);
  } catch {
    url = undefined;
  }
  if (url && url.pathname.replace(/\/$/, '').endsWith(FRAMELEAF_MOBILE_REDIRECT_PATH)) {
    // The override already is this server's Frameleaf forwarder (the documented setup).
    url.search = '';
    url.hash = '';
    return url.href;
  }
  if (!url || !LEGACY_MOBILE_REDIRECT_PATH.test(url.pathname)) {
    throw new BadRequestException(
      "Frameleaf app sign-in needs the mobile redirect override to be this server's " +
        '/api/oauth/frameleaf-mobile-redirect address, registered as a redirect URI with the identity provider',
    );
  }
  url.pathname = url.pathname.replace(LEGACY_MOBILE_REDIRECT_PATH, () => FRAMELEAF_MOBILE_REDIRECT_PATH);
  url.search = '';
  url.hash = '';
  return url.href;
};

@Injectable()
export class AuthService extends BaseService {
  @Inject(SignInSecurityService)
  private signInSecurity!: SignInSecurityService;

  /** FL-836: whether a session was started with a passkey (accepted through remote access). */
  @Inject(PasskeyRepository)
  private passkeyRepository!: PasskeyRepository;

  /** FL-721: the Locked encryption PIN hooks (spec §4.1, §4.3, §7.5). */
  @Inject(LockedEncryptionService)
  private lockedEncryption!: LockedEncryptionService;

  /** FL-803: connected apps' access tokens (`Authorization: Bearer fla_…`). */
  @Inject(OAuthAppService)
  private oauthApps!: OAuthAppService;

  /**
   * `trustToken` is the browser's "Trust this browser" cookie (FL-793). For an account with two-step
   * sign-in the response then carries `twoFactorRequired` and no session, unless the browser is trusted.
   */
  async login(dto: LoginCredentialDto, loginDetails: LoginDetails, trustToken?: string): Promise<LoginResponseDto> {
    const details = withCapabilities(loginDetails, dto.capabilities);
    await this.requirePasswordLogin(details);

    const { user, password } = await this.signInSecurity.attempt('password', dto.email, details, async (backoff) => {
      const user = await this.userRepository.getByEmail(dto.email, { withPassword: true });
      // Always run bcrypt so response time is constant regardless of whether the email is registered.
      const isAuthenticated = await this.cryptoRepository.compareBcrypt(
        dto.password,
        user?.password ?? LOGIN_DUMMY_HASH,
      );
      if (!user || !user.password || !isAuthenticated || user.importClaimPending) {
        await this.signInSecurity.failed(backoff, user?.importClaimPending ? undefined : user);
        this.logger.warn(`Failed login attempt for user ${dto.email} from ip address ${details.clientIp}`);
        if (user) {
          // Keep known- and unknown-account failure responses on the same timing path.
          void this.recordAccountEvent({
            userId: user.id,
            action: AccountEventAction.SignInFailed,
            subject: user.name,
            detail: 'password',
            ...loginEventDetails(details),
          });
        }
        throw new UnauthorizedException('Incorrect email or password');
      }

      await this.signInSecurity.succeeded(backoff);
      return { user, password: user.password };
    });
    const twoFactor = await this.userRepository.getTwoFactor(user.id);
    if (isRemoteVia(details.via) && !(await this.isLegacyClient(details)) && !twoFactor?.enabledAt) {
      // away from home a capable client's password counts only together with the authenticator
      this.logger.warn(`Refused a password sign-in without two-step over remote access (${details.via})`);
      throw frameleafSignInRequired();
    }
    if (twoFactor?.enabledAt && !(await this.isTrustedBrowser(user.id, password, twoFactor.enabledAt, trustToken))) {
      // FL-793: a client that can't show the code step gets a clear refusal, never an empty session
      // (403, not 401: today's apps read 401 as a wrong password)
      if (!dto.twoFactor && !dto.steps) {
        throw new ForbiddenException({
          message: TWO_FACTOR_REQUIRED_MESSAGE,
          error: 'Forbidden',
          statusCode: 403,
          code: TWO_FACTOR_REQUIRED,
        });
      }
      const challenge: TwoFactorChallenge = {
        sub: user.id,
        rem: dto.rememberMe ?? true,
        exp: epochSeconds(new Date()) + TWO_FACTOR_CHALLENGE_SECONDS,
      };
      // FL-793: no session yet, until the code step
      const twoFactorToken = await signToken(this.twoFactorMac('challenge'), challenge, password);
      return {
        ...mapLoginResponse(user, ''),
        twoFactorRequired: true,
        twoFactorToken,
        // Contract B: the same two-factor token is the transaction
        ...(dto.steps && {
          status: 'next' as const,
          transaction: twoFactorToken,
          methods: ['totp', 'recovery_code' as const],
        }),
      };
    }

    // the 30-day trusted-browser cookie counts as password plus authenticator (spec: Verified)
    const methods = twoFactor?.enabledAt ? ['pwd', 'totp'] : ['pwd'];
    const response = await this.createLoginResponse(user, details, { passwordHash: password }, 'password', methods);
    return dto.steps ? { ...response, status: 'done' as const } : response;
  }

  /**
   * Unified sign-in: proof of the local password and/or authenticator for a Frameleaf sign-in that needs it
   * (first link by email match; a local authenticator after a Basic Frameleaf sign-in). Wrong answers count
   * against the usual sign-in limits (401). Returns the methods proved, as `amr` names, and the password hash
   * that was checked (so a session can be fenced against a password change).
   */
  async verifyLocalProof(
    user: { id: string; name: string; email: string },
    proof: { password?: string; code?: string; recoveryCode?: string },
    details: LoginDetails,
    need: { password: boolean; authenticator: boolean },
  ): Promise<{ methods: string[]; passwordHash?: string }> {
    if (need.authenticator) {
      requireOneSecondFactor(proof);
    }
    const now = new Date();
    const proved: string[] = [];
    let passwordHash: string | undefined;
    const twoFactor = await this.userRepository.getTwoFactor(user.id);
    const ok = await this.signInSecurity.attempt('two-factor', user.id, details, async (backoff) => {
      proved.length = 0;
      if (need.password) {
        const { password } = await this.userRepository.getForChangePassword(user.id);
        if (!password || !proof.password || !(await this.cryptoRepository.compareBcrypt(proof.password, password))) {
          await this.signInSecurity.failed(backoff, user as never);
          return false;
        }
        proved.push('pwd');
        passwordHash = password;
      }
      if (need.authenticator) {
        if (!twoFactor?.enabledAt || !(await this.checkSecondFactor(user.id, twoFactor.secret, proof, now))) {
          await this.signInSecurity.failed(backoff, user as never);
          return false;
        }
        proved.push(proof.recoveryCode ? 'recovery_code' : 'totp');
      }
      await this.signInSecurity.succeeded(backoff);
      return true;
    });
    if (!ok) {
      throw new UnauthorizedException(
        need.authenticator && !need.password
          ? proof.code
            ? TWO_FACTOR_WRONG_CODE
            : TWO_FACTOR_WRONG_RECOVERY_CODE
          : 'That didn’t work. Check your password and your authenticator code and try again.',
      );
    }
    return { methods: proved, passwordHash };
  }

  /**
   * Unified sign-in "confirmed recently" for the actions that had no check before (restore from a backup,
   * removing a person): a recent Frameleaf or passkey sign-in, or the password (and authenticator code) typed
   * now. A session that is legacy keeps today's rights until "Apply to older apps too".
   */
  async requireConfirmedRecently(
    auth: AuthDto,
    proof: { password?: string; code?: string; recoveryCode?: string } | undefined,
    details: LoginDetails,
  ): Promise<void> {
    if (!auth.session) {
      return;
    }
    const signIn = auth.session.signIn;
    const { signInPolicy } = await this.getConfig({ withCache: true });
    if (!signIn || (signIn.legacy && !signInPolicy.applyToOlderApps)) {
      return;
    }
    if (await sessionIsConfirmedRecently(auth.session, (id) => this.frameleafAccountRepository.getSession(id))) {
      return;
    }
    const enrolled = !!(await this.userRepository.getTwoFactor(auth.user.id))?.enabledAt;
    if (proof?.password === undefined || (enrolled && !proof.code && !proof.recoveryCode)) {
      throw new ForbiddenException({
        message: 'Confirm it’s you: sign in again, or enter your password',
        error: 'Forbidden',
        statusCode: 403,
        code: CONFIRMATION_REQUIRED,
      });
    }
    await this.verifyLocalProof(auth.user, proof, details, { password: true, authenticator: enrolled });
  }

  /** Unified sign-in rollout: a client that does not declare `verification` keeps today's rights. */
  private async isLegacyClient(details: LoginDetails) {
    const { signInPolicy } = await this.getConfig({ withCache: true });
    return !details.capabilities?.includes(VERIFICATION_CAPABILITY) && !signInPolicy.applyToOlderApps;
  }

  private async requirePasswordLogin(details: LoginDetails) {
    const config = await this.getConfig({ withCache: false });
    if (!config.passwordLogin.enabled) {
      throw new UnauthorizedException('Password login has been disabled');
    }

    // FL-161: away from home a password is refused before any account is looked up, unless an
    // administrator allowed it
    if (isRemoteVia(details.via) && !config.frameleafCloud.remoteAccess.allowPasswordOverRelay) {
      this.logger.warn(`Refused password sign-in over remote access (${details.via}) from ${details.clientIp}`);
      throw frameleafSignInRequired();
    }
  }

  /**
   * FL-793: the code step of a password sign-in. Wrong codes answer 401 so the sign-in rate limit counts
   * them. Returns the session, whether to remember it, and a "Trust this browser" token when asked for.
   */
  async loginTwoFactor(
    dto: LoginTwoFactorDto,
    loginDetails: LoginDetails,
  ): Promise<{ response: LoginResponseDto; rememberMe: boolean; trustToken?: string }> {
    const details = withCapabilities(loginDetails, dto.capabilities);
    await this.requirePasswordLogin(details);
    requireOneSecondFactor(dto);

    const now = new Date();
    const userId = peekToken<{ sub?: unknown }>(dto.twoFactorToken)?.sub;
    const user =
      typeof userId === 'string' && UUID_PATTERN.test(userId) ? await this.userRepository.get(userId, {}) : undefined;
    const { password } = user ? await this.userRepository.getForChangePassword(user.id) : { password: null };
    const challenge =
      user && password
        ? await verifyToken<TwoFactorChallenge>(this.twoFactorMac('challenge'), dto.twoFactorToken, password, now)
        : null;
    const twoFactor = challenge ? await this.userRepository.getTwoFactor(challenge.sub) : undefined;
    if (!user || !password || !challenge || !twoFactor?.enabledAt) {
      throw new UnauthorizedException(TWO_FACTOR_EXPIRED);
    }

    const verified = await this.signInSecurity.attempt('two-factor', user.id, details, async (backoff) => {
      if (!(await this.checkSecondFactor(user.id, twoFactor.secret, dto, now))) {
        await this.signInSecurity.failed(backoff, user);
        return false;
      }
      await this.signInSecurity.succeeded(backoff);
      return true;
    });
    if (!verified) {
      this.logger.warn(`Failed two-step sign-in for user ${user.email} from ip address ${details.clientIp}`);
      await this.recordAccountEvent({
        userId: user.id,
        action: AccountEventAction.SignInFailed,
        subject: user.name,
        detail: 'two-factor',
        ...loginEventDetails(details),
      });
      throw new UnauthorizedException(dto.code ? TWO_FACTOR_WRONG_CODE : TWO_FACTOR_WRONG_RECOVERY_CODE);
    }

    const created = await this.createLoginResponse(
      user,
      details,
      { passwordHash: password },
      'two-factor',
      dto.recoveryCode ? ['pwd', 'recovery_code'] : ['pwd', 'totp'],
    );
    const response = dto.steps ? { ...created, status: 'done' as const } : created;
    const trust: TwoFactorTrust = {
      sub: user.id,
      en: twoFactor.enabledAt.getTime(),
      exp: epochSeconds(now) + TWO_FACTOR_TRUST_DAYS * 24 * 60 * 60,
    };
    const trustToken = dto.trustDevice ? await signToken(this.twoFactorMac('trust'), trust, password) : undefined;
    return { response, rememberMe: challenge.rem, trustToken };
  }

  /** FL-793: start setting up two-step sign-in; the new key is confirmed with `enableTwoFactor`. */
  async setupTwoFactor(auth: AuthDto, dto: TwoFactorPasswordDto): Promise<TwoFactorSetupResponseDto> {
    await this.requireAccountPassword(auth.user.id, dto.password, auth.session);
    const secret = newTotpSecret();
    const sealed = sealMailSecret(await this.twoFactorSealKey(), `two-factor:${auth.user.id}`, secret);
    if (!(await this.userRepository.setPendingTwoFactor(auth.user.id, sealed))) {
      throw new BadRequestException('Two-step sign-in is already on');
    }
    return { secret, otpauthUri: otpauthUri('Frameleaf', auth.user.email, secret) };
  }

  /** FL-793: confirm the authenticator with its first code; the recovery codes are returned only now. */
  async enableTwoFactor(auth: AuthDto, dto: TwoFactorCodeDto): Promise<TwoFactorRecoveryCodesResponseDto> {
    const row = await this.userRepository.getTwoFactor(auth.user.id);
    if (!row || row.enabledAt) {
      throw new BadRequestException(row ? 'Two-step sign-in is already on' : 'Start setting up two-step sign-in first');
    }
    const secret = await this.openTwoFactorSecret(auth.user.id, row.secret);
    const step = secret ? matchTotp(secret, dto.code, new Date()) : null;
    if (step === null) {
      throw new BadRequestException(TWO_FACTOR_WRONG_CODE);
    }
    const recoveryCodes = newRecoveryCodes();
    if (
      !(await this.userRepository.enableTwoFactor(
        auth.user.id,
        step,
        recoveryCodes.map((code) => hashRecoveryCode(code)),
      ))
    ) {
      throw new BadRequestException('Two-step sign-in is already on');
    }
    await this.recordTwoFactorChange(auth, 'enabled');
    return { recoveryCodes };
  }

  /** FL-808: two-step sign-in turned on, off or moved, in the account's own activity log. */
  private recordTwoFactorChange(auth: AuthDto, detail: 'enabled' | 'disabled' | 'moved') {
    return this.recordAccountEvent({
      userId: auth.user.id,
      sessionId: auth.session?.id ?? null,
      action: AccountEventAction.TwoFactorChanged,
      subject: auth.user.name,
      detail,
    });
  }

  /** FL-793: turn two-step sign-in off with the password and a code (or a recovery code). */
  async disableTwoFactor(auth: AuthDto, dto: TwoFactorProofDto): Promise<void> {
    await this.requireTwoFactorProof(auth.user.id, dto, auth.session);
    await this.userRepository.deleteTwoFactor(auth.user.id);
    await this.recordTwoFactorChange(auth, 'disabled');
  }

  /**
   * FL-793: start moving to a new phone with the password and a code from the old one (or a recovery code
   * when it is gone). Returns the new phone's key; the old phone keeps working until it is confirmed.
   */
  async startTwoFactorMove(auth: AuthDto, dto: TwoFactorProofDto): Promise<TwoFactorSetupResponseDto> {
    await this.requireTwoFactorProof(auth.user.id, dto, auth.session);
    const secret = newTotpSecret();
    const sealed = sealMailSecret(await this.twoFactorSealKey(), `two-factor:${auth.user.id}`, secret);
    if (!(await this.userRepository.setPendingTwoFactorMove(auth.user.id, sealed))) {
      throw new BadRequestException('Two-step sign-in is not on');
    }
    return { secret, otpauthUri: otpauthUri('Frameleaf', auth.user.email, secret) };
  }

  /**
   * FL-793: finish the move with a code from the new phone. Recovery codes and trusted browsers stay;
   * the account's history notes it as `account-updated` with detail `two-factor-moved`.
   */
  async confirmTwoFactorMove(auth: AuthDto, dto: TwoFactorCodeDto): Promise<void> {
    const row = await this.userRepository.getTwoFactor(auth.user.id);
    if (!row?.enabledAt || !row.pendingSecret) {
      throw new BadRequestException('Start moving to a new phone first');
    }
    const secret = await this.openTwoFactorSecret(auth.user.id, row.pendingSecret);
    const step = secret ? matchTotp(secret, dto.code, new Date()) : null;
    if (step === null) {
      throw new BadRequestException(TWO_FACTOR_WRONG_CODE);
    }
    if (!(await this.userRepository.confirmTwoFactorMove(auth.user.id, step, row.pendingSecret))) {
      throw new BadRequestException('The move to a new phone was started again; scan the newest code');
    }
    await this.recordAdminEvents([
      {
        userId: auth.user.id,
        actorId: auth.user.id,
        action: AdminAuditAction.AccountUpdated,
        subject: auth.user.name,
        detail: 'two-factor-moved',
      },
    ]);
    await this.recordTwoFactorChange(auth, 'moved');
  }

  /** The password, two-step sign-in on, and exactly one right second factor (a recovery code is spent). */
  private async requireTwoFactorProof(userId: string, dto: TwoFactorProofDto, session?: AuthSession) {
    await this.requireAccountPassword(userId, dto.password, session);
    const row = await this.userRepository.getTwoFactor(userId);
    if (!row?.enabledAt) {
      throw new BadRequestException('Two-step sign-in is not on');
    }
    requireOneSecondFactor(dto);
    if (!(await this.checkSecondFactor(userId, row.secret, dto, new Date()))) {
      throw new BadRequestException(dto.code ? TWO_FACTOR_WRONG_CODE : TWO_FACTOR_WRONG_RECOVERY_CODE);
    }
  }

  /** FL-793: replace every recovery code with ten new ones, shown once. */
  async regenerateRecoveryCodes(auth: AuthDto, dto: TwoFactorPasswordDto): Promise<TwoFactorRecoveryCodesResponseDto> {
    await this.requireAccountPassword(auth.user.id, dto.password, auth.session);
    const row = await this.userRepository.getTwoFactor(auth.user.id);
    if (!row?.enabledAt) {
      throw new BadRequestException('Two-step sign-in is not on');
    }
    const recoveryCodes = newRecoveryCodes();
    await this.userRepository.replaceRecoveryCodes(
      auth.user.id,
      recoveryCodes.map((code) => hashRecoveryCode(code)),
    );
    return { recoveryCodes };
  }

  /**
   * "Confirmed recently" for a two-step change: the password typed for the action, or (with none sent) a
   * Frameleaf or passkey sign-in from the last 10 minutes (`signInIsRecent`).
   */
  private async requireAccountPassword(userId: string, password: string | undefined, session?: AuthSession) {
    if (password === undefined) {
      if (await sessionIsConfirmedRecently(session, (id) => this.frameleafAccountRepository.getSession(id))) {
        return;
      }
      throw new ForbiddenException({
        message: 'Confirm it’s you: sign in again, or enter your password',
        error: 'Forbidden',
        statusCode: 403,
        code: CONFIRMATION_REQUIRED,
      });
    }
    const user = await this.userRepository.getForChangePassword(userId);
    if (!user.password) {
      throw new BadRequestException('Two-step sign-in protects signing in with a password; this account has none');
    }
    if (!(await this.validateSecret(password, user.password))) {
      throw new BadRequestException('Wrong password');
    }
  }

  /** A right authenticator code (each time step once) or an unused recovery code, which is spent. */
  private async checkSecondFactor(
    userId: string,
    sealedSecret: string,
    dto: { code?: string; recoveryCode?: string },
    now: Date,
  ): Promise<boolean> {
    if (dto.code) {
      const secret = await this.openTwoFactorSecret(userId, sealedSecret);
      const step = secret ? matchTotp(secret, dto.code, now) : null;
      return step !== null && (await this.userRepository.useTwoFactorStep(userId, step));
    }
    return (
      !!dto.recoveryCode && (await this.userRepository.useRecoveryCode(userId, hashRecoveryCode(dto.recoveryCode)))
    );
  }

  private async isTrustedBrowser(userId: string, passwordHash: string, enabledAt: Date, token?: string) {
    if (!token) {
      return false;
    }
    const trust = await verifyToken<TwoFactorTrust>(this.twoFactorMac('trust'), token, passwordHash, new Date());
    // bound to the password (in the MAC) and to this switch-on: turning it off and on again forgets every browser
    return trust?.sub === userId && trust.en === enabledAt.getTime();
  }

  /** HMACs for two-step sign-in tokens, under the server's own key file (never in the database). */
  private twoFactorMac(purpose: 'challenge' | 'trust' | 'verification'): ServerMac {
    const directory = identityDirectory(this.configRepository);
    return (value) => this.cryptoRepository.serverKeyedHash(directory, `two-factor-${purpose}`, value);
  }

  /**
   * The key authenticator secrets are sealed with, derived from the server's own key file.
   * ponytail: reuses the mail secret sealing (AES-256-GCM, record-bound); only the key purpose differs.
   */
  private async twoFactorSealKey() {
    const directory = identityDirectory(this.configRepository);
    return mailSealKey(await this.cryptoRepository.serverKeyedHash(directory, 'two-factor-secret', 'seal-key'));
  }

  private async openTwoFactorSecret(userId: string, sealed: string) {
    const secret = openMailSecret<string>(await this.twoFactorSealKey(), `two-factor:${userId}`, sealed);
    if (secret === null) {
      this.logger.error(`The two-step sign-in key of user ${userId} could not be opened; the server key file changed`);
    }
    return secret;
  }

  async logout(auth: AuthDto, authType: AuthType): Promise<LogoutResponseDto> {
    let oauthBearerToken: string | undefined;
    let frameleafRedirect: string | null = null;
    if (auth.session) {
      const session = await this.sessionRepository.get(auth.session.id);
      oauthBearerToken = session?.oauthBearerToken ?? undefined;
      // FL-177: read before the session goes, while its Sign in with Frameleaf tag still exists
      frameleafRedirect = await this.frameleafLogoutRedirect(auth.session.id, oauthBearerToken);
      await this.sessionRepository.delete(auth.session.id);
      await this.eventRepository.emit('SessionDelete', { sessionId: auth.session.id });
      await this.recordAccountEvent({
        userId: auth.user.id,
        sessionId: auth.session.id,
        action: AccountEventAction.SignedOut,
        subject: auth.user.name,
      });
    }

    return {
      successful: true,
      redirectUri: frameleafRedirect ?? (await this.getLogoutEndpoint(authType, oauthBearerToken)),
    };
  }

  /**
   * FL-177 (as-built decision #32): a session Sign in with Frameleaf created ends at Frameleaf too,
   * through the issuer's `end_session_endpoint` (RP-initiated logout). Any other session, or a
   * Frameleaf one when the issuer cannot be reached or advertises no endpoint, signs out as before;
   * a failure here never stops the sign-out.
   */
  private async frameleafLogoutRedirect(sessionId: string, idToken: string | undefined): Promise<string | null> {
    try {
      if (!(await this.frameleafAccountRepository.getSession(sessionId))) {
        return null;
      }
      const cloudUrl = this.configRepository.getEnv().frameleafCloud.url;
      const config = await frameleafOAuthConfig(this.frameleafDeps());
      if (!cloudUrl || !config) {
        return null;
      }
      const endpoint = await this.oauthRepository.getLogoutEndpoint(config);
      return frameleafLogoutUrl(cloudUrl, endpoint, config.clientId, idToken);
    } catch (error) {
      this.logger.warn(`Could not end the Frameleaf session on sign-out: ${error}`);
      return null;
    }
  }

  private frameleafDeps() {
    return {
      configRepository: this.configRepository,
      databaseRepository: this.databaseRepository,
      systemMetadataRepository: this.systemMetadataRepository,
      instanceIdentityRepository: this.instanceIdentityRepository,
      frameleafCloudRepository: this.frameleafCloudRepository,
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
    const config = await frameleafOAuthConfig(this.frameleafDeps());
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

    // FL-230: an exchange token minted before this logout is refused for as long as it could be
    // accepted. Recorded first: an exchange that tags its session after the lookup below sees this
    // record and ends that session. When it cannot be recorded the sessions still end, and the logout
    // then fails so Frameleaf Cloud delivers it again.
    const seconds = FRAMELEAF_EXCHANGE_TOKEN_MAX_AGE_SECONDS + 2 * FRAMELEAF_EXCHANGE_CLOCK_TOLERANCE_SECONDS;
    let revocationError: unknown;
    try {
      await this.frameleafAccountRepository.revokeSignIns(
        { sid: claims.sid, sub: claims.sub },
        new Date(Date.now() + seconds * 1000),
      );
    } catch (error) {
      this.logger.error(`Could not record a Frameleaf back-channel logout for token exchange: ${error}`);
      revocationError = error;
    }

    const tagged = await this.frameleafAccountRepository.findSessions({ sid: claims.sid, sub: claims.sub });
    for (const { sessionId } of tagged) {
      await this.sessionRepository.delete(sessionId);
      await this.eventRepository.emit('SessionDelete', { sessionId });
    }
    await this.frameleafAccountRepository.deleteSessions(tagged.map(({ sessionId }) => sessionId));
    if (revocationError) {
      throw revocationError;
    }
    return true;
  }

  async changePassword(auth: AuthDto, dto: ChangePasswordDto): Promise<UserAdminResponseDto> {
    const { password, newPassword } = dto;
    const user = await this.userRepository.getForChangePassword(auth.user.id);
    const initial = !user.password && password === '';
    const updatedUser = initial
      ? await this.databaseRepository.withLock(DatabaseLock.FrameleafLinkAuthority, async () => {
          const owner = await this.initialPasswordOwner(auth);
          if (!owner) throw new BadRequestException('Sign in again with the Frameleaf account that owns this library');
          const hash = await this.cryptoRepository.hashBcrypt(newPassword, SALT_ROUNDS);
          const updated = await this.userRepository.setInitialLocalPassword(user.id, hash, owner);
          if (!updated) throw new ConflictException('The sign-in changed. Sign in again to continue');
          return updated;
        })
      : await this.changeExistingPassword(user, password, newPassword);

    await this.eventRepository.emit('AuthChangePassword', {
      userId: user.id,
      currentSessionId: auth.session?.id,
      invalidateSessions: dto.invalidateSessions,
    });
    await this.recordAccountEvent({
      userId: user.id,
      sessionId: auth.session?.id ?? null,
      action: AccountEventAction.PasswordChanged,
      subject: auth.user.name,
    });

    return mapUserAdmin(updatedUser);
  }

  private async changeExistingPassword(
    user: { id: string; password: string | null },
    password: string,
    newPassword: string,
  ) {
    if (!(await this.validateSecret(password, user.password))) throw new BadRequestException('Wrong password');
    return this.userRepository.update(user.id, {
      password: await this.cryptoRepository.hashBcrypt(newPassword, SALT_ROUNDS),
      shouldChangePassword: false,
    });
  }

  /** Only a fresh session tagged to the current instance owner can choose this account’s first password. */
  private async initialPasswordOwner(auth: AuthDto) {
    if (!auth.user.isAdmin || !auth.session || auth.apiKey || auth.sharedLink) return;
    const tag = await this.frameleafAccountRepository.getSession(auth.session.id);
    const notBefore = new Date(Date.now() - 10 * 60_000);
    if (!tag || tag.userId !== auth.user.id || tag.createdAt < notBefore) return;
    const { link, linked } = await readCloudLink({
      configRepository: this.configRepository,
      systemMetadataRepository: this.systemMetadataRepository,
    });
    if (linked && link?.accountId === tag.sub) return { sessionId: auth.session.id, subject: tag.sub, notBefore };
  }

  /** FL-538: who an emailed "choose a password" link is for, while it can still be used. */
  async checkPasswordLink(dto: PasswordLinkCheckDto): Promise<PasswordLinkCheckResponseDto> {
    const user = await this.userRepository.getByPasswordLink(this.cryptoRepository.hashSha256(dto.token));
    if (!user) {
      throw new BadRequestException('This link has expired or was already used');
    }
    return { name: user.name, email: user.email };
  }

  /**
   * FL-538: choose a password with an emailed link. The link works once; every session the account
   * had is signed out, as after any password change.
   */
  async redeemPasswordLink(dto: PasswordLinkRedeemDto): Promise<void> {
    const hash = this.cryptoRepository.hashSha256(dto.token);
    const account = await this.userRepository.getByPasswordLink(hash);
    if (!account) {
      throw new BadRequestException('This link has expired or was already used');
    }
    const hashedPassword = await this.cryptoRepository.hashBcrypt(dto.newPassword, SALT_ROUNDS);
    const user = account.importClaimPending
      ? await this.userRepository.redeemImportedAccountClaim(hash, hashedPassword)
      : await this.userRepository.redeemPasswordLink(hash, hashedPassword);
    if (!user) {
      throw new BadRequestException('This link has expired or was already used');
    }
    await this.eventRepository.emit('AuthChangePassword', { userId: user.id, invalidateSessions: true });
    await this.recordAccountEvent({
      userId: user.id,
      action: AccountEventAction.PasswordChanged,
      subject: account.name,
      detail: 'link',
    });
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
    // FL-721 (spec §4.1): everyone with a Locked PIN gets a key pair wrapped with it; one key-file
    // change at a time, from reading the file to storing the PIN
    await this.lockedEncryption.withKeyFileLock(auth.user.id, async () => {
      const undo = await this.lockedEncryption.onPinSet(auth.user.id, pinCode);
      await this.storePinCode(auth.user.id, user, hashed, undo);
    });
    await this.recordPinChange(auth, 'set');
  }

  /** FL-808: a PIN set, changed or reset, never its value. */
  private recordPinChange(auth: AuthDto, detail: 'set' | 'changed' | 'reset') {
    return this.recordAccountEvent({
      userId: auth.user.id,
      sessionId: auth.session?.id ?? null,
      action: AccountEventAction.PinChanged,
      subject: auth.user.name,
      detail,
    });
  }

  async resetPinCode(auth: AuthDto, dto: PinCodeResetDto) {
    // FL-721 (spec §7.5, owner): while Locked encryption is on, a forgotten PIN is reset with the recovery key
    await this.lockedEncryption.assertPinResettable(auth.user.id);
    const user = await this.validatePinCode(auth.user.id, dto);

    if (!(await this.userRepository.setPinCodeAndLockSessions(auth.user.id, user, null))) {
      throw new UnauthorizedException('Your PIN or password changed; try again');
    }
    await this.lockedEncryption.onSessionsLocked(auth.user.id);
    // FL-34: every open tab of every session of this account drops what it unlocked
    this.websocketRepository.clientSend('on_session_lock', auth.user.id);
    await this.recordPinChange(auth, 'reset');
  }

  async changePinCode(auth: AuthDto, dto: PinCodeChangeDto) {
    const user = await this.validatePinCode(auth.user.id, dto);

    const hashed = await this.cryptoRepository.hashBcrypt(dto.newPinCode, SALT_ROUNDS);
    // FL-721 (spec §7.5): in PIN mode the key file is re-wrapped with the new PIN
    await this.lockedEncryption.withKeyFileLock(auth.user.id, async () => {
      const undo = await this.lockedEncryption.onPinSet(auth.user.id, dto.newPinCode, dto.pinCode);
      await this.storePinCode(auth.user.id, user, hashed, undo);
    });
    // FL-34: an elevation granted by the old PIN ends with it, in every session of the account
    this.websocketRepository.clientSend('on_session_lock', auth.user.id);
    await this.recordPinChange(auth, 'changed');
  }

  /** Stores a PIN (locking every session); `undo` puts the Locked key file back if it isn't stored. */
  private async storePinCode(
    userId: string,
    verified: { pinCode: string | null; password: string | null },
    hashed: string,
    undo: () => Promise<void>,
  ) {
    let stored = false;
    try {
      stored = await this.userRepository.setPinCodeAndLockSessions(userId, verified, hashed);
    } finally {
      if (!stored) {
        await undo();
      }
    }
    if (!stored) {
      throw new UnauthorizedException('Your PIN or password changed; try again');
    }
    await this.lockedEncryption.onSessionsLocked(userId);
  }

  private async validatePinCode(userId: string, dto: { pinCode?: string; password?: string }) {
    // Throttle PIN brute-force per user (security.md M5); FL-721 shares it with Locked encryption.
    return checkSecret(userId, async (verify) => {
      const user = await this.userRepository.getForPinCode(userId);
      await verify(() => this.validatePinCodeSecret(user, dto));
      return user;
    });
  }

  private async validatePinCodeSecret(
    user: { pinCode: string | null; password: string | null },
    dto: { pinCode?: string; password?: string },
  ) {
    if (!user.pinCode) {
      throw new BadRequestException('User does not have a PIN code');
    }

    if (dto.password) {
      if (!(await this.validateSecret(dto.password, user.password))) {
        throw new BadRequestException('Wrong password');
      }
    } else if (dto.pinCode) {
      if (!(await this.validateSecret(dto.pinCode, user.pinCode))) {
        throw new BadRequestException('Wrong PIN code');
      }
    } else {
      throw new BadRequestException('Either password or pinCode is required');
    }
  }

  /**
   * `POST auth/admin-sign-up`: the first administrator. FL-292: only from the home network.
   */
  async adminSignUp(dto: SignUpDto, client: SetupClient): Promise<UserAdminResponseDto> {
    return whileClaimable(this.setupGate, client, async () => {
      const admin = await this.createUser({
        isAdmin: true,
        email: dto.email,
        name: dto.name,
        password: dto.password,
        // The administrator chose this password themselves: there is nothing to change at first sign-in.
        shouldChangePassword: false,
        storageLabel: 'admin',
      });
      await this.recordAdminEvents([
        {
          userId: admin.id,
          actorId: admin.id,
          action: AdminAuditAction.AccountCreated,
          subject: admin.name,
          detail: 'server-claimed:web',
        },
      ]);
      this.logger.log(`This server was set up (${client.ip}): ${admin.email} administers it`);
      return mapUserAdmin(admin);
    });
  }

  /** The narrow offline album grant never inherits a browser's PIN elevation. */
  async authorizeOfflineAlbumSession(sessionId: string, ownerId: string): Promise<AuthDto | undefined> {
    const user = await this.sessionRepository.getOfflineAlbumOwner(sessionId, ownerId);
    if (!user) return;
    const auth: AuthDto = { user, session: { id: sessionId, hasElevatedPermission: false } };
    const hiddenContent = await this.getHiddenContentFilter(auth, false);
    if (hasHiddenContentFilter(hiddenContent)) {
      auth.suppressedContent = hiddenContent;
      auth.hiddenContent = hiddenContent;
      auth.hideNsfwAssets = true;
    }
    return auth;
  }

  async authenticate({ headers, queryParams, metadata }: ValidateRequest): Promise<AuthDto> {
    const appToken = this.getBearerToken(headers);
    const authDto = isOAuthAccessToken(appToken)
      ? await this.oauthApps.validateAccessToken(appToken, metadata.via)
      : await this.validate({ headers, queryParams }, metadata.refreshElevation !== false);
    const { adminRoute, sharedLinkRoute, uri } = metadata;
    const requestedPermission = metadata.permission ?? Permission.All;

    const audience = authDto.oauthApp?.resource;
    if (audience && new URL(audience).pathname === MCP_PATH) {
      throw new UnauthorizedException('This connected app token is for the MCP endpoint');
    }

    // FL-803: a connected app reaches only routes its scopes' permissions name: never an admin
    // route, and never one that takes any signed-in caller (`permission: false`), whoever owns it.
    if (authDto.oauthApp && (adminRoute || requestedPermission === false)) {
      this.logger.warn(`Denied a connected app access to ${uri}`);
      throw new ForbiddenException('Connected apps can’t use this');
    }

    if (!metadata.remoteSignInExempt) {
      await this.applySessionPolicy(authDto, { via: metadata.via, adminRoute: !!adminRoute, uri });
    }

    if (!authDto.user.isAdmin && adminRoute) {
      this.logger.warn(`Denied access to admin only route: ${uri}`);
      throw new ForbiddenException('Forbidden');
    }

    if (authDto.sharedLink && !sharedLinkRoute) {
      this.logger.warn(`Denied access to non-shared route: ${uri}`);
      throw new ForbiddenException('Forbidden');
    }

    if (authDto.sharedLink && metadata.sharedLinkPassword !== false) {
      const tokens = parse(headers.cookie || '')[AuthCookie.SharedLinkToken]?.split(',') ?? [];
      await requireSharedLinkUnlocked(
        this.cryptoRepository,
        () => identityDirectory(this.configRepository),
        authDto.sharedLink,
        tokens,
      );
    }

    if (
      authDto.apiKey &&
      requestedPermission !== false &&
      !isGranted({ requested: [requestedPermission], current: authDto.apiKey.permissions })
    ) {
      throw new ForbiddenException(`Missing required permission: ${requestedPermission}`);
    }

    return this.applyHiddenContent(authDto);
  }

  async authenticateMcp(headers: IncomingHttpHeaders, resource: string, via: FrameleafVia | null) {
    const token = this.getBearerToken(headers);
    if (!isOAuthAccessToken(token)) {
      throw new UnauthorizedException();
    }
    return this.authorizeMcpGrant(await this.oauthApps.validateAccessToken(token, via), resource, via);
  }

  async authorizeMcpGrant(
    auth: AuthDto,
    resource: string,
    via: FrameleafVia | null,
  ): Promise<AuthDto & { oauthApp: AuthOAuthApp }> {
    const oauthApp = auth.oauthApp;
    if (oauthApp?.resource !== resource) {
      throw new UnauthorizedException();
    }
    await this.applySessionPolicy(auth, { via, adminRoute: false, uri: MCP_PATH });
    return this.applyHiddenContent({ ...auth, oauthApp });
  }

  private async applyHiddenContent<T extends AuthDto>(authDto: T): Promise<T> {
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

  /**
   * FL-161 (instance contract "Via-header contract") and unified sign-in (spec 2026-11-11): the one place a
   * request's sign-in is judged. A public shared link passes. A session is judged by `evaluateSession` against
   * how it was made (`session_sign_in`): away from home it must come from Frameleaf or a passkey (or an
   * allowed password with the authenticator), administrator routes need a Verified sign-in, and a person's
   * local authenticator is never skipped after a Basic Frameleaf sign-in. An API key passes away from home
   * only when its owner's account here is linked to a Frameleaf account. Refusals are 403
   * `frameleaf_sign_in_required` or `verification_required`; at home sessions are judged only by the rules
   * that apply there.
   */
  private async applySessionPolicy(
    auth: AuthDto,
    { via, adminRoute, uri }: { via: FrameleafVia | null | undefined; adminRoute: boolean; uri: string },
  ): Promise<void> {
    const away = isRemoteVia(via);
    if (auth.sharedLink) {
      return;
    }
    if (!auth.session) {
      if (away && !(auth.apiKey && (await this.frameleafAccountRepository.getLinkByUser(auth.user.id)))) {
        this.logger.warn(`Denied remote access (${via}) without a Frameleaf sign-in: ${uri}`);
        throw frameleafSignInRequired();
      }
      return;
    }
    let record = auth.session.signIn ?? undefined;
    // a Frameleaf sign-in counts away from home only while its live tag exists (unlinking removes the tag
    // and keeps the session)
    if (
      away &&
      record?.source === 'frameleaf' &&
      !(await this.frameleafAccountRepository.getSession(auth.session.id))
    ) {
      // nothing Cloud vouched for counts any more, a Cloud passkey included: never a local passkey
      record = { ...record, source: 'local', methods: [], level: 'basic' };
    }
    if (!away && !record) {
      // a session with no record is legacy, and a legacy session at home keeps today's rights: nothing to judge
      return;
    }
    if (away && !record) {
      // a session with no record (made outside createSession) is judged as before: legacy, by its Frameleaf tag
      // or its passkey link
      const tagged = !!(await this.frameleafAccountRepository.getSession(auth.session.id));
      const passkey = !tagged && (await this.passkeyRepository.isPasskeySession(auth.session.id));
      record = {
        source: tagged ? 'frameleaf' : 'local',
        methods: passkey ? ['passkey'] : [],
        level: passkey ? 'verified' : 'basic',
        legacy: true,
      };
    }
    const { frameleafCloud, signInPolicy } = await this.getConfig({ withCache: true });
    // the authenticator matters only for a Basic sign-in from Frameleaf, or when everyone needs two steps:
    // look it up only then
    const hasAuthenticator =
      record?.level === 'basic' && (record.source === 'frameleaf' || signInPolicy.require === 'everyone')
        ? !!(await this.userRepository.getTwoFactor(auth.user.id))?.enabledAt
        : false;
    const decision = evaluateSession({
      away,
      isAdmin: auth.user.isAdmin,
      adminRoute,
      record,
      requirement: signInPolicy.require ?? DEFAULT_SIGN_IN_REQUIREMENT,
      applyToOlderApps: !!signInPolicy.applyToOlderApps,
      allowPasswordOverRelay: frameleafCloud.remoteAccess.allowPasswordOverRelay,
      hasAuthenticator,
    });
    if (decision.ok) {
      return;
    }
    if (decision.code === 'frameleaf_sign_in_required') {
      this.logger.warn(`Denied remote access (${via}) without a Frameleaf sign-in: ${uri}`);
      throw frameleafSignInRequired();
    }
    if (decision.code === 'two_factor_setup_required') {
      if (SETUP_ROUTES.test(uri)) {
        return;
      }
      throw twoFactorSetupRequired();
    }
    throw await this.sessionVerificationRequired(auth, record?.source === 'frameleaf');
  }

  /** The `verification_required` answer for a session: Cloud's step-up, or the local authenticator code. */
  private async sessionVerificationRequired(auth: AuthDto, viaFrameleaf: boolean) {
    const twoFactor = await this.userRepository.getTwoFactor(auth.user.id);
    const methods: VerificationMethod[] = [];
    if (viaFrameleaf) methods.push('frameleaf');
    if (twoFactor?.enabledAt) methods.push('totp', 'recovery_code');
    const payload: VerificationTransaction = {
      k: 'session',
      sid: auth.session!.id,
      sub: auth.user.id,
      exp: epochSeconds(new Date()) + VERIFICATION_TRANSACTION_SECONDS,
    };
    return verificationRequired(methods, await signToken(this.twoFactorMac('verification'), payload, auth.session!.id));
  }

  /**
   * `POST auth/step-up`: answer a `verification_required` with the local authenticator (a code or a recovery
   * code). The session then counts as Verified. Cloud's own step-up is answered with a new exchange token
   * instead (`POST oauth/frameleaf/exchange`).
   */
  async stepUp(auth: AuthDto, dto: StepUpDto, loginDetails: LoginDetails): Promise<void> {
    if (!auth.session) {
      throw new BadRequestException('This endpoint can only be used with a session token');
    }
    requireOneSecondFactor(dto);
    const now = new Date();
    const transaction = await verifyToken<VerificationTransaction>(
      this.twoFactorMac('verification'),
      dto.transaction,
      auth.session.id,
      now,
    );
    const twoFactor = await this.userRepository.getTwoFactor(auth.user.id);
    if (
      transaction?.k !== 'session' ||
      transaction.sid !== auth.session.id ||
      transaction.sub !== auth.user.id ||
      !twoFactor?.enabledAt
    ) {
      throw new UnauthorizedException(TWO_FACTOR_EXPIRED);
    }
    const user = await this.userRepository.get(auth.user.id, {});
    const verified = await this.signInSecurity.attempt('two-factor', auth.user.id, loginDetails, async (backoff) => {
      if (!(await this.checkSecondFactor(auth.user.id, twoFactor.secret, dto, now))) {
        await this.signInSecurity.failed(backoff, user);
        return false;
      }
      await this.signInSecurity.succeeded(backoff);
      return true;
    });
    if (!verified) {
      throw new UnauthorizedException(dto.code ? TWO_FACTOR_WRONG_CODE : TWO_FACTOR_WRONG_RECOVERY_CODE);
    }
    await this.sessionRepository.raiseSignIn(auth.session.id, dto.recoveryCode ? 'recovery_code' : 'totp');
  }

  /**
   * FL-161: originals, archive downloads and database backups are refused over the relay unless an
   * administrator allowed them (`frameleafCloud.remoteAccess.allowOriginalsOverRelay`). Thumbnails,
   * previews and playback are not marked and keep working; direct and home connections are unchanged.
   */
  async requireOriginalTransfer(via: FrameleafVia | null | undefined, uri: string): Promise<void> {
    if (via !== 'relay') {
      return;
    }
    const config = await this.getConfig({ withCache: true });
    if (config.frameleafCloud.remoteAccess.allowOriginalsOverRelay) {
      return;
    }
    this.logger.warn(`Refused an original transfer over the relay: ${uri}`);
    throw new ForbiddenException({
      message: RELAY_ORIGINALS_REFUSED_MESSAGE,
      error: 'Forbidden',
      statusCode: 403,
      code: RELAY_ORIGINALS_REFUSED,
    });
  }

  /**
   * FL-161: a websocket handshake. Its `Origin` must be this server's own, its external domain or a
   * published Frameleaf name (the socket carries the visitor's cookies, so no other page may open it);
   * its arrival is read from the edge worker's headers, and it then authenticates like any request.
   */
  async authenticateWebsocket(headers: IncomingHttpHeaders): Promise<{ auth: AuthDto; via: FrameleafVia | null }> {
    const via = frameleafVia(headers, this.configRepository.getEnv().frameleafCloud.edge.secret);
    if (!via && claimsFrameleafVia(headers)) {
      // like the via middleware: an arrival claim the edge worker did not vouch for is never home
      this.logger.warn('Refused a websocket that claims a Frameleaf arrival without the edge secret');
      throw new ForbiddenException(
        'This request claims to come through Frameleaf remote access, but the claim could not be verified',
      );
    }
    const origin = Array.isArray(headers.origin) ? headers.origin[0] : headers.origin;
    if (origin !== undefined && !this.configRepository.isDev()) {
      const config = await this.getConfig({ withCache: true });
      const { link, linked } = await readCloudLink({
        configRepository: this.configRepository,
        systemMetadataRepository: this.systemMetadataRepository,
      });
      const services: Record<string, unknown> = (linked ? link?.services : null) ?? {};
      const origins = allowedOrigins([
        config.server.externalDomain,
        typeof services.relayOrigin === 'string' ? services.relayOrigin : null,
        typeof services.publicUrl === 'string' ? services.publicUrl : null,
      ]);
      if (!websocketOriginAllowed(origin, { hosts: requestHosts(headers), origins })) {
        this.logger.warn(`Refused a websocket from origin ${JSON.stringify(origin)}`);
        throw new ForbiddenException('This page may not connect to this server');
      }
    }
    const auth = await this.authenticate({
      headers,
      queryParams: {},
      metadata: { adminRoute: false, sharedLinkRoute: false, uri: '/api/socket.io', via },
    });
    return { auth, via };
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
    const shareKey = (headers[RequestHeader.SharedLinkKey] || queryParams[RequestQuery.SharedLinkKey]) as string;
    const shareSlug = (headers[RequestHeader.SharedLinkSlug] || queryParams[RequestQuery.SharedLinkSlug]) as string;
    const session = (headers[RequestHeader.UserToken] ||
      headers[RequestHeader.SessionToken] ||
      queryParams[RequestQuery.SessionKey] ||
      this.getBearerToken(headers) ||
      this.getCookieToken(headers)) as string;
    const apiKey = (headers[RequestHeader.ApiKey] || queryParams[RequestQuery.ApiKey]) as string;

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

  async callback(dto: OAuthCallbackDto, headers: IncomingHttpHeaders, details: LoginDetails) {
    const loginDetails = withCapabilities(details, dto.capabilities);
    const { oauth, user: userConfig } = await this.getConfig({ withCache: false });
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
    if (user?.importClaimPending) throw new BadRequestException('OAuth authentication failed');

    // FL-158: an email is used to find or create an account only when the provider verified it
    const emailProblem = emailVerificationProblem(profile);

    // link by email
    if (!user && normalizedEmail) {
      const emailUser = await this.userRepository.getByEmail(normalizedEmail);
      if (emailUser) {
        if (emailUser.importClaimPending) throw new BadRequestException('OAuth authentication failed');
        if (emailProblem) {
          this.logger.warn(`OAuth login refused: ${normalizedEmail} is not verified by the provider`);
          throw new BadRequestException(emailProblem);
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

      if (emailProblem) {
        this.logger.warn(`OAuth registration refused: ${normalizedEmail} is not verified by the provider`);
        throw new BadRequestException(emailProblem);
      }

      this.logger.log(`Registering new user: ${profile.sub}/${normalizedEmail}`);

      const storageLabel = this.getClaim(profile, {
        key: storageLabelClaim,
        default: '',
        isValid: (value: unknown): value is string => typeof value === 'string',
      });
      const storageQuota = this.getClaim(profile, {
        key: storageQuotaClaim,
        // FL-516: "Space for new people" decides, however the account is made; the older sign-in
        // provider default applies only while it is unset
        default: userConfig.newUserStorageQuota ?? defaultStorageQuota,
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
        // D5: the claim and the default quota are decimal GB
        quotaSizeInBytes: storageQuota === null ? null : storageQuota * DecimalSize.GB,
        storageLabel: storageLabel || null,
        isAdmin,
      });
    }

    if (!user.profileImagePath && profile.picture) {
      await this.syncProfilePicture(user, profile.picture);
    }

    return this.createLoginResponse(user, loginDetails, { sid: oauthSid, bearerToken: oauthBearerToken }, 'oauth', []);
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
    return cookies[AuthCookie.AccessToken] || null;
  }

  private getCookieOauthState(headers: IncomingHttpHeaders): string | null {
    const cookies = parse(headers.cookie || '');
    return cookies[AuthCookie.OAuthState] || null;
  }

  private getCookieCodeVerifier(headers: IncomingHttpHeaders): string | null {
    const cookies = parse(headers.cookie || '');
    return cookies[AuthCookie.OAuthCodeVerifier] || null;
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
      void this.recordApiKeyUse(apiKey.id);
      return {
        user: apiKey.user,
        apiKey,
      };
    }

    throw new UnauthorizedException('Invalid API key');
  }

  /**
   * FL-367: "Last used" for API keys. Kept in system metadata rather than on the key, so a request
   * never writes to the key's row; recorded at most once every few minutes per key and process.
   */
  private async recordApiKeyUse(id: string): Promise<void> {
    const now = Date.now();
    if (now - (apiKeyUseRecorded.get(id) ?? 0) < API_KEY_USE_INTERVAL_MS) {
      return;
    }
    apiKeyUseRecorded.set(id, now);
    try {
      const used = (await this.systemMetadataRepository.get(SystemMetadataKey.ApiKeyLastUsed)) ?? {};
      await this.systemMetadataRepository.set(SystemMetadataKey.ApiKeyLastUsed, {
        ...used,
        [id]: new Date(now).toISOString(),
      });
    } catch (error) {
      this.logger.warn(`Could not record when an API key was last used: ${error}`);
    }
  }

  private async validateSecret(inputSecret: string, existingHash?: string | null): Promise<boolean> {
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
          const pinExpiresAt = DateTime.now()
            .plus({ minutes: await this.relockMinutes(session.user.id) })
            .toJSDate();
          hasElevatedPermission = await this.sessionRepository.refreshPinExpiry(session.id, pinExpiresAt);
          const userId = session.user.id;
          if (hasElevatedPermission && lockedKeys.has(userId)) {
            // FL-721 (spec §4.3): a PIN-mode Locked key stays open while the unlock does
            await this.lockedEncryption.onPinExtended(userId, pinExpiresAt).catch((error: Error) => {
              this.logger.warn(`Could not extend the Locked key of user ${userId}: ${error.name}`);
            });
          }
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
          signIn: session.signIn as AuthSession['signIn'],
        },
      };
    }

    throw new UnauthorizedException('Invalid user token');
  }

  /** FL-517: the account's "Lock again after" choice (an hour unless it chose 5 or 15 minutes). */
  private async relockMinutes(userId: string): Promise<number> {
    try {
      return relockMinutesOf(getPreferences(await this.userRepository.getMetadata(userId)));
    } catch {
      return ELEVATED_SESSION_DURATION_MINUTES;
    }
  }

  async unlockSession(auth: AuthDto, dto: SessionUnlockDto): Promise<void> {
    if (!auth.session) {
      throw new BadRequestException('This endpoint can only be used with a session token');
    }

    const user = await this.validatePinCode(auth.user.id, { pinCode: dto.pinCode });

    // FL-34: conditional on the credentials just checked, so a PIN or password change that lands
    // in between (and locked every session) is not undone by this unlock
    const elevated = await this.sessionRepository.elevate(
      auth.session.id,
      auth.user.id,
      user,
      DateTime.now()
        .plus({ minutes: await this.relockMinutes(auth.user.id) })
        .toJSDate(),
    );
    if (!elevated) {
      throw new UnauthorizedException('Your PIN or password changed; unlock again');
    }
    // FL-721 (spec §4.3): a PIN-mode Locked key opens with the PIN, for as long as the unlock lasts
    try {
      await this.lockedEncryption.onPinVerified(auth.user.id, dto.pinCode!);
    } catch (error) {
      // the unlock stands; Locked files then ask for the key again (never log the PIN)
      this.logger.warn(`Could not open the Locked key of user ${auth.user.id}: ${(error as Error).name}`);
    }
  }

  async lockSession(auth: AuthDto): Promise<void> {
    if (!auth.session) {
      throw new BadRequestException('This endpoint can only be used with a session token');
    }

    await this.sessionRepository.update(auth.session.id, { pinExpiresAt: null });
    // FL-34: only once the lock is stored; the session's other tabs drop what it unlocked
    this.websocketRepository.clientSend('on_session_lock', auth.session.id);
    await this.lockedEncryption.onSessionsLocked(auth.user.id);
  }

  private async createLoginResponse(
    user: UserAdmin,
    loginDetails: LoginDetails,
    identity: { sid?: string; bearerToken?: string; passwordHash?: string },
    method: SignInMethod,
    methods: string[],
  ) {
    const { session, response } = await createSession(
      { sessionRepository: this.sessionRepository, cryptoRepository: this.cryptoRepository },
      user,
      loginDetails,
      { methods, source: 'local' },
      identity,
      identity.passwordHash,
    );
    await this.recordAccountEvent({
      userId: user.id,
      sessionId: session.id,
      action: AccountEventAction.SignedIn,
      subject: user.name,
      detail: method,
      ...loginEventDetails(loginDetails),
    });
    await this.signInSecurity.signedIn(user, loginDetails);
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

  /** FL-836: the passkey fields are added by the controller (they depend on the request's address). */
  async getAuthStatus(auth: AuthDto): Promise<Omit<AuthStatusResponseDto, 'passkeysAvailable' | 'hasPasskeys'>> {
    const user = await this.userRepository.getForPinCode(auth.user.id);
    if (!user) {
      throw new UnauthorizedException();
    }

    const session = auth.session ? await this.sessionRepository.get(auth.session.id) : undefined;
    const twoFactorEnabled = !!(await this.userRepository.getTwoFactor(auth.user.id))?.enabledAt;

    return {
      twoFactorEnabled,
      recoveryCodesRemaining: twoFactorEnabled ? await this.userRepository.countRecoveryCodes(auth.user.id) : 0,
      pinCode: !!user.pinCode,
      password: !!user.password,
      ...(!user.password && (await this.initialPasswordOwner(auth)) && { localPasswordRequired: true }),
      isElevated: !!auth.session?.hasElevatedPermission,
      expiresAt: session?.expiresAt?.toISOString(),
      pinExpiresAt: session?.pinExpiresAt?.toISOString(),
    };
  }
}
