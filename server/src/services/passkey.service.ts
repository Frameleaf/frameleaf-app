import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type { IncomingHttpHeaders } from 'node:http';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import {
  PasskeyCredentialDto,
  PasskeyLoginDto,
  PasskeyOptionsResponseDto,
  PasskeyRegisterDto,
  PasskeyRegistrationOptionsDto,
  PasskeyResponseDto,
  PasskeyUpdateDto,
} from 'src/dtos/passkey.dto.js';
import { AccountEventAction } from 'src/enum.js';
import { PasskeyRepository } from 'src/repositories/passkey.repository.js';
import { type LoginDetails, loginEventDetails } from 'src/services/auth.service.js';
import { BaseService } from 'src/services/base.service.js';
import { SignInSecurityService } from 'src/services/sign-in-security.service.js';
import { asDateTimeString } from 'src/utils/date.js';
import { readCloudLink } from 'src/utils/frameleaf-cloud-gateway.js';
import { isRemoteVia } from 'src/utils/frameleaf-sign-in.js';
import {
  PASSKEY_CEREMONY_TIMEOUT_MS,
  PASSKEY_CHALLENGE_SECONDS,
  PASSKEY_PASSWORD_PROOF_SECONDS,
  type PasskeyPlace,
  PasskeyUnavailableReason,
  answeredChallenge,
  cleanPasskeyName,
  passkeyPlace,
  passkeyProvider,
  passkeyUserHandle,
  requestOrigin,
} from 'src/utils/passkey.js';
import { checkSecret } from 'src/utils/secret-attempts.js';
import { frameleafTrustedOrigins } from 'src/utils/frameleaf-trusted-origins.js';
import { createSession, withCapabilities } from 'src/utils/session.js';

/** FL-836: the error code of adding a passkey without a recent password check. */
export const PASSKEY_PASSWORD_REQUIRED = 'passkey_password_required';
/**
 * FL-836: why a passkey sign-in was refused, as `code` on the 401 (the web shows its own words for each).
 * `passkey_not_recognised`: no passkey here for that credential and address (removed, or another
 * account's); `passkey_failed`: the signature, the person check or the count was wrong;
 * `passkey_expired`: the challenge was used or ran out.
 */
const signInRefused = (
  code: 'passkey_not_recognised' | 'passkey_failed' | 'passkey_expired' | 'passkey_insecure',
  message: string,
) => new UnauthorizedException({ message, error: 'Unauthorized', statusCode: 401, code });
const NOT_RECOGNISED = () =>
  signInRefused(
    'passkey_not_recognised',
    'That passkey isn’t set up for this server. It may have been removed, or it belongs to another account. Sign in with your password, then add a new passkey.',
  );
const DIDNT_WORK = () =>
  signInRefused('passkey_failed', 'Your passkey didn’t work this time. Try again, or sign in with your password.');
const EXPIRED = () => signInRefused('passkey_expired', 'This passkey sign-in took too long. Try again.');

type PasskeyRow = Awaited<ReturnType<PasskeyRepository['getByUser']>>[number];

const mapPasskey = (row: PasskeyRow): PasskeyResponseDto => ({
  id: row.id,
  name: row.name,
  provider: passkeyProvider(row.aaguid),
  backedUp: row.backedUp,
  rpId: row.rpId,
  createdAt: asDateTimeString(row.createdAt),
  lastUsedAt: row.lastUsedAt ? asDateTimeString(row.lastUsedAt) : null,
});

const unavailable = (place: Extract<PasskeyPlace, { available: false }>): PasskeyOptionsResponseDto => ({
  passkeysAvailable: false,
  reason: place.reason,
  options: null,
});

const expiresIn = (seconds: number) => new Date(Date.now() + seconds * 1000);

/** A first suggestion for a new passkey's name, from the browser that made it: "Chrome on Mac". */
const suggestedName = (details: LoginDetails) =>
  cleanPasskeyName(
    [details.browserFamily, details.deviceOSFamily?.replace(/^macOS$/, 'Mac')].filter(Boolean).join(' on '),
  ) || 'Passkey';

/**
 * FL-836: passkeys (WebAuthn) for local accounts. An account adds one after checking its password
 * (good for 10 minutes in that session), and signs in with it instead of the password; a passkey sign-in
 * verifies the person on their device, so it skips the two-step code. Challenges live on the server for
 * 5 minutes and answer once; the relying party is the page's own address, only when it is this server's
 * external domain, its Frameleaf address or localhost (`utils/passkey.ts`).
 */
@Injectable()
export class PasskeyService extends BaseService {
  @Inject(PasskeyRepository)
  private passkeyRepository!: PasskeyRepository;

  @Inject(SignInSecurityService)
  private signInSecurity!: SignInSecurityService;

  /** Where passkeys may be used for this request: its origin, checked against the server's addresses. */
  async getPlace(headers: IncomingHttpHeaders, isSecure: boolean): Promise<PasskeyPlace> {
    const config = await this.getConfig({ withCache: true });
    const { link, linked } = await readCloudLink({
      configRepository: this.configRepository,
      systemMetadataRepository: this.systemMetadataRepository,
    });
    const services: Record<string, unknown> = (linked ? link?.services : null) ?? {};
    const text = (value: unknown) => (typeof value === 'string' ? value : null);
    // every https origin this server already trusts for Sign in with Frameleaf: the published addresses, the
    // enrolled relay name and a verified custom hostname, and the external domain
    const origins = await frameleafTrustedOrigins(
      { configRepository: this.configRepository, systemMetadataRepository: this.systemMetadataRepository },
      config,
    );
    const place = passkeyPlace(requestOrigin(headers, isSecure), [
      config.server.externalDomain,
      text(services.relayOrigin),
      text(services.publicUrl),
      ...origins,
    ]);
    // the Origin header is the page's word only: the request itself must also have come over https
    // (or through a proxy that says so), else a session token could cross the network in clear
    if (place.available && place.rpId !== 'localhost' && !isSecure) {
      return { available: false, reason: PasskeyUnavailableReason.Insecure };
    }
    return place;
  }

  /** The two auth-status fields: passkeys work at this address, and the account has any. */
  async getStatus(auth: AuthDto, headers: IncomingHttpHeaders, isSecure: boolean) {
    // the session's own status never fails because the server's addresses couldn't be read
    const place = await this.getPlace(headers, isSecure).catch((error: unknown) => {
      this.logger.warn(`Could not tell whether passkeys work at this address: ${error}`);
      return { available: false };
    });
    return {
      passkeysAvailable: place.available,
      hasPasskeys: (await this.passkeyRepository.countByUser(auth.user.id)) > 0,
    };
  }

  async getAll(auth: AuthDto): Promise<PasskeyResponseDto[]> {
    const rows = await this.passkeyRepository.getByUser(auth.user.id);
    return rows.map((row) => mapPasskey(row));
  }

  /**
   * Starts adding a passkey. Needs a session (not an API key or a shared link) and a password check in
   * the last 10 minutes: the password sent now, or one sent earlier in this session. A Frameleaf sign-in
   * made in the last 10 minutes counts too, for accounts away from home or without a password.
   */
  async getRegistrationOptions(
    auth: AuthDto,
    dto: PasskeyRegistrationOptionsDto,
    headers: IncomingHttpHeaders,
    details: LoginDetails,
  ): Promise<PasskeyOptionsResponseDto> {
    const session = this.requireSession(auth);
    const place = await this.getPlace(headers, details.isSecure);
    if (!place.available) {
      return unavailable(place);
    }
    // FL-1368: the version first, so a reset that lands after the password check makes this challenge stale
    const credentialVersion = await this.passkeyRepository.getCredentialVersion(auth.user.id);
    await this.requirePasswordProof(auth, session.id, dto.password, details);

    const existing = await this.passkeyRepository.getByUser(auth.user.id);
    const options = await generateRegistrationOptions({
      rpName: 'Frameleaf',
      rpID: place.rpId,
      userName: auth.user.email,
      userDisplayName: auth.user.name,
      userID: passkeyUserHandle(auth.user.id),
      timeout: PASSKEY_CEREMONY_TIMEOUT_MS,
      attestationType: 'none',
      // a device that already holds one of this account's passkeys says so instead of making another
      excludeCredentials: existing
        .filter(({ rpId }) => rpId === place.rpId)
        .map(({ credentialId, transports }) => ({ id: credentialId.toString('base64url'), transports })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });
    await this.passkeyRepository.createChallenge({
      purpose: 'register',
      challenge: options.challenge,
      userId: auth.user.id,
      sessionId: session.id,
      origin: place.origin,
      rpId: place.rpId,
      credentialVersion,
      expiresAt: expiresIn(PASSKEY_CHALLENGE_SECONDS),
    });
    return { passkeysAvailable: true, reason: null, options: options as unknown as Record<string, unknown> };
  }

  /** Finishes adding a passkey with the browser's answer to this session's challenge. */
  async register(auth: AuthDto, dto: PasskeyRegisterDto, details: LoginDetails): Promise<PasskeyResponseDto> {
    const session = this.requireSession(auth);
    const credential = dto.credential as unknown as RegistrationResponseJSON;
    const challenge = answeredChallenge(credential.response?.clientDataJSON);
    const stored = challenge ? await this.passkeyRepository.takeChallenge('register', challenge) : undefined;
    if (
      !stored ||
      stored.userId !== auth.user.id ||
      stored.sessionId !== session.id ||
      !stored.origin ||
      !stored.rpId
    ) {
      throw new BadRequestException('Adding this passkey took too long. Try again.');
    }

    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: credential,
        expectedChallenge: challenge!,
        expectedOrigin: stored.origin,
        expectedRPID: stored.rpId,
        requireUserVerification: true,
      });
    } catch (error) {
      this.logger.warn(`A passkey for user ${auth.user.id} could not be verified: ${(error as Error).message}`);
      verification = undefined;
    }
    if (!verification?.verified) {
      throw new BadRequestException('Your browser didn’t make a passkey. Nothing was saved; try again.');
    }

    const info = verification.registrationInfo;
    const row = await this.passkeyRepository.create(
      {
        userId: auth.user.id,
        credentialId: Buffer.from(info.credential.id, 'base64url'),
        publicKey: Buffer.from(info.credential.publicKey),
        counter: String(info.credential.counter),
        transports: (info.credential.transports ?? []).slice(0, 8),
        name: dto.name ? cleanPasskeyName(dto.name) : suggestedName(details),
        rpId: stored.rpId,
        aaguid: /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(info.aaguid) ? info.aaguid : null,
        backedUp: info.credentialBackedUp,
      },
      stored.credentialVersion ?? 0,
    );
    if (row === 'stale') {
      // an administrator reset this account's sign-in since this passkey was started
      throw new BadRequestException('Your sign-in was reset while adding this passkey. Start again.');
    }
    if (!row) {
      throw new ConflictException('This passkey is already saved');
    }
    await this.recordAccountEvent({
      userId: auth.user.id,
      sessionId: session.id,
      action: AccountEventAction.PasskeyAdded,
      subject: row.name,
    });
    return mapPasskey(row);
  }

  async update(auth: AuthDto, id: string, dto: PasskeyUpdateDto): Promise<PasskeyResponseDto> {
    const row = await this.passkeyRepository.rename(auth.user.id, id, cleanPasskeyName(dto.name));
    if (!row) {
      throw new NotFoundException('Passkey not found');
    }
    return mapPasskey(row);
  }

  /** Removes a passkey of the account; the sessions it started are signed out. */
  async remove(auth: AuthDto, id: string): Promise<void> {
    // the device removing it stays signed in; any other it signed in (a lost phone) is signed out
    const removed = await this.passkeyRepository.delete(auth.user.id, id, auth.session?.id);
    if (!removed) {
      throw new NotFoundException('Passkey not found');
    }
    for (const sessionId of removed.sessionIds) {
      await this.eventRepository.emit('SessionDelete', { sessionId });
    }
    await this.recordAccountEvent({
      userId: auth.user.id,
      sessionId: auth.session?.id ?? null,
      action: AccountEventAction.PasskeyRemoved,
      subject: removed.name,
    });
  }

  /** Starts a passkey sign-in: a challenge any of this server's passkeys at this address can answer. */
  async getLoginOptions(headers: IncomingHttpHeaders, details: LoginDetails): Promise<PasskeyOptionsResponseDto> {
    const place = await this.getPlace(headers, details.isSecure);
    if (!place.available) {
      return unavailable(place);
    }
    await this.requireLocalSignIn();
    const options = await generateAuthenticationOptions({
      rpID: place.rpId,
      userVerification: 'required',
      timeout: PASSKEY_CEREMONY_TIMEOUT_MS,
    });
    await this.passkeyRepository.createChallenge({
      purpose: 'login',
      challenge: options.challenge,
      origin: place.origin,
      rpId: place.rpId,
      expiresAt: expiresIn(PASSKEY_CHALLENGE_SECONDS),
    });
    return { passkeysAvailable: true, reason: null, options: options as unknown as Record<string, unknown> };
  }

  /**
   * Signs in with a passkey. Its answer must be to an unused challenge from this server, signed by a
   * passkey stored here for that address, with the person verified on their device and a signature count
   * that moved on (or a passkey that doesn't count). Failures answer 401 so the sign-in limits count them.
   * The new session skips two-step sign-in, and works through remote access like a Frameleaf sign-in.
   */
  async login(dto: PasskeyLoginDto, loginDetails: LoginDetails) {
    const details = withCapabilities(loginDetails, dto.capabilities);
    await this.requireLocalSignIn();
    const credential = dto.credential as unknown as AuthenticationResponseJSON;
    const challenge = answeredChallenge(credential.response?.clientDataJSON);
    const stored = challenge ? await this.passkeyRepository.takeChallenge('login', challenge) : undefined;
    if (!stored?.origin || !stored.rpId) {
      throw EXPIRED();
    }
    // the session token goes back in this answer: only over https, except on localhost
    if (stored.rpId !== 'localhost' && !details.isSecure) {
      throw signInRefused('passkey_insecure', 'Passkeys work only at a secure (https) address.');
    }

    const credentialId = this.credentialId(dto.credential);
    const passkey = credentialId ? await this.passkeyRepository.getByCredentialId(credentialId) : undefined;
    const user =
      passkey && passkey.rpId === stored.rpId ? await this.userRepository.get(passkey.userId, {}) : undefined;
    const handle = credential.response?.userHandle;
    if (
      !passkey ||
      !user ||
      user.importClaimPending ||
      (handle && handle !== Buffer.from(passkeyUserHandle(passkey.userId)).toString('base64url'))
    ) {
      this.logger.warn(`Refused a passkey sign-in with an unknown passkey from ${details.clientIp}`);
      throw NOT_RECOGNISED();
    }

    const verified = await this.signInSecurity.attempt('passkey', passkey.id, details, async (backoff) => {
      let result;
      try {
        result = await verifyAuthenticationResponse({
          response: credential,
          expectedChallenge: challenge!,
          expectedOrigin: stored.origin!,
          expectedRPID: stored.rpId!,
          credential: {
            id: passkey.credentialId.toString('base64url'),
            publicKey: new Uint8Array(passkey.publicKey),
            counter: Number(passkey.counter),
            transports: passkey.transports as never,
          },
          requireUserVerification: true,
        });
      } catch (error) {
        // a wrong signature, a counter that went backwards (a cloned authenticator) or the wrong address
        this.logger.warn(`A passkey sign-in for user ${user.id} was refused: ${(error as Error).message}`);
        result = undefined;
      }
      const ok =
        !!result?.verified &&
        (await this.passkeyRepository.recordUse(
          passkey.id,
          Number(passkey.counter),
          result.authenticationInfo.newCounter,
          result.authenticationInfo.credentialBackedUp,
        ));
      if (ok) {
        await this.signInSecurity.succeeded(backoff);
      } else {
        await this.signInSecurity.failed(backoff, user);
      }
      return ok;
    });
    if (!verified) {
      await this.recordAccountEvent({
        userId: user.id,
        action: AccountEventAction.SignInFailed,
        subject: user.name,
        detail: 'passkey',
        ...loginEventDetails(details),
      });
      throw DIDNT_WORK();
    }

    const { session, response } = await createSession(
      { sessionRepository: this.sessionRepository, cryptoRepository: this.cryptoRepository },
      user,
      details,
      { methods: ['passkey'], source: 'local' },
    );
    // removed (by its owner or an administrator) while this sign-in was checked: no session from it
    if (!(await this.passkeyRepository.linkSession(session.id, passkey.id))) {
      await this.sessionRepository.delete(session.id);
      throw NOT_RECOGNISED();
    }
    await this.recordAccountEvent({
      userId: user.id,
      sessionId: session.id,
      action: AccountEventAction.SignedIn,
      subject: user.name,
      detail: 'passkey',
      ...loginEventDetails(details),
    });
    await this.signInSecurity.signedIn(user, details);
    return { response, rememberMe: dto.rememberMe ?? true };
  }

  private credentialId(credential: PasskeyCredentialDto): Buffer | undefined {
    if (credential.id !== credential.rawId || !/^[\w-]+$/.test(credential.id)) {
      return;
    }
    return Buffer.from(credential.id, 'base64url');
  }

  /** Passkeys are a way into local accounts, so they follow the server's password sign-in switch. */
  private async requireLocalSignIn() {
    const config = await this.getConfig({ withCache: false });
    if (!config.passwordLogin.enabled) {
      throw new UnauthorizedException('Signing in with a password or passkey has been turned off');
    }
  }

  private requireSession(auth: AuthDto) {
    if (!auth.session) {
      throw new ForbiddenException('Passkeys can only be managed when signed in, not with an API key');
    }
    return auth.session;
  }

  private async requirePasswordProof(
    auth: AuthDto,
    sessionId: string,
    password: string | undefined,
    details: LoginDetails,
  ) {
    if (password !== undefined) {
      await this.checkPassword(auth, sessionId, password, details);
      return;
    }
    if (await this.passkeyRepository.hasPasswordProof(sessionId)) {
      return;
    }
    const tag = await this.frameleafAccountRepository.getSession(sessionId);
    if (
      tag &&
      tag.userId === auth.user.id &&
      // when the person signed in at Frameleaf, kept across handoffs (not when this tag was made)
      !!tag.authTime &&
      tag.authTime.getTime() > Date.now() - PASSKEY_PASSWORD_PROOF_SECONDS * 1000
    ) {
      return;
    }
    throw new ForbiddenException({
      message: 'Enter your password to add a passkey',
      error: 'Forbidden',
      statusCode: 403,
      code: PASSKEY_PASSWORD_REQUIRED,
    });
  }

  /** The password, checked with the usual lockout, and remembered in this session for 10 minutes. */
  private async checkPassword(auth: AuthDto, sessionId: string, password: string, details: LoginDetails) {
    if (isRemoteVia(details.via)) {
      const config = await this.getConfig({ withCache: true });
      // FL-161: passwords stay on the home network unless an administrator allowed them
      if (!config.frameleafCloud.remoteAccess.allowPasswordOverRelay) {
        throw new ForbiddenException(
          'Away from home, sign in again with your Frameleaf account, then add your passkey within 10 minutes',
        );
      }
    }
    await checkSecret(
      auth.user.id,
      async (verify) => {
        const { password: hash } = await this.userRepository.getForChangePassword(auth.user.id);
        if (!hash) {
          throw new BadRequestException('This account has no password. Set one first, then add a passkey.');
        }
        await verify(async () => {
          if (!(await this.cryptoRepository.compareBcrypt(password, hash))) {
            throw new BadRequestException('Wrong password');
          }
        });
      },
      'password',
    );
    await this.passkeyRepository.createChallenge({
      purpose: 'password-proof',
      challenge: this.cryptoRepository.randomBytesAsText(32),
      userId: auth.user.id,
      sessionId,
      expiresAt: expiresIn(PASSKEY_PASSWORD_PROOF_SECONDS),
    });
  }
}
