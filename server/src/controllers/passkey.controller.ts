import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { LoginDetails } from 'src/services/auth.service.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { type AuthDto, LoginResponseDto } from 'src/dtos/auth.dto.js';
import {
  PasskeyLoginDto,
  PasskeyOptionsResponseDto,
  PasskeyRegisterDto,
  PasskeyRegistrationOptionsDto,
  PasskeyResponseDto,
  PasskeyUpdateDto,
} from 'src/dtos/passkey.dto.js';
import { ApiTag, AuthCookie, AuthType, Permission } from 'src/enum.js';
import { Auth, Authenticated, GetLoginDetails } from 'src/middleware/auth.guard.js';
import { RATE_LIMITS, RateLimited } from 'src/middleware/rate-limit.guard.js';
import { PasskeyService } from 'src/services/passkey.service.js';
import { passkeyDetails } from 'src/utils/passkey.js';
import { respondWithCookie } from 'src/utils/response.js';
import { UUIDv7ParamDto } from 'src/validation.js';

/** FL-836: passkeys (WebAuthn) for local accounts. */
@ApiTags(ApiTag.Authentication)
@Controller('auth/passkeys')
export class PasskeyController {
  constructor(private service: PasskeyService) {}

  @Get()
  @Authenticated({ permission: Permission.AuthChangePassword })
  @Endpoint({
    summary: 'List passkeys',
    description: 'The passkeys of the current user, oldest first.',
    history: new HistoryBuilder().added('v3.4.0').beta('v3.4.0'),
  })
  getPasskeys(@Auth() auth: AuthDto): Promise<PasskeyResponseDto[]> {
    return this.service.getAll(auth);
  }

  @Post('register/options')
  @RateLimited(RATE_LIMITS.passkeyChange)
  @Authenticated({ permission: Permission.AuthChangePassword })
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Start adding a passkey',
    description:
      'Check the password (or a check from this session in the last 10 minutes) and get the options for the browser. Answers passkeysAvailable false with a reason at an address where passkeys cannot work, such as plain http.',
    history: new HistoryBuilder().added('v3.4.0').beta('v3.4.0'),
  })
  getPasskeyRegistrationOptions(
    @Req() req: Request,
    @Auth() auth: AuthDto,
    @Body() dto: PasskeyRegistrationOptionsDto,
    @GetLoginDetails() details: LoginDetails,
  ): Promise<PasskeyOptionsResponseDto> {
    return this.service.getRegistrationOptions(auth, dto, req.headers, passkeyDetails(req, details));
  }

  @Post('register')
  @RateLimited(RATE_LIMITS.passkeyChange)
  @Authenticated({ permission: Permission.AuthChangePassword })
  @Endpoint({
    summary: 'Add a passkey',
    description: 'Save the passkey the browser made for the options from register/options.',
    history: new HistoryBuilder().added('v3.4.0').beta('v3.4.0'),
  })
  registerPasskey(
    @Auth() auth: AuthDto,
    @Body() dto: PasskeyRegisterDto,
    @GetLoginDetails() details: LoginDetails,
  ): Promise<PasskeyResponseDto> {
    return this.service.register(auth, dto, details);
  }

  @Patch(':id')
  @Authenticated({ permission: Permission.AuthChangePassword })
  @Endpoint({
    summary: 'Rename a passkey',
    description: 'Change the name of one of the current user’s passkeys.',
    history: new HistoryBuilder().added('v3.4.0').beta('v3.4.0'),
  })
  updatePasskey(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDv7ParamDto,
    @Body() dto: PasskeyUpdateDto,
  ): Promise<PasskeyResponseDto> {
    return this.service.update(auth, id, dto);
  }

  @Delete(':id')
  @Authenticated({ permission: Permission.AuthChangePassword })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Remove a passkey',
    description: 'Remove one of the current user’s passkeys. Sessions it signed in are signed out.',
    history: new HistoryBuilder().added('v3.4.0').beta('v3.4.0'),
  })
  removePasskey(@Auth() auth: AuthDto, @Param() { id }: UUIDv7ParamDto): Promise<void> {
    return this.service.remove(auth, id);
  }

  @Post('login/options')
  @Authenticated({ public: true })
  @RateLimited(RATE_LIMITS.passkeyLoginOptions)
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Start a passkey sign-in',
    description:
      'Get the options for the browser to sign in with a passkey. Answers passkeysAvailable false with a reason at an address where passkeys cannot work, such as plain http.',
    history: new HistoryBuilder().added('v3.4.0').beta('v3.4.0'),
  })
  getPasskeyLoginOptions(
    @Req() req: Request,
    @GetLoginDetails() details: LoginDetails,
  ): Promise<PasskeyOptionsResponseDto> {
    return this.service.getLoginOptions(req.headers, passkeyDetails(req, details));
  }

  @Post('login')
  @Authenticated({ public: true })
  @RateLimited(RATE_LIMITS.login)
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Sign in with a passkey',
    description:
      'Send the browser’s answer to login/options and receive a session token. A passkey sign-in skips two-step sign-in.',
    history: new HistoryBuilder().added('v3.4.0').beta('v3.4.0'),
  })
  async loginWithPasskey(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() dto: PasskeyLoginDto,
    @GetLoginDetails() details: LoginDetails,
  ): Promise<LoginResponseDto> {
    const secure = passkeyDetails(req, details);
    const { response, rememberMe } = await this.service.login(dto, secure);
    return respondWithCookie(res, response, {
      isSecure: secure.isSecure,
      rememberMe,
      values: [
        { key: AuthCookie.AccessToken, value: response.accessToken },
        { key: AuthCookie.AuthType, value: AuthType.Password },
        { key: AuthCookie.IsAuthenticated, value: 'true' },
      ],
    });
  }
}
