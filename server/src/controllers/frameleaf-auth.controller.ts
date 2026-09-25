import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Post, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { LoginDetails } from 'src/services/auth.service.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { LoginResponseDto, OAuthAuthorizeResponseDto, OAuthCallbackDto, OAuthConfigDto } from 'src/dtos/auth.dto.js';
import {
  FrameleafAccountLinkResponseDto,
  FrameleafHandoffRedeemDto,
  FrameleafHandoffResponseDto,
} from 'src/dtos/frameleaf-auth.dto.js';
import { UserAdminResponseDto } from 'src/dtos/user.dto.js';
import { ApiTag, AuthType, ImmichCookie, Permission } from 'src/enum.js';
import { Auth, Authenticated, GetLoginDetails } from 'src/middleware/auth.guard.js';
import { FrameleafAuthService } from 'src/services/frameleaf-auth.service.js';
import { respondWithCookie } from 'src/utils/response.js';

/**
 * Sign in with Frameleaf (FL-158, CLD-005): the second OpenID Connect provider slot, beside the
 * administrator's own provider under `oauth/*`, which it never reads or changes.
 */
@ApiTags(ApiTag.Authentication)
@Controller('oauth/frameleaf')
export class FrameleafAuthController {
  constructor(private service: FrameleafAuthService) {}

  @Post('authorize')
  @Authenticated({ public: true })
  @Endpoint({
    operationId: 'startFrameleafSignIn',
    summary: 'Start Sign in with Frameleaf',
    description:
      'The Frameleaf authorization URL for one of the callbacks registered for this server. PKCE is used when the provider advertises it.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  async authorize(
    @Body() dto: OAuthConfigDto,
    @Res({ passthrough: true }) res: Response,
    @GetLoginDetails() loginDetails: LoginDetails,
  ): Promise<OAuthAuthorizeResponseDto> {
    const { url, state, codeVerifier } = await this.service.authorize(dto);
    return respondWithCookie(
      res,
      { url },
      {
        isSecure: loginDetails.isSecure,
        values: [
          { key: ImmichCookie.OAuthState, value: state },
          { key: ImmichCookie.OAuthCodeVerifier, value: codeVerifier },
        ],
      },
    );
  }

  @Post('callback')
  @Authenticated({ public: true })
  @Endpoint({
    operationId: 'finishFrameleafSignIn',
    summary: 'Finish Sign in with Frameleaf',
    description:
      'Exchanges the authorization code, requires a verified email, links or creates the account Frameleaf Cloud authorized, and signs in with a session Frameleaf Cloud can end.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  async callback(
    @Req() request: Request,
    @Res({ passthrough: true }) res: Response,
    @Body() dto: OAuthCallbackDto,
    @GetLoginDetails() loginDetails: LoginDetails,
  ): Promise<LoginResponseDto> {
    const body = await this.service.callback(dto, request.headers, loginDetails);
    res.clearCookie(ImmichCookie.OAuthState);
    res.clearCookie(ImmichCookie.OAuthCodeVerifier);
    return this.signedIn(res, body, loginDetails, dto.rememberMe);
  }

  @Post('handoff')
  @Authenticated()
  @Endpoint({
    operationId: 'createFrameleafHandoff',
    summary: 'Hand a Sign in with Frameleaf session to another address',
    description:
      'A single-use code, valid for a minute, that signs you in on another address of this server (for example your home address). Only a Sign in with Frameleaf session can be handed over.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  createHandoff(@Auth() auth: AuthDto): Promise<FrameleafHandoffResponseDto> {
    return this.service.createHandoff(auth);
  }

  @Post('handoff/redeem')
  @Authenticated({ public: true })
  @Endpoint({
    operationId: 'redeemFrameleafHandoff',
    summary: 'Sign in with a handoff code',
    description: 'Exchanges a handoff code for a new session tagged like the one that created it.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  async redeemHandoff(
    @Res({ passthrough: true }) res: Response,
    @Body() dto: FrameleafHandoffRedeemDto,
    @GetLoginDetails() loginDetails: LoginDetails,
  ): Promise<LoginResponseDto> {
    const body = await this.service.redeemHandoff(dto, loginDetails);
    return this.signedIn(res, body, loginDetails, dto.rememberMe);
  }

  @Get('link')
  @Authenticated({ permission: Permission.FrameleafAccountRead })
  @Endpoint({
    operationId: 'getFrameleafAccountLink',
    summary: 'Get your Frameleaf account link',
    description: 'Whether your account here is linked to a Frameleaf account, and which one.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  getLink(@Auth() auth: AuthDto): Promise<FrameleafAccountLinkResponseDto> {
    return this.service.getLink(auth);
  }

  @Post('link')
  @Authenticated({ permission: Permission.FrameleafAccountUpdate })
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    operationId: 'linkFrameleafAccount',
    summary: 'Link your Frameleaf account',
    description:
      'Links the Frameleaf account you just signed in with to your account here, so you can sign in with it when you are away from home. A verified email is required.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  link(@Req() request: Request, @Auth() auth: AuthDto, @Body() dto: OAuthCallbackDto): Promise<UserAdminResponseDto> {
    return this.service.link(auth, dto, request.headers);
  }

  @Delete('link')
  @Authenticated({ permission: Permission.FrameleafAccountUpdate })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    operationId: 'unlinkFrameleafAccount',
    summary: 'Unlink your Frameleaf account',
    description:
      'Unlinks your Frameleaf account and ends your other Sign in with Frameleaf sessions. Signing in at home is unchanged.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  unlink(@Auth() auth: AuthDto): Promise<void> {
    return this.service.unlink(auth);
  }

  private signedIn(res: Response, body: LoginResponseDto, loginDetails: LoginDetails, rememberMe?: boolean) {
    return respondWithCookie(res, body, {
      isSecure: loginDetails.isSecure,
      rememberMe,
      values: [
        { key: ImmichCookie.AccessToken, value: body.accessToken },
        // not AuthType.OAuth: signing out must never send a Frameleaf session to the other provider
        { key: ImmichCookie.AuthType, value: AuthType.Password },
        { key: ImmichCookie.IsAuthenticated, value: 'true' },
      ],
    });
  }
}
