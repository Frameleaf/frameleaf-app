import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Post, Put, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { parseCookie } from 'cookie';
import type { Request, Response } from 'express';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  type AuthDto,
  AuthStatusResponseDto,
  ChangePasswordDto,
  LoginCredentialDto,
  LoginResponseDto,
  LoginTwoFactorDto,
  LogoutResponseDto,
  PasswordLinkCheckDto,
  PasswordLinkCheckResponseDto,
  PasswordLinkRedeemDto,
  PinCodeChangeDto,
  PinCodeResetDto,
  PinCodeSetupDto,
  SessionUnlockDto,
  SignUpDto,
  TwoFactorDisableDto,
  TwoFactorEnableDto,
  TwoFactorPasswordDto,
  TwoFactorRecoveryCodesResponseDto,
  TwoFactorSetupResponseDto,
  ValidateAccessTokenResponseDto,
} from 'src/dtos/auth.dto.js';
import { UserAdminResponseDto } from 'src/dtos/user.dto.js';
import { ApiTag, AuthCookie, AuthType, Permission } from 'src/enum.js';
import { Auth, Authenticated, GetLoginDetails, RemoteSignInExempt } from 'src/middleware/auth.guard.js';
import { RATE_LIMITS, RateLimited } from 'src/middleware/rate-limit.guard.js';
import { AuthService, type LoginDetails } from 'src/services/auth.service.js';
import { respondWithCookie, respondWithoutCookie } from 'src/utils/response.js';

@ApiTags(ApiTag.Authentication)
@Controller('auth')
export class AuthController {
  constructor(private service: AuthService) {}

  @Post('login')
  @Endpoint({
    summary: 'Login',
    description: 'Login with username and password and receive a session token.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  @Authenticated({ public: true })
  @RateLimited(RATE_LIMITS.login)
  async login(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() loginCredential: LoginCredentialDto,
    @GetLoginDetails() loginDetails: LoginDetails,
  ): Promise<LoginResponseDto> {
    const trustToken = parseCookie(req.headers.cookie || '')[AuthCookie.TwoFactorTrust];
    const body = await this.service.login(loginCredential, loginDetails, trustToken);
    if (body.twoFactorRequired) {
      return body;
    }
    return respondWithCookie(res, body, {
      isSecure: loginDetails.isSecure,
      rememberMe: loginCredential.rememberMe,
      values: [
        { key: AuthCookie.AccessToken, value: body.accessToken },
        { key: AuthCookie.AuthType, value: AuthType.Password },
        { key: AuthCookie.IsAuthenticated, value: 'true' },
      ],
    });
  }

  @Post('login/two-factor')
  @Endpoint({
    summary: 'Finish a two-step sign-in',
    description:
      'Send the authenticator code (or a recovery code) for a password sign-in that answered twoFactorRequired, and receive the session token.',
    history: new HistoryBuilder().added('v3.4.0').beta('v3.4.0'),
  })
  @Authenticated({ public: true })
  @RateLimited(RATE_LIMITS.twoFactorLogin)
  @HttpCode(HttpStatus.OK)
  async loginTwoFactor(
    @Res({ passthrough: true }) res: Response,
    @Body() dto: LoginTwoFactorDto,
    @GetLoginDetails() loginDetails: LoginDetails,
  ): Promise<LoginResponseDto> {
    const { response, rememberMe, trustToken } = await this.service.loginTwoFactor(dto, loginDetails);
    return respondWithCookie(res, response, {
      isSecure: loginDetails.isSecure,
      rememberMe,
      values: [
        { key: AuthCookie.AccessToken, value: response.accessToken },
        { key: AuthCookie.AuthType, value: AuthType.Password },
        { key: AuthCookie.IsAuthenticated, value: 'true' },
        ...(trustToken ? [{ key: AuthCookie.TwoFactorTrust, value: trustToken }] : []),
      ],
    });
  }

  @Post('two-factor/setup')
  @RateLimited(RATE_LIMITS.login)
  @Authenticated({ permission: Permission.AuthChangePassword })
  @Endpoint({
    summary: 'Start setting up two-step sign-in',
    description:
      'Check the password and create a new authenticator key. Two-step sign-in turns on once a code from it is confirmed.',
    history: new HistoryBuilder().added('v3.4.0').beta('v3.4.0'),
  })
  setupTwoFactor(@Auth() auth: AuthDto, @Body() dto: TwoFactorPasswordDto): Promise<TwoFactorSetupResponseDto> {
    return this.service.setupTwoFactor(auth, dto);
  }

  @Post('two-factor/enable')
  @RateLimited(RATE_LIMITS.login)
  @Authenticated({ permission: Permission.AuthChangePassword })
  @Endpoint({
    summary: 'Turn on two-step sign-in',
    description: 'Confirm the new authenticator key with a code. Returns ten recovery codes, shown only this once.',
    history: new HistoryBuilder().added('v3.4.0').beta('v3.4.0'),
  })
  enableTwoFactor(@Auth() auth: AuthDto, @Body() dto: TwoFactorEnableDto): Promise<TwoFactorRecoveryCodesResponseDto> {
    return this.service.enableTwoFactor(auth, dto);
  }

  @Delete('two-factor')
  @RateLimited(RATE_LIMITS.login)
  @Authenticated({ permission: Permission.AuthChangePassword })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Turn off two-step sign-in',
    description: 'Turn off two-step sign-in with the password and an authenticator or recovery code.',
    history: new HistoryBuilder().added('v3.4.0').beta('v3.4.0'),
  })
  disableTwoFactor(@Auth() auth: AuthDto, @Body() dto: TwoFactorDisableDto): Promise<void> {
    return this.service.disableTwoFactor(auth, dto);
  }

  @Post('two-factor/recovery-codes')
  @RateLimited(RATE_LIMITS.login)
  @Authenticated({ permission: Permission.AuthChangePassword })
  @Endpoint({
    summary: 'Make new recovery codes',
    description: 'Replace every recovery code with ten new ones, shown only this once.',
    history: new HistoryBuilder().added('v3.4.0').beta('v3.4.0'),
  })
  regenerateRecoveryCodes(
    @Auth() auth: AuthDto,
    @Body() dto: TwoFactorPasswordDto,
  ): Promise<TwoFactorRecoveryCodesResponseDto> {
    return this.service.regenerateRecoveryCodes(auth, dto);
  }

  @Post('admin-sign-up')
  @Endpoint({
    summary: 'Register admin',
    description: 'Create the first admin user in the system.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  @Authenticated({ public: true, setup: true })
  @RateLimited(RATE_LIMITS.frameleafSetup)
  signUpAdmin(@Body() dto: SignUpDto, @GetLoginDetails() details: LoginDetails): Promise<UserAdminResponseDto> {
    return this.service.adminSignUp(dto, { ip: details.clientIp, via: details.via ?? null });
  }

  @Post('validateToken')
  @Endpoint({
    summary: 'Validate access token',
    description: 'Validate the current authorization method is still valid.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  @Authenticated({ permission: false })
  @HttpCode(HttpStatus.OK)
  validateAccessToken(): ValidateAccessTokenResponseDto {
    return { authStatus: true };
  }

  @Post('change-password')
  @Authenticated({ permission: Permission.AuthChangePassword })
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Change password',
    description: 'Change the password of the current user.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  changePassword(@Auth() auth: AuthDto, @Body() dto: ChangePasswordDto): Promise<UserAdminResponseDto> {
    return this.service.changePassword(auth, dto);
  }

  @Post('password-link/check')
  @Authenticated({ public: true })
  @RateLimited(RATE_LIMITS.login)
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Check a choose-a-password link',
    description: 'Who an emailed single-use link to choose a password is for, while it can still be used.',
    history: new HistoryBuilder().added('v3.2.1'),
  })
  checkPasswordLink(@Body() dto: PasswordLinkCheckDto): Promise<PasswordLinkCheckResponseDto> {
    return this.service.checkPasswordLink(dto);
  }

  @Post('password-link')
  @Authenticated({ public: true })
  @RateLimited(RATE_LIMITS.login)
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Choose a password with a link',
    description:
      'Set the password with an emailed single-use link. The link stops working once used, and every session of the account is signed out.',
    history: new HistoryBuilder().added('v3.2.1'),
  })
  redeemPasswordLink(@Body() dto: PasswordLinkRedeemDto): Promise<void> {
    return this.service.redeemPasswordLink(dto);
  }

  @Post('logout')
  @Authenticated()
  // FL-161: a session that is not a Frameleaf sign-in can still sign out through remote access
  @RemoteSignInExempt()
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Logout',
    description: 'Logout the current user and invalidate the session token.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) res: Response,
    @Auth() auth: AuthDto,
  ): Promise<LogoutResponseDto> {
    const authType = (request.cookies || {})[AuthCookie.AuthType];

    const body = await this.service.logout(auth, authType);
    return respondWithoutCookie(res, body, [AuthCookie.AccessToken, AuthCookie.AuthType, AuthCookie.IsAuthenticated]);
  }

  @Get('status')
  // FL-34: reporting the session's state is not activity; it never extends an unlocked session
  @Authenticated({ refreshElevation: false })
  @Endpoint({
    summary: 'Retrieve auth status',
    description:
      'Get information about the current session, including whether the user has a password, and if the session can access locked assets.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  getAuthStatus(@Auth() auth: AuthDto): Promise<AuthStatusResponseDto> {
    return this.service.getAuthStatus(auth);
  }

  @Post('pin-code')
  @Authenticated({ permission: Permission.PinCodeCreate })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Setup pin code',
    description: 'Setup a new pin code for the current user.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  setupPinCode(@Auth() auth: AuthDto, @Body() dto: PinCodeSetupDto): Promise<void> {
    return this.service.setupPinCode(auth, dto);
  }

  @Put('pin-code')
  @RateLimited(RATE_LIMITS.login)
  @Authenticated({ permission: Permission.PinCodeUpdate })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Change pin code',
    description: 'Change the pin code for the current user.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  async changePinCode(@Auth() auth: AuthDto, @Body() dto: PinCodeChangeDto): Promise<void> {
    return this.service.changePinCode(auth, dto);
  }

  @Delete('pin-code')
  @RateLimited(RATE_LIMITS.login)
  @Authenticated({ permission: Permission.PinCodeDelete })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Reset pin code',
    description: 'Reset the pin code for the current user by providing the account password',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  async resetPinCode(@Auth() auth: AuthDto, @Body() dto: PinCodeResetDto): Promise<void> {
    return this.service.resetPinCode(auth, dto);
  }

  @Post('session/unlock')
  @Authenticated()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Unlock auth session',
    description: 'Temporarily grant the session elevated access to locked assets by providing the correct PIN code.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  async unlockAuthSession(@Auth() auth: AuthDto, @Body() dto: SessionUnlockDto): Promise<void> {
    return this.service.unlockSession(auth, dto);
  }

  @Post('session/lock')
  @Authenticated()
  @Endpoint({
    summary: 'Lock auth session',
    description: 'Remove elevated access to locked assets from the current session.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  @HttpCode(HttpStatus.NO_CONTENT)
  async lockAuthSession(@Auth() auth: AuthDto): Promise<void> {
    return this.service.lockSession(auth);
  }
}
