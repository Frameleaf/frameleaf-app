import { BadRequestException, ForbiddenException, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { BrowserExtensionGrant } from 'src/schema/tables/browser-extension-sign-in.table.js';
import {
  BrowserExtensionSignInAuthorizeDto,
  BrowserExtensionSignInAuthorizeResponseDto,
  BrowserExtensionSignInExchangeDto,
  BrowserExtensionSignInExchangeResponseDto,
  BrowserExtensionSignInInfoDto,
  BrowserExtensionSignInStartDto,
  BrowserExtensionSignInStartResponseDto,
} from 'src/dtos/browser-extension-sign-in.dto.js';
import { Permission } from 'src/enum.js';
import { BrowserExtensionSignInRepository } from 'src/repositories/browser-extension-sign-in.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import {
  SIGN_IN_CODE_TTL_SECONDS,
  accessName,
  checkRedirectUri,
  isCodeChallenge,
  returnAddress,
  verifierMatches,
} from 'src/utils/browser-extension-sign-in.js';
import { stableServerId } from 'src/utils/frameleaf-server-identity.js';

/** The "Browser extension" key purpose: save into Boards and list collections and tags, nothing else. */
export const BROWSER_EXTENSION_PERMISSIONS = [Permission.CaptureCreate, Permission.CaptureCatalogRead];

/**
 * FL-1427: what each grant issues, exactly. `capture` is all an older extension asks for and all a
 * key issued before media downloads holds; `media` adds the seven media permissions and nothing else.
 */
export const BROWSER_EXTENSION_GRANTS: Record<BrowserExtensionGrant, Permission[]> = {
  capture: BROWSER_EXTENSION_PERMISSIONS,
  media: [
    ...BROWSER_EXTENSION_PERMISSIONS,
    Permission.MediaImportRead,
    Permission.MediaImportCreate,
    Permission.MediaImportUpdate,
    Permission.MediaConnectionRead,
    Permission.MediaConnectionWrite,
    Permission.MediaSubscriptionRead,
    Permission.MediaSubscriptionWrite,
  ],
};

const INVALID_MESSAGE = 'This sign-in can’t be used. Sign in again from Save to Frameleaf.';
const EXPIRED_MESSAGE = 'This sign-in took too long. Sign in again from Save to Frameleaf.';

/** Every refusal of an exchange says only whether signing in again will help. */
const exchangeError = (code: 'expired' | 'invalid') =>
  new HttpException(
    {
      message: code === 'expired' ? EXPIRED_MESSAGE : INVALID_MESSAGE,
      error: 'Bad Request',
      statusCode: HttpStatus.BAD_REQUEST,
      code,
    },
    HttpStatus.BAD_REQUEST,
  );

/**
 * FL-655: Save to Frameleaf signs in with your own Frameleaf account. The extension opens the
 * browser's sign-in window on this server's Allow page with its return address, a code challenge
 * (S256) and a state. A signed-in person presses Allow, which makes a single-use code bound to them,
 * their session, the challenge, the exact return address and this server, valid five minutes. The
 * extension exchanges the code with its verifier for a new API key that can only save captures and
 * list collections and tags (and, when Allow was pressed for media downloads, use those), named "Save to Frameleaf · Chrome" (or Edge). No new account system:
 * the person's own session approves and the existing API keys carry the access.
 */
@Injectable()
export class BrowserExtensionSignInService {
  constructor(
    private repository: BrowserExtensionSignInRepository,
    private cryptoRepository: CryptoRepository,
    private systemMetadataRepository: SystemMetadataRepository,
    private userRepository: UserRepository,
  ) {}

  /** `GET browser-extension/sign-in`: tells the extension this server can sign in from the browser. */
  info(): BrowserExtensionSignInInfoDto {
    return { version: 1, grants: ['capture', 'media'] };
  }

  /** `POST browser-extension/sign-in/start`: checks the request behind the Allow page. */
  async start(auth: AuthDto, dto: BrowserExtensionSignInStartDto): Promise<BrowserExtensionSignInStartResponseDto> {
    const { origin } = this.check(auth, dto);
    const existing = await this.repository.getAccess(auth.user.id, dto.client, origin, dto.installationId);
    // Allow is skipped only when this installation's key already holds everything now asked for.
    const held = new Set<string>(existing?.permissions);
    const alreadyAllowed =
      !!existing &&
      (held.has(Permission.All) || BROWSER_EXTENSION_GRANTS[dto.grant ?? 'capture'].every((item) => held.has(item)));
    return { accessName: accessName(dto.client), alreadyAllowed };
  }

  /**
   * `POST browser-extension/sign-in/authorize`: Allow or Cancel. Allow makes the single-use code;
   * Cancel makes nothing and only tells the extension it was cancelled.
   */
  async authorize(
    auth: AuthDto,
    dto: BrowserExtensionSignInAuthorizeDto,
  ): Promise<BrowserExtensionSignInAuthorizeResponseDto> {
    const { redirectUri } = this.check(auth, dto);
    if (!dto.allow) {
      return { redirectUrl: returnAddress(redirectUri, { error: 'access_denied', state: dto.state }) };
    }
    const code = this.cryptoRepository.randomBytesAsText(32);
    await this.repository.createCode({
      codeHash: this.cryptoRepository.hashSha256(code),
      userId: auth.user.id,
      sessionId: auth.session!.id,
      codeChallenge: dto.codeChallenge,
      redirectUri,
      client: dto.client,
      installationId: dto.installationId,
      accessGrant: dto.grant ?? 'capture',
      serverId: await stableServerId({ systemMetadataRepository: this.systemMetadataRepository }),
      expiresAt: new Date(Date.now() + SIGN_IN_CODE_TTL_SECONDS * 1000),
    });
    return { redirectUrl: returnAddress(redirectUri, { code, state: dto.state }) };
  }

  /**
   * `POST browser-extension/sign-in/exchange` (no sign-in: the code is the proof). The code is used
   * up by the first attempt, right or wrong, so it can never be replayed or guessed at twice.
   */
  async exchange(dto: BrowserExtensionSignInExchangeDto): Promise<BrowserExtensionSignInExchangeResponseDto> {
    const found = await this.repository.takeCode(this.cryptoRepository.hashSha256(dto.code));
    if (!found) {
      throw exchangeError('invalid');
    }
    if (new Date(found.expiresAt).getTime() <= Date.now()) {
      throw exchangeError('expired');
    }
    const serverId = await stableServerId({ systemMetadataRepository: this.systemMetadataRepository });
    if (
      found.serverId !== serverId ||
      found.redirectUri !== dto.redirectUri ||
      !verifierMatches(dto.codeVerifier, found.codeChallenge)
    ) {
      throw exchangeError('invalid');
    }
    const redirect = checkRedirectUri(found.redirectUri);
    const user = await this.userRepository.get(found.userId, { withDeleted: false });
    if (!redirect || !user) {
      throw exchangeError('invalid');
    }

    // The scope comes from the code alone: nothing the exchange is sent can widen it.
    const grant: BrowserExtensionGrant = found.accessGrant === 'media' ? 'media' : 'capture';
    const secret = this.cryptoRepository.randomBytesAsText(32);
    const name = accessName(found.client);
    const apiKey = await this.repository.replaceAccess({
      userId: user.id,
      client: found.client,
      redirectOrigin: redirect.origin,
      installationId: found.installationId,
      name,
      key: this.cryptoRepository.hashSha256(secret),
      permissions: BROWSER_EXTENSION_GRANTS[grant],
    });
    return { secret, apiKeyId: apiKey.id, name: apiKey.name, userId: user.id, serverId, grant };
  }

  /** `DELETE browser-extension/sign-in`: Sign out in the extension removes its own access. */
  async signOut(auth: AuthDto): Promise<void> {
    if (!auth.apiKey || !(await this.repository.removeAccess(auth.user.id, auth.apiKey.id))) {
      throw new BadRequestException('Only Save to Frameleaf’s own access can sign out here');
    }
  }

  /** Only a signed-in person (a session, never a key) may allow, for an extension's own address. */
  private check(auth: AuthDto, dto: BrowserExtensionSignInStartDto) {
    if (!auth.session || auth.apiKey || auth.sharedLink) {
      throw new ForbiddenException('Sign in to Frameleaf in this browser to allow Save to Frameleaf');
    }
    const redirect = checkRedirectUri(dto.redirectUri);
    if (!redirect) {
      throw new BadRequestException('This isn’t Save to Frameleaf’s sign-in address');
    }
    if (dto.codeChallengeMethod !== 'S256' || !isCodeChallenge(dto.codeChallenge)) {
      throw new BadRequestException('This sign-in request is incomplete. Sign in again from Save to Frameleaf.');
    }
    return redirect;
  }
}
