import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiResponse, ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  BrowserExtensionSignInAuthorizeDto,
  BrowserExtensionSignInAuthorizeResponseDto,
  BrowserExtensionSignInErrorDto,
  BrowserExtensionSignInExchangeDto,
  BrowserExtensionSignInExchangeResponseDto,
  BrowserExtensionSignInInfoDto,
  BrowserExtensionSignInStartDto,
  BrowserExtensionSignInStartResponseDto,
} from 'src/dtos/browser-extension-sign-in.dto.js';
import { ApiTag } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { RATE_LIMITS, RateLimited } from 'src/middleware/rate-limit.guard.js';
import { BrowserExtensionSignInService } from 'src/services/browser-extension-sign-in.service.js';

/**
 * FL-655: Save to Frameleaf signs in with your Frameleaf account through the browser's sign-in
 * window, and gets an access listed in API keys. See `BrowserExtensionSignInService`.
 */
@ApiTags(ApiTag.Authentication)
@Controller('browser-extension/sign-in')
export class BrowserExtensionSignInController {
  constructor(private service: BrowserExtensionSignInService) {}

  @Get()
  @Authenticated({ public: true })
  @Endpoint({
    operationId: 'getBrowserExtensionSignIn',
    summary: 'Check that Save to Frameleaf can sign in here',
    description:
      'Public. Tells Save to Frameleaf this server can sign in from the browser; a server without it is asked for a key instead.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  getInfo(): BrowserExtensionSignInInfoDto {
    return this.service.info();
  }

  @Post('start')
  @Authenticated({ permission: false })
  @RateLimited(RATE_LIMITS.extensionSignIn)
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    operationId: 'startBrowserExtensionSignIn',
    summary: 'Check a Save to Frameleaf sign-in before Allow',
    description:
      'For the Allow page, signed in with a session (never a key). Checks the extension’s return address (https://<extension id>.chromiumapp.org/ only) and its S256 code challenge, and says whether this extension already has access, so Allow is asked only once per browser.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  start(
    @Auth() auth: AuthDto,
    @Body() dto: BrowserExtensionSignInStartDto,
  ): Promise<BrowserExtensionSignInStartResponseDto> {
    return this.service.start(auth, dto);
  }

  @Post('authorize')
  @Authenticated({ permission: false })
  @RateLimited(RATE_LIMITS.extensionSignIn)
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    operationId: 'authorizeBrowserExtensionSignIn',
    summary: 'Allow or cancel a Save to Frameleaf sign-in',
    description:
      'Signed in with a session (never a key). Allow makes a single-use code, valid five minutes, bound to you, this session, the code challenge, the exact return address and this server; only its SHA-256 is kept. Cancel makes nothing. Either way the response is where the sign-in window goes next.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  authorize(
    @Auth() auth: AuthDto,
    @Body() dto: BrowserExtensionSignInAuthorizeDto,
  ): Promise<BrowserExtensionSignInAuthorizeResponseDto> {
    return this.service.authorize(auth, dto);
  }

  @Post('exchange')
  @Authenticated({ public: true })
  @RateLimited(RATE_LIMITS.extensionSignIn)
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    operationId: 'exchangeBrowserExtensionSignIn',
    summary: 'Finish a Save to Frameleaf sign-in',
    description:
      'Public: the code is the proof. Exchanges the code with its code verifier and the same return address for a new API key that can only save captures and list collections and tags (capture.create and capture.catalog.read), listed in API keys as “Save to Frameleaf · Chrome” or “· Edge” and added by signing in. It replaces this extension’s previous access to the account. The code is used up by the first attempt.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  @ApiResponse({
    status: 400,
    type: BrowserExtensionSignInErrorDto,
    description:
      'expired: the code is older than five minutes; invalid: anything else (unknown, used, wrong verifier, return address or server)',
  })
  exchange(@Body() dto: BrowserExtensionSignInExchangeDto): Promise<BrowserExtensionSignInExchangeResponseDto> {
    return this.service.exchange(dto);
  }

  @Delete()
  @Authenticated({ permission: false })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    operationId: 'signOutBrowserExtension',
    summary: 'Sign Save to Frameleaf out',
    description:
      'Called with the extension’s own access: removes it, so it is no longer listed in API keys. Only an access added by signing in can sign itself out.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  signOut(@Auth() auth: AuthDto): Promise<void> {
    return this.service.signOut(auth);
  }
}
